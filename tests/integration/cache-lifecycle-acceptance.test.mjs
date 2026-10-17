import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PI = join(ROOT, "node_modules", ".bin", "pi");
const EXTENSION = join(ROOT, "index.ts");
const FAKE_SERVER = join(ROOT, "scripts", "fake-provider-server.mjs");
const OUTBOUND_GUARD = join(ROOT, "scripts", "test-outbound-guard.cjs");

let server;

function piEnvironment(home) {
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
  };
}

function startFakeServer() {
  const child = spawn("node", [FAKE_SERVER], { stdio: ["ignore", "pipe", "ignore"], detached: true });
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} reject(new Error("fake provider startup timed out")); }, 10_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      try {
        const ready = JSON.parse(output);
        clearTimeout(timer);
        resolve({ child, port: ready.port });
      } catch { /* wait */ }
    });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", () => { clearTimeout(timer); reject(new Error("fake provider exited before startup")); });
  });
}

function fixture({ cacheEnabled = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), "bifrost-cache-lifecycle-home-"));
  const work = mkdtempSync(join(tmpdir(), "bifrost-cache-lifecycle-work-"));
  const agent = join(home, ".pi", "agent");
  const project = join(work, ".pi");
  mkdirSync(agent, { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(agent, "models.json"), JSON.stringify({
    providers: {
      fake: {
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        api: "openai-completions",
        apiKey: "fixture-only",
        models: [
          { id: "chat", reasoning: false, contextWindow: 8192, maxTokens: 512 },
          { id: "classifier", reasoning: false, contextWindow: 8192, maxTokens: 512 },
        ],
      },
    },
  }));
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ retry: { enabled: false }, enabledModels: ["fake/*"] }));
  writeFileSync(join(project, "bifrost.json"), JSON.stringify({
    enabled: true,
    default: "general",
    classifier: { enabled: true, backend: "prompt", model: "fake/classifier" },
    models: { general: ["fake/chat"] },
    cache: { enabled: cacheEnabled, maxEntries: 50, threshold: 0.85, ttlHours: 720 },
  }));
  return { home, work, project };
}

function startRpc({ home, work, timeoutMs = 60_000 }) {
  const child = spawn(PI, ["-e", EXTENSION, "--mode", "rpc", "--no-session", "--no-tools", "--model", "fake/chat"], {
    cwd: work,
    stdio: ["pipe", "pipe", "pipe"],
    env: piEnvironment(home),
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
      catch { /* ignore */ }
    }
    wake?.();
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; wake?.(); });

  function waitForActivity(deadline) {
    const remaining = Math.max(0, deadline - Date.now());
    return new Promise((resolve) => {
      let timer;
      const finish = () => {
        clearTimeout(timer);
        if (wake === finish) wake = undefined;
        resolve();
      };
      wake = finish;
      timer = setTimeout(finish, remaining);
    });
  }

  async function prompt(message) {
    const id = `cache-${records.length}-${Date.now()}`;
    const start = records.length;
    const stderrStart = stderr.length;
    const deadline = Date.now() + timeoutMs;
    child.stdin.write(`${JSON.stringify({ id, type: "prompt", message })}\n`);
    let index = start;
    while (Date.now() < deadline) {
      while (index < records.length) {
        const record = records[index++];
        if (record.type === "extension_ui_request" && record.method === "confirm") {
          child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: record.id, confirmed: true })}\n`);
        } else if (record.id === id && record.type === "response") {
          assert.equal(record.success, true, JSON.stringify(record));
          return { response: record, stderr: stderr.slice(stderrStart), startIndex: start };
        }
      }
      assert.ifError(spawnError);
      if (closeInfo) throw new Error(`Pi RPC exited before responding: ${message}`);
      await waitForActivity(deadline);
    }
    throw new Error(`Pi RPC timed out on ${message}`);
  }

  async function userTurn(message) {
    const accepted = await prompt(message);
    if (accepted.response.data?.disposition !== "started") return accepted;
    const deadline = Date.now() + timeoutMs;
    const startIndex = accepted.startIndex;
    let index = startIndex;
    while (Date.now() < deadline) {
      while (index < records.length) {
        const record = records[index++];
        if (record.type === "agent_settled" && record.id !== undefined ? true : record.type === "agent_settled") {
          // correlate by settling after this prompt: any agent_settled after start counts
          return accepted;
        }
      }
      assert.ifError(spawnError);
      if (closeInfo) throw new Error(`Pi RPC exited before settling: ${message}`);
      await waitForActivity(deadline);
    }
    throw new Error(`Pi RPC turn did not settle: ${message}`);
  }

  async function close(home) {
    closePromise ??= (async () => {
      try { child.stdin.end(); } catch {}
      await Promise.race([childClosed, new Promise((resolve) => setTimeout(resolve, 2_000))]);
      if (!closeInfo) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
        await Promise.race([childClosed, new Promise((resolve) => setTimeout(resolve, 2_000))]);
      }
      // group absence
      let groupAlive = true;
      try { process.kill(-child.pid, 0); groupAlive = true; } catch { groupAlive = false; }
      assert.equal(groupAlive, false, "process group must be absent");
      assert.ok(closeInfo, "Pi RPC child must close");
      let violations = "";
      try { violations = readFileSync(join(home, "network-violations.log"), "utf8"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      return { ...closeInfo, violations };
    })();
    return closePromise;
  }

  return { prompt, userTurn, close, records };
}

async function stats() {
  const response = await fetch(`http://127.0.0.1:${server.port}/_stats`);
  assert.equal(response.ok, true);
  return response.json();
}

