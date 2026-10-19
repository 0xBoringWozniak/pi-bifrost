// ── Severity, record shaping, and redaction ───────────────────────
// Filtering and record construction stay cheap: no recursive traversal of
// arbitrary metadata, no work for filtered events.

import {
  DEFAULT_LOG_LEVEL,
  LOG_LEVELS,
  type LogIdentity,
  type LogLevel,
} from "./types.ts";

const RANK: Readonly<Record<LogLevel, number>> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value);
}

export function parseLogLevel(value: unknown, fallback: LogLevel = DEFAULT_LOG_LEVEL): LogLevel {
  return isLogLevel(value) ? value : fallback;
}

export function levelRank(level: LogLevel): number {
  return RANK[level];
}

/** Higher retention survives overflow longer. Protected events rank above peers. */
export function retentionFor(level: LogLevel, protectedEvent: boolean): number {
  return RANK[level] * 2 + (protectedEvent ? 1 : 0);
}

export function shouldEmit(minimum: LogLevel, level: LogLevel): boolean {
  return RANK[level] >= RANK[minimum];
}

// Ownership and record identity are reserved. Correlation identifiers stay
// writable because session-aware callers supply them as metadata (and existing
// trace consumers depend on them).
const RESERVED_BASE = new Set([
  "ts", "level", "module", "event", "entryType", "duration_ms", "_meta_error",
  "root_session_id", "session_id", "run_id", "agent_id", "parent_agent_id", "process_id",
]);

// Top-level channels that could carry raw user or provider text. Non-string
// values stay (for example the probe report's numeric `error` count).
const SENSITIVE_KEYS = new Set([
  "prompt", "prompts", "message", "messages", "content", "response", "responsebody",
  "request", "requestbody", "body", "apikey", "api_key", "authorization", "secret",
  "credentials", "endpoint", "url", "errortext", "errormessage", "stack",
  "criteria", "systemprompt", "token", "accesstoken", "access_token",
  "refreshtoken", "refresh_token", "password",
]);

/** Removes reserved fields and drops top-level string values in sensitive channels. */
export function sanitizeMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!meta) return {};
  const clean: Record<string, unknown> = {};
  for (const key of Object.keys(meta)) {
    if (RESERVED_BASE.has(key)) continue;
    const value = meta[key];
    if (typeof value === "string" && value.length > 0 && SENSITIVE_KEYS.has(key.toLowerCase())) continue;
    clean[key] = value;
  }
  return clean;
}

export interface BuildRecordInput {
  readonly now: Date;
  readonly module: string;
  readonly event: string;
  readonly entryType: "event" | "measure";
  readonly level: LogLevel;
  readonly identity: LogIdentity;
  readonly correlation: Readonly<Record<string, string>>;
  readonly meta: Record<string, unknown> | undefined;
  readonly durationMs?: number;
  readonly metaError?: string;
}

export function buildRecord(input: BuildRecordInput): Record<string, unknown> {
  const clean = sanitizeMeta(input.meta);
  // Base and correlation fields first so metadata key order stays stable for
  // existing consumers; ownership fields are appended and cannot be overridden.
  const record: Record<string, unknown> = {
    ts: input.now.toISOString(),
    module: input.module,
    event: input.event,
    entryType: input.entryType,
    ...input.correlation,
    ...clean,
  };
  if (input.entryType === "measure" && input.durationMs !== undefined) {
    record.duration_ms = input.durationMs;
  }
  if (input.metaError !== undefined) record._meta_error = input.metaError;
  record.level = input.level;
  record.root_session_id = input.identity.rootSessionId;
  record.session_id = input.identity.sessionId;
  record.run_id = input.identity.runId;
  record.process_id = input.identity.processId;
  if (input.identity.agentId !== undefined) record.agent_id = input.identity.agentId;
  if (input.identity.parentAgentId !== undefined) record.parent_agent_id = input.identity.parentAgentId;
  return record;
}

export interface SerializedLine {
  readonly line: string;
  readonly bytes: number;
}

/**
 * Serialize one record. Returns null when the record exceeds the per-entry cap,
 * so callers can count a bounded rejection instead of retaining a huge string.
 * Serialization failures fall back to a metadata-free record.
 */
export function serializeRecord(
  record: Record<string, unknown>,
  maxEntryBytes: number,
): SerializedLine | null {
  let line: string;
  try {
    line = `${JSON.stringify(record)}\n`;
  } catch {
    try {
      const fallback: Record<string, unknown> = {};
      for (const key of Object.keys(record)) {
        const value = record[key];
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
          fallback[key] = value;
        }
      }
      fallback._meta_error = "unserializable";
      line = `${JSON.stringify(fallback)}\n`;
    } catch {
      return null;
    }
  }
  const bytes = Buffer.byteLength(line, "utf8");
  if (bytes > maxEntryBytes) return null;
  return { line, bytes };
}
