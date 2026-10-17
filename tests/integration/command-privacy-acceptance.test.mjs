// G09 (P2) — Commands and artifact privacy matrix.
//
// This suite seeds synthetic prompt, secret, endpoint, and error canaries and
// inspects every artifact Bifrost writes (debug trace, classifier metrics,
// reliability state, runtime mode state, normalized prompt cache, probe
// report) against an explicit allowlist. It also exercises the two detailed
// classifier trace gates, classifier opt-out persistence, the probe abort
// path, and the user-facing classifier test/benchmark commands.
//
// Boundary: real pinned Pi processes (RPC) against the local fake provider.
// No live provider calls. The outbound guard proves no non-fixture network
// request. Every spawned process is the leader of a process group owned by
// this module; scratch is reclaimed only after each owned group is observed
// dead (see scenario/releaseScratch).
//
// The final case is a controlled fault proof: it mutates only the debug prompt
// projection in a private scratch copy of the tree and confirms the named
// redaction assertion turns RED, then proves the committed index.ts is
// unchanged. The production index.ts hash is never modified.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { processGroupExists, terminateProcessGroup } from "../../scripts/acceptance/core.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PI = join(ROOT, "node_modules", ".bin", "pi");
const EXTENSION = join(ROOT, "index.ts");
const FAKE_SERVER = join(ROOT, "scripts", "fake-provider-server.mjs");
const OUTBOUND_GUARD = join(ROOT, "scripts", "test-outbound-guard.cjs");

/** Production index.ts hash that the fault proof must leave byte-identical. */
const PRODUCTION_INDEX_SHA256 = "3164a3dbc41a864c68bede2f9e7365c5ed32bbbcd91fc584a3d07446014e3f12";

// ── synthetic canaries ──────────────────────────────────────────
// Distinct shapes so a leak is unambiguous, and words that survive cache
// normalization are separated so the normalized-cache contract can be checked.
const PROMPT_CANARY = "CANARY_PROMPT_alpaca_7f3d";
const SECRET_CANARY = "sk-CANARY_SECRET_9b2e";
const ENDPOINT_CANARY = "CANARY_ENDPOINT_4c1a";
const ERROR_CANARY = "CANARY_ERROR_5d8f";
const CANARIES = [PROMPT_CANARY, SECRET_CANARY, ENDPOINT_CANARY, ERROR_CANARY];
const CANARY_PROMPT = `${PROMPT_CANARY} implement a small routing helper and mention ${ERROR_CANARY}`;

/** Original-casing tokens that must never be written verbatim into any artifact. */
const RAW_LEAK_MARKERS = [...CANARIES];

// ── explicit debug-trace allowlist ──────────────────────────────
// Every top-level key any debug/measure record may carry. A new field must be
// added here deliberately after a privacy review; an unexpected key fails the
// allowlist assertion. `decision` is the one structured nested payload and is
// separately checked for sensitive content below.
const DEBUG_KEY_ALLOWLIST = new Set([
  "ts", "module", "event", "entryType", "duration_ms", "_meta_error",
  "run_correlation_id", "session_correlation_id", "turn_correlation_id",
  "pattern_run_id", "subagent_run_id",
  "extensionDir", "processId", "runtimeVersion", "routingMode", "reliabilityMode",
  "enabled", "pinned", "classifierEnabled", "reliabilityStateVersion",
  "routingEnabled", "budget_scope", "reason", "scope", "target", "action",
  "allowed", "claimed", "generation", "depth", "origin", "modelCount",
  "evidence", "issueCount", "exitCode", "stderrPresent", "streamingBehavior",
  "length", "outcome", "match", "hit", "entries", "model", "outputChars",
  "outputPresent", "provider", "status", "transport", "tier", "tiers",
  "trace_id", "runId", "kind", "source", "strategy", "skipped", "cacheHit",
  "classifierBackend", "classifierModel", "thinkingLevel", "fallback",
  "fallbackReason", "selectedTier", "decision", "request_correlation_id",
  "backend", "attribution", "category", "pool", "errorCategory", "agent",
  "command", "resultCount", "failedModels",
]);

// A sensitive channel is any key whose value could carry raw user/provider
// text. None may ever appear in the trace, even inside `decision`.
const SENSITIVE_KEYS = new Set([
  "prompt", "prompts", "message", "messages", "content", "response",
  "responseBody", "request", "requestBody", "body", "apiKey", "api_key",
  "authorization", "secret", "credentials", "endpoint", "url", "error",
  "errorText", "errorMessage", "stack", "criteria", "systemPrompt",
]);

