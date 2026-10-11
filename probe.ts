// ── Model probe: availability testing ────────────────────────────
// Sends a tiny prompt to every available model and records results.
// Used by /bifrost probe to surface real-world model health.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { constants } from "node:fs";
import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promptWithMinimalSession } from "./session-fallback.ts";
import { writeJsonFile } from "./storage.ts";
import { isVirtualModel } from "./virtual-model.ts";

export interface ProbeResult {
  provider: string;
  model: string;
  cost_input: number;
  cost_output: number;
  status: "ok" | "error" | "timeout" | "skipped";
  duration_ms: number;
  transport?: "streamSimple" | "session";
  error?: string;
  tokens?: number;
}

const PROBE_PROMPT = "1+1=";
export const PROBE_PROMPT_TEXT = PROBE_PROMPT;
export const PROBE_CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_PROBE_CACHE_BYTES = 10_000_000;
const PROBE_TIMEOUT_MS = 10_000;
const PROBE_MAX_TOKENS = 5;
/** Default worker count. Override via config `probe.concurrency` —
 * lower it if a provider rate-limits burst traffic. */
export const DEFAULT_PROBE_CONCURRENCY = 50;

function assistantText(message: { content: Array<{ type: string; text?: string }> }): string {
  return message.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

type MinimalSessionPrompt = (
  model: Model<Api>,
  prompt: string,
  options: { cwd?: string; systemPrompt?: string; signal?: AbortSignal },
) => Promise<string | undefined>;

export interface RunProbeOptions {
  onProgress?: (done: number, total: number, last: ProbeResult) => void;
  models?: readonly Model<Api>[];
  shouldProbe?: (model: Model<Api>) => boolean;
  promptWithSession?: MinimalSessionPrompt;
  timeoutMs?: number;
  concurrency?: number;
  signal?: AbortSignal;
}

export type ProbeCatalogModel = Pick<Model<Api>, "provider" | "id">;

/** Accept only reports that contain one actual outcome for every physical model. */
export function validateCompleteProbeReport(
  value: unknown,
  catalog: readonly ProbeCatalogModel[],
): ProbeResult[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const expected = new Set<string>();
  for (const model of catalog) {
    const key = JSON.stringify([model.provider, model.id]);
    if (expected.has(key)) return undefined;
    expected.add(key);
  }
  if (value.length !== expected.size) return undefined;

  const seen = new Set<string>();
  const results: ProbeResult[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
    const row = entry as Record<string, unknown>;
    if (typeof row.provider !== "string" || typeof row.model !== "string"
      || (row.status !== "ok" && row.status !== "error" && row.status !== "timeout")) return undefined;
    const key = JSON.stringify([row.provider, row.model]);
    if (!expected.has(key) || seen.has(key)) return undefined;
    seen.add(key);
    for (const field of ["cost_input", "cost_output", "duration_ms"] as const) {
      if (row[field] !== undefined && (typeof row[field] !== "number" || !Number.isFinite(row[field]))) return undefined;
    }
    if (row.error !== undefined && typeof row.error !== "string") return undefined;
    results.push(row as unknown as ProbeResult);
  }
  return seen.size === expected.size ? results : undefined;
}

/** Read a recent, complete cache from one no-follow file descriptor snapshot. */
export function readRecentCompleteProbeReport(
  path: string,
  catalog: readonly ProbeCatalogModel[],
  now = Date.now(),
): ProbeResult[] | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > MAX_PROBE_CACHE_BYTES) return undefined;
    const ageMs = now - before.mtimeMs;
    if (ageMs < 0 || ageMs >= PROBE_CACHE_TTL_MS) return undefined;
    const text = readFileSync(fd, "utf8");
    const after = fstatSync(fd);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || Buffer.byteLength(text) !== before.size) return undefined;
    return validateCompleteProbeReport(JSON.parse(text) as unknown, catalog);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** RunProbe options derived from config (`probe.concurrency`/`probe.timeoutMs`).
 * Undefined fields fall back to runProbe defaults. */
export function probeOptionsFromConfig(config?: {
  concurrency?: number;
  timeoutMs?: number;
}): Pick<RunProbeOptions, "concurrency" | "timeoutMs"> {
  return { concurrency: config?.concurrency, timeoutMs: config?.timeoutMs };
}

