import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execPath } from "node:process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { processGroupExists, terminateProcessGroup } from "../../scripts/acceptance/core.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const child = join(root, "tests", "fixtures", "native-faux-lifecycle-child.mjs");
const guard = join(root, "scripts", "test-outbound-guard.cjs");
const credentials = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "TYPESAFE_API_KEY", "HF_TOKEN", "HUGGINGFACE_HUB_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"];
const DEADLINE_MS = 120_000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForGroupGone(groupId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processGroupExists(groupId)) return true;
    await delay(25);
  }
  return !processGroupExists(groupId);
}

// Bounded, owned-child runner. Every child is a detached process-group leader
// with an explicit deadline; on expiry the whole group is terminated through the
// shared acceptance helper. The result reports the observed close and whether the
// owned group is independently gone, so the caller can refuse to delete scratch
// while a group might still live.
function runNode(args, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEADLINE_MS;
  return new Promise((resolve, reject) => {
    const childProcess = spawn(execPath, args, { ...options, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const groupId = childProcess.pid;
    let stdout = "";
    let stderr = "";
    let exitCode = null;
    let exitSignal = null;
    let deadlineExceeded = false;
    let settled = false;
    let timer = null;

    if (childProcess.stdout) childProcess.stdout.setEncoding("utf8");
    if (childProcess.stderr) childProcess.stderr.setEncoding("utf8");
    childProcess.stdout?.on("data", (chunk) => { stdout += chunk; });
    childProcess.stderr?.on("data", (chunk) => { stderr += chunk; });

    const closePromise = new Promise((resolveClose) => {
      childProcess.once("close", (code, signal) => {
        exitCode = code;
        exitSignal = signal;
        resolveClose();
      });
    });

    async function settle() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let groupGone = !Number.isInteger(groupId) || groupId <= 0 || process.platform === "win32";
      if (!groupGone) {
        groupGone = await waitForGroupGone(groupId, 500);
        if (!groupGone) groupGone = await terminateProcessGroup(childProcess, { graceMs: 2_000, cleanupTimeoutMs: 5_000 });
      }
      try { childProcess.unref(); } catch {}
      resolve({ status: exitCode, signal: exitSignal, stdout, stderr, deadlineExceeded, groupId, groupGone });
    }

    timer = setTimeout(async () => {
      deadlineExceeded = true;
      try { await terminateProcessGroup(childProcess, { graceMs: 2_000, cleanupTimeoutMs: 5_000 }); } catch {}
      await closePromise;
      await settle();
    }, timeoutMs);

    closePromise.then(() => { if (!deadlineExceeded) void settle(); });
    childProcess.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

it("routes real AgentSession turns by direct rules, tier override precedence, and default", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "bifrost-native-lifecycle-"));
  const violations = join(scratch, "network-violations.log");
  const previousCredentials = Object.fromEntries(credentials.map((name) => [name, process.env[name]]));
  // Scratch is reclaimed only when every owned group is independently proven
  // gone. A spawn error or an unverified group death retains the scratch instead
  // of guessing, and names it for inspection.
  let cleanupVerified = true;
  async function runOwned(args, options) {
    try {
      const result = await runNode(args, options);
      if (result.groupGone !== true) cleanupVerified = false;
      return result;
    } catch (error) {
      cleanupVerified = false;
      throw error;
    }
  }
  try {
    for (const name of credentials) process.env[name] = "ambient-secret-fixture";
    const isolatedEnv = {
      PATH: process.env.PATH,
      HOME: join(scratch, "home"),
      BIFROST_TEST_ALLOWED_ORIGIN: "http://127.0.0.1:1",
      BIFROST_TEST_NETWORK_VIOLATIONS: violations,
      BIFROST_NATIVE_LIFECYCLE_SCRATCH: scratch,
      NODE_OPTIONS: `--require=${guard}`,
    };
    for (const name of credentials) assert.equal(isolatedEnv[name], undefined, `${name} must not enter child env`);

    writeFileSync(violations, "");
    const probe = await runOwned(["-e", `
      const net = require("node:net");
      const tls = require("node:tls");
      const dgram = require("node:dgram");
      (async () => {
        for (const attempt of [
          () => fetch("http://127.0.0.1:2"),
          () => fetch("https://127.0.0.1:2"),
          () => new net.Socket().connect({ port: 2, host: "127.0.0.1" }),
          () => tls.connect({ port: 2, host: "127.0.0.1" }),
          () => dgram.createSocket("udp4").send(Buffer.from("fixture"), 2, "127.0.0.1"),
        ]) { try { await attempt(); } catch {} }
        if (${JSON.stringify(credentials)}.some((name) => process.env[name] !== undefined)) process.exitCode = 9;
      })();
    `], { cwd: root, env: isolatedEnv });
    assert.equal(probe.deadlineExceeded, false, `guard probe must finish inside its bounded deadline\n${probe.stdout}\n${probe.stderr}`);
    assert.equal(probe.groupGone, true, "guard probe process group must be gone before scratch deletion");
    assert.equal(probe.status, 0, `${probe.stdout}\n${probe.stderr}`);
    const attempts = readFileSync(violations, "utf8");
    assert.match(attempts, /blocked fetch to https?:\/\/[^:\s]+:\d/);
    assert.match(attempts, /blocked socket connection to [^\s]+:\d/);
    assert.match(attempts, /blocked UDP datagram to/);

    // Guard-loading negative control: with deny-all the previously allowed origin
    // must itself be blocked and recorded. If the guard were not loaded, nothing
    // would be recorded and the reachable origin would succeed.
    writeFileSync(violations, "");
    const denyAllEnv = { ...isolatedEnv, BIFROST_TEST_DENY_ALL: "1" };
    delete denyAllEnv.BIFROST_TEST_ALLOWED_ORIGIN;
    const denyAllProbe = await runOwned(["-e", `
      (async () => {
        let reached = false;
        try { await fetch("http://127.0.0.1:1"); reached = true; } catch {}
        if (reached) process.exitCode = 10;
      })();
    `], { cwd: root, env: denyAllEnv });
    assert.equal(denyAllProbe.deadlineExceeded, false, `guard negative control must finish inside its bounded deadline\n${denyAllProbe.stdout}\n${denyAllProbe.stderr}`);
    assert.equal(denyAllProbe.groupGone, true, "guard negative control process group must be gone before scratch deletion");
    assert.equal(denyAllProbe.status, 0, `${denyAllProbe.stdout}\n${denyAllProbe.stderr}`);
    assert.match(readFileSync(violations, "utf8"), /blocked fetch to http:\/\/127\.0\.0\.1:1/, "deny-all control must prove the outbound guard is loaded and enforcing");

    for (const scenario of [
      // Baseline: direct rules, inline tier precedence, and the default tier on a physical seed.
      { name: "physical-default", env: {} },
      // Unmarked host explicitly selects Auto: expected physical routed target and inline handoff.
      { name: "auto-unmarked", env: {} },
      // Marked child host with an explicit physical model: never rerouted.
      { name: "child-physical", env: { PI_SUBAGENT_CHILD: "1" } },
      // Same marked child host with an explicit Auto selection: ordinary routing plus inline handoff.
      { name: "child-auto", env: { PI_SUBAGENT_CHILD: "1" } },
    ]) {
      const runScratch = join(scratch, scenario.name);
      mkdirSync(runScratch, { recursive: true });
      writeFileSync(violations, "");
      const result = await runOwned(["--test", "--experimental-strip-types", child], {
        cwd: root,
        env: { ...isolatedEnv, BIFROST_NATIVE_LIFECYCLE_SCRATCH: runScratch, BIFROST_NATIVE_LIFECYCLE_SCENARIO: scenario.name, ...scenario.env },
        timeoutMs: DEADLINE_MS,
      });
      assert.equal(result.deadlineExceeded, false, `${scenario.name} must complete inside its bounded deadline\n${result.stdout}\n${result.stderr}`);
      assert.equal(result.groupGone, true, `${scenario.name} owned process group must be gone before scratch deletion`);
      assert.equal(result.status, 0, `${scenario.name}\n${result.stdout}\n${result.stderr}`);
      assert.equal(readFileSync(violations, "utf8"), "", `${scenario.name} AgentSession made a blocked outbound attempt`);
    }
  } finally {
    for (const [name, value] of Object.entries(previousCredentials)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    if (cleanupVerified) {
      rmSync(scratch, { recursive: true, force: true });
    } else {
      process.stderr.write(`[native-lifecycle] retaining scratch without verified owned-group death: ${scratch}\n`);
    }
  }
});
