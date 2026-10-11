import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXTENSION_PATH = join(ROOT, "index.ts");
const FAKE_SERVER = join(ROOT, "scripts", "fake-provider-server.mjs");
const OUTBOUND_GUARD = join(ROOT, "scripts", "test-outbound-guard.cjs");

function startFakeServer() {
  const child = spawn("node", [FAKE_SERVER], { stdio: ["ignore", "pipe", "ignore"] });
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("fake provider did not start")); }, 10_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      try {
        const ready = JSON.parse(output);
        if (ready.port) { clearTimeout(timer); resolve({ child, port: ready.port }); }
      } catch { /* wait for the ready JSON line */ }
    });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

function fixture({ home, work, port }) {
  const agent = join(home, ".pi", "agent");
  mkdirSync(agent, { recursive: true });
  writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: {
    fake: {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      api: "openai-completions",
      apiKey: "fixture-only",
      models: [
        { id: "auto-selection-held-general", reasoning: false, cost: { input: 2, output: 2, cacheRead: 0, cacheWrite: 0 } },
        { id: "frontier-healthy", reasoning: false, cost: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 } },
      ],
    },
  } }));
  writeFileSync(join(agent, "settings.json"), JSON.stringify({
    retry: { enabled: false },
    enabledModels: ["fake/*"],
  }));
  return {
    cwd: work,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      PI_CODING_AGENT_DIR: agent,
      PI_SKIP_VERSION_CHECK: "1",
      PI_OFFLINE: "1",
      NODE_OPTIONS: `--require=${OUTBOUND_GUARD}`,
      BIFROST_TEST_ALLOWED_ORIGIN: `http://127.0.0.1:${port}`,
      BIFROST_TEST_NETWORK_VIOLATIONS: join(home, "network-violations.log"),
    },
  };
}

async function stats(port) {
  const response = await fetch(`http://127.0.0.1:${port}/_stats`);
  assert.equal(response.ok, true);
  return response.json();
}

async function probeGate(port, action) {
  const response = await fetch(`http://127.0.0.1:${port}/_probe-gate/${action}?model=auto-selection-held-general`, { method: "POST" });
  assert.equal(response.ok, true);
}