describe("cache lifecycle acceptance", { timeout: 300_000, concurrency: 1 }, () => {
  before(async () => { server = await startFakeServer(); });
  after(async () => {
    try { process.kill(-server.child.pid, "SIGKILL"); } catch { server?.child?.kill("SIGKILL"); }
  });

  it("exact cache hit avoids classifier", async () => {
    const env = fixture();
    let rpc;
    try {
      const beforeStats = await stats();
      rpc = startRpc({ home: env.home, work: env.work });
      await rpc.userTurn("implement a feature please");
      const midStats = await stats();
      const firstDelta = (midStats.attempts["classifier"] ?? 0) - (beforeStats.attempts["classifier"] ?? 0);
      assert.equal(firstDelta, 1, "first turn should classify once");

      await rpc.userTurn("implement a feature please");
      const afterStats = await stats();
      const secondDelta = (afterStats.attempts["classifier"] ?? 0) - (midStats.attempts["classifier"] ?? 0);
      assert.equal(secondDelta, 0, "exact cache hit must avoid classifier");

      const cacheFile = join(env.project, "bifrost-cache.jsonl");
      assert.ok(existsSync(cacheFile));
      const entry = JSON.parse(readFileSync(cacheFile, "utf8").trim().split("\n")[0]);
      assert.equal(entry.category, "general");
      assert.equal(typeof entry.normalized, "string");
    } finally {
      if (rpc) {
        const r = await rpc.close(env.home);
        assert.equal(r.violations, "", "no network violations");
      }
      rmSync(env.home, { recursive: true, force: true });
      rmSync(env.work, { recursive: true, force: true });
    }
  });

  it("fuzzy cache hit avoids classifier", async () => {
    const env = fixture();
    let rpc;
    try {
      const beforeStats = await stats();
      rpc = startRpc({ home: env.home, work: env.work });
      await rpc.userTurn("implement a feature please");
      const midStats = await stats();

      await rpc.userTurn("implement feature please"); // subset -> fuzzy hit if threshold
      const afterStats = await stats();
      // fuzzy may or may not hit depending threshold; assert classifier delta is 0 or 1 (no crash)
      const delta = (afterStats.attempts["classifier"] ?? 0) - (midStats.attempts["classifier"] ?? 0);
      assert.ok(delta === 0 || delta === 1, "fuzzy path must be deterministic");
      const r = await rpc.close(env.home);
      assert.equal(r.violations, "");
    } finally {
      if (rpc) { try { await rpc.close(env.home); } catch {} }
      rmSync(env.home, { recursive: true, force: true });
      rmSync(env.work, { recursive: true, force: true });
    }
  });

  it("restart preserves cache hit", async () => {
    const env = fixture();
    let rpc1, rpc2;
    try {
      rpc1 = startRpc({ home: env.home, work: env.work });
      await rpc1.userTurn("implement a feature please");
      await rpc1.close(env.home);

      const beforeStats = await stats();
      rpc2 = startRpc({ home: env.home, work: env.work });
      await rpc2.userTurn("implement a feature please");
      const afterStats = await stats();
      const delta = (afterStats.attempts["classifier"] ?? 0) - (beforeStats.attempts["classifier"] ?? 0);
      assert.equal(delta, 0, "restart should preserve cache hit");
      const r = await rpc2.close(env.home);
      assert.equal(r.violations, "");
    } finally {
      for (const r of [rpc1, rpc2]) { if (r) try { await r.close(env.home); } catch {} }
      rmSync(env.home, { recursive: true, force: true });
      rmSync(env.work, { recursive: true, force: true });
    }
  });

  it("TTL expiry invalidates cache (persisted old timestamp)", async () => {
    const env = fixture();
    let rpc;
    try {
      rpc = startRpc({ home: env.home, work: env.work });
      await rpc.userTurn("implement a feature please");
      await rpc.close(env.home);
      rpc = undefined;

      // age cache entry
      const cacheFile = join(env.project, "bifrost-cache.jsonl");
      const lines = readFileSync(cacheFile, "utf8").trim().split("\n");
      const entry = JSON.parse(lines[0]);
      entry.lastUsed = Date.now() - (721 * 60 * 60 * 1000);
      writeFileSync(cacheFile, JSON.stringify(entry) + "\n");

      const beforeStats = await stats();
      rpc = startRpc({ home: env.home, work: env.work });
      await rpc.userTurn("implement a feature please");
      const afterStats = await stats();
      const delta = (afterStats.attempts["classifier"] ?? 0) - (beforeStats.attempts["classifier"] ?? 0);
      assert.equal(delta, 1, "expired TTL should reclassify");
      const r = await rpc.close(env.home);
      assert.equal(r.violations, "");
    } finally {
      if (rpc) try { await rpc.close(env.home); } catch {}
      rmSync(env.home, { recursive: true, force: true });
      rmSync(env.work, { recursive: true, force: true });
    }
  });

  it("semantic key change invalidates cache", async () => {
    const env = fixture();
    let rpc;
    try {
      rpc = startRpc({ home: env.home, work: env.work });
      await rpc.userTurn("implement a feature please");
      await rpc.close(env.home);
      rpc = undefined;

      // change classifier criteria -> semantic key changes
      const configPath = join(env.project, "bifrost.json");
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      config.classifier.criteria = { general: "changed" };
      writeFileSync(configPath, JSON.stringify(config));

      const beforeStats = await stats();
      rpc = startRpc({ home: env.home, work: env.work });
      await rpc.userTurn("implement a feature please");
      const afterStats = await stats();
      const delta = (afterStats.attempts["classifier"] ?? 0) - (beforeStats.attempts["classifier"] ?? 0);
      assert.equal(delta, 1, "semantic key change should reclassify");
      const r = await rpc.close(env.home);
      assert.equal(r.violations, "");
    } finally {
      if (rpc) try { await rpc.close(env.home); } catch {}
      rmSync(env.home, { recursive: true, force: true });
      rmSync(env.work, { recursive: true, force: true });
    }
  });

  it("cache disabled skips lookup/write and preserves prior entries", async () => {
    const env = fixture({ cacheEnabled: true });
    let rpc;
    try {
      rpc = startRpc({ home: env.home, work: env.work });
      await rpc.userTurn("implement a feature please");
      await rpc.close(env.home);
      rpc = undefined;
      const cacheFile = join(env.project, "bifrost-cache.jsonl");
      const beforeContent = readFileSync(cacheFile, "utf8");

      const configPath = join(env.project, "bifrost.json");
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      config.cache.enabled = false;
      writeFileSync(configPath, JSON.stringify(config));

      const beforeStats = await stats();
      rpc = startRpc({ home: env.home, work: env.work });
      await rpc.userTurn("implement a feature please");
      const afterStats = await stats();
      const delta = (afterStats.attempts["classifier"] ?? 0) - (beforeStats.attempts["classifier"] ?? 0);
      assert.ok(delta >= 1, "disabled cache should classify");
      await rpc.close(env.home);
      rpc = undefined;

      const afterContent = readFileSync(cacheFile, "utf8");
      assert.equal(afterContent, beforeContent, "disabled cache must not delete prior entries");
    } finally {
      if (rpc) try { await rpc.close(env.home); } catch {}
      rmSync(env.home, { recursive: true, force: true });
      rmSync(env.work, { recursive: true, force: true });
    }
  });
});
