import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readdirSync, symlinkSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const EXTENSION_PATH = join(ROOT, "index.ts");
const FAKE_SERVER = join(ROOT, "scripts", "fake-provider-server.mjs");
const OUTBOUND_GUARD = join(ROOT, "scripts", "test-outbound-guard.cjs");
let fakePort;

function startFakeServer() {
  const child = spawn("node", [FAKE_SERVER], { stdio: ["ignore", "pipe", "ignore"] });
  return new Promise((resolve, reject) => {
    let buf = "";
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error("fake server start timeout")), 10_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      try {
        const parsed = JSON.parse(buf);
        if (parsed.port) {
          settled = true;
          clearTimeout(timer);
          resolve({ child, port: parsed.port });
        }
      } catch {
        // partial JSON; wait for more
      }
    });
    child.on("error", (error) => fail(error));
    child.on("close", () => fail(new Error("fake server exited before ready")));
  });
}

function writeFixture({ home, work, port, models, bifrost }) {
  writePiModels({ home, port, models });
  writeFileSync(join(work, "bifrost.json"), JSON.stringify(bifrost));
}

function writePiModels({ home, port, models }) {
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  const providers = {};
  for (const { provider = "fake", ...model } of models) {
    const entry = providers[provider] ??= {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      api: provider === "openai-codex" ? "openai-codex-responses" : "openai-completions",
      apiKey: provider === "fake" ? "fixture-only" : `fixture-${provider}`,
      models: [],
    };
    entry.models.push(model);
  }
  writeFileSync(
    join(home, ".pi", "agent", "models.json"),
    JSON.stringify({ providers }),
  );
  writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({ retry: { enabled: false }, enabledModels: Object.keys(providers).map((provider) => `${provider}/*`) }));
}

function piTestEnv(home) {
  const agentDir = join(home, ".pi", "agent");
  return {
    PATH: process.env.PATH,
    HOME: home,
    PI_CODING_AGENT_DIR: agentDir,
    PI_SKIP_VERSION_CHECK: "1",
    PI_OFFLINE: "1",
    NODE_OPTIONS: `--require=${OUTBOUND_GUARD}`,
    BIFROST_TEST_ALLOWED_ORIGIN: `http://127.0.0.1:${fakePort}`,
    BIFROST_TEST_NETWORK_VIOLATIONS: join(home, "test-network-violations.log"),
  };
}

function assertNoNetworkViolations(home) {
  const path = join(home, "test-network-violations.log");
  if (!existsSync(path)) return;
  assert.equal(readFileSync(path, "utf8"), "", "test network guard recorded a blocked external request");
}

function listAvailableProviders({ home, work }) {
  return new Promise((resolve, reject) => {
    const child = spawn("pi", ["-e", EXTENSION_PATH, "--list-models"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: piTestEnv(home),
      cwd: work,
    });
    let stdout = "";
    let stderr = "";
    let forceKill;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      forceKill = setTimeout(() => child.kill("SIGKILL"), 1_000);
      reject(new Error("pi model inventory timed out"));
    }, 15_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      clearTimeout(forceKill);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(forceKill);
      try {
        assertNoNetworkViolations(home);
      } catch (error) {
        reject(error);
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

async function fakeStats(port) {
  const response = await fetch(`http://127.0.0.1:${port}/_stats`);
  assert.equal(response.ok, true);
  return response.json();
}

function runAuto({ home, work, messages, model = "bifrost/auto" }) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "pi",
      ["-e", EXTENSION_PATH, "--approve", "--no-session", "--no-tools", "--model", model, "-p", ...messages],
      {
        stdio: ["ignore", "pipe", "pipe"],
        // Keep real provider credentials from the developer shell out of the
        // subprocess. The fixture registry should contain only fake providers.
        env: piTestEnv(home),
        cwd: work,
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`pi timed out: ${messages.join(" | ")}`));
    }, 120_000);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    // Nonzero exit is a valid outcome under test; callers assert on code/output.
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function createDebugExtension(directory, logPath, enabled = true, probeTimeoutMs = 250) {
  mkdirSync(directory, { recursive: true });
  for (const entry of readdirSync(ROOT)) {
    if ([".git", "node_modules", "index.ts", "bifrost.json"].includes(entry)) continue;
    symlinkSync(join(ROOT, entry), join(directory, entry));
  }
  symlinkSync(join(ROOT, "node_modules"), join(directory, "node_modules"));
  copyFileSync(EXTENSION_PATH, join(directory, "index.ts"));
  const config = JSON.parse(readFileSync(join(ROOT, "bifrost.json"), "utf8"));
  config.debug = { enabled, path: logPath };
  config.probe = { ...config.probe, timeoutMs: probeTimeoutMs };
  writeFileSync(join(directory, "bifrost.json"), JSON.stringify(config));
  return join(directory, "index.ts");
}

