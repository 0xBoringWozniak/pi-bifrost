// ── Structured debug logging (public facade) ──────────────────────
// Configuration-first, best-effort diagnostics. The routing hot path never
// performs filesystem I/O and never waits for logging capacity.
//
// Legacy configuration keeps its meaning:
//   { "debug": { "enabled": true, "path": ".pi/bifrost-debug.jsonl" } }
// Without an explicit path, logs are session-scoped:
//   .pi/bifrost/logs/<root-session>/main/<run>.jsonl
//   .pi/bifrost/logs/<root-session>/subagents/<agent>/<run>.jsonl

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import {
  UNATTRIBUTED_SESSION,
  createProcessIdentity,
  resolveDebugConfig,
} from "./logging/context.ts";
import { BifrostLogger } from "./logging/logger.ts";
import type { LoggerStats } from "./logging/types.ts";
import type {
  DebugConfig,
  DebugEmitOptions,
  DebugMetaSource,
  LogIdentity,
} from "./logging/types.ts";

export type { DebugConfig, DebugEmitOptions, DebugMeta, DebugMetaSource, LogLevel, LoggerStats } from "./logging/types.ts";

export interface DebugSessionLike {
  getHeader?: () => { id?: unknown } | null | undefined;
}

export interface DebugBindOptions {
  rootSessionId?: string;
  agentId?: string;
  parentAgentId?: string;
}

let active: BifrostLogger | null = null;
let activeKey: string | null = null;
let exitHookInstalled = false;

const noopStop = (_meta?: DebugMetaSource, _options?: DebugEmitOptions): void => {};

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // `exit` cannot await asynchronous work. Flush a strictly bounded prefix
  // synchronously; lifecycle hooks above handle the ordinary graceful drain.
  process.on("exit", () => {
    try {
      active?.flushSyncBounded();
    } catch {
      // Logging never aborts process exit.
    }
  });
}

function configKey(resolved: ReturnType<typeof resolveDebugConfig>, cwd: string): string {
  return JSON.stringify({ cwd, ...resolved });
}

/**
 * Configure the logger. Repeated calls are idempotent for identical config.
 * A changed config retires the previous logger after its accepted events drain;
 * those events keep the destination captured at admission.
 */
export function setupDebug(cfg: DebugConfig, cwd: string): void {
  const resolved = resolveDebugConfig(cfg, cwd);
  const key = configKey(resolved, cwd);
  if (active && activeKey === key) return;

  const previous = active;
  active = null;
  activeKey = null;

  if (resolved.enabled) {
    try {
      mkdirSync(resolved.legacyPath ? dirname(resolved.legacyPath) : resolved.directory, {
        recursive: true,
        mode: 0o700,
      });
    } catch {
      try {
        process.stderr.write("[bifrost] debug directory unavailable\n");
      } catch {
        // Ignore stderr failures.
      }
      void previous?.close(250);
      return;
    }

    const logger = new BifrostLogger({
      config: resolved,
      identity: createProcessIdentity(),
    });
    const carried = previous?.currentIdentity();
    if (carried && carried.rootSessionId !== UNATTRIBUTED_SESSION) {
      logger.bindSession({
        sessionId: carried.sessionId,
        rootSessionId: carried.rootSessionId,
        ...(carried.agentId ? { agentId: carried.agentId } : {}),
        ...(carried.parentAgentId ? { parentAgentId: carried.parentAgentId } : {}),
      });
    }
    active = logger;
    activeKey = key;
    installExitHook();
  }

  if (previous) void previous.close(250);
}

/** Associate the current process with a Pi session. Safe when logging is off. */
export function bindDebugSession(session: DebugSessionLike | undefined, options?: DebugBindOptions): void {
  if (!active) return;
  let id: unknown;
  try {
    id = session?.getHeader?.()?.id;
  } catch {
    return;
  }
  if (typeof id !== "string" || id.length === 0) return;
  active.bindSession({ sessionId: id, ...options });
}

/** Return subsequent contextless events to the process fallback. */
export function endDebugSession(): void {
  active?.endSession();
}

/** Whether structured logging is enabled for the current setup. */
export function isDebugEnabled(): boolean {
  return active?.enabled ?? false;
}

/** Log a discrete event. Async — serialized and queued, never awaited. */
export function debug(
  module: string,
  event: string,
  meta?: DebugMetaSource,
  options?: DebugEmitOptions,
): void {
  active?.emit(module, event, meta, options);
}

/**
 * Start a performance measure. Durations use the monotonic clock, so
 * overlapping measurements with the same name remain independent.
 */
export function debugMeasure(
  module: string,
  event: string,
  options?: DebugEmitOptions,
): (meta?: DebugMetaSource, stopOptions?: DebugEmitOptions) => void {
  if (!active?.accepts(options?.level ?? "debug")) return noopStop;
  const startedAt = performance.now();
  return (meta?: DebugMetaSource, stopOptions?: DebugEmitOptions) => {
    const logger = active;
    const level = stopOptions?.level ?? options?.level ?? "debug";
    if (!logger?.accepts(level)) return;
    const identity = stopOptions?.identity ?? options?.identity;
    const protectedEvent = stopOptions?.protected ?? options?.protected;
    logger.emit(
      module,
      event,
      meta,
      {
        level,
        ...(identity ? { identity } : {}),
        ...(protectedEvent ? { protected: true } : {}),
      },
      "measure",
      performance.now() - startedAt,
    );
  };
}

/** Best-effort bounded drain for awaited host shutdown hooks. */
export async function flushDebug(timeoutMs = 250): Promise<void> {
  const logger = active;
  if (!logger) return;
  await logger.flush(timeoutMs);
}

/** Internal health snapshot. Returns null when logging is disabled. */
export function debugLoggerStats(): LoggerStats | null {
  return active?.stats() ?? null;
}

/** Current default identity, for tests and diagnostics. */
export function debugLoggerIdentity(): LogIdentity | null {
  return active?.currentIdentity() ?? null;
}