async function waitFor(description, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for ${description}`);
}

function startRpc({ home, work, model = "fake/auto-selection-held-general" }) {
  const paths = fixture({ home, work, port: server.port });
  const child = spawn("pi", ["-e", EXTENSION_PATH, "--approve", "--mode", "rpc", "--no-session", "--no-tools", "--model", model], {
    cwd: paths.cwd,
    env: paths.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const records = [];
  let partial = "";
  let stderr = "";
  let wake;
  let closeInfo;
  let spawnError;
  const closed = new Promise((resolve) => child.once("close", (code) => { closeInfo = { code }; wake?.(); resolve(closeInfo); }));
  child.once("error", (error) => { spawnError = error; wake?.(); });
  child.stdin.on("error", (error) => { spawnError ??= error; wake?.(); });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    const lines = `${partial}${chunk}`.split("\n");
    partial = lines.pop();
    for (const line of lines) { try { records.push(JSON.parse(line)); } catch { /* unexpected RPC output is captured by timeout */ } }
    wake?.();
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; wake?.(); });
  const wait = (deadline) => new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); if (wake === finish) wake = undefined; resolve(); };
    const timer = setTimeout(finish, Math.max(0, deadline - Date.now()));
    wake = finish;
  });
  async function request(message) {
    const id = `bootstrap-selection-${Date.now()}-${records.length}`;
    const start = records.length;
    const deadline = Date.now() + 30_000;
    child.stdin.write(`${JSON.stringify({ ...message, id })}\n`);
    let index = start;
    while (Date.now() < deadline) {
      while (index < records.length) {
        const record = records[index++];
        if (record.id === id && record.type === "response") {
          assert.equal(record.success, true, JSON.stringify(record));
          return record;
        }
      }
      assert.ifError(spawnError);
      assert.equal(closeInfo, undefined, `Pi RPC exited before ${message.type}`);
      await wait(deadline);
    }
    throw new Error(`Pi RPC timed out waiting for ${message.type}\n${stderr}`);
  }
  async function userTurn(message) {
    const id = `bootstrap-selection-turn-${Date.now()}-${records.length}`;
    const start = records.length;
    const deadline = Date.now() + 30_000;
    child.stdin.write(`${JSON.stringify({ type: "prompt", id, message })}\n`);
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
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    if (!closeInfo) { child.kill("SIGKILL"); await closed; }
    assert.equal(closeInfo.code, 0, stderr);
    const violations = join(home, "network-violations.log");
    if (existsSync(violations)) assert.equal(readFileSync(violations, "utf8"), "");
  }
  return { request, userTurn, close, get records() { return records; }, get stderr() { return stderr; } };
}

let server;
describe("Auto selection during first-use verification", { timeout: 120_000, concurrency: 1 }, () => {
  before(async () => { server = await startFakeServer(); });
  after(() => server?.child.kill());

  it("transfers the pending save to Auto and keeps physical pin cancellation", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-auto-select-home-"));
    const work = mkdtempSync(join(tmpdir(), "bifrost-auto-select-work-"));
    const configPath = join(work, ".pi", "bifrost.json");
    const ownershipPath = join(work, ".pi", "bifrost-reconcile-ownership.json");
    try {
      const heldModel = "auto-selection-held-general";
      await probeGate(server.port, "hold");
      const before = await stats(server.port);
      const rpc = startRpc({ home, work });
      try {
        await waitFor("the held first-use probe", async () => {
          const current = await stats(server.port);
          return current.stats.find((item) => item.kind === "probe" && item.model === heldModel && !item.completed);
        });
        await rpc.request({ type: "set_model", provider: "bifrost", modelId: "auto" });
        assert.equal(existsSync(configPath), false, "partial probe results cannot be saved");
        await probeGate(server.port, "release");
        await waitFor("the verified config and ownership save", () => existsSync(configPath) && existsSync(ownershipPath));

        const saved = JSON.parse(readFileSync(configPath, "utf8"));
        assert.deepEqual(saved.models, {
          quick: [],
          general: [`fake/${heldModel}`],
          frontier: ["fake/frontier-healthy"],
        });
        const probeReport = JSON.parse(readFileSync(join(work, ".pi", "bifrost-probe.json"), "utf8"));
        assert.deepEqual(probeReport.map((result) => result.status), ["ok", "ok"]);
        const afterProbes = await stats(server.port);
        for (const model of [heldModel, "frontier-healthy"]) {
          assert.equal((afterProbes.attempts[model] ?? 0) - (before.attempts[model] ?? 0), 1,
            `${model} must receive exactly one probe request across the Auto selection`);
        }

        const beforeTurn = afterProbes;
        await rpc.userTurn("frontier say ready");
        const afterTurn = await stats(server.port);
        assert.ok((afterTurn.attempts["frontier-healthy"] ?? 0) > (beforeTurn.attempts["frontier-healthy"] ?? 0),
          "the next Auto input must route through the saved healthy frontier pool");
      } finally { await rpc.close(); }
    } finally {
      await probeGate(server.port, "release");
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }

    const manualHome = mkdtempSync(join(tmpdir(), "bifrost-physical-select-home-"));
    const manualWork = mkdtempSync(join(tmpdir(), "bifrost-physical-select-work-"));
    const manualConfig = join(manualWork, ".pi", "bifrost.json");
    const manualOwnership = join(manualWork, ".pi", "bifrost-reconcile-ownership.json");
    try {
      await probeGate(server.port, "hold");
      const beforeManual = await stats(server.port);
      const rpc = startRpc({ home: manualHome, work: manualWork });
      try {
        await waitFor("the held probe before a physical pin", async () => {
          const current = await stats(server.port);
          return current.stats.find((item) => item.kind === "probe" && item.model === "auto-selection-held-general" && !item.completed);
        });
        await rpc.request({ type: "set_model", provider: "fake", modelId: "frontier-healthy" });
        await waitFor("the physical pin to abort its held probe", async () => {
          const current = await stats(server.port);
          return current.stats.slice(beforeManual.stats.length)
            .find((item) => item.kind === "probe" && item.model === "auto-selection-held-general" && item.clientClosed);
        });
        await probeGate(server.port, "release");
        await waitFor("the fake provider to release the cancelled probe", async () => {
          const current = await stats(server.port);
          return current.stats.slice(beforeManual.stats.length)
            .find((item) => item.kind === "probe" && item.model === "auto-selection-held-general" && item.gateReleased);
        });
        await rpc.userTurn("ordinary say ready");
        assert.equal(existsSync(manualConfig), false, "a physical pin must cancel automatic persistence");
        assert.equal(existsSync(manualOwnership), false, "cancellation must not leave an orphan ownership receipt");
      } finally { await rpc.close(); }
    } finally {
      await probeGate(server.port, "release");
      rmSync(manualHome, { recursive: true, force: true });
      rmSync(manualWork, { recursive: true, force: true });
    }
  });
});
