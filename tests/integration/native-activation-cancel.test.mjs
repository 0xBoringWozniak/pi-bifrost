import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { execPath } from "node:process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { processGroupExists, terminateProcessGroup } from "../../scripts/acceptance/core.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const child = join(root, "tests", "fixtures", "native-activation-cancel-child.mjs");
const guard = join(root, "scripts", "test-outbound-guard.cjs");
const credentials = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "TYPESAFE_API_KEY", "HF_TOKEN", "HUGGINGFACE_HUB_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"];
const DEADLINE_MS = 120_000;
const PRODUCTION_SHA256 = "3164a3dbc41a864c68bede2f9e7365c5ed32bbbcd91fc584a3d07446014e3f12";
const LATE_ABORT_GUARD = `      if (ctx.signal?.aborted) {
        endClassify({ kind: classification.kind, outcome: "aborted" });
        endInput({ outcome: "aborted" });
        return routeBoundary
          ? strictInputHandled(ctx, state, originalText, editorTextAtInput, "Bifrost routing was cancelled; the turn was not sent. Resubmit after repair.")
          : defaultAction;
      }`;

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
    let closeObserved = false;
    let timer = null;

    if (childProcess.stdout) childProcess.stdout.setEncoding("utf8");
    if (childProcess.stderr) childProcess.stderr.setEncoding("utf8");
    childProcess.stdout?.on("data", (chunk) => { stdout += chunk; });
    childProcess.stderr?.on("data", (chunk) => { stderr += chunk; });

    const closePromise = new Promise((resolveClose) => {
      childProcess.once("close", (code, signal) => {
        closeObserved = true;
        exitCode = code;
        exitSignal = signal;
        resolveClose();
      });
    });

    async function settle() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let groupGone = false;
      if (process.platform !== "win32" && Number.isInteger(groupId) && groupId > 0) {
        groupGone = await waitForGroupGone(groupId, 500);
        if (!groupGone) {
          try { await terminateProcessGroup(childProcess, { graceMs: 2_000, cleanupTimeoutMs: 5_000 }); } catch {}
          groupGone = !processGroupExists(groupId);
        }
      }
      if (!closeObserved) {
        let drainTimer;
        await Promise.race([closePromise, new Promise((resolveDrain) => { drainTimer = setTimeout(resolveDrain, 500); })]);
        clearTimeout(drainTimer);
      }
      if (!closeObserved) {
        childProcess.stdout?.destroy();
        childProcess.stderr?.destroy();
      }
      childProcess.unref();
      resolve({ status: exitCode, signal: exitSignal, stdout, stderr, deadlineExceeded, groupId, groupGone, closeObserved });
    }

    timer = setTimeout(() => {
      deadlineExceeded = true;
      void settle();
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

it("cancels real AgentSession activation behind a proven deny-all fence", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "bifrost-native-activation-"));
  const violations = join(scratch, "network-violations.log");
  const previousCredentials = Object.fromEntries(credentials.map((name) => [name, process.env[name]]));
  // The child never deletes scratch; the parent reclaims it only when every owned
  // group is independently proven gone. A spawn error or unverified group death
  // retains the scratch and names it for inspection.
  let cleanupVerified = true;
  let runCounter = 0;
  let isolatedEnv;
  async function runOwned(args, options) {
    try {
      const result = await runNode(args, options);
      if (result.groupGone !== true || result.closeObserved !== true) cleanupVerified = false;
      return result;
    } catch (error) {
      cleanupVerified = false;
      throw error;
    }
  }
  async function runScenario(scenario, env = {}) {
    runCounter += 1;
    const runScratch = join(scratch, `run-${runCounter}-${scenario}`);
    mkdirSync(runScratch, { recursive: true });
    writeFileSync(violations, "");
    const result = await runOwned(["--test", "--experimental-strip-types", child], {
      cwd: root,
      env: { ...isolatedEnv, BIFROST_NATIVE_ACTIVATION_SCRATCH: runScratch, BIFROST_NATIVE_ACTIVATION_SCENARIO: scenario, ...env },
      timeoutMs: DEADLINE_MS,
    });
    return { ...result, runScratch };
  }

  try {
    for (const name of credentials) process.env[name] = "ambient-secret-fixture";
    isolatedEnv = {
      PATH: process.env.PATH,
      HOME: join(scratch, "home"),
      BIFROST_TEST_DENY_ALL: "1",
      BIFROST_TEST_NETWORK_VIOLATIONS: violations,
      NODE_OPTIONS: `--require=${guard}`,
    };
    for (const name of credentials) assert.equal(isolatedEnv[name], undefined, `${name} must not enter child env`);

    // Positive guard probe first: the deny-all fence must block fetch, socket, and
    // UDP before any scenario is credited with zero violations.
    writeFileSync(violations, "");
    const probe = await runOwned(["-e", `
      const net = require("node:net");
      const tls = require("node:tls");
      const dgram = require("node:dgram");
      const assert = require("node:assert/strict");
      (async () => {
        for (const url of ["http://127.0.0.1:2", "https://127.0.0.1:2"]) {
          await assert.rejects(async () => fetch(url, { signal: AbortSignal.timeout(500) }), /blocked fetch/);
        }
        for (const socket of [new net.Socket(), new tls.TLSSocket()]) {
          socket.on("error", () => {});
          try { assert.throws(() => socket.connect({ port: 2, host: "127.0.0.1" }), /blocked socket connection/); }
          finally { socket.destroy(); }
        }
        const udp = dgram.createSocket("udp4");
        udp.on("error", () => {});
        try { assert.throws(() => udp.send(Buffer.from("fixture"), 2, "127.0.0.1"), /blocked UDP datagram/); }
        finally { try { udp.close(); } catch {} }
        if (${JSON.stringify(credentials)}.some((name) => process.env[name] !== undefined)) process.exitCode = 9;
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `], { cwd: root, env: isolatedEnv });
    assert.equal(probe.deadlineExceeded, false, `guard probe must finish inside its bounded deadline\n${probe.stdout}\n${probe.stderr}`);
    if (process.platform !== "win32") assert.equal(probe.groupGone, true, "guard probe process group must be gone before scratch deletion");
    assert.equal(probe.status, 0, `${probe.stdout}\n${probe.stderr}`);
    const attempts = readFileSync(violations, "utf8");
    assert.match(attempts, /blocked fetch to https?:\/\/[^:\s]+:\d/);
    assert.match(attempts, /blocked socket connection to [^\s]+:\d/);
    assert.match(attempts, /blocked UDP datagram to/);

    // GREEN: real AgentSession + real extension. The aborted steer and the newer
    // manual selection must produce zero forbidden provider callbacks.
    for (const scenario of ["cancel-late-classifier", "manual-override"]) {
      const green = await runScenario(scenario);
      assert.equal(green.deadlineExceeded, false, `${scenario} must complete inside its bounded deadline\n${green.stdout}\n${green.stderr}`);
      if (process.platform !== "win32") assert.equal(green.groupGone, true, `${scenario} owned process group must be gone before scratch deletion`);
      assert.equal(green.status, 0, `${scenario}\n${green.stdout}\n${green.stderr}`);
      assert.equal(readFileSync(violations, "utf8"), "", `${scenario} made a blocked outbound attempt`);
    }

    // Sensitivity proof: remove the late-abort guard in a private scratch copy of
    // index.ts. The same child scenario must fail its forbidden-dispatch assertion,
    // and the failure must be the named assertion, not a startup/syntax failure.
    const original = readFileSync(join(root, "index.ts"), "utf8");
    assert.equal(sha256(original), PRODUCTION_SHA256, "production index.ts must match the reviewed baseline hash");
    assert.ok(original.includes(LATE_ABORT_GUARD), "the late-abort guard must exist in production source");
    const mutantSource = original.replace(LATE_ABORT_GUARD, "      console.error('MUTANT_GUARD_REMOVED_REACHED');");
    assert.notEqual(mutantSource, original, "fault injection must change the production source");
    const mutantDir = join(scratch, "mutant");
    mkdirSync(mutantDir, { recursive: true });
    for (const file of readdirSync(root)) {
      if (file.endsWith(".ts")) copyFileSync(join(root, file), join(mutantDir, file));
    }
    writeFileSync(join(mutantDir, "index.ts"), mutantSource);
    symlinkSync(join(root, "node_modules"), join(mutantDir, "node_modules"));

    const red = await runScenario("cancel-late-classifier", { BIFROST_NATIVE_ACTIVATION_EXTENSION: join(mutantDir, "index.ts") });
    assert.equal(red.deadlineExceeded, false, `mutant run must finish inside its bounded deadline\n${red.stdout}\n${red.stderr}`);
    assert.notEqual(red.status, 0, `the guard-removed mutant must fail the native forbidden-dispatch assertion\n${red.stdout}\n${red.stderr}`);
    assert.match(`${red.stdout}\n${red.stderr}`, /forbidden late dispatch observable/,
      "the mutant failure must be the intended forbidden-dispatch assertion");
    assert.equal(readFileSync(violations, "utf8"), "", "mutant run made a blocked outbound attempt");

    // GREEN restored: the pristine extension again passes the same scenario.
    const restored = await runScenario("cancel-late-classifier");
    assert.equal(restored.deadlineExceeded, false, `restored run must finish inside its bounded deadline\n${restored.stdout}\n${restored.stderr}`);
    assert.equal(restored.status, 0, `restored run\n${restored.stdout}\n${restored.stderr}`);
    assert.equal(readFileSync(violations, "utf8"), "", "restored run made a blocked outbound attempt");
  } finally {
    for (const [name, value] of Object.entries(previousCredentials)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    if (cleanupVerified) {
      rmSync(scratch, { recursive: true, force: true });
    } else {
      process.stderr.write(`[native-activation] retaining scratch without verified owned-group death: ${scratch}\n`);
    }
  }
});

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}