export async function runProbe(
  ctx: ExtensionContext,
  options: RunProbeOptions = {},
): Promise<{ results: ProbeResult[]; path: string; cancelled?: true }> {
  const outputPath = join(process.cwd(), ".pi", "bifrost-probe.json");
  const catalog = ctx.modelRegistry.getAvailable().filter((model) => !isVirtualModel(model));
  const available = (options.models ?? catalog).filter((model) => !isVirtualModel(model));
  const total = available.length;
  const results: ProbeResult[] = new Array(total);
  let cursor = 0;
  let completed = 0;

  const { onProgress, promptWithSession = promptWithMinimalSession, timeoutMs = PROBE_TIMEOUT_MS, concurrency = DEFAULT_PROBE_CONCURRENCY, signal, shouldProbe } = options;

  async function worker() {
    while (cursor < total && !signal?.aborted) {
      const i = cursor++;
      const model = available[i];
      let eligible = true;
      try { eligible = shouldProbe?.(model) ?? true; }
      catch { eligible = false; }
      results[i] = eligible
        ? await probeOne(ctx, model, promptWithSession, timeoutMs, signal)
        : { provider: model.provider, model: model.id, cost_input: model.cost?.input ?? 0, cost_output: model.cost?.output ?? 0, status: "skipped", duration_ms: 0, error: "model is no longer eligible" };
      completed++;
      onProgress?.(completed, total, results[i]);
    }
  }

  // Use minimum of requested concurrency and total models, but at least 1
  const effectiveConcurrency = Math.max(1, Math.min(concurrency, total));
  const workers = Array.from({ length: effectiveConcurrency }, () => worker());
  await Promise.all(workers);

  if (signal?.aborted) return { results: results.filter((result): result is ProbeResult => result !== undefined), path: outputPath, cancelled: true };
  if (!validateCompleteProbeReport(results, catalog)) return { results, path: outputPath };
  try {
    writeJsonFile(outputPath, results);
  } catch (err) {
    // Persistence is best-effort: a completed probe must still return its
    // results so callers record reliability outcomes and render the report.
    console.error(`[bifrost] failed to write probe results: ${err}`);
    return { results, path: outputPath };
  }
  return { results, path: outputPath };
}

async function probeOne(
  ctx: ExtensionContext,
  model: Model<Api>,
  promptWithSession: MinimalSessionPrompt,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ProbeResult> {
  const base: ProbeResult = {
    provider: model.provider,
    model: model.id,
    cost_input: model.cost?.input ?? 0,
    cost_output: model.cost?.output ?? 0,
    status: "skipped",
    duration_ms: 0,
  };

  const api = model.api as string | undefined;
  if (!api) {
    base.error = "unsupported api: undefined";
    return base;
  }

  const start = performance.now();
  if (signal?.aborted) return base;
  try {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const rejectOnAbort = (reject: (error: DOMException) => void) => {
      const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
      controller.signal.addEventListener("abort", onAbort, { once: true });
      return () => controller.signal.removeEventListener("abort", onAbort);
    };
    let removeAbortListener = () => {};
    try {
      const stream = ctx.modelRegistry.streamSimple(
        model,
        {
          messages: [{ role: "user", content: PROBE_PROMPT, timestamp: Date.now() }],
        },
        {
          maxTokens: PROBE_MAX_TOKENS,
          temperature: 0,
          signal: controller.signal,
          cacheRetention: "none",
        },
      );
      const response = await Promise.race([
        stream.result(),
        new Promise<never>((_, reject) => { removeAbortListener = rejectOnAbort(reject); }),
      ]);
      base.duration_ms = +(performance.now() - start).toFixed(1);
      if (response.stopReason === "error") {
        base.status = "error";
        base.error = response.errorMessage ?? "model error";
        return base;
      }
      const text = assistantText(response).trim();
      if (!text) {
        const fallbackText = await promptWithSession(model, PROBE_PROMPT, {
          cwd: ctx.cwd,
          systemPrompt: "You are a model probe. Reply with only the result.",
          signal: controller.signal,
        });
        if (controller.signal.aborted) {
          base.status = signal?.aborted ? "skipped" : "timeout";
          return base;
        }
        if (!fallbackText?.trim()) {
          base.status = "error";
          base.error = "empty response";
          return base;
        }
        base.status = "ok";
        base.transport = "session";
        return base;
      }
      base.transport = "streamSimple";
      base.status = "ok";
      base.tokens = response.usage.totalTokens;
    } finally {
      clearTimeout(timer);
      removeAbortListener();
      signal?.removeEventListener("abort", abort);
    }
  } catch (err) {
    base.duration_ms = +(performance.now() - start).toFixed(1);
    base.status = err instanceof DOMException && err.name === "AbortError"
      ? "timeout"
      : "error";
    base.error = String(err).slice(0, 200);
  }

  return base;
}