let server;

// ── fake provider ───────────────────────────────────────────────

async function startFakeServer() {
  const child = spawn("node", [FAKE_SERVER], { stdio: ["ignore", "pipe", "ignore"], detached: true });
  let closed = false;
  const childClosed = new Promise((resolve) => child.once("close", () => { closed = true; resolve(); }));
  child.unref();
  try {
    const ready = await new Promise((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("fake provider startup timed out")), 10_000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        output += chunk;
        try { const record = JSON.parse(output); clearTimeout(timer); resolve(record); }
        catch { /* wait for the startup record */ }
      });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", () => { clearTimeout(timer); reject(new Error("fake provider exited before startup")); });
    });
    return {
      child,
      port: ready.port,
      async shutdown() {
        if (!closed) await Promise.race([childClosed, new Promise((r) => setTimeout(r, 500))]);
        if (!closed) {
          const terminated = await terminateProcessGroup(child, { graceMs: 1000, cleanupTimeoutMs: 2000 });
          assert.equal(terminated, true, "fake provider group must terminate");
          await Promise.race([childClosed, new Promise((r) => setTimeout(r, 2000))]);
        }
        assert.equal(closed, true, "fake provider must close before teardown completes");
        assert.equal(processGroupExists(child.pid), false, "fake provider group must be absent after close");
      },
    };
  } catch (error) {
    try { child.stdout.destroy(); } catch {}
    const terminated = await terminateProcessGroup(child, { graceMs: 1000, cleanupTimeoutMs: 2000 });
    await Promise.race([childClosed, new Promise((r) => setTimeout(r, 2000))]);
    assert.equal(terminated, true, "fake provider group must terminate on startup failure");
    assert.equal(processGroupExists(child.pid), false, "fake provider group must be absent after startup failure");
    throw error;
  }
}

async function stats() {
  const response = await fetch(`http://127.0.0.1:${server.port}/_stats`);
  assert.equal(response.ok, true);
  return response.json();
}

function attemptDelta(before, after, model) {
  return (after.attempts[model] ?? 0) - (before.attempts[model] ?? 0);
}

// ── fixture ─────────────────────────────────────────────────────

const FIXTURE_MODELS = ["chat", "classifier", "fail", "probe-slow", "probe-fast"];

function fixture({ config, models = FIXTURE_MODELS, extension = EXTENSION, apiKey = SECRET_CANARY } = {}) {
  const home = mkdtempSync(join(tmpdir(), "bifrost-privacy-home-"));
  const work = mkdtempSync(join(tmpdir(), "bifrost-privacy-work-"));
  const agent = join(home, ".pi", "agent");
  const project = join(work, ".pi");
  mkdirSync(agent, { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(home, "network-violations.log"), "");
  writeFileSync(join(agent, "models.json"), JSON.stringify({
    providers: {
      fake: {
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        api: "openai-completions",
        apiKey,
        models: models.map((id) => ({ id, reasoning: false, contextWindow: 8192, maxTokens: 512 })),
      },
    },
  }));
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ retry: { enabled: false }, enabledModels: ["fake/*"] }));
  writeFileSync(join(project, "bifrost.json"), JSON.stringify(config));
  return { home, work, project, agent, extension };
}

function piEnvironment(home, extension) {
  const base = Object.fromEntries(["PATH", "TMPDIR", "LANG", "TERM"]
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]));
  return {
    ...base,
    HOME: home,
    PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
    PI_SKIP_VERSION_CHECK: "1",
    PI_OFFLINE: "1",
    NODE_OPTIONS: `--require=${OUTBOUND_GUARD}`,
    BIFROST_TEST_ALLOWED_ORIGIN: `http://127.0.0.1:${server.port}`,
    BIFROST_TEST_NETWORK_VIOLATIONS: join(home, "network-violations.log"),
    BIFROST_TEST_EXTENSION_PATH: extension,
  };
}

// ── owned RPC session ───────────────────────────────────────────

