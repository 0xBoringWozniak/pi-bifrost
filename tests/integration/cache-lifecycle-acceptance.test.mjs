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
  const child = spawn("node", [FAKE_SERVER], { stdio: ["ignore", "pipe", "ignore"] });
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("fake provider startup timed out")); }, 10_000);
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

function fixture({ cacheEnabled = true, classifierModel = "fake/classifier" } = {}) {
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
    classifier: { enabled: true, backend: "prompt", model: classifierModel },
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
          return { response: record, stderr: stderr.slice(stderrStart) };
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
    let index = records.length;
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

  async function close() {
    closePromise ??= (async () => {
      child.stdin.end();
      await Promise.race([childClosed, new Promise((resolve) => setTimeout(resolve, 2_000))]);
      if (!closeInfo) {
        child.kill("SIGKILL");
        await Promise.race([childClosed, new Promise((resolve) => setTimeout(resolve, 2_000))]);
      }
      assert.ok(closeInfo, "Pi RPC child must close");
      let violations = "";
      try { violations = readFileSync(join(home, "network-violations.log"), "utf8"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      return { ...closeInfo, violations };
    })();
    return closePromise;
  }

  return { prompt, userTurn, close };
}

async function stats() {
  const response = await fetch(`http://127.0.0.1:${server.port}/_stats`);
  assert.equal(response.ok, true);
  return response.json();
}

describe("cache lifecycle acceptance", { timeout: 300_000, concurrency: 1 }, () => {
  before(async () => { server = await startFakeServer(); });
  after(async () => { server?.child?.kill("SIGKILL"); });

  it("first turn classifies and second exact turn is a cache hit", async () => {
    const env = fixture();
    try {
      const beforeStats = await stats();
      const rpc = startRpc({ home: env.home, work: env.work });
      await rpc.userTurn("implement a feature please");
      const midStats = await stats();
      const classifierAttempts1 = midStats.attempts["classifier"] ?? 0;
      assert.ok(classifierAttempts1 >= 1, "first turn should classify");

      await rpc.userTurn("implement a feature please");
      const afterStats = await stats();
      const classifierAttempts2 = afterStats.attempts["classifier"] ?? 0;
      assert.equal(classifierAttempts2, classifierAttempts1, "exact cache hit must avoid classifier");

      const closeResult = await rpc.close();
      assert.equal(closeResult.violations, "", "no network violations");

      // saved cache entry
      const cacheFile = join(env.project, "bifrost-cache.jsonl");
      assert.ok(existsSync(cacheFile), "cache file should exist");
      const lines = readFileSync(cacheFile, "utf8").trim().split("\n").filter(Boolean);
      assert.ok(lines.length >= 1, "cache should have at least one entry");
      const entry = JSON.parse(lines[0]);
      assert.equal(typeof entry.normalized, "string");
      assert.equal(entry.category, "general");
    } finally {
      rmSync(env.home, { recursive: true, force: true });
      rmSync(env.work, { recursive: true, force: true });
    }
  });

  it("restart preserves cache hit", async () => {
    const env = fixture();
    try {
      const rpc1 = startRpc({ home: env.home, work: env.work });
      await rpc1.userTurn("implement a feature please");
      await rpc1.close();

      const beforeStats = await stats();
      const rpc2 = startRpc({ home: env.home, work: env.work });
      await rpc2.userTurn("implement a feature please");
      const afterStats = await stats();
      const delta = (afterStats.attempts["classifier"] ?? 0) - (beforeStats.attempts["classifier"] ?? 0);
      assert.equal(delta, 0, "restart should preserve cache hit");
      await rpc2.close();
    } finally {
      rmSync(env.home, { recursive: true, force: true });
      rmSync(env.work, { recursive: true, force: true });
    }
  });

  it("cache disabled skips lookup and write without deleting prior entries", async () => {
    const env = fixture({ cacheEnabled: true });
    try {
      // populate cache
      const rpc1 = startRpc({ home: env.home, work: env.work });
      await rpc1.userTurn("implement a feature please");
      await rpc1.close();
      const cacheFile = join(env.project, "bifrost-cache.jsonl");
      const beforeContent = readFileSync(cacheFile, "utf8");
      assert.ok(beforeContent.trim().length > 0);

      // now disable cache in config
      const configPath = join(env.project, "bifrost.json");
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      config.cache.enabled = false;
      writeFileSync(configPath, JSON.stringify(config));

      const beforeStats = await stats();
      const rpc2 = startRpc({ home: env.home, work: env.work });
      await rpc2.userTurn("implement a feature please");
      const afterStats = await stats();
      // classifier should run now (cache disabled) 
      const delta = (afterStats.attempts["classifier"] ?? 0) - (beforeStats.attempts["classifier"] ?? 0);
      assert.ok(delta >= 1, "disabled cache should classify");
      await rpc2.close();

      // prior entries not deleted
      const afterContent = readFileSync(cacheFile, "utf8");
      assert.equal(afterContent, beforeContent, "disabled cache must not delete prior entries");
    } finally {
      rmSync(env.home, { recursive: true, force: true });
      rmSync(env.work, { recursive: true, force: true });
    }
  });
});
