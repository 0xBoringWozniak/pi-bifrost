import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execPath } from "node:process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const PI = join(ROOT, "node_modules", ".bin", "pi");
const EXTENSION = join(__dirname, "..", "fixtures", "child-auto-inline-extension.mjs");
const FAKE_SERVER = join(ROOT, "scripts", "fake-provider-server.mjs");
const OUTBOUND_GUARD = join(ROOT, "scripts", "test-outbound-guard.cjs");
const CREDENTIALS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "TYPESAFE_API_KEY", "HF_TOKEN", "HUGGINGFACE_HUB_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"];

let fakePort;
const observedClosedChildren = new WeakSet();
const closeWaiters = new WeakMap();

function childStreamsClosed(child) {
  const streams = [child.stdin, child.stdout, child.stderr].filter(Boolean);
  return streams.length > 0 && streams.every((stream) => stream.closed === true);
}

function waitForChildClose(child) {
  if (observedClosedChildren.has(child) || childStreamsClosed(child)) return Promise.resolve();
  let waiter = closeWaiters.get(child);
  if (!waiter) {
    waiter = new Promise((resolve) => {
      child.once("close", () => {
        observedClosedChildren.add(child);
        closeWaiters.delete(child);
        resolve();
      });
    });
    closeWaiters.set(child, waiter);
  }
  return waiter;
}

function stopChild(child, graceMs = 1_000) {
  const alreadyExited = child.exitCode !== null || child.signalCode !== null;
  const close = waitForChildClose(child);
  if (alreadyExited) return close;
  const forceKill = setTimeout(() => child.kill("SIGKILL"), graceMs);
  close.finally(() => clearTimeout(forceKill));
  child.kill("SIGTERM");
  return close;
}

function waitForFakeReady(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const fail = async (message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await stopChild(child);
      reject(new Error(message));
    };
    const timer = setTimeout(() => { void fail("fake provider startup timed out"); }, 10_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (settled) return;
      try {
        const ready = JSON.parse(output);
        settled = true;
        clearTimeout(timer);
        resolve({ port: ready.port });
      } catch {
        // Wait for the server's complete one-line startup record.
      }
    });
    child.on("error", () => { void fail("fake provider failed before startup"); });
    child.on("close", () => {
      if (!settled) void fail("fake provider exited before startup");
    });
  });
}

function startFakeServer() {
  const child = spawn("node", [FAKE_SERVER], { stdio: ["ignore", "pipe", "ignore"] });
  return waitForFakeReady(child).then(({ port }) => ({ child, port }));
}

async function readStats(port) {
  const response = await fetch(`http://127.0.0.1:${port}/_stats`);
  return response.json();
}

function alternatePort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError("provider port must be 1..65535");
  return port === 65535 ? 65534 : 65535;
}

function writeFixture({ home, work, port }) {
  const agentDir = join(home, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(work, ".pi"), { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      fake: {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        api: "openai-completions",
        apiKey: "fixture-only",
        models: [
          { id: "physical-fast", reasoning: false },
          { id: "physical-capable", reasoning: true },
        ],
      },
    },
  }));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
  writeFileSync(join(work, ".pi", "bifrost.json"), JSON.stringify({
    enabled: true,
    default: "quick",
    strategy: "first",
    classifier: { enabled: false },
    models: {
      quick: ["fake/physical-fast"],
      general: ["fake/physical-capable"],
      frontier: ["fake/physical-capable"],
    },
    // The conflict regex: without the inline tier handoff, Auto routes the
    // marker prompt to the capable model instead of the quick-tier fast model.
    rules: [{ pattern: "native faux dispatch marker", model: "fake/physical-capable" }],
  }));
}

function runPi({ home, work, model, prompt, child }) {
  const violations = join(home, "test-network-violations.log");
  writeFileSync(violations, "");
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
    PI_SKIP_VERSION_CHECK: "1",
    PI_OFFLINE: "1",
    NODE_OPTIONS: `--require=${OUTBOUND_GUARD}`,
    BIFROST_TEST_ALLOWED_ORIGIN: `http://127.0.0.1:${fakePort}`,
    BIFROST_TEST_NETWORK_VIOLATIONS: violations,
  };
  for (const name of CREDENTIALS) env[name] = "ambient-secret-fixture";
  // pi-subagents 0.77.0 producer contract: only the verified child marker
  // value "1" scopes the explicit child host; absent and empty stay parent.
  if (child !== undefined) env.PI_SUBAGENT_CHILD = child;
  return new Promise((resolve, reject) => {
    const childProcess = spawn(PI, ["-e", EXTENSION, "--approve", "--no-session", "--no-tools", "--model", model, "-p", prompt], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: work,
      env,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let spawnError;
    childProcess.stdout.setEncoding("utf8");
    childProcess.stderr.setEncoding("utf8");
    childProcess.stdout.on("data", (chunk) => { stdout += chunk; });
    childProcess.stderr.on("data", (chunk) => { stderr += chunk; });
    childProcess.on("error", (error) => { spawnError = error; });
    // Bounded termination: SIGTERM, then SIGKILL after the grace window,
    // resolving only on close so cleanup never races a live child.
    const timer = setTimeout(() => {
      timedOut = true;
      void stopChild(childProcess, 5_000);
    }, 60_000);
    childProcess.on("close", async (code) => {
      clearTimeout(timer);
      if (spawnError) {
        reject(spawnError);
        return;
      }
      if (timedOut) {
        reject(new Error(`Pi exceeded the bounded run window and was force-killed after SIGTERM (stdout=${stdout.length}, stderr=${stderr.length})`));
        return;
      }
      try {
        const violationsText = readFileSync(violations, "utf8");
        assert.equal(violationsText, "", "Pi child made a blocked outbound attempt");
        resolve({ code, stdout, stderr, violations: violationsText });
      } catch (error) {
        reject(error);
      }
    });
  });
}

