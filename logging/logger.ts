// ── Bifrost logger ────────────────────────────────────────────────
// Bounded, best-effort diagnostics. The routing hot path only filters,
// optionally evaluates lazy metadata, serializes, and admits into a bounded
// queue. Filesystem work runs later, off the caller's stack, and failures are
// counted rather than propagated.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { BoundedQueue } from "./bounded-queue.ts";
import { createDrainPolicy, type DrainPolicy } from "./drain-policy.ts";
import { AsyncFileSink } from "./file-sink.ts";
import {
  UNATTRIBUTED_SESSION,
  destinationFor,
  mergeIdentity,
  processCorrelation,
} from "./context.ts";
import {
  buildRecord,
  retentionFor,
  serializeRecord,
  shouldEmit,
} from "./severity.ts";
import { resolveOverflowPolicy, type OverflowPolicy } from "./overflow-policy.ts";
import {
  FAILURE_BACKOFF_MS,
  MAX_ENTRY_BYTES,
  type DebugEmitOptions,
  type DebugMeta,
  type DebugMetaSource,
  type DropReason,
  type LogDestination,
  type LogEntry,
  type LogIdentity,
  type LogIdentityHint,
  type LogLevel,
  type LogSink,
  type LoggerStats,
  type ResolvedDebugConfig,
} from "./types.ts";

const BOOTSTRAP_MAX_ENTRIES = 64;
const BOOTSTRAP_MAX_BYTES = 128 * 1024;
const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 5_000;
const SYNC_FLUSH_MAX_ENTRIES = 128;
const SYNC_FLUSH_MAX_BYTES = 256 * 1024;
const SYNC_FLUSH_MAX_FILES = 8;
const MAX_FLUSH_TIMEOUT_MS = 5_000;
const FAILURE_BACKOFF_THRESHOLD = 5;
const DIAGNOSTIC_INTERVAL_MS = 30_000;

interface BootstrapRecord {
  readonly level: LogLevel;
  readonly retention: number;
  readonly module: string;
  readonly event: string;
  readonly entryType: "event" | "measure";
  readonly now: Date;
  readonly meta: DebugMeta | undefined;
  readonly durationMs?: number;
  readonly metaError?: string;
}

export interface BifrostLoggerOptions {
  readonly config: ResolvedDebugConfig;
  readonly identity: LogIdentity;
  readonly correlation?: Readonly<Record<string, string>>;
  readonly sinkFactory?: (destination: LogDestination, config: ResolvedDebugConfig) => LogSink;
  readonly bootstrapTimeoutMs?: number;
  readonly now?: () => number;
  readonly date?: () => Date;
}

interface MutableStats {
  droppedTotal: number;
  droppedBySeverity: Record<LogLevel, number>;
  droppedByReason: Record<DropReason, number>;
  evictionsTotal: number;
  batchesWritten: number;
  bytesWritten: number;
  writeFailures: number;
  lastFlushAt: number | null;
  lastWriteFailureAt: number | null;
}

function emptyByLevel(): Record<LogLevel, number> {
  return { trace: 0, debug: 0, info: 0, warn: 0, error: 0 };
}

function emptyByReason(): Record<DropReason, number> {
  return { queue_capacity: 0, oversized: 0, write_failure: 0, sink_degraded: 0, closed: 0 };
}

function evaluateMeta(source: DebugMetaSource | undefined): { meta?: DebugMeta; error?: string } {
  try {
    const value = typeof source === "function" ? source() : source;
    if (value && typeof value === "object" && !Array.isArray(value)) return { meta: value };
    return {};
  } catch {
    return { error: "callback_threw" };
  }
}

export class BifrostLogger {
  private readonly config: ResolvedDebugConfig;
  private readonly queue: BoundedQueue;
  private readonly overflow: OverflowPolicy;
  private readonly drainPolicy: DrainPolicy;
  private readonly baseIdentity: LogIdentity;
  private readonly correlation: Readonly<Record<string, string>>;
  private readonly sinkFactory: (destination: LogDestination, config: ResolvedDebugConfig) => LogSink;
  private readonly bootstrapTimeoutMs: number;
  private readonly now: () => number;
  private readonly date: () => Date;

