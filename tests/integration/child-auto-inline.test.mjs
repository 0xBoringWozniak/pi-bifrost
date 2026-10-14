import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const PI = join(ROOT, "node_modules", ".bin", "pi");
const EXTENSION = join(__dirname, "..", "fixtures", "child-auto-inline-extension.mjs");
const FAKE_SERVER = join(ROOT, "scripts", "fake-provider-server.mjs");
const OUTBOUND_GUARD = join(ROOT, "scripts", "test-outbound-guard.cjs");
const CREDENTIALS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "TYPESAFE_API_KEY", "HF_TOKEN", "HUGGINGFACE_HUB_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"];

let fakePort;

function stopChild(child, graceMs = 1_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const forceKill = setTimeout(() => child.kill("SIGKILL"), graceMs);
    child.once("close", () => {
      clearTimeout(forceKill);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

function startFakeServer() {
  const child = spawn("node", [FAKE_SERVER], { stdio: ["ignore", "pipe", "ignore"] });
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
        resolve({ child, port: ready.port });
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

async function readStats(port) {
  const response = await fetch(`http://127.0.0.1:${port}/_stats`);
  return response.json();
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
    let forceKill;
    childProcess.stdout.setEncoding("utf8");
    childProcess.stderr.setEncoding("utf8");
    childProcess.stdout.on("data", (chunk) => { stdout += chunk; });
    childProcess.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      childProcess.kill("SIGTERM");
    }, 60_000);
    childProcess.on("error", async (error) => {
      clearTimeout(timer);
      clearTimeout(forceKill);
      await stopChild(childProcess);
      reject(error);
    });
    childProcess.on("close", async (code) => {
      clearTimeout(timer);
      clearTimeout(forceKill);
      try {
        if (timedOut) throw new Error(`Pi timed out and exited after termination (stdout=${stdout.length}, stderr=${stderr.length})`);
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
        // Non-vacuous fence: the fenced Pi child reached exactly the allowed
        // origin (the attempts delta above is non-zero), and the pre-created
        // violation log proves the guard was armed and silent.
        assert.ok(Object.values(attempts).reduce((sum, count) => sum + count, 0) >= 1,
          "no provider attempt reached the allowed fake provider origin");
        assert.equal(result.violations, "", "network fence recorded a violation");
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(work, { recursive: true, force: true });
      }
    }
  });
});