describe("explicit child host keeps Auto inline overrides", { timeout: 300_000, concurrency: 1 }, () => {
  let server;
  before(async () => {
    server = await startFakeServer();
    fakePort = server.port;
  });
  after(async () => {
    if (server) await stopChild(server.child);
  });

  it("routes Auto inline tiers in child hosts without weakening physical identity", async () => {
    for (const testCase of [
      // The regression: marker 1 + bifrost/auto + inline quick prefix must
      // keep the quick-tier fast model even though the conflict regex routes
      // the stripped prompt to the capable model.
      { child: "1", model: "bifrost/auto", prompt: "quick native faux dispatch marker", expected: { "physical-fast": 1, "physical-capable": 0 } },
      // Plain Auto children (no inline prefix) still route through Bifrost.
      { child: "1", model: "bifrost/auto", prompt: "native faux dispatch marker", expected: { "physical-fast": 0, "physical-capable": 1 } },
      // Absent and empty markers are ordinary parent sessions: the inline
      // handoff routes the fast model before the conflict regex.
      { model: "bifrost/auto", prompt: "quick native faux dispatch marker", expected: { "physical-fast": 1, "physical-capable": 0 } },
      { child: "", model: "bifrost/auto", prompt: "quick native faux dispatch marker", expected: { "physical-fast": 1, "physical-capable": 0 } },
      // Explicit physical child identity still wins over the conflict regex.
      { child: "1", model: "fake/physical-fast", prompt: "native faux dispatch marker", expected: { "physical-fast": 1, "physical-capable": 0 } },
    ]) {
      const home = mkdtempSync(join(tmpdir(), "bifrost-child-auto-home-"));
      const work = mkdtempSync(join(tmpdir(), "bifrost-child-auto-work-"));
      try {
        writeFixture({ home, work, port: server.port });
        const before = await readStats(server.port);
        const result = await runPi({
          home,
          work,
          model: testCase.model,
          prompt: testCase.prompt,
          child: testCase.child,
        });
        assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
        assert.notEqual(result.stdout.trim(), "", "Pi produced no response through the fake provider");
        const after = await readStats(server.port);
        const attempts = Object.fromEntries(Object.entries(after.attempts).map(([model, count]) => [model, count - (before.attempts[model] ?? 0)]));
        const dispatch = { "physical-fast": 0, "physical-capable": 0, ...attempts };
        assert.deepEqual(dispatch, testCase.expected,
          `child=${JSON.stringify(testCase.child)} model=${testCase.model} prompt=${JSON.stringify(testCase.prompt)} dispatched ${JSON.stringify(attempts)}`);
        // The main matrix keeps the real allowed loopback transport and
        // asserts zero outbound violations. That absence alone is not proof
        // the guard blocks; the negative-control test below supplies it.
        assert.equal(result.violations, "", "network fence recorded a violation");
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(work, { recursive: true, force: true });
      }
    }
  });

  it("waits for close when exit precedes close", async () => {
    const child = spawn(execPath, ["-e", `
      const { spawn } = require("node:child_process");
      spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 100)"], {
        stdio: ["ignore", "inherit", "ignore"],
      });
      process.stdout.write("exit-gap-ready\\n");
      process.exit(0);
    `], { stdio: ["ignore", "pipe", "ignore"] });
    child.stdout.setEncoding("utf8");
    await new Promise((resolve, reject) => {
      child.stdout.once("data", (chunk) => {
        if (chunk.includes("exit-gap-ready")) resolve();
        else reject(new Error(`unexpected startup output: ${chunk}`));
      });
      child.once("error", reject);
    });
    await new Promise((resolve, reject) => {
      child.once("exit", resolve);
      child.once("error", reject);
    });
    let closed = false;
    child.once("close", () => { closed = true; });
    await stopChild(child);
    assert.equal(closed, true, "stopChild must await close after exit");
  });

  it("force-kills a real SIGTERM-ignoring child, awaits close, and frees its scratch", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "bifrost-term-proof-"));
    const stubborn = spawn(execPath, ["-e",
      "process.on('SIGTERM', () => {}); process.stdout.write('stubborn-ready\\n'); setInterval(() => {}, 1000);"],
      { stdio: ["ignore", "pipe", "ignore"], cwd: scratch });
    try {
      // Readiness comes from the child's observable ready record, no sleep.
      await new Promise((resolve, reject) => {
        stubborn.stdout.setEncoding("utf8");
        stubborn.stdout.once("data", (chunk) => {
          if (chunk.includes("stubborn-ready")) resolve();
          else reject(new Error(`unexpected startup output: ${chunk}`));
        });
        stubborn.once("error", reject);
        stubborn.once("close", () => reject(new Error("child exited before it could ignore SIGTERM")));
      });
      await stopChild(stubborn, 300);
      // stopChild resolves on close, so the dead child cannot hold the scratch.
      assert.equal(stubborn.exitCode, null, "SIGTERM-ignoring child must not exit via TERM");
      assert.equal(stubborn.signalCode, "SIGKILL", "SIGTERM-ignoring child must be force-killed");
      rmSync(scratch, { recursive: true, force: true });
      assert.equal(existsSync(scratch), false, "scratch must be removable after the forced close");
    } finally {
      await stopChild(stubborn, 300);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("rejects fake-provider startup when the child exits before its ready record", async () => {
    const failing = spawn(execPath, ["-e", "process.exit(3)"], { stdio: ["ignore", "pipe", "ignore"] });
    await assert.rejects(waitForFakeReady(failing), /fake provider exited before startup/);
    await stopChild(failing);
  });

  it("records forbidden fetch, socket, and UDP attempts through the same preloaded guard", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-guard-negative-home-"));
    try {
      const violations = join(home, "test-network-violations.log");
      const forbiddenPort = alternatePort(fakePort);
      assert.equal(alternatePort(65535), 65534);
      assert.equal(alternatePort(65534), 65535);
      assert.ok(Number.isInteger(fakePort) && fakePort >= 1 && fakePort <= 65535);
      assert.ok(Number.isInteger(forbiddenPort) && forbiddenPort >= 1 && forbiddenPort <= 65535);
      assert.notEqual(forbiddenPort, fakePort);
      writeFileSync(violations, "");
      // Same preload, same guard, same allowed-origin contract as runPi.
      // Without the preload (guard-removal mutation) nothing records the
      // forbidden attempts, so the record assertions below go RED.
      const probe = await new Promise((resolve, reject) => {
        const childProcess = spawn(execPath, ["-e", `
          const net = require("node:net");
          const dgram = require("node:dgram");
          (async () => {
            const allowed = await fetch("http://127.0.0.1:${fakePort}/_stats");
            const stats = await allowed.json();
            if (!stats || typeof stats.attempts !== "object") process.exitCode = 7;
            const unreachable = ${forbiddenPort};
            for (const attempt of [
              () => fetch("http://127.0.0.1:" + unreachable),
              () => new Promise((resolveAttempt) => {
                const socket = new net.Socket();
                const done = () => { socket.destroy(); resolveAttempt(); };
                socket.once("error", done);
                try { socket.connect({ port: unreachable, host: "127.0.0.1" }, done); } catch { done(); }
              }),
              () => new Promise((resolveAttempt) => {
                const socket = dgram.createSocket("udp4");
                const done = () => { try { socket.close(); } catch {} resolveAttempt(); };
                try {
                  socket.send(Buffer.from("fixture"), unreachable, "127.0.0.1", done);
                } catch { done(); }
              }),
            ]) { try { await attempt(); } catch {} }
          })();
        `], {
          stdio: ["ignore", "pipe", "pipe"],
          cwd: ROOT,
          env: {
            PATH: process.env.PATH,
            NODE_OPTIONS: `--require=${OUTBOUND_GUARD}`,
            BIFROST_TEST_ALLOWED_ORIGIN: `http://127.0.0.1:${fakePort}`,
            BIFROST_TEST_NETWORK_VIOLATIONS: violations,
          },
        });
        let stderr = "";
        let timedOut = false;
        childProcess.stderr.setEncoding("utf8");
        childProcess.stderr.on("data", (chunk) => { stderr += chunk; });
        // Bounded termination so a leaking probe cannot hang the suite.
        const killer = setTimeout(() => {
          timedOut = true;
          void stopChild(childProcess, 1_000);
        }, 30_000);
        childProcess.once("error", reject);
        childProcess.once("close", (code) => {
          clearTimeout(killer);
          if (timedOut) reject(new Error(`guard negative-control probe exceeded its bounded window (stderr=${stderr.length})`));
          else resolve({ code, stderr });
        });
      });
      assert.equal(probe.code, 0, probe.stderr);
      const attempts = readFileSync(violations, "utf8");
      assert.match(attempts, /blocked fetch to http:\/\/127\.0\.0\.1:/,
        "forbidden fetch must be blocked and specifically recorded");
      assert.match(attempts, /blocked socket connection to 127\.0\.0\.1:/,
        "forbidden socket connection must be blocked and specifically recorded");
      assert.match(attempts, /blocked UDP datagram to 127\.0\.0\.1/,
        "forbidden UDP datagram must be blocked and specifically recorded");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
