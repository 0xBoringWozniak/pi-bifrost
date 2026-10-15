import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execPath } from "node:process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { processGroupExists, terminateProcessGroup } from "../../scripts/acceptance/core.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const child = join(root, "tests", "fixtures", "concurrent-sessions-child.mjs");
const guard = join(root, "scripts", "test-outbound-guard.cjs");
const credentials = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "TYPESAFE_API_KEY", "HF_TOKEN"];
const MAX_STREAM_BYTES = 256 * 1024;

function appendBounded(capture, chunk) {
  if (capture.size >= MAX_STREAM_BYTES) return;
  const text = chunk.toString("utf8");
  const room = MAX_STREAM_BYTES - capture.size;
  capture.text += text.slice(0, room);
  capture.size += Math.min(room, Buffer.byteLength(text));
}

// The caller owns its child process group: detached spawn, bounded output,
// bounded kill deadline, and a hard wall bound that settles independently of
// error/close. On the failure path only caller-owned stdio handles are
// released; group death is never claimed, only observed via processGroupExists.
// signalGroup is an injection point for the denied-kill control; production
// use always passes the real group signal through terminateProcessGroup.
function runIsolatedNode(args, {
  cwd,
  env,
  timeoutMs,
  graceMs = 2000,
  cleanupTimeoutMs = 3000,
  drainMs = 2000,
  marginMs = 5000,
  signalGroup,
}) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const childProcess = spawn(execPath, args, { cwd, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    const groupId = childProcess.pid;
    const stdout = { text: "", size: 0 };
    const stderr = { text: "", size: 0 };
    let timedOut = false;
    let hardBoundHit = false;
    let closeMissing = false;
    let exitCode;
    let exitSignal;
    let finished = false;
    let termination;
    const terminateOptions = signalGroup ? { graceMs, cleanupTimeoutMs, signalGroup } : { graceMs, cleanupTimeoutMs };
    const terminate = () => termination ??= terminateProcessGroup(childProcess, terminateOptions).catch(() => false);
    const destroyOwnedHandles = () => {
      try { childProcess.stdout.destroy(); } catch {}
      try { childProcess.stderr.destroy(); } catch {}
      childProcess.removeAllListeners("error");
      childProcess.removeAllListeners("close");
      childProcess.removeAllListeners("exit");
    };
    const finish = async () => {
      if (finished) return;
      finished = true;
      clearTimeout(killTimer);
      clearTimeout(drainTimer);
      clearTimeout(hardTimer);
      if (!termination && process.platform !== "win32" && groupId !== undefined && processGroupExists(groupId)) terminate();
      const groupTerminated = termination ? await termination : true;
      if (hardBoundHit || closeMissing) destroyOwnedHandles();
      resolve({
        status: !groupTerminated ? 1 : exitCode !== undefined && exitCode !== null ? exitCode : timedOut || hardBoundHit ? 124 : 1,
        signal: exitSignal ?? null,
        stdout: stdout.text,
        stderr: stderr.text,
        timedOut,
        hardBoundHit,
        closeMissing,
        cleanupFailed: !groupTerminated,
        groupGone: groupId === undefined || !processGroupExists(groupId),
        groupId,
        durationMs: Date.now() - startedAt,
      });
    };
    const killTimer = setTimeout(() => {
      timedOut = true;
      void terminate().then(() => {
        // Settlement still requires exit/close/drain/hard-bound below; the
        // kill alone never resolves the caller.
      });
    }, timeoutMs);
    // After exit without close (a descendant inherited the pipes), wait a
    // bounded drain, then settle with the exit code and clean the group.
    let drainArmed = false;
    let drainTimer;
    const armDrain = () => {
      if (drainArmed) return;
      drainArmed = true;
      drainTimer = setTimeout(() => {
        if (finished) return;
        closeMissing = true;
        void finish();
      }, drainMs);
      drainTimer.unref?.();
    };
    const hardTimer = setTimeout(() => {
      hardBoundHit = true;
      void finish();
    }, timeoutMs + graceMs + cleanupTimeoutMs + drainMs + marginMs);
    childProcess.stdout.setEncoding("utf8");
    childProcess.stderr.setEncoding("utf8");
    childProcess.stdout.on("data", (chunk) => appendBounded(stdout, chunk));
    childProcess.stderr.on("data", (chunk) => appendBounded(stderr, chunk));
    childProcess.once("error", () => { void finish(); });
    childProcess.once("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      armDrain();
    });
    childProcess.once("close", () => { void finish(); });
  });
}