function startRpc({ home, work, extension = EXTENSION }) {
  const child = spawn(PI, ["-e", extension, "--mode", "rpc", "--no-session", "--no-tools", "--model", "fake/chat"], {
    cwd: work,
    stdio: ["pipe", "pipe", "pipe"],
    env: piEnvironment(home, extension),
    detached: true,
  });
  const records = [];
  let incompleteLine = "";
  let stderr = "";
  let wake;
  let closePromise;
  let closeInfo;
  let spawnError;
  const childClosed = new Promise((resolve) => child.once("close", (code, signal) => {
    closeInfo = { code, signal };
    wake?.();
    resolve(closeInfo);
  }));
  child.once("error", (error) => { spawnError = error; wake?.(); });
  child.stdin.on("error", (error) => { spawnError ??= error; wake?.(); });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    const lines = `${incompleteLine}${chunk}`.split("\n");
    incompleteLine = lines.pop();
    for (const line of lines) {
      try { records.push(JSON.parse(line)); }
      catch { /* malformed output remains a protocol assertion failure */ }
    }
    wake?.();
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; wake?.(); });

  function waitForActivity(deadline) {
    const remaining = Math.max(0, deadline - Date.now());
    return new Promise((resolve) => {
      let timer;
      const finish = () => { clearTimeout(timer); if (wake === finish) wake = undefined; resolve(); };
      wake = finish;
      timer = setTimeout(finish, remaining);
    });
  }

  async function prompt(message, timeoutMs = 30_000) {
    const id = `privacy-${records.length}-${Date.now()}`;
    const startIndex = records.length;
    const stderrStart = stderr.length;
    const deadline = Date.now() + timeoutMs;
    child.stdin.write(`${JSON.stringify({ id, type: "prompt", message })}\n`);
    let index = startIndex;
    while (Date.now() < deadline) {
      while (index < records.length) {
        const record = records[index++];
        if (record.type === "extension_ui_request" && record.method === "confirm") {
          child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: record.id, confirmed: true })}\n`);
        } else if (record.id === id && record.type === "response") {
          assert.equal(record.success, true, JSON.stringify(record));
          return { response: record, stderr: stderr.slice(stderrStart), startIndex };
        }
      }
      assert.ifError(spawnError);
      if (closeInfo) throw new Error(`Pi RPC exited before responding: ${message}`);
      await waitForActivity(deadline);
    }
    throw new Error(`Pi RPC timed out on ${message}`);
  }

  async function userTurn(message, timeoutMs = 30_000) {
    const accepted = await prompt(message, timeoutMs);
    if (accepted.response.data?.disposition !== "started") return accepted;
    const deadline = Date.now() + timeoutMs;
    let index = accepted.startIndex;
    while (Date.now() < deadline) {
      while (index < records.length) {
        const record = records[index++];
        if (record.type === "agent_settled") return accepted;
      }
      assert.ifError(spawnError);
      if (closeInfo) throw new Error(`Pi RPC exited before settling: ${message}`);
      await waitForActivity(deadline);
    }
    throw new Error(`Pi RPC turn did not settle: ${message}`);
  }

  function close(home) {
    closePromise ??= (async () => {
      try { child.stdin.end(); } catch {}
      await Promise.race([childClosed, new Promise((resolve) => setTimeout(resolve, 2_000))]);
      if (!closeInfo) {
        const terminated = await terminateProcessGroup(child, { graceMs: 1_000, cleanupTimeoutMs: 2_000 });
        await Promise.race([childClosed, new Promise((resolve) => setTimeout(resolve, 2_000))]);
        try { child.stdout.destroy(); } catch {}
        try { child.stderr.destroy(); } catch {}
        try { child.unref(); } catch {}
        if (!terminated) return { closed: Boolean(closeInfo), groupGone: !processGroupExists(child.pid) };
      }
      try { child.stdout.destroy(); } catch {}
      try { child.stderr.destroy(); } catch {}
      try { child.unref(); } catch {}
      return { closed: Boolean(closeInfo), groupGone: !processGroupExists(child.pid), code: closeInfo?.code, signal: closeInfo?.signal };
    })();
    return closePromise.then((result) => {
      let violations;
      try { violations = readFileSync(join(home, "network-violations.log"), "utf8"); }
      catch (error) {
        if (error.code === "ENOENT") throw new Error("network-violations log is missing");
        throw error;
      }
      if (/blocked|network.?violation|violation/i.test(stderr)) {
        throw new Error(`blocked request observed in captured stderr: ${stderr.trim()}`);
      }
      return { ...result, violations };
    });
  }

  return { prompt, userTurn, close };
}

/** Owns scratch removal; reclaims only after every owned group is observed dead. */
async function releaseScratch(env, sessions) {
  const failures = [];
  const receipts = [];
  for (const session of sessions) {
    if (!session) continue;
    let receipt;
    try { receipt = await session.close(env.home); }
    catch (error) { failures.push(error); continue; }
    receipts.push(receipt);
    if (!receipt.closed) failures.push(new Error("owned RPC session did not close"));
    if (!receipt.groupGone) failures.push(new Error("owned RPC process group still present"));
    if (receipt.violations !== "") failures.push(new Error(`network violations observed: ${receipt.violations}`));
  }
  if (failures.length > 0) return { removed: false, failures, receipts, retained: [env.home, env.work] };
  rmSync(env.home, { recursive: true, force: true });
  rmSync(env.work, { recursive: true, force: true });
  return { removed: !existsSync(env.home) && !existsSync(env.work), failures, receipts, retained: [] };
}

async function scenario(run) {
  const env = fixture(run.fixtureOptions ?? {});
  const sessions = [];
  let bodyError;
  try { await run.body({ env, sessions }); }
  catch (error) { bodyError = error; }
  const released = await releaseScratch(env, sessions);
  if (!released.removed || released.failures.length > 0) {
    const cleanup = new Error(`privacy scratch retained at ${released.retained.join(", ")}: ${released.failures.map((f) => f.message).join("; ")}`);
    if (bodyError) { cleanup.cause = bodyError; throw cleanup; }
    throw cleanup;
  }
  if (bodyError) throw bodyError;
  return released;
}

// ── artifact helpers ────────────────────────────────────────────

function artifact(project, name) {
  const path = join(project, name);
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

function assertNoCanaries(text, label) {
  assert.equal(typeof text, "string", `${label}: artifact must exist`);
  for (const marker of RAW_LEAK_MARKERS) {
    assert.equal(text.includes(marker), false, `${label} must not contain canary ${marker}`);
  }
}

function debugRows(project) {
  const raw = artifact(project, "bifrost-debug.jsonl");
  if (raw === undefined) return [];
  return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Sensitive keys carrying raw text. A key like probe's numeric `error` count is
 * permitted; a non-empty string under a sensitive key is a leak.
 */
function sensitiveStringKeys(row) {
  return Object.keys(row).filter((key) => SENSITIVE_KEYS.has(key) && typeof row[key] === "string" && row[key].length > 0);
}

/** Mirrors cache.ts normalize: lowercased, punctuation-flattened, sorted tokens. */
function normalize(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").split(" ").filter(Boolean).sort().join(" ");
}

// ── named redaction assertion (shared by the live case and its fault control) ──

/**
 * Run one real Pi turn with debug tracing enabled and assert the debug prompt
 * projection stays content-free. Returns the raw debug text so the caller can
 * make broader claims. The exact named assertion below is what the fault
 * control must break.
 */
async function debugProjectionScenario(extension) {
  let raw = "";
  await scenario({
    fixtureOptions: {
      extension,
      config: {
        enabled: true,
        default: "general",
        strategy: "first",
        classifier: { enabled: false },
        models: { general: ["fake/chat"] },
        debug: { enabled: true },
      },
    },
    body: async ({ env, sessions }) => {
      const rpc = startRpc({ home: env.home, work: env.work, extension });
      sessions.push(rpc);
      await rpc.userTurn(CANARY_PROMPT);
      // Close inside the body so Pi's exit flush completes before the artifact
      // is read; scenario cleanup stays idempotent for the same session.
      await rpc.close(env.home);
      raw = artifact(env.project, "bifrost-debug.jsonl") ?? "";
    },
  });
  assert.notEqual(raw, "", "debug artifact must be written");
  const promptRows = debugRowsFrom(raw).filter((row) => row.module === "input" && row.event === "prompt");
  assert.equal(promptRows.length, 1, `exactly one debug prompt record; trace was:\n${raw}`);
  assert.deepEqual(
    Object.keys(promptRows[0]).sort(),
    ["entryType", "event", "length", "module", "ts"],
    "debug prompt projection must stay content-free",
  );
  assertNoCanaries(raw, "debug trace");
  return raw;
}

function debugRowsFrom(raw) {
  return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

// ── scenarios ───────────────────────────────────────────────────

describe("command and artifact privacy acceptance", { timeout: 600_000, concurrency: 1 }, () => {
  before(async () => { server = await startFakeServer(); });
  after(async () => { await server?.shutdown(); });

  it("keeps the debug trace inside an explicit key allowlist and free of canaries", async () => {
    await scenario({
      fixtureOptions: {
        config: {
          enabled: true,
          default: "general",
          strategy: "first",
          classifier: {
            enabled: true,
            backend: "prompt",
            model: "fake/classifier",
            // Endpoint canary: a same-origin path that resolves to a 404. The
            // classifier must record the status without persisting the URL.
            endpoint: `http://127.0.0.1:${server.port}/v1/${ENDPOINT_CANARY}`,
          },
          models: { general: ["fake/chat"] },
          debug: { enabled: true },
        },
      },
      body: async ({ env, sessions }) => {
        const rpc = startRpc({ home: env.home, work: env.work });
        sessions.push(rpc);
        await rpc.userTurn(CANARY_PROMPT);
        await rpc.close(env.home);
        const raw = artifact(env.project, "bifrost-debug.jsonl");
        assertNoCanaries(raw, "debug trace");
        const rows = debugRowsFrom(raw);
        assert.ok(rows.length > 0, "debug trace must contain events");
        for (const row of rows) {
          for (const key of Object.keys(row)) {
            assert.equal(DEBUG_KEY_ALLOWLIST.has(key), true, `debug key outside allowlist: ${key} (${row.module}/${row.event})`);
          }
          assert.deepEqual(sensitiveStringKeys(row), [], `sensitive string channel persisted (${row.module}/${row.event})`);
        }
        const promptRows = rows.filter((row) => row.module === "input" && row.event === "prompt");
        assert.equal(promptRows.length, 1);
        assert.equal(promptRows[0].length, CANARY_PROMPT.length);
        assert.equal(Object.keys(promptRows[0]).includes("prompt"), false, "prompt text must never be a debug field");
      },
    });
  });

  it("writes a content-free classifier metrics artifact with no canaries", async () => {
    await scenario({
      fixtureOptions: {
        config: {
          enabled: true,
          default: "general",
          strategy: "first",
          classifier: { enabled: true, backend: "pi-native", piNative: { model: "fake/classifier" } },
          models: { general: ["fake/chat"] },
          debug: { enabled: true },
        },
      },
      body: async ({ env, sessions }) => {
        const rpc = startRpc({ home: env.home, work: env.work });
        sessions.push(rpc);
        await rpc.userTurn(CANARY_PROMPT);
        await rpc.close(env.home);
        const raw = artifact(env.project, "bifrost-classifier-metrics.json");
        assertNoCanaries(raw, "classifier metrics artifact");
        const state = JSON.parse(raw);
        assert.deepEqual(
          Object.keys(state).sort(),
          ["confidenceBands", "latencyBuckets", "lastObservedAt", "model", "outcomes", "tiers", "total", "totalAttempts", "totalLatencyMs", "version"].sort(),
          "metrics artifact must hold only the declared aggregate contract fields",
        );
        assert.equal(typeof state.model, "string");
        assert.equal(JSON.stringify(state).includes("prompt"), false, "metrics must not persist prompt state");
      },
    });
  });

  it("persists reliability and runtime state without prompt, secret, or error canaries", async () => {
    await scenario({
      fixtureOptions: {
        config: {
          enabled: true,
          default: "general",
          strategy: "first",
          classifier: { enabled: true, backend: "prompt", model: "fake/classifier" },
          models: { general: ["fake/fail"] },
          reliability: { enabled: true },
          debug: { enabled: true },
        },
      },
      body: async ({ env, sessions }) => {
        const rpc = startRpc({ home: env.home, work: env.work });
        sessions.push(rpc);
        // Opt out of the classifier: persist that preference to runtime state.
        const off = await rpc.prompt("/bifrost classifier off");
        assert.equal(off.response.data?.disposition, "handled");
        await rpc.userTurn(CANARY_PROMPT);
        await rpc.close(env.home);
        const reliability = artifact(env.project, "bifrost-reliability.json");
        assertNoCanaries(reliability, "reliability artifact");
        assertNoCanaries(artifact(env.project, "bifrost-provider-reliability.json") ?? "", "provider reliability artifact");
        const runtime = artifact(env.project, "bifrost-state.json");
        assertNoCanaries(runtime, "runtime mode state");
        assert.deepEqual(Object.keys(JSON.parse(runtime)).sort(), ["classifierEnabled", "enabled"], "runtime state must hold only mode booleans");
        assert.equal(JSON.parse(runtime).classifierEnabled, false);
      },
    });
  });

  it("persists the classifier opt-out across restart and suppresses classifier dispatch", async () => {
    await scenario({
      fixtureOptions: {
        config: {
          enabled: true,
          default: "general",
          strategy: "first",
          classifier: { enabled: true, backend: "prompt", model: "fake/classifier" },
          models: { general: ["fake/chat"] },
        },
      },
      body: async ({ env, sessions }) => {
        const first = startRpc({ home: env.home, work: env.work });
        sessions.push(first);
        const before = await stats();
        await first.userTurn(CANARY_PROMPT);
        const after = await stats();
        assert.equal(attemptDelta(before, after, "classifier"), 1, "classifier runs before opt-out");
        assert.equal(attemptDelta(before, after, "chat"), 1, "generation runs before opt-out");
        const off = await first.prompt("/bifrost classifier off");
        assert.equal(off.response.data?.disposition, "handled");
        const closed = await first.close(env.home);
        assert.equal(closed.closed, true);
        assert.equal(closed.groupGone, true);

        const beforeRestart = await stats();
        const second = startRpc({ home: env.home, work: env.work });
        sessions.push(second);
        await second.userTurn(CANARY_PROMPT);
        const afterRestart = await stats();
        assert.equal(attemptDelta(beforeRestart, afterRestart, "classifier"), 0, "persisted opt-out must survive restart");
        assert.equal(attemptDelta(beforeRestart, afterRestart, "chat"), 1, "generation continues while classifier is off");
      },
    });
  });

  it("stores normalized prompt words in the cache without the original prompt or secret canary", async () => {
    await scenario({
      fixtureOptions: {
        config: {
          enabled: true,
          default: "general",
          strategy: "first",
          classifier: { enabled: true, backend: "prompt", model: "fake/classifier" },
          models: { general: ["fake/chat"] },
          cache: { enabled: true, maxEntries: 50, threshold: 0.85, ttlHours: 720 },
          debug: { enabled: true },
        },
      },
      body: async ({ env, sessions }) => {
        const rpc = startRpc({ home: env.home, work: env.work });
        sessions.push(rpc);
        await rpc.userTurn(CANARY_PROMPT);
        await rpc.close(env.home);
        const raw = artifact(env.project, "bifrost-cache.jsonl");
        assert.equal(typeof raw, "string", "normalized cache artifact must exist");
        // The normalized contract persists lowercased, sorted word tokens; the
        // original casing, punctuation, secret, and endpoint canaries must not
        // survive. The error canary's words normalize into the allowlisted token
        // stream and are asserted, not forbidden.
        assert.equal(raw.includes(PROMPT_CANARY), false, "cache must not persist original prompt casing");
        for (const marker of [SECRET_CANARY, ENDPOINT_CANARY, ERROR_CANARY]) {
          assert.equal(raw.includes(marker), false, `cache must not persist ${marker}`);
        }
        const [entry] = raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
        assert.equal(entry.normalized, normalize(CANARY_PROMPT), "cache must persist only normalized prompt words");
        assert.deepEqual(
          Object.keys(entry).sort(),
          ["category", "hits", "lastUsed", "normalized", "semanticKey", "seq"],
          "cache entry must hold only the declared contract fields",
        );
        assert.doesNotMatch(raw, /"response"|"content"|"messages"/u, "cache must not persist response payloads");
      },
    });
  });

  it("writes a content-free completed probe report and saves nothing on abort", async () => {
    // (a) Real Pi RPC probe over fast fixture models: the report is written and
    // carries only the declared probe fields, with no canaries.
    await scenario({
      fixtureOptions: {
        config: {
          enabled: true,
          default: "general",
          strategy: "first",
          classifier: { enabled: false },
          models: { general: ["fake/chat"] },
          probe: { timeoutMs: 15_000, concurrency: 2 },
          debug: { enabled: true },
        },
        models: ["chat", "probe-fast"],
      },
      body: async ({ env, sessions }) => {
        const rpc = startRpc({ home: env.home, work: env.work });
        sessions.push(rpc);
        const probed = await rpc.prompt("/bifrost probe");
        assert.equal(probed.response.data?.disposition, "handled");
        await rpc.close(env.home);
        const raw = artifact(env.project, "bifrost-probe.json");
        assertNoCanaries(raw, "probe report");
        const report = JSON.parse(raw);
        assert.equal(Array.isArray(report), true, "probe report must be an array of results");
        const allowed = new Set(["provider", "model", "cost_input", "cost_output", "status", "duration_ms", "transport", "error", "tokens"]);
        for (const row of report) {
          for (const key of Object.keys(row)) assert.equal(allowed.has(key), true, `probe field outside allowlist: ${key}`);
        }
        assertNoCanaries(artifact(env.project, "bifrost-debug.jsonl"), "probe debug trace");
      },
    });

    // (b) Deterministic abort boundary (unit-level, matching tests/probe.test.ts):
    // an aborted run saves no report and records a cancelled completion with no
    // canaries or sensitive keys.
    const { runProbe } = await import("../../probe.ts");
    const { setupDebug, flushDebug } = await import("../../debug.ts");
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-privacy-probe-abort-"));
    const previousCwd = process.cwd();
    const controller = new AbortController();
    try {
      process.chdir(cwd);
      setupDebug({ enabled: true, path: join(cwd, "probe-debug.jsonl") }, cwd);
      const models = [
        { provider: "fake", id: "held-one", api: "openai-completions" },
        { provider: "fake", id: "held-two", api: "openai-completions" },
      ];
      const ctx = { modelRegistry: { getAvailable: () => models, streamSimple: () => ({ result: () => new Promise(() => {}) }) } };
      const pending = runProbe(ctx, { concurrency: 1, signal: controller.signal });
      await new Promise((resolve) => setTimeout(resolve, 25));
      controller.abort();
      const result = await pending;
      await flushDebug(1_000);
      assert.equal(result.cancelled, true, "aborted probe must report cancellation");
      assert.equal(existsSync(join(cwd, ".pi", "bifrost-probe.json")), false, "aborted probe must save no partial report");
      const rows = readFileSync(join(cwd, "probe-debug.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
      const complete = rows.find((row) => row.event === "complete");
      assert.equal(complete?.cancelled, true, "probe abort must record a cancelled completion");
      assert.equal(rows.some((row) => sensitiveStringKeys(row).length > 0), false, "probe abort trace must not carry sensitive string channels");
      assertNoCanaries(JSON.stringify(rows), "probe abort trace");
    } finally {
      setupDebug({ enabled: false, path: join(cwd, "probe-debug.jsonl") }, cwd);
      process.chdir(previousCwd);
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("gates the pi-native detailed trace on global debug and the typesafe trace on both gates", async () => {
    // pi-native: only the global debug.enabled gate.
    await scenario({
      fixtureOptions: {
        config: {
          enabled: true, default: "general", strategy: "first",
          classifier: { enabled: true, backend: "pi-native", piNative: { model: "fake/classifier" } },
          models: { general: ["fake/chat"] }, debug: { enabled: true },
        },
      },
      body: async ({ env, sessions }) => {
        const rpc = startRpc({ home: env.home, work: env.work });
        sessions.push(rpc);
        await rpc.userTurn(CANARY_PROMPT);
        await rpc.close(env.home);
        const rows = debugRows(env.project);
        assert.ok(rows.some((row) => row.module === "pi-native" && row.event === "start"), "pi-native trace must appear when global debug is on");
        assert.equal(rows.some((row) => sensitiveStringKeys(row).length > 0), false, "pi-native trace must not carry sensitive string channels");
      },
    });
    // pi-native: global debug off -> no trace at all.
    await scenario({
      fixtureOptions: {
        config: {
          enabled: true, default: "general", strategy: "first",
          classifier: { enabled: true, backend: "pi-native", piNative: { model: "fake/classifier" } },
          models: { general: ["fake/chat"] }, debug: { enabled: false },
        },
      },
      body: async ({ env, sessions }) => {
        const rpc = startRpc({ home: env.home, work: env.work });
        sessions.push(rpc);
        await rpc.userTurn(CANARY_PROMPT);
        await rpc.close(env.home);
        assert.equal(existsSync(join(env.project, "bifrost-debug.jsonl")), false, "disabled debug must write no trace artifact");
      },
    });
    // typesafe: global on but typesafe.debug off -> no typesafe rows.
    await scenario({
      fixtureOptions: {
        config: {
          enabled: true, default: "general", strategy: "first",
          classifier: { enabled: true, backend: "typesafe", typesafe: {} },
          models: { general: ["fake/chat"] }, debug: { enabled: true },
        },
      },
      body: async ({ env, sessions }) => {
        const rpc = startRpc({ home: env.home, work: env.work });
        sessions.push(rpc);
        await rpc.userTurn(CANARY_PROMPT);
        await rpc.close(env.home);
        const rows = debugRows(env.project);
        assert.equal(rows.some((row) => row.module === "typesafe"), false, "typesafe trace must stay off without typesafe.debug");
      },
    });
    // typesafe: both gates on -> trace rows appear and carry only allowlisted keys.
    await scenario({
      fixtureOptions: {
        config: {
          enabled: true, default: "general", strategy: "first",
          classifier: { enabled: true, backend: "typesafe", typesafe: { debug: true } },
          models: { general: ["fake/chat"] }, debug: { enabled: true },
        },
      },
      body: async ({ env, sessions }) => {
        const rpc = startRpc({ home: env.home, work: env.work });
        sessions.push(rpc);
        await rpc.userTurn(CANARY_PROMPT);
        await rpc.close(env.home);
        const rows = debugRows(env.project);
        const typesafe = rows.filter((row) => row.module === "typesafe");
        assert.ok(typesafe.some((row) => row.event === "start"), "typesafe trace must appear when both gates are on");
        for (const row of typesafe) {
          assert.equal(sensitiveStringKeys(row).length, 0, "typesafe trace must not carry sensitive string channels");
        }
        assertNoCanaries(artifact(env.project, "bifrost-debug.jsonl"), "typesafe debug trace");
      },
    });
  });

  it("runs the classifier test and benchmark commands without leaking canaries into artifacts", async () => {
    await scenario({
      fixtureOptions: {
        config: {
          enabled: true,
          default: "general",
          strategy: "first",
          classifier: { enabled: true, backend: "prompt", model: "fake/classifier" },
          models: { general: ["fake/chat"] },
          debug: { enabled: true },
        },
      },
      body: async ({ env, sessions }) => {
        const rpc = startRpc({ home: env.home, work: env.work });
        sessions.push(rpc);
        const tested = await rpc.prompt("/bifrost classifier test");
        assert.equal(tested.response.data?.disposition, "handled");
        const benchmarked = await rpc.prompt(`/bifrost benchmark ${CANARY_PROMPT}`);
        assert.equal(benchmarked.response.data?.disposition, "handled");
        await rpc.close(env.home);
        // The command output may echo the prompt to the user, but no persisted
        // artifact may contain any canary.
        for (const name of ["bifrost-debug.jsonl", "bifrost-classifier-metrics.json", "bifrost-reliability.json", "bifrost-state.json"]) {
          const text = artifact(env.project, name);
          if (text !== undefined) assertNoCanaries(text, name);
        }
      },
    });
  });

  it("fault control: leaking the prompt projection turns the named redaction assertion RED", async () => {
    const sourcePath = join(ROOT, "index.ts");
    const original = readFileSync(sourcePath, "utf8");
    assert.equal(sha256(original), PRODUCTION_INDEX_SHA256, "production index.ts must match the recorded baseline before the proof");
    const anchor = 'debug("input", "prompt", { length: promptText.length });';
    assert.ok(original.includes(anchor), "debug prompt projection anchor must exist");
    const mutated = original.replace(anchor, 'debug("input", "prompt", { length: promptText.length, prompt: promptText });');
    assert.notEqual(mutated, original, "debug projection mutation must apply");
    assert.notEqual(sha256(mutated), PRODUCTION_INDEX_SHA256, "mutation must be a real source change");

    const scratch = mkdtempSync(join(tmpdir(), "bifrost-privacy-fault-"));
    try {
      for (const entry of readdirSync(ROOT)) {
        if (entry.endsWith(".ts") || ["schema.json", "package.json"].includes(entry)) {
          copyFileSync(join(ROOT, entry), join(scratch, entry));
        }
      }
      symlinkSync(join(ROOT, "node_modules"), join(scratch, "node_modules"));
      writeFileSync(join(scratch, "index.ts"), mutated);

      // RED: the mutated private copy must fail the named assertion, not a
      // startup or syntax error.
      const redError = await debugProjectionScenario(join(scratch, "index.ts")).then(
        () => undefined,
        (error) => error,
      );
      assert.ok(redError, "mutated prompt projection must fail the redaction assertion");
      assert.match(String(redError.message), /debug prompt projection must stay content-free/u, "mutation must fail the named assertion");
      assert.equal(redError.name, "AssertionError", "mutation must fail by assertion, not by startup or runtime error");
      assert.equal(sha256(readFileSync(join(scratch, "index.ts"), "utf8")), sha256(mutated), "mutated copy must stay mutated");

      // GREEN + restore: the committed source is untouched and still passes.
      assert.equal(sha256(readFileSync(sourcePath, "utf8")), PRODUCTION_INDEX_SHA256, "production source must be unchanged after the proof");
      await debugProjectionScenario(sourcePath);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