  private sessionIdentity: LogIdentity | null = null;
  private cachedIdentity: LogIdentity | null = null;
  private cachedDestination: LogDestination | null = null;
  private readonly sinks = new Map<string, LogSink>();
  private readonly activeWrites = new Set<Promise<void>>();
  private readonly flushWaiters = new Set<() => void>();
  private bootstrap: Array<{ record: BootstrapRecord; bytes: number }> = [];
  private bootstrapBytes = 0;
  private bootstrapTimer: ReturnType<typeof setTimeout> | null = null;
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;
  private pumping = false;
  private accepting = true;
  private closing = false;
  private stopped = false;
  private entrySequence = 0;
  private consecutiveFailures = 0;
  private degradedUntil = 0;
  private summarySuppressed = false;
  private lastDiagnosticAt = 0;
  private pendingDropTotal = 0;
  private pendingDropByLevel = emptyByLevel();
  private pendingDropByReason = emptyByReason();
  private emittingSummary = false;
  private readonly statsValue: MutableStats = {
    droppedTotal: 0,
    droppedBySeverity: emptyByLevel(),
    droppedByReason: emptyByReason(),
    evictionsTotal: 0,
    batchesWritten: 0,
    bytesWritten: 0,
    writeFailures: 0,
    lastFlushAt: null,
    lastWriteFailureAt: null,
  };

  constructor(options: BifrostLoggerOptions) {
    this.config = options.config;
    this.queue = new BoundedQueue(options.config.queue.maxEntries, options.config.queue.maxBytes);
    this.overflow = resolveOverflowPolicy(options.config.queue.overflowPolicy);
    this.drainPolicy = createDrainPolicy(options.config);
    this.baseIdentity = options.identity;
    this.correlation = options.correlation ?? processCorrelation();
    this.sinkFactory = options.sinkFactory ?? ((destination, config) => new AsyncFileSink(destination, {
      maxFileSizeBytes: config.sink.maxFileSizeBytes,
      rotatedFiles: config.sink.rotatedFiles,
    }));
    this.bootstrapTimeoutMs = options.bootstrapTimeoutMs ?? DEFAULT_BOOTSTRAP_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.date = options.date ?? (() => new Date());
  }

  get enabled(): boolean {
    return this.accepting;
  }

  get minimumLevel(): LogLevel {
    return this.config.level;
  }

  accepts(level: LogLevel): boolean {
    return this.accepting && shouldEmit(this.config.level, level);
  }

  currentIdentity(): LogIdentity {
    return this.sessionIdentity ?? this.baseIdentity;
  }

  currentDestination(): LogDestination {
    return destinationFor(this.config, this.currentIdentity());
  }

  /** Associate subsequent default-attributed events with a Pi session. */
  bindSession(hint: LogIdentityHint): LogIdentity {
    const next = mergeIdentity(this.baseIdentity, hint);
    this.sessionIdentity = next;
    this.finalizeBootstrap(next);
    return next;
  }

  endSession(): void {
    this.sessionIdentity = null;
  }

  emit(
    module: string,
    event: string,
    metaSource?: DebugMetaSource,
    options?: DebugEmitOptions,
    entryType: "event" | "measure" = "event",
    durationMs?: number,
  ): void {
    if (!this.accepting || !this.config.enabled) return;
    const level = options?.level ?? "debug";
    if (!shouldEmit(this.config.level, level)) return;
    const outcome = evaluateMeta(metaSource);
    const record: BootstrapRecord = {
      level,
      retention: retentionFor(level, options?.protected === true),
      module,
      event,
      entryType,
      now: this.date(),
      meta: outcome.meta,
      ...(durationMs !== undefined ? { durationMs: Math.round(durationMs * 1_000) / 1_000 } : {}),
      ...(outcome.error ? { metaError: outcome.error } : {}),
    };
    if (this.needsBootstrap(options?.identity)) {
      this.addBootstrap(record, options?.identity);
      return;
    }
    const entry = this.prepare(record, this.identityFor(options?.identity));
    if (entry) this.enqueue(entry);
  }