// Scratch is removed only when every tracked owned group is confirmed gone.
// The group list is required: there is no path that deletes scratch without
// checking observed group absence first.
function removeScratchWhenGroupGone(scratch, groupIds) {
  assert.ok(Array.isArray(groupIds), "owned group list is required before scratch removal");
  if (process.platform !== "win32" && groupIds.some((groupId) => groupId !== undefined && processGroupExists(groupId))) return false;
  rmSync(scratch, { recursive: true, force: true });
  return !existsSync(scratch);
}

function scrubbedEnv(scratch, port, violations) {
  return {
    PATH: process.env.PATH,
    HOME: join(scratch, "home"),
    BIFROST_CONCURRENT_SCRATCH: scratch,
    BIFROST_TEST_ALLOWED_ORIGIN: `http://127.0.0.1:${port}`,
    BIFROST_TEST_NETWORK_VIOLATIONS: violations,
    NODE_OPTIONS: `--require=${guard}`,
  };
}

it("proves concurrent native AgentSession dispatch and isolation behind non-vacuous network fence", { timeout: 90_000 }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), "bifrost-concurrent-"));
  const violations = join(scratch, "network-violations.log");
  const ownedGroups = [];
  const previousCredentials = Object.fromEntries(credentials.map((name) => [name, process.env[name]]));
  let bodyError;
  let probe;
  let result;
  let server;
  try {
    server = createServer((_request, response) => response.end("allowed fixture"));
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
    } catch (error) {
      throw new Error(`guard server failed to start: ${error instanceof Error ? error.message : String(error)}`);
    }
    const port = server.address().port;
    // Negative probes target a port that can never be the ephemeral guard
    // server, so an unrelated listener cannot mask a fence failure.
    const closedPort = port === 65535 ? 65534 : 65535;
    for (const name of credentials) process.env[name] = "ambient-secret-fixture";
    const env = scrubbedEnv(scratch, port, violations);
    for (const name of credentials) assert.equal(env[name], undefined, `${name} entered isolated child env`);

    probe = await runIsolatedNode(["-e", `
      const net = require("node:net");
      const dgram = require("node:dgram");
      (async () => {
        await (await fetch("http://127.0.0.1:${port}")).text();
        for (const attempt of [
          () => fetch("https://127.0.0.1:${port}"),
          () => fetch("http://127.0.0.1:${closedPort}"),
          () => new net.Socket().connect({ host: "127.0.0.1", port: ${closedPort} }),
          () => dgram.createSocket("udp4").send(Buffer.from("probe"), ${closedPort}, "127.0.0.1"),
        ]) { try { await attempt(); } catch {} }
      })();
    `], { cwd: root, env, timeoutMs: 30_000 });
    ownedGroups.push(probe.groupId);
    assert.equal(probe.cleanupFailed, false, `probe group ${probe.groupId} cleanup failed`);
    assert.equal(probe.groupGone, true, `probe group ${probe.groupId} still observable after close`);
    assert.equal(probe.status, 0, `${probe.stdout}\n${probe.stderr}`);
    const probeLog = readFileSync(violations, "utf8");
    assert.match(probeLog, /blocked fetch to https/);
    assert.match(probeLog, /blocked fetch to http/);
    assert.match(probeLog, /blocked socket connection/);
    assert.match(probeLog, /blocked UDP datagram/);
    writeFileSync(violations, "");

    result = await runIsolatedNode(["--test", "--experimental-strip-types", child], { cwd: root, env, timeoutMs: 60_000 });
    ownedGroups.push(result.groupId);
    assert.equal(result.timedOut, false, `child group ${result.groupId} exceeded its deadline after ${result.durationMs}ms`);
    assert.equal(result.hardBoundHit, false, `child group ${result.groupId} needed the hard wall bound`);
    assert.equal(result.cleanupFailed, false, `child group ${result.groupId} did not terminate cleanly`);
    assert.equal(result.groupGone, true, `child group ${result.groupId} still observable after close`);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.signal, null, "child required forced termination; cleanup leaked a handle");
    assert.equal(readFileSync(violations, "utf8"), "", "native sessions made blocked outbound request");
    const report = JSON.parse(readFileSync(join(scratch, "concurrent-report.json"), "utf8"));
    assert.equal(report.host.separateRuntimeRegistries, true);
    assert.equal(report.cancellation.sessionBUnaffected, true);
    assert.ok(report.cancellation.sessionAOutcome.every((status) => status === "fulfilled" || status === "rejected"));
    assert.equal(report.storage.sharedWorkspacePolicy, true);
    assert.equal(report.storage.pinSessionLocal, true);
    assert.equal(report.cleanup.fauxAPending, 0);
    assert.equal(report.cleanup.fauxBPending, 0);
    assert.ok(report.invocations.some(({ model }) => model === "faux-a/session-a-model"));
    assert.ok(report.invocations.some(({ model }) => model === "faux-b/session-b-model"));
    assert.ok(!report.invocations.some(({ model }) => /standby/.test(model)), "standby decoy reached a provider");
  } catch (error) {
    bodyError = error;
  }
  try {
    for (const [name, value] of Object.entries(previousCredentials)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    if (server) await new Promise((resolve) => server.close(() => resolve()));
  } catch {}
  const liveGroups = ownedGroups.filter((groupId) => groupId !== undefined && process.platform !== "win32" && processGroupExists(groupId));
  let cleanupError;
  for (const [label, run] of [["probe", probe], ["child", result]]) {
    if (run && (run.cleanupFailed || run.hardBoundHit)) {
      cleanupError = new Error(`${label} group ${run.groupId} unsettled (cleanupFailed=${run.cleanupFailed}, hardBoundHit=${run.hardBoundHit}); scratch retained`);
    }
  }
  if (!cleanupError && liveGroups.length) {
    cleanupError = new Error(`scratch retained: owned groups still active ${liveGroups.join(",")}`);
  }
  if (!cleanupError) {
    if (!removeScratchWhenGroupGone(scratch, ownedGroups)) {
      cleanupError = new Error(`scratch retained: group absence changed during removal for groups ${ownedGroups.join(",")}`);
    }
  }
  if (bodyError) {
    if (cleanupError) process.stderr.write(`concurrent-sessions cleanup: ${cleanupError.message}\n`);
    throw bodyError;
  }
  if (cleanupError) throw cleanupError;
});

