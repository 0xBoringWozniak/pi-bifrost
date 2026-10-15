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
// bounded deadline, group kill on timeout/error/close, and an awaited group
// exit before resolving. Reuses the existing acceptance process-group pattern.
function runIsolatedNode(args, { cwd, env, timeoutMs }) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const childProcess = spawn(execPath, args, { cwd, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    const stdout = { text: "", size: 0 };
    const stderr = { text: "", size: 0 };
    let timedOut = false;
    let finished = false;
    let termination;
    const terminate = () => termination ??= terminateProcessGroup(childProcess).catch(() => false);
    const timeout = setTimeout(() => {
      timedOut = true;
      void terminate();
    }, timeoutMs);
    childProcess.stdout.setEncoding("utf8");
    childProcess.stderr.setEncoding("utf8");
    childProcess.stdout.on("data", (chunk) => appendBounded(stdout, chunk));
    childProcess.stderr.on("data", (chunk) => appendBounded(stderr, chunk));
    const finish = async (status, signal, errorText = "") => {
      if (finished) return;
      finished = true;
      if (!termination && process.platform !== "win32" && processGroupExists(childProcess.pid)) terminate();
      const groupTerminated = termination ? await termination : true;
      clearTimeout(timeout);
      resolve({
        status: !groupTerminated ? 1 : timedOut ? 124 : status ?? 1,
        signal,
        stdout: stdout.text,
        stderr: `${stderr.text}${errorText}`,
        timedOut,
        cleanupFailed: !groupTerminated,
        groupGone: childProcess.pid === undefined || !processGroupExists(childProcess.pid),
        durationMs: Date.now() - startedAt,
      });
    };
    childProcess.once("error", (error) => { void finish(1, null, error.message); });
    childProcess.once("close", (status, signal) => { void finish(status, signal); });
  });
}

// Scratch is removed only after the owned group is confirmed gone; a live
// group retains its scratch for diagnosis.
function removeScratchWhenGroupGone(scratch, groupId) {
  if (groupId !== undefined && process.platform !== "win32" && processGroupExists(groupId)) return false;
  rmSync(scratch, { recursive: true, force: true });
  return true;
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
  const server = createServer((_request, response) => response.end("allowed fixture"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const previousCredentials = Object.fromEntries(credentials.map((name) => [name, process.env[name]]));
  try {
    for (const name of credentials) process.env[name] = "ambient-secret-fixture";
    const env = scrubbedEnv(scratch, port, violations);
    for (const name of credentials) assert.equal(env[name], undefined, `${name} entered isolated child env`);

    const probe = await runIsolatedNode(["-e", `
      const net = require("node:net");
      const dgram = require("node:dgram");
      (async () => {
        await (await fetch("http://127.0.0.1:${port}")).text();
        for (const attempt of [
          () => fetch("https://127.0.0.1:${port}"),
          () => fetch("http://127.0.0.1:${port + 1}"),
          () => new net.Socket().connect({ host: "127.0.0.1", port: ${port + 1} }),
          () => dgram.createSocket("udp4").send(Buffer.from("probe"), ${port}, "127.0.0.1"),
        ]) { try { await attempt(); } catch {} }
      })();
    `], { cwd: root, env, timeoutMs: 30_000 });
    assert.equal(probe.cleanupFailed, false, "probe process group cleanup failed");
    assert.equal(probe.status, 0, `${probe.stdout}\n${probe.stderr}`);
    const probeLog = readFileSync(violations, "utf8");
    assert.match(probeLog, /blocked fetch to https/);
    assert.match(probeLog, /blocked fetch to http/);
    assert.match(probeLog, /blocked socket connection/);
    assert.match(probeLog, /blocked UDP datagram/);
    writeFileSync(violations, "");

    const result = await runIsolatedNode(["--test", "--experimental-strip-types", child], { cwd: root, env, timeoutMs: 75_000 });
    assert.equal(result.timedOut, false, `child exceeded its deadline after ${result.durationMs}ms`);
    assert.equal(result.cleanupFailed, false, "child process group did not terminate cleanly");
    assert.equal(result.groupGone, true, "child process group is still observable after close");
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
  } finally {
    for (const [name, value] of Object.entries(previousCredentials)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await new Promise((resolve) => server.close(resolve));
    // The isolated runner awaited the owned group before resolving; scratch
    // goes away only with the group confirmed gone.
    assert.equal(removeScratchWhenGroupGone(scratch, undefined), true, "scratch was not removed after cleanup");
  }
});

it("bounds a hanging descendant group and retains scratch while the group stays active", { timeout: 30_000 }, async () => {
  if (process.platform === "win32") return;
  // A hanging parent plus its own descendant must be terminated as one owned
  // group within a bounded deadline.
  const hanging = await runIsolatedNode(["-e", `
    const { spawn } = require("node:child_process");
    spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" });
    setInterval(() => {}, 1000);
  `], { cwd: root, env: { PATH: process.env.PATH }, timeoutMs: 1_500 });
  assert.equal(hanging.timedOut, true);
  assert.equal(hanging.cleanupFailed, false, hanging.stderr);
  assert.equal(hanging.groupGone, true, "hanging descendant group survived the owned kill");
  assert.ok(hanging.durationMs < 15_000, `caller not bounded: ${hanging.durationMs}ms`);

  // Failed-kill detection uses the existing pattern: a group that never exits
  // reports cleanup failure instead of success.
  const stuck = await terminateProcessGroup(
    { pid: -1, kill: () => { throw Object.assign(new Error("stub"), { code: "ESRCH" }); } },
    { graceMs: 1, cleanupTimeoutMs: 1, groupExists: () => true, signalGroup: () => {}, wait: () => Promise.resolve() },
  );
  assert.equal(stuck, false, "a surviving group must report cleanup failure");

  // Scratch is retained while its group is still observable, then removed
  // once the group is gone: real group, real scratch, real durations.
  const retainedDir = mkdtempSync(join(tmpdir(), "bifrost-concurrent-retain-"));
  const keeper = spawn(execPath, ["-e", "setInterval(() => {}, 1000);"], { detached: true, stdio: "ignore" });
  keeper.unref();
  try {
    assert.equal(processGroupExists(keeper.pid), true, "keeper group never started");
    assert.equal(removeScratchWhenGroupGone(retainedDir, keeper.pid), false, "active-group scratch was removed");
    assert.equal(existsSync(retainedDir), true, "active-group scratch missing while group lives");
  } finally {
    await terminateProcessGroup(keeper);
  }
  assert.equal(removeScratchWhenGroupGone(retainedDir, keeper.pid), true, "scratch retained after group exit");
  assert.equal(existsSync(retainedDir), false, "scratch not removed after cleanup");
});