  stats(): LoggerStats {
    return {
      queuedEntries: this.queue.pendingEntryCount,
      queuedBytes: this.queue.pendingBytes,
      inFlightEntries: this.queue.inFlightEntryCount,
      inFlightBytes: this.queue.inFlightBytes,
      droppedTotal: this.statsValue.droppedTotal,
      droppedBySeverity: { ...this.statsValue.droppedBySeverity },
      droppedByReason: { ...this.statsValue.droppedByReason },
      evictionsTotal: this.statsValue.evictionsTotal,
      batchesWritten: this.statsValue.batchesWritten,
      bytesWritten: this.statsValue.bytesWritten,
      writeFailures: this.statsValue.writeFailures,
      largestQueuedEntries: this.queue.largestObservedEntries,
      largestQueuedBytes: this.queue.largestObservedBytes,
      lastFlushAt: this.statsValue.lastFlushAt,
      lastWriteFailureAt: this.statsValue.lastWriteFailureAt,
    };
  }

  /** Bounded drain. The timeout is a real deadline, not a retry budget. */
  async flush(timeoutMs = 250): Promise<void> {
    const budget = Math.min(Math.max(Number.isFinite(timeoutMs) ? timeoutMs : 0, 0), MAX_FLUSH_TIMEOUT_MS);
    this.finalizeBootstrap();
    if (this.stopped && this.queue.totalEntries === 0 && this.activeWrites.size === 0) return;
    if (this.queue.pendingEntryCount > 0) this.schedulePump(0);
    if (this.queue.totalEntries === 0 && this.activeWrites.size === 0 && !this.pumping) {
      this.maybeEmitDropSummary();
      if (this.queue.totalEntries === 0 && this.activeWrites.size === 0) return;
    }
    if (budget <= 0) return;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.flushWaiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, budget);
      timer.unref?.();
      this.flushWaiters.add(finish);
      this.schedulePump(0);
    });
  }

  /** Stop accepting work, drain what is already accepted, then close sinks. */
  async close(timeoutMs = 250): Promise<void> {
    if (this.closing) return this.flush(timeoutMs);
    this.closing = true;
    this.accepting = false;
    this.finalizeBootstrap();
    this.schedulePump(0);
    await this.flush(timeoutMs);
    this.stopped = true;
    this.clearTimers();
    const sinks = [...this.sinks.values()];
    this.sinks.clear();
    await Promise.race([
      Promise.allSettled(sinks.map((sink) => sink.close())),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(timeoutMs, 1_000));
        timer.unref?.();
      }),
    ]);
    this.resolveWaiters();
  }

  /** Strictly bounded synchronous fallback for `process.exit`. */
  flushSyncBounded(): void {
    try {
      this.accepting = false;
      this.finalizeBootstrapSync();
      const batch = this.queue.takePendingSync(SYNC_FLUSH_MAX_ENTRIES, SYNC_FLUSH_MAX_BYTES);
      if (batch.length === 0) return;
      const groups = new Map<string, { path: string; lines: string[] }>();
      for (const entry of batch) {
        let group = groups.get(entry.destination.key);
        if (!group) {
          if (groups.size >= SYNC_FLUSH_MAX_FILES) break;
          group = { path: entry.destination.path, lines: [] };
          groups.set(entry.destination.key, group);
        }
        group.lines.push(entry.line);
      }
      for (const group of groups.values()) {
        try {
          mkdirSync(dirname(group.path), { recursive: true, mode: 0o700 });
          appendFileSync(group.path, group.lines.join(""), { encoding: "utf-8", flag: "a", mode: 0o600 });
        } catch {
          // Exit path: no diagnostics, no retries.
        }
      }
    } catch {
      // Logging must never abort process exit.
    }
  }

  // ── Admission ──────────────────────────────────────────────────

  private identityFor(hint?: LogIdentityHint): LogIdentity {
    const current = this.currentIdentity();
    if (!hint?.sessionId) return current;
    // The overwhelmingly common case is a call site naming the already-bound
    // session. Reuse the identity object so destination lookup stays cached.
    if (hint.sessionId === current.sessionId
      && (hint.rootSessionId === undefined || hint.rootSessionId === current.rootSessionId)
      && (hint.agentId === undefined || hint.agentId === current.agentId)) {
      return current;
    }
    return mergeIdentity(this.baseIdentity, hint);
  }

  private destinationForIdentity(identity: LogIdentity): LogDestination {
    if (this.cachedIdentity === identity && this.cachedDestination) return this.cachedDestination;
    const destination = destinationFor(this.config, identity);
    this.cachedIdentity = identity;
    this.cachedDestination = destination;
    return destination;
  }

  private needsBootstrap(hint?: LogIdentityHint): boolean {
    if (this.config.legacyPath) return false;
    if (hint?.sessionId) return false;
    if (this.sessionIdentity) return false;
    return this.baseIdentity.rootSessionId === UNATTRIBUTED_SESSION;
  }

  private prepare(record: BootstrapRecord, identity: LogIdentity): LogEntry | null {
    const built = buildRecord({
      now: record.now,
      module: record.module,
      event: record.event,
      entryType: record.entryType,
      level: record.level,
      identity,
      correlation: this.correlation,
      meta: record.meta,
      ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
      ...(record.metaError !== undefined ? { metaError: record.metaError } : {}),
    });
    const serialized = serializeRecord(built, MAX_ENTRY_BYTES);
    if (!serialized) {
      this.recordDrop(record.level, "oversized");
      return null;
    }
    this.entrySequence += 1;
    return {
      id: this.entrySequence,
      level: record.level,
      retention: record.retention,
      destination: this.destinationForIdentity(identity),
      line: serialized.line,
      bytes: serialized.bytes,
    };
  }

  private enqueue(entry: LogEntry): void {
    if (!this.accepting) {
      this.recordDrop(entry.level, "closed");
      return;
    }
    const result = this.queue.admit(entry, this.overflow);
    if (!result.accepted) {
      this.recordDrop(entry.level, "queue_capacity");
      return;
    }
    for (const evicted of result.evicted) {
      this.statsValue.evictionsTotal += 1;
      this.recordDrop(evicted.level, "queue_capacity");
    }
    if (this.queue.pendingEntryCount > 0) {
      if (this.drainPolicy.shouldDrainNow(this.queue.pendingBytes, this.queue.pendingEntryCount)) {
        this.schedulePump(0);
      } else {
        this.ensurePumpTimer();
      }
    }
  }

  private recordDrop(level: LogLevel, reason: DropReason): void {
    this.statsValue.droppedTotal += 1;
    this.statsValue.droppedBySeverity[level] += 1;
    this.statsValue.droppedByReason[reason] += 1;
    if (this.emittingSummary) return;
    this.pendingDropTotal += 1;
    this.pendingDropByLevel[level] += 1;
    this.pendingDropByReason[reason] += 1;
  }

  // ── Bootstrap ──────────────────────────────────────────────────

  private addBootstrap(record: BootstrapRecord, hint?: LogIdentityHint): void {
    const provisional = this.prepare(record, this.identityFor(hint));
    if (!provisional) return;
    while (this.bootstrap.length > 0
      && (this.bootstrap.length >= BOOTSTRAP_MAX_ENTRIES
        || this.bootstrapBytes + provisional.bytes > BOOTSTRAP_MAX_BYTES)) {
      const removed = this.bootstrap.shift();
      if (!removed) break;
      this.bootstrapBytes -= removed.bytes;
      this.recordDrop(removed.record.level, "queue_capacity");
    }
    if (provisional.bytes > BOOTSTRAP_MAX_BYTES) {
      this.recordDrop(record.level, "oversized");
      return;
    }
    this.bootstrap.push({ record, bytes: provisional.bytes });
    this.bootstrapBytes += provisional.bytes;
    if (!this.bootstrapTimer) {
      this.bootstrapTimer = setTimeout(() => this.finalizeBootstrap(), this.bootstrapTimeoutMs);
      this.bootstrapTimer.unref?.();
    }
  }

  private finalizeBootstrap(identity?: LogIdentity): void {
    if (this.bootstrapTimer) {
      clearTimeout(this.bootstrapTimer);
      this.bootstrapTimer = null;
    }
    if (this.bootstrap.length === 0) return;
    const records = this.bootstrap;
    this.bootstrap = [];
    this.bootstrapBytes = 0;
    const target = identity ?? this.currentIdentity();
    for (const record of records) {
      const entry = this.prepare(record.record, target);
      if (entry) this.enqueue(entry);
    }
  }

  private finalizeBootstrapSync(): void {
    if (this.bootstrap.length === 0) return;
    const records = this.bootstrap;
    this.bootstrap = [];
    this.bootstrapBytes = 0;
    const target = this.currentIdentity();
    for (const record of records) {
      const entry = this.prepare(record.record, target);
      if (!entry) continue;
      const result = this.queue.admit(entry, this.overflow);
      if (!result.accepted) this.recordDrop(entry.level, "queue_capacity");
    }
  }

  // ── Draining ───────────────────────────────────────────────────

  private ensurePumpTimer(): void {
    if (this.pumpTimer || this.stopped) return;
    this.schedulePump(this.drainPolicy.intervalMs);
  }

  private schedulePump(delayMs: number): void {
    if (this.stopped) return;
    if (this.pumpTimer) {
      if (delayMs > 0) return;
      clearTimeout(this.pumpTimer);
      this.pumpTimer = null;
    }
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null;
      this.pump();
    }, Math.max(0, delayMs));
    this.pumpTimer.unref?.();
  }

  private pump(): void {
    if (this.pumping || this.stopped) return;
    this.pumping = true;
    const batch = this.queue.drain(this.drainPolicy.maxBatchEntries, this.drainPolicy.maxBatchBytes);
    if (batch.length === 0) {
      this.pumping = false;
      this.maybeEmitDropSummary();
      this.maybeSettle();
      return;
    }
    this.dispatch(batch);
    this.pumping = false;
    if (this.queue.pendingEntryCount > 0) this.schedulePump(0);
    else this.maybeSettle();
  }

  private dispatch(batch: readonly LogEntry[]): void {
    const groups = new Map<string, { destination: LogDestination; entries: LogEntry[] }>();
    for (const entry of batch) {
      let group = groups.get(entry.destination.key);
      if (!group) {
        group = { destination: entry.destination, entries: [] };
        groups.set(entry.destination.key, group);
      }
      group.entries.push(entry);
    }
    for (const group of groups.values()) {
      const bytes = group.entries.reduce((total, entry) => total + entry.bytes, 0);
      if (this.now() < this.degradedUntil) {
        this.queue.release(group.entries);
        for (const entry of group.entries) this.recordDrop(entry.level, "sink_degraded");
        continue;
      }
      const sink = this.sinkFor(group.destination);
      let write: Promise<void>;
      try {
        write = sink.write(group.entries);
      } catch (error) {
        this.onWriteFailure(group.entries, bytes, error, group.destination);
        continue;
      }
      write
        .then(() => this.onWriteSuccess(group.entries, bytes))
        .catch((error: unknown) => this.onWriteFailure(group.entries, bytes, error, group.destination))
        .finally(() => {
          this.activeWrites.delete(write);
          this.maybeSettle();
        });
      this.activeWrites.add(write);
    }
  }

  private sinkFor(destination: LogDestination): LogSink {
    const existing = this.sinks.get(destination.key);
    if (existing) return existing;
    const sink = this.sinkFactory(destination, this.config);
    this.sinks.set(destination.key, sink);
    return sink;
  }

  private onWriteSuccess(entries: readonly LogEntry[], bytes: number): void {
    this.queue.release(entries);
    this.consecutiveFailures = 0;
    this.summarySuppressed = false;
    this.statsValue.batchesWritten += 1;
    this.statsValue.bytesWritten += bytes;
    this.statsValue.lastFlushAt = this.now();
    this.maybeEmitDropSummary();
  }

  private onWriteFailure(
    entries: readonly LogEntry[],
    _bytes: number,
    error: unknown,
    destination: LogDestination,
  ): void {
    this.queue.release(entries);
    this.statsValue.writeFailures += 1;
    this.statsValue.lastWriteFailureAt = this.now();
    this.consecutiveFailures += 1;
    this.summarySuppressed = true;
    for (const entry of entries) this.recordDrop(entry.level, "write_failure");
    if (this.consecutiveFailures >= FAILURE_BACKOFF_THRESHOLD) {
      this.degradedUntil = this.now() + FAILURE_BACKOFF_MS;
      this.consecutiveFailures = 0;
    }
    this.reportFailure(error, destination);
  }

  private reportFailure(error: unknown, destination: LogDestination): void {
    const current = this.now();
    if (current - this.lastDiagnosticAt < DIAGNOSTIC_INTERVAL_MS) return;
    this.lastDiagnosticAt = current;
    const code = typeof (error as { code?: unknown })?.code === "string"
      ? (error as { code: string }).code
      : "write_failed";
    try {
      process.stderr.write(`[bifrost] debug logging degraded (${code}) for ${destination.legacy ? "legacy path" : "session log"}\n`);
    } catch {
      // Never let diagnostics fail the caller.
    }
  }

  private maybeEmitDropSummary(): void {
    if (this.pendingDropTotal === 0 || this.emittingSummary || this.stopped) return;
    // Never report drops through a pipeline that is currently failing: the
    // summary would be dropped again and re-triggered on the next tick.
    if (this.summarySuppressed || this.now() < this.degradedUntil) return;
    const counts: Partial<Record<LogLevel, number>> = {};
    for (const level of ["trace", "debug", "info", "warn", "error"] as const) {
      const value = this.pendingDropByLevel[level];
      if (value > 0) counts[level] = value;
    }
    const reasons: Partial<Record<DropReason, number>> = {};
    for (const reason of ["queue_capacity", "oversized", "write_failure", "sink_degraded", "closed"] as const) {
      const value = this.pendingDropByReason[reason];
      if (value > 0) reasons[reason] = value;
    }
    const total = this.pendingDropTotal;
    this.pendingDropTotal = 0;
    this.pendingDropByLevel = emptyByLevel();
    this.pendingDropByReason = emptyByReason();
    this.emittingSummary = true;
    try {
      // Bypass the bootstrap stage: the summary describes events admitted
      // before identity resolution, so it belongs to the current run now.
      const entry = this.prepare({
        level: "warn",
        retention: retentionFor("warn", true),
        module: "logger",
        event: "events_dropped",
        entryType: "event",
        now: this.date(),
        meta: {
          counts,
          reasons,
          dropped_total: total,
          reason: Object.keys(reasons)[0] ?? "queue_capacity",
        },
      }, this.currentIdentity());
      if (entry) this.enqueue(entry);
    } finally {
      this.emittingSummary = false;
    }
    if (this.queue.pendingEntryCount > 0) this.schedulePump(0);
  }

  private maybeSettle(): void {
    if (this.queue.totalEntries > 0 || this.activeWrites.size > 0 || this.pumping) return;
    this.maybeEmitDropSummary();
    if (this.queue.totalEntries > 0 || this.activeWrites.size > 0) return;
    this.resolveWaiters();
  }

  private resolveWaiters(): void {
    for (const waiter of [...this.flushWaiters]) waiter();
  }

  private clearTimers(): void {
    if (this.pumpTimer) {
      clearTimeout(this.pumpTimer);
      this.pumpTimer = null;
    }
    if (this.bootstrapTimer) {
      clearTimeout(this.bootstrapTimer);
      this.bootstrapTimer = null;
    }
  }
}