it("bounds a hanging descendant group and retains scratch while the group stays active", { timeout: 30_000 }, async () => {
  if (process.platform === "win32") return;
  const hanging = await runIsolatedNode(["-e", `
    const { spawn } = require("node:child_process");
    spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" });
    setInterval(() => {}, 1000);
  `], { cwd: root, env: { PATH: process.env.PATH }, timeoutMs: 1_500 });
  assert.equal(hanging.timedOut, true);
  assert.equal(hanging.hardBoundHit, false, `hanging group ${hanging.groupId} needed the hard wall bound`);
  assert.equal(hanging.cleanupFailed, false, hanging.stderr);
  assert.equal(hanging.groupGone, true, `hanging descendant group ${hanging.groupId} survived the owned kill`);
  assert.ok(hanging.durationMs < 15_000, `caller not bounded: ${hanging.durationMs}ms`);
});

it("fails bounded with scratch retained when the owned group kill is denied", { timeout: 30_000 }, async () => {
  if (process.platform === "win32") return;
  // Actual caller path with real PIDs, pipes, wall time and scratch; only the
  // group kill signal is denied. Settlement must not depend on close.
  const scratch = mkdtempSync(join(tmpdir(), "bifrost-concurrent-denied-"));
  const startedAt = Date.now();
  const denied = await runIsolatedNode(["-e", `
    const { spawn } = require("node:child_process");
    spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" });
    setInterval(() => {}, 1000);
  `], {
    cwd: root,
    env: { PATH: process.env.PATH },
    timeoutMs: 1_500,
    graceMs: 500,
    cleanupTimeoutMs: 1_000,
    drainMs: 500,
    marginMs: 2_000,
    signalGroup: () => {},
  });
  const wallMs = Date.now() - startedAt;
  assert.equal(denied.timedOut, true);
  assert.equal(denied.hardBoundHit, true, `denied-kill caller for group ${denied.groupId} settled via close instead of the wall bound`);
  assert.equal(denied.cleanupFailed, true, `denied kill of owned group ${denied.groupId} reported success`);
  assert.equal(denied.groupGone, false, `owned group ${denied.groupId} gone despite denied kill`);
  assert.ok(denied.durationMs < 15_000 && wallMs < 15_000, `denied-kill caller not bounded: runner ${denied.durationMs}ms, wall ${wallMs}ms`);
  assert.equal(removeScratchWhenGroupGone(scratch, [denied.groupId]), false, "active-group scratch was removed");
  assert.equal(existsSync(scratch), true, `scratch for live group ${denied.groupId} missing`);
  // Restoration signals only the owned group, then scratch goes away once the
  // group is confirmed gone.
  try { process.kill(-denied.groupId, "SIGKILL"); } catch {}
  const deadline = Date.now() + 5_000;
  while (processGroupExists(denied.groupId) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(processGroupExists(denied.groupId), false, `owned group ${denied.groupId} survived restoration`);
  assert.equal(removeScratchWhenGroupGone(scratch, [denied.groupId]), true, `scratch for group ${denied.groupId} retained after group exit`);
  assert.equal(existsSync(scratch), false, "scratch not removed after cleanup");
});

it("settles children whose descendants outlive them via inherited or no stdio", { timeout: 30_000 }, async () => {
  if (process.platform === "win32") return;
  // The descendant inherits the leader's pipes, so close never arrives; the
  // caller settles on the bounded exit drain and still cleans the group.
  const inherited = await runIsolatedNode(["-e", `
    const { spawn } = require("node:child_process");
    const descendant = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000);"], { stdio: "inherit" });
    descendant.unref();
    process.stdout.write("leader-done");
  `], { cwd: root, env: { PATH: process.env.PATH }, timeoutMs: 10_000 });
  assert.equal(inherited.status, 0, inherited.stderr);
  assert.equal(inherited.closeMissing, true, `inherited-pipe group ${inherited.groupId} closed cleanly; drain path not exercised`);
  assert.equal(inherited.cleanupFailed, false, `inherited-pipe group ${inherited.groupId} cleanup failed`);
  assert.equal(inherited.groupGone, true, `inherited-pipe group ${inherited.groupId} still observable`);
  assert.match(inherited.stdout, /leader-done/);
  assert.ok(inherited.durationMs < 15_000, `inherited-pipe caller not bounded: ${inherited.durationMs}ms`);
  // A no-stdio descendant holds no pipes: close arrives normally and the
  // lingering group member is still terminated and awaited.
  const nostriod = await runIsolatedNode(["-e", `
    const { spawn } = require("node:child_process");
    const descendant = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000);"], { stdio: "ignore" });
    descendant.unref();
    process.stdout.write("leader-done");
  `], { cwd: root, env: { PATH: process.env.PATH }, timeoutMs: 10_000 });
  assert.equal(nostriod.status, 0, nostriod.stderr);
  assert.equal(nostriod.cleanupFailed, false, `no-stdio group ${nostriod.groupId} cleanup failed`);
  assert.equal(nostriod.groupGone, true, `no-stdio group ${nostriod.groupId} still observable`);
  assert.match(nostriod.stdout, /leader-done/);
  assert.ok(nostriod.durationMs < 15_000, `no-stdio caller not bounded: ${nostriod.durationMs}ms`);
});