async function waitForFile(path, timeoutMs = 5_000, onTimeout = "") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const details = typeof onTimeout === "function" ? await onTimeout() : onTimeout;
  assert.fail(`file was not created: ${path}\n${details}`);
}

function startRpc({ home, work, model = "bifrost/auto", extensionPath = EXTENSION_PATH }) {
  const child = spawn("pi", ["-e", extensionPath, "--approve", "--mode", "rpc", "--no-session", "--no-tools", "--model", model], {
    cwd: work,
    stdio: ["pipe", "pipe", "pipe"],
    env: piTestEnv(home),
  });
  const records = [];
  let incompleteLine = "";
  let stderr = "";
  let wake;
  let closeInfo;
  let spawnError;
  const childClosed = new Promise((resolve) => child.once("close", (code) => {
    closeInfo = { code };
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
    for (const line of lines) { try { records.push(JSON.parse(line)); } catch { /* malformed output is caught by response timeout */ } }
    wake?.();
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; wake?.(); });
  const wait = (deadline) => new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); if (wake === finish) wake = undefined; resolve(); };
    const timer = setTimeout(finish, Math.max(0, deadline - Date.now()));
    wake = finish;
  });
  async function userTurn(message) {
    const id = `bootstrap-${Date.now()}-${records.length}`;
    const start = records.length;
    const deadline = Date.now() + 30_000;
    child.stdin.write(`${JSON.stringify({ id, type: "prompt", message })}\n`);
    let index = start;
    let started = false;
    while (Date.now() < deadline) {
      while (index < records.length) {
        const record = records[index++];
        if (record.id === id && record.type === "response") {
          assert.equal(record.success, true, JSON.stringify(record));
          started = record.data?.disposition === "started";
          if (!started) return;
        }
        if (started && record.type === "agent_settled") return;
      }
      assert.ifError(spawnError);
      assert.equal(closeInfo, undefined, `Pi RPC exited before settling: ${message}`);
      await wait(deadline);
    }
    throw new Error(`Pi RPC timed out: ${message}\n${stderr}`);
  }
  async function close() {
    child.stdin.end();
    await Promise.race([childClosed, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    if (!closeInfo) { child.kill("SIGKILL"); await childClosed; }
    assert.equal(closeInfo.code, 0, stderr);
  }
  return { userTurn, close, get stderr() { return stderr; }, get records() { return records; } };
}

it("rejects a pre-recorded network guard violation without an uncaught close error", async () => {
  const home = mkdtempSync(join(tmpdir(), "bifrost-auto-home-"));
  const work = mkdtempSync(join(tmpdir(), "bifrost-auto-work-"));
  try {
    writePiModels({ home, port: 0, models: [] });
    writeFileSync(join(home, "test-network-violations.log"), "blocked external request fixture\n");
    await assert.rejects(
      listAvailableProviders({ home, work }),
      /test network guard recorded a blocked external request/u,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

describe("auto virtual production path", { timeout: 240_000, concurrency: 1 }, () => {
  let server;
  before(async () => {
    server = await startFakeServer();
    fakePort = server.port;
  });
  after(() => {
    server?.child.kill();
  });

  it("bootstraps a fresh install on the first physical and direct Auto prompt", async () => {
    for (const model of ["fake/healthy", "bifrost/auto"]) {
      const home = mkdtempSync(join(tmpdir(), "bifrost-fresh-home-"));
      const work = mkdtempSync(join(tmpdir(), "bifrost-fresh-work-"));
      try {
        writePiModels({ home, port: server.port, models: [{ id: "healthy", reasoning: false }] });
        const beforeInventory = await fakeStats(server.port);
        const inventory = await listAvailableProviders({ home, work });
        const afterInventory = await fakeStats(server.port);
        assertNoNetworkViolations(home);
        assert.deepEqual(afterInventory.attempts, beforeInventory.attempts, "startup/model inventory must issue zero provider POSTs");
        assert.deepEqual(afterInventory.stats, beforeInventory.stats, "startup/model inventory must issue zero provider POSTs");
        const before = afterInventory;
        assert.equal(inventory.code, 0, inventory.stderr);
        const rows = inventory.stdout
          .split("\n")
          .slice(1)
          .filter((line) => line.trim())
          .map((line) => line.trim().split(/\s+/u));
        assert.ok(rows.length > 0, inventory.stdout);
        assert.deepEqual(
          [...new Set(rows.filter(([provider]) => provider !== "bifrost").map(([provider]) => provider))],
          ["fake"],
          inventory.stdout,
        );
        assert.deepEqual(rows.filter(([provider]) => provider === "bifrost").map(([, model]) => model), ["auto"]);
        for (const [index, prompt] of ["Review this module and suggest one useful improvement", "Explain one design choice in this module"].entries()) {
          if (model === "bifrost/auto" && index === 1) {
            mkdirSync(join(work, ".pi"), { recursive: true });
            // The registered model_select hook persists this owned, routing-neutral
            // mode file; the CLI's --model flag does not emit model_select.
            writeFileSync(join(work, ".pi", "bifrost-state.json"), JSON.stringify({ enabled: true, classifierEnabled: true }));
          }
          const beforePrompt = await fakeStats(server.port);
          const result = await runAuto({ home, work, model, messages: [prompt] });
          const afterPrompt = await fakeStats(server.port);
          const promptStats = afterPrompt.stats.slice(beforePrompt.stats.length);
          assert.equal(result.code, 0, result.stderr);
          assert.match(result.stdout, /healthy/u);
          if (index === 0) {
            assert.match(result.stderr, /Bifrost loaded 1 provisional chat model\(s\) into in-memory pools/u);
          } else {
            assert.doesNotMatch(result.stderr, /Bifrost loaded .* into in-memory pools/u);
          }
          assert.match(result.stderr, /Bifrost(?: auto)?: quick → fake\/healthy/u);
          assert.deepEqual(
            promptStats.reduce((counts, item) => ({ ...counts, [item.kind]: (counts[item.kind] ?? 0) + 1 }), {}),
            index === 0 ? { classifier: 2, generation: 1, probe: 1 } : { classifier: 2, generation: 1 },
            `ordinary ${model} prompt ${index + 1} must match its first-use probe count`,
          );
        }
        const after = await fakeStats(server.port);
        const newStats = after.stats.slice(before.stats.length);
        assert.deepEqual(
          newStats.reduce((counts, item) => ({ ...counts, [item.kind]: (counts[item.kind] ?? 0) + 1 }), {}),
          { classifier: 4, generation: 2, probe: 1 },
          `each one-shot process starts and cancels its own background probe`,
        );
        assert.equal(existsSync(join(work, "bifrost.json")), false);
        const savedConfigPath = join(work, ".pi", "bifrost.json");
        const ownershipPath = join(work, ".pi", "bifrost-reconcile-ownership.json");
        if (existsSync(savedConfigPath)) {
          const savedConfig = JSON.parse(readFileSync(savedConfigPath, "utf8"));
          assert.deepEqual(savedConfig.models.quick, ["fake/healthy"], "a one-shot process can persist only completed verified pools");
          assert.equal(existsSync(ownershipPath), true);
        } else {
          assert.equal(existsSync(ownershipPath), false, "shutdown cancellation must not leave an ownership receipt without config");
        }
        if (model === "bifrost/auto") {
          assert.deepEqual(JSON.parse(readFileSync(join(work, ".pi", "bifrost-state.json"), "utf8")), {
            enabled: true,
            classifierEnabled: true,
          });
        }
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(work, { recursive: true, force: true });
      }
    }
  });

  it("returns the first Auto response before slow probes and later saves only verified pools", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-background-home-"));
    const work = mkdtempSync(join(tmpdir(), "bifrost-background-work-"));
    const extensionDir = mkdtempSync(join(tmpdir(), "bifrost-background-extension-"));
    const extensionPath = createDebugExtension(extensionDir, ".pi/bifrost-debug.jsonl", false, 10_000);
    const configPath = join(work, ".pi", "bifrost.json");
    try {
      writePiModels({ home, port: server.port, models: [
        { id: "healthy", reasoning: false, cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0 } },
        { id: "probe-background-slow-fail", reasoning: false, cost: { input: 20, output: 20, cacheRead: 0, cacheWrite: 0 } },
      ] });
      const before = await fakeStats(server.port);
      const rpc = startRpc({ home, work, extensionPath });
      try {
        await rpc.userTurn("quick say ready");
        const afterFirst = await fakeStats(server.port);
        assert.ok(afterFirst.stats.some((item) => item.kind === "probe" && item.model === "healthy" && item.completed),
          "at least one healthy probe completed before the first user response");
        assert.ok((afterFirst.stats.filter((item) => item.kind === "generation" && item.model === "healthy").length
          - before.stats.filter((item) => item.kind === "generation" && item.model === "healthy").length) >= 1,
        "the first user generation completed while the slow probe was pending");
        assert.ok(afterFirst.stats.some((item) => item.kind === "probe" && item.model === "probe-background-slow-fail" && !item.completed),
          "the slow probe remains pending after the first user response");
        assert.equal(existsSync(configPath), false, "no config is saved from a partial probe result");

        const secondTurn = rpc.userTurn("frontier say ready");
        await waitForFile(configPath, 5_000, async () => JSON.stringify({
          stderr: rpc.stderr,
          notifications: rpc.records.filter((record) => record.type === "extension_ui_request" && record.method === "notify").map((record) => record.message),
          stats: await fakeStats(server.port),
        }));
        await secondTurn;
        const saved = JSON.parse(readFileSync(configPath, "utf8"));
        assert.equal(saved.default, "quick");
        assert.deepEqual(saved.models, { quick: ["fake/healthy"], general: [], frontier: [] });
        assert.equal(saved.enabled, true);
        assert.equal(saved.strategy, "first");
        assert.deepEqual(saved.categoryStrategies, { quick: "random", general: "first", frontier: "first" });
        assert.deepEqual(saved.cache, { enabled: true, maxEntries: 500, threshold: 0.88 });
        assert.equal(saved.reliability.enabled, true);
        assert.equal(saved.debug.enabled, false);

        const beforeVerifiedTurn = await fakeStats(server.port);
        await rpc.userTurn("frontier say after verification");
        const after = await fakeStats(server.port);
        assert.equal((beforeVerifiedTurn.attempts["probe-background-slow-fail"] ?? 0) - (before.attempts["probe-background-slow-fail"] ?? 0), 2,
          "the slow model handled a user turn while its probe was pending");
        assert.equal((after.attempts["probe-background-slow-fail"] ?? 0) - (beforeVerifiedTurn.attempts["probe-background-slow-fail"] ?? 0), 0,
          "after the probe result is installed, the next turn excludes the failed model");
        assert.ok((after.attempts.healthy ?? 0) > (beforeVerifiedTurn.attempts.healthy ?? 0),
          "the next turn routes through the verified healthy pool");
      } finally {
        await rpc.close();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
      rmSync(extensionDir, { recursive: true, force: true });
    }
  });

  it("saves a nonempty verified default and routes from it after restart", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-default-home-"));
    const work = mkdtempSync(join(tmpdir(), "bifrost-default-work-"));
    const configPath = join(work, ".pi", "bifrost.json");
    try {
      writePiModels({ home, port: server.port, models: [
        { id: "fail", reasoning: false, cost: { input: 2, output: 2, cacheRead: 0, cacheWrite: 0 } },
        { id: "healthy", reasoning: false, cost: { input: 20, output: 20, cacheRead: 0, cacheWrite: 0 } },
      ] });
      const before = await fakeStats(server.port);
      const rpc = startRpc({ home, work });
      try {
        await rpc.userTurn("frontier say ready");
        await waitForFile(configPath, 10_000, rpc.stderr);
      } finally { await rpc.close(); }

      const saved = JSON.parse(readFileSync(configPath, "utf8"));
      assert.equal(saved.default, "frontier", `default must select a verified nonempty tier: ${JSON.stringify(saved)}`);
      assert.deepEqual(saved.models.frontier, ["fake/healthy"]);

      const beforeRestart = await fakeStats(server.port);
      const restarted = await runAuto({ home, work, messages: ["say ready"] });
      const afterRestart = await fakeStats(server.port);
      assert.equal(restarted.code, 0, restarted.stderr);
      assert.equal(afterRestart.stats.slice(beforeRestart.stats.length).filter((item) => item.kind === "generation").length, 1,
        `a normal Auto prompt after restart should use the verified default; initial stats ${JSON.stringify(before.stats)}`);
      assert.match(restarted.stderr, /Bifrost auto: frontier → fake\/healthy/u);
      assertNoNetworkViolations(home);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("keeps all-failed probe candidates out of config and does not retry on every prompt", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-all-failed-home-"));
    const work = mkdtempSync(join(tmpdir(), "bifrost-all-failed-work-"));
    const configPath = join(work, ".pi", "bifrost.json");
    try {
      writePiModels({ home, port: server.port, models: [
        { id: "probe-background-slow-fail", reasoning: false, cost: { input: 20, output: 20, cacheRead: 0, cacheWrite: 0 } },
      ] });
      const before = await fakeStats(server.port);
      const rpc = startRpc({ home, work });
      try {
        await rpc.userTurn("quick say ready");
        assert.equal(existsSync(configPath), false, "an all-failed run must not save an empty default pool");
        const afterFirst = await fakeStats(server.port);
        const probesAfterFirst = afterFirst.stats.filter((item) => item.kind === "probe").length
          - before.stats.filter((item) => item.kind === "probe").length;
        assert.ok(probesAfterFirst >= 1);
        assert.ok(afterFirst.stats.some((item) => item.kind === "probe" && item.completed && item.model === "probe-background-slow-fail"));
        assert.ok(existsSync(join(work, ".pi", "bifrost-probe.json")), "the safe health report explains why setup was not saved");
        const warningText = "No catalog models passed the background health check; starter config was not saved.";
        const warningDeadline = Date.now() + 5_000;
        let warningNotification;
        while (Date.now() < warningDeadline) {
          warningNotification = rpc.records.find((record) => record.type === "extension_ui_request"
            && record.method === "notify" && typeof record.message === "string" && record.message.includes(warningText));
          if (warningNotification) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.ok(warningNotification, `all-failed background setup must notify the user: ${JSON.stringify({
          stderr: rpc.stderr,
          notifications: rpc.records.filter((record) => record.type === "extension_ui_request" && record.method === "notify"),
        })}`);

        await rpc.userTurn("quick say ready again");
        const afterSecond = await fakeStats(server.port);
        assert.equal(afterSecond.stats.filter((item) => item.kind === "probe").length
          - before.stats.filter((item) => item.kind === "probe").length, probesAfterFirst,
        "a complete all-failed result is not retried on each prompt");
        assert.equal(existsSync(configPath), false);
      } finally {
        await rpc.close();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("pauses a quota-exhausted background provider before dispatching queued sibling probes", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-background-quota-home-"));
    const work = mkdtempSync(join(tmpdir(), "bifrost-background-quota-work-"));
    const configPath = join(work, ".pi", "bifrost.json");
    const logPath = join(work, "probe-debug.jsonl");
    const extensionDir = mkdtempSync(join(tmpdir(), "bifrost-debug-extension-"));
    const extensionPath = createDebugExtension(extensionDir, logPath);
    try {
      writePiModels({ home, port: server.port, models: [
        { provider: "fake", id: "background-credits-exhausted", reasoning: false, cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0 } },
        ...["probe-background-slow-fail", "sibling-one", "sibling-two", "sibling-three", "sibling-four"].map((id) => ({
          provider: "fake", id, reasoning: false, cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0 },
        })),
        { provider: "openai-codex", id: "gpt-fixture", reasoning: false, cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0 } },
        { provider: "good", id: "codex-like-temperature-rejects", reasoning: false, cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0 } },
        { provider: "good", id: "healthy", reasoning: false, cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0 } },
      ] });
      // A synthetic future-dated OAuth credential makes the native Codex
      // provider eligible in Pi's model snapshot. Its deliberately invalid
      // token is rejected locally by Pi before any provider request is sent.
      writeFileSync(join(home, ".pi", "agent", "auth.json"), JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: "synthetic-not-a-jwt",
          refresh: "synthetic-refresh-token",
          expires: Date.now() + 60 * 60 * 1000,
        },
      }));
      const before = await fakeStats(server.port);
      const rpc = startRpc({ home, work, extensionPath });
      try {
        await rpc.userTurn("quick say ready");
        await waitForFile(configPath, 10_000, async () => JSON.stringify(await fakeStats(server.port)));
        const saved = JSON.parse(readFileSync(configPath, "utf8"));
        assert.ok(saved.models.quick.includes("good/healthy"), "the successful healthy model remains in the saved quick pool");
        assert.ok(saved.models.quick.every((model) => !model.startsWith("fake/")), "saved pools omit every model from the quota-blocked provider");
        const stats = await fakeStats(server.port);
        const added = stats.stats.slice(before.stats.length);
        const fakeProbes = added.filter((item) => item.provider === "fake" && item.kind === "probe");
        assert.ok(fakeProbes.some((item) => item.model === "background-credits-exhausted"), "the fake provider receives the quota probe");
        assert.ok(fakeProbes.length <= 3, `queued fake-provider probes should stop after the initial concurrency window: ${JSON.stringify(fakeProbes)}`);
        assert.equal(fakeProbes.some((item) => ["sibling-three", "sibling-four"].includes(item.model)), false,
          `after the initial concurrency window, queued siblings must not start: ${JSON.stringify(fakeProbes)}`);
        const providerStatePath = join(work, ".pi", "bifrost-provider-reliability.json");
        assert.equal(existsSync(providerStatePath), true, "the confirmed provider quota pause is persisted");
        assert.match(readFileSync(providerStatePath, "utf8"), /fake/u);
        assertNoNetworkViolations(home);
      } finally {
        await rpc.close();
      }
      const events = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      const runIds = new Set(events.filter((event) => event.module === "probe").map((event) => event.runId));
      assert.equal(runIds.size, 1, "one background probe run has one correlation ID");
      const outcomes = events.filter((event) => event.module === "probe" && event.event === "model_result");
      assert.ok(outcomes.some((event) => event.provider === "fake" && event.model === "background-credits-exhausted"
        && event.status === "error" && event.reason === "allowance_exhausted"), JSON.stringify(outcomes));
      assert.ok(outcomes.some((event) => event.provider === "fake" && event.model === "probe-background-slow-fail"
        && event.status === "timeout" && event.reason === "timeout"), JSON.stringify(outcomes));
      assert.ok(outcomes.some((event) => event.provider === "good" && event.model === "codex-like-temperature-rejects"
        && event.status === "ok"), JSON.stringify(outcomes));
      const codexOutcomes = outcomes.filter((event) => event.provider === "openai-codex");
      const catalog = events.find((event) => event.module === "probe" && event.event === "catalog");
      assert.ok(codexOutcomes.length > 0, "Pi's enabled native Codex models appear in the probe catalog");
      assert.equal(codexOutcomes.length, catalog.providerCounts["openai-codex"]);
      assert.ok(codexOutcomes.every((event) => event.status === "error" && event.reason === "authentication_or_access"), JSON.stringify(codexOutcomes));
      const summary = events.find((event) => event.module === "probe" && event.event === "complete");
      assert.equal(summary.cache, "not_written");
      assert.equal(summary.cacheReason, "incomplete_report");
      assert.ok(summary.ok > 0 && summary.error > 0 && summary.timeout > 0);
      assert.equal(JSON.stringify(events).includes("no remaining credits"), false);
      assert.equal(JSON.stringify(events).includes("probe-only failure"), false);
    } finally {
      rmSync(extensionDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("leaves a concurrently created project config untouched", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-config-race-home-"));
    const work = mkdtempSync(join(tmpdir(), "bifrost-config-race-work-"));
    const configPath = join(work, ".pi", "bifrost.json");
    try {
      writePiModels({ home, port: server.port, models: [
        { id: "healthy", reasoning: false, cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0 } },
        { id: "probe-background-slow-fail", reasoning: false, cost: { input: 20, output: 20, cacheRead: 0, cacheWrite: 0 } },
      ] });
      const rpc = startRpc({ home, work });
      try {
        await rpc.userTurn("quick say ready");
        const userConfig = `${JSON.stringify({ strategy: "first", enabled: false, customSetting: "keep-me" }, null, 2)}\n`;
        mkdirSync(join(work, ".pi"), { recursive: true });
        writeFileSync(configPath, userConfig);
        const reportPath = join(work, ".pi", "bifrost-probe.json");
        await waitForFile(reportPath, 5_000, rpc.stderr);
        assert.equal(readFileSync(configPath, "utf8"), userConfig, "background reconciliation must not replace a newly written user config");
        assert.equal(existsSync(join(work, ".pi", "bifrost-reconcile-ownership.json")), false,
          "a config race must not create an ownership receipt for pools it did not write");
      } finally {
        await rpc.close();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("fails fresh sessions actionably when no pools are configured", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-auto-home-"));
    const work = mkdtempSync(join(tmpdir(), "bifrost-auto-work-"));
    try {
      writeFixture({
        home, work, port: server.port,
        models: [{ id: "healthy", reasoning: false }],
        bifrost: { enabled: true, default: "general", classifier: { enabled: false }, models: { quick: [], general: [], frontier: [] } },
      });
      const { code, stderr } = await runAuto({ home, work, messages: ["hi"] });
      assert.notEqual(code, 0);
      assert.match(stderr, /0 models configured for "general"/);
      assert.match(stderr, /bifrost init/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("dispatches per request with prefix handoff intact", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-auto-home-"));
    const work = mkdtempSync(join(tmpdir(), "bifrost-auto-work-"));
    try {
      writeFixture({
        home, work, port: server.port,
        models: [{ id: "fast", reasoning: false }, { id: "strong", reasoning: false }],
        bifrost: {
          enabled: true, default: "quick", strategy: "first", classifier: { enabled: false },
          models: { quick: ["fake/fast"], frontier: ["fake/strong"] },
          rules: [{ pattern: "hello", model: "quick" }],
        },
      });
      const { code, stderr } = await runAuto({ home, work, messages: ["frontier hello", "hello"] });
      assert.equal(code, 0, stderr);
      assert.match(stderr, /Bifrost auto: frontier → fake\/strong/);
      assert.match(stderr, /Bifrost auto: quick → fake\/fast/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("lets /bifrost off resolve the default-tier model without a prior dispatch", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-auto-home-"));
    const work = mkdtempSync(join(tmpdir(), "bifrost-auto-work-"));
    try {
      writeFixture({
        home, work, port: server.port,
        models: [{ id: "fast", reasoning: false }, { id: "strong", reasoning: false }],
        bifrost: {
          enabled: true, default: "general", strategy: "first", classifier: { enabled: false },
          models: { quick: ["fake/fast"], general: ["fake/strong"] },
        },
      });
      // The first turn is the command itself: nothing ever dispatched through
      // Auto, so leaving it must resolve the default-tier model instead of
      // dead-ending with "select one in /model first" (issue #17 P2).
      const { code, stderr } = await runAuto({ home, work, messages: ["/bifrost off"] });
      assert.equal(code, 0);
      assert.match(stderr, /Bifrost disabled/);
      assert.doesNotMatch(stderr, /no dispatched physical model/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("settles a claimed half-open trial end to end", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-auto-home-"));
    const work = mkdtempSync(join(tmpdir(), "bifrost-auto-work-"));
    try {
      writeFixture({
        home, work, port: server.port,
        models: [{ id: "healthy", reasoning: false }],
        bifrost: {
          enabled: true, default: "quick", strategy: "first", classifier: { enabled: false },
          models: { quick: ["fake/healthy"] },
          reliability: { enabled: true, failureThreshold: 3, windowMinutes: 5, cooldownMinutes: 60 },
          debug: { enabled: true, path: ".pi/bifrost-debug.jsonl" },
        },
      });
      // Seed an expired-cooldown circuit: the route must CLAIM a half-open trial.
      mkdirSync(join(work, ".pi"), { recursive: true });
      writeFileSync(join(work, ".pi", "bifrost-reliability.json"), JSON.stringify({
        version: 1,
        models: { "fake/healthy": { failures: [Date.now() - 7_200_000], openUntil: Date.now() - 1_000, trialActive: false } },
      }));
      const { code, stderr } = await runAuto({ home, work, messages: ["hello"] });
      assert.equal(code, 0);
      assert.match(stderr, /Bifrost auto: quick → fake\/healthy/);
      const reliability = JSON.parse(readFileSync(join(work, ".pi", "bifrost-reliability.json"), "utf8"));
      const record = reliability.models["fake/healthy"];
      assert.equal(record.trialActive, false, "claimed half-open trial must resolve at settle");
      const debugLog = readFileSync(join(work, ".pi", "bifrost-debug.jsonl"), "utf8");
      assert.match(debugLog, /"event":"trial","entryType":"event","model":"fake\/healthy","allowed":true,"claimed":true/, "seeded half-open trial must actually be claimed");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("opens the circuit on failure and visibly degrades to the last dispatched model", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-auto-home-"));
    const work = mkdtempSync(join(tmpdir(), "bifrost-auto-work-"));
    try {
      writeFixture({
        home, work, port: server.port,
        models: [{ id: "fail-then-ok", reasoning: false }],
        bifrost: {
          enabled: true, default: "quick", strategy: "first", classifier: { enabled: false },
          models: { quick: ["fake/fail-then-ok"] },
          reliability: { enabled: true, failureThreshold: 1, windowMinutes: 5, cooldownMinutes: 60 },
        },
      });
      const before = await fakeStats(server.port);
      const { code, stderr } = await runAuto({ home, work, messages: ["hello one", "hello two"] });
      const after = await fakeStats(server.port);
      assert.equal(code, 0);
      assert.match(stderr, /Bifrost auto: quick → fake\/fail-then-ok/);
      assert.match(stderr, /Bifrost: keeping fake\/fail-then-ok/);
      assert.equal((after.attempts["fail-then-ok"] ?? 0) - (before.attempts["fail-then-ok"] ?? 0), 2,
        "the two user turns must produce two provider attempts; Bifrost must not replay the failed prompt");
      const reliability = JSON.parse(readFileSync(join(work, ".pi", "bifrost-reliability.json"), "utf8"));
      assert.equal(reliability.models["fake/fail-then-ok"].lastFailureSource, "agent_settled");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("does not degrade an exhausted explicit tier boundary to the last dispatched model", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-auto-home-"));
    const work = mkdtempSync(join(tmpdir(), "bifrost-auto-work-"));
    try {
      writeFixture({
        home, work, port: server.port,
        models: [{ id: "healthy", reasoning: false }],
        bifrost: {
          schemaVersion: 2,
          enabled: true, default: "quick", strategy: "first", classifier: { enabled: false },
          models: { quick: ["fake/healthy"], frontier: ["fake/missing"] },
          tierPolicies: { frontier: { fallbackTiers: [] } },
          rules: [
            { pattern: "warmup", model: "quick" },
            { pattern: "strict-boundary", model: "frontier" },
          ],
        },
      });
      const before = await fakeStats(server.port);
      const { stderr } = await runAuto({ home, work, messages: ["warmup", "strict-boundary"] });
      const after = await fakeStats(server.port);
      assert.equal((after.attempts.healthy ?? 0) - (before.attempts.healthy ?? 0), 1,
        "only the warmup turn may reach the healthy model; the exhausted frontier boundary must not dispatch it");
      assert.match(stderr, /Bifrost auto: quick → fake\/healthy/);
      assert.match(stderr, /no healthy physical model for tier frontier/);
      assert.doesNotMatch(stderr, /Bifrost: keeping fake\/healthy/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("does not send an exhausted reserve-policy turn to Auto's previous model", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-auto-home-"));
    const work = mkdtempSync(join(tmpdir(), "bifrost-auto-work-"));
    try {
      writeFixture({
        home, work, port: server.port,
        models: [{ id: "healthy", reasoning: false }, { id: "reserved", reasoning: false }],
        bifrost: {
          schemaVersion: 2,
          enabled: true, default: "reserve", strategy: "first", classifier: { enabled: false },
          models: { quick: ["fake/healthy"], restricted: ["fake/missing"], reserve: ["fake/reserved"] },
          rules: [
            { pattern: "warmup", model: "quick" },
            { pattern: "reserve-task", model: "restricted" },
          ],
          economics: {
            mode: "policy",
            scopes: { reserved: { kind: "model", model: "fake/reserved" } },
            sources: [{ id: "manual", scopeRef: "reserved", authority: "declared" }],
            admission: [{ id: "daily", scopeRef: "reserved", windowId: "day", reserveRatio: 0.2, unknown: "block" }],
            observations: [{
              sourceId: "manual", scopeRef: "reserved", billing: "metered", observedAt: Date.now() - 1, expiresAt: Date.now() + 60_000, revision: 1,
              windows: [{ id: "day", period: { id: "p1", sequence: 1 }, unit: "ratio", remaining: 0.1 }],
            }],
          },
        },
      });
      const before = await fakeStats(server.port);
      const { stderr } = await runAuto({ home, work, messages: ["warmup", "reserve-task"] });
      const after = await fakeStats(server.port);
      assert.equal((after.attempts.healthy ?? 0) - (before.attempts.healthy ?? 0), 1,
        "the warmup may reach its selected model once");
      assert.equal((after.attempts.reserved ?? 0) - (before.attempts.reserved ?? 0), 0,
        "a reserve-excluded candidate must never reach the fake provider");
      assert.match(stderr, /no eligible physical model for tier restricted \(reserve policy exclusion\)/);
      assert.match(stderr, /reserve policy excluded 1 configured candidate\(s\) in fallback tier reserve \(reasons: reserve_reached\)/);
      assert.doesNotMatch(stderr, /resolved 0 available models|check provider credentials/);
      assert.doesNotMatch(stderr, /reserve-task|0\.1/);
      assert.doesNotMatch(stderr, /Bifrost: keeping fake\/healthy/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });
});
