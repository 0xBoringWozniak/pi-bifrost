import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execPath } from "node:process";
import { processGroupExists, terminateProcessGroup } from "../../scripts/acceptance/core.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const PI = join(ROOT, "node_modules", ".bin", "pi");
const EXTENSION = join(__dirname, "..", "fixtures", "child-auto-inline-extension.mjs");
const DESCENDANT_CLI = join(__dirname, "..", "fixtures", "child-auto-descendant-cli.mjs");
const PIPE_RACE_CLI = join(__dirname, "..", "fixtures", "child-auto-pipe-race-descendant-cli.mjs");
const FAKE_SERVER = join(ROOT, "scripts", "fake-provider-server.mjs");
const OUTBOUND_GUARD = join(ROOT, "scripts", "test-outbound-guard.cjs");
const CREDENTIALS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "TYPESAFE_API_KEY", "HF_TOKEN", "HUGGINGFACE_HUB_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"];

let fakePort;
const trackedChildren = new WeakMap();
// Upper bound for awaiting the close event. A descendant that inherited a
// child's stdio can hold the pipe open after the child itself has exited, so
// the wait is bounded to keep a leak from hanging the suite indefinitely.
const CLOSE_WAIT_MS = 10_000;
// Bounds for the owned-descendant path: a child that never reaches close is
// terminated as the leader of a process group this suite owns, and the result
// is only true when the real close event then arrives.
const DESCENDANT_GRACE_MS = 2_000;
const DESCENDANT_CLEANUP_MS = 5_000;
// How long the leader's own close may take after its grace window before the
// owned group is terminated anyway. Kept short so a stubborn leader cannot
// spend the whole descendant budget before the group phase begins.
const LEADER_CLOSE_SLOP_MS = 2_000;

// Every child this suite owns is spawned as the leader of its own process group
// so cleanup can signal that group and nothing else. Each carries one lifecycle
// record: the observed close event plus a single coordinated termination
// promise. The close path and the timeout path await that same promise, so
// neither can settle while a descendant of the owned group is still alive.
function spawnOwned(command, args, options = {}) {
  const child = spawn(command, args, { detached: process.platform !== "win32", ...options });
  let markClosed;
  const observed = new Promise((resolve) => { markClosed = resolve; });
  const lifecycle = { isClosed: false, observed, termination: null };
  child.once("close", () => {
    lifecycle.isClosed = true;
    markClosed(true);
  });
  lifecycle.terminate = (graceMs) => {
    // Memoized on purpose: one owned group, one termination, one result.
    lifecycle.termination ??= terminateOwnedGroup(child, graceMs);
    return lifecycle.termination;
  };
  trackedChildren.set(child, lifecycle);
  return child;
}

function closeTracking(child) {
  const tracking = trackedChildren.get(child);
  if (!tracking) throw new Error("child was not created by spawnOwned, so its close event is not tracked");
  return tracking;
}

// Resolves true only when the close event has actually been observed. False
// means the bound expired with a descendant still holding an inherited pipe.
function waitForObservedClose(child, boundMs = CLOSE_WAIT_MS) {
  const tracking = closeTracking(child);
  if (tracking.isClosed) return Promise.resolve(true);
  let bound;
  return Promise.race([
    tracking.observed,
    new Promise((resolve) => { bound = setTimeout(() => resolve(false), boundMs); }),
  ]).then((observed) => {
    clearTimeout(bound);
    return observed;
  });
}

// Terminates the owned child and its process group, and resolves true only when
// BOTH halves of the cleanup are proven: the leader's close event was actually
// observed, and the owned group is dead. A close event alone proves nothing --
// a descendant can close the inherited pipes when signalled and keep running,
// and an already-closed leader says nothing about what it left behind. False
// means cleanup could not be verified, and every caller must fail rather than
// assume.
async function terminateOwnedGroup(child, graceMs = 1_000) {
  if (child.exitCode === null && child.signalCode === null) {
    const forceKill = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, graceMs);
    try { child.kill("SIGTERM"); } catch {}
    await waitForObservedClose(child, graceMs + LEADER_CLOSE_SLOP_MS);
    clearTimeout(forceKill);
  }
  // Signal only the process group this suite owns. Never a parent or shared
  // group, and never a bare pattern match against unrelated processes.
  const groupSignalled = await terminateProcessGroup(child, {
    graceMs: DESCENDANT_GRACE_MS,
    cleanupTimeoutMs: DESCENDANT_CLEANUP_MS,
  });
  // terminateProcessGroup already returns group death; re-derive it here so the
  // result rests on observed evidence rather than on the helper's contract.
  const groupDead = groupSignalled === true && !processGroupExists(child.pid);
  const leaderClosed = await waitForObservedClose(child, DESCENDANT_CLEANUP_MS + CLOSE_WAIT_MS);
  return leaderClosed && groupDead;
}

// Terminates an owned child, resolving true only when its cleanup is verified.
async function stopChild(child, graceMs = 1_000) {
  return closeTracking(child).terminate(graceMs);
}

// Test-only seam: forces one child's cleanup to report failure without touching
// shared state, so a caller's cleanup-failure cause can be asserted directly.
function forceCleanupFailure(child) {
  closeTracking(child).terminate = () => Promise.resolve(false);
}

// Every caller reports cleanup the same way: the primary cause first, then an
// explicit clause when the owned group could not be verified gone. A caller can
// therefore tell "this run timed out" from "this run timed out and its cleanup
// could not be verified".
function cleanupFailure(message, verified) {
  return verified
    ? message
    : `${message}; cleanup failure: the owned process group did not reach a verified dead state`;
}

function waitForFakeReady(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const fail = async (message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // The stop result is the only evidence of whether this child is really
      // gone. Discarding it is how an unverified cleanup stayed invisible.
      const verified = await stopChild(child);
      reject(new Error(cleanupFailure(message, verified)));
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
  const child = spawnOwned("node", [FAKE_SERVER], { stdio: ["ignore", "pipe", "ignore"] });
  return waitForFakeReady(child).then(({ port }) => ({ child, port }));
}

async function readStats(port) {
  const response = await fetch(`http://127.0.0.1:${port}/_stats`);
  return response.json();
}

// A forbidden port must stay a legal, distinct port across the whole valid
// range. The previous `port + 1` arithmetic overflowed to 65536 as soon as the
// fake provider bound the top of the range, so fetch rejected before the
// guard ever logged a violation.
function alternatePort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError("provider port must be 1..65535");
  return port === 65535 ? 65534 : 65535;
}

function assertAlternatePortStaysLegalAndDistinct(port) {
  const alternate = alternatePort(port);
  assert.ok(Number.isInteger(alternate) && alternate >= 1 && alternate <= 65535,
    `alternatePort(${port}) left the legal port range: ${alternate}`);
  assert.notEqual(alternate, port, `alternatePort(${port}) must differ from the allowed port`);
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

function runPi({ home, work, model, prompt, child, command = PI, args, windowMs = 60_000, terminationGraceMs = 5_000, extraEnv = {} }) {
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
  Object.assign(env, extraEnv);
  return new Promise((resolve, reject) => {
    const resolvedArgs = args ?? ["-e", EXTENSION, "--approve", "--no-session", "--no-tools", "--model", model, "-p", prompt];
    const childProcess = spawnOwned(command, resolvedArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: work,
      env,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let spawnError;
    let settled = false;
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle(value);
    };
    childProcess.stdout.setEncoding("utf8");
    childProcess.stderr.setEncoding("utf8");
    childProcess.stdout.on("data", (chunk) => { stdout += chunk; });
    childProcess.stderr.on("data", (chunk) => { stderr += chunk; });
    childProcess.on("error", (error) => { spawnError = error; });
    // Bounded termination: SIGTERM, then SIGKILL after the grace window, and
    // then the owned process group. The run settles only once that cleanup has
    // reported back, so a child whose descendant closes the inherited pipes on
    // SIGTERM and keeps running fails the run instead of settling on a close
    // event that proves nothing.
    const lifecycle = closeTracking(childProcess);
    const timeoutDetail = () => `Pi exceeded the bounded run window and was force-killed after SIGTERM (stdout=${stdout.length}, stderr=${stderr.length})`;
    const timer = setTimeout(() => {
      timedOut = true;
      void lifecycle.terminate(terminationGraceMs).then((verified) => {
        finish(reject, new Error(cleanupFailure(timeoutDetail(), verified)));
      });
    }, windowMs);
    childProcess.on("close", async (code) => {
      if (spawnError) {
        finish(reject, spawnError);
        return;
      }
      if (timedOut) {
        // The leader closed, but the owned group may still have a live member
        // that closed the inherited pipes. Wait for the same coordinated
        // termination the timeout path started; it decides the message.
        const verified = await lifecycle.terminate(terminationGraceMs);
        finish(reject, new Error(cleanupFailure(timeoutDetail(), verified)));
        return;
      }
      try {
        const violationsText = readFileSync(violations, "utf8");
        assert.equal(violationsText, "", "Pi child made a blocked outbound attempt");
        finish(resolve, { code, stdout, stderr, violations: violationsText });
      } catch (error) {
        finish(reject, error);
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
    // Cleanup is asserted, never assumed: an unverified stop is a test failure.
    if (server) assert.equal(await stopChild(server.child), true, "fake provider must reach an observed close during cleanup");
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
    const child = spawnOwned(execPath, ["-e", `
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
    assert.equal(closeTracking(child).isClosed, false, "close must not have been observed before stopChild");
    const observed = await stopChild(child);
    assert.equal(closeTracking(child).isClosed, true, "stopChild must await the real close event after exit");
    assert.equal(observed, true, "stopChild must report the observed close");
  });

  it("reports the observed close for an already-closed child", async () => {
    const child = spawnOwned(execPath, ["-e", "process.exit(0)"], { stdio: ["ignore", "pipe", "ignore"] });
    await once(child, "close");
    // The close event already fired. Asserting the boolean result itself keeps
    // this fault-sensitive: mapping any outcome to one string would let a
    // failed closure pass as success.
    assert.equal(await stopChild(child), true, "already-closed child must report its observed close");
    assert.equal(await stopChild(child), true, "a repeated stop must still report an observed close");
    assert.equal(closeTracking(child).isClosed, true, "close must be observed, not inferred");
  });

  it("observes close for a child created without stdio pipes", async () => {
    const child = spawnOwned(execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    // Record when the real close event lands relative to the stop result. With
    // no pipes there is no stream state to inspect, so an inferred fast path
    // would report success before the event it claims to have observed.
    const order = [];
    child.once("close", () => { order.push("close"); });
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => {
        order.push("exit");
        closeTracking(child);
        stopChild(child).then((observed) => {
          order.push("stopChild");
          try {
            assert.deepEqual(order, ["exit", "close", "stopChild"],
              "stopChild must resolve only after the real close event, never from an inferred exit");
            assert.equal(observed, true, "no-stdio child must report its observed close");
            assert.equal(closeTracking(child).isClosed, true, "close must be observed, never inferred from exit");
            resolve();
          } catch (error) {
            reject(error);
          }
        }, reject);
      });
    });
  });

  it("force-kills a real SIGTERM-ignoring child, awaits close, and frees its scratch", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "bifrost-term-proof-"));
    const stubborn = spawnOwned(execPath, ["-e",
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
      assert.equal(await stopChild(stubborn, 300), true, "force-kill must reach a verified close");
      // stopChild resolves on close, so the dead child cannot hold the scratch.
      assert.equal(stubborn.exitCode, null, "SIGTERM-ignoring child must not exit via TERM");
      assert.equal(stubborn.signalCode, "SIGKILL", "SIGTERM-ignoring child must be force-killed");
      assert.equal(processGroupExists(stubborn.pid), false, "the owned process group must be gone");
      rmSync(scratch, { recursive: true, force: true });
      assert.equal(existsSync(scratch), false, "scratch must be removable after the forced close");
    } finally {
      await stopChild(stubborn, 300);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("rejects fake-provider startup when the child exits before its ready record", async () => {
    const failing = spawnOwned(execPath, ["-e", "process.exit(3)"], { stdio: ["ignore", "pipe", "ignore"] });
    await assert.rejects(waitForFakeReady(failing), /fake provider exited before startup/);
    assert.equal(await stopChild(failing), true, "failed startup must still reach a verified close");
  });

  it("settles a timed-out run only after the owned group is verified dead", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-pipe-race-home-"));
    const pidFile = join(home, "descendant.pid");
    try {
      // The leader exits and its descendant releases the inherited pipes when
      // signalled but keeps running, so the close event lands while a member of
      // the owned group is still alive. A close event is not cleanup evidence:
      // the run must not settle until the group is verified gone.
      const run = runPi({
        home,
        work: home,
        model: "bifrost/auto",
        prompt: "native faux dispatch marker",
        child: "1",
        command: execPath,
        args: [PIPE_RACE_CLI],
        windowMs: 1_000,
        terminationGraceMs: 200,
        extraEnv: { BIFROST_DESCENDANT_PID_FILE: pidFile },
      });
      await assert.rejects(
        Promise.race([
          run,
          new Promise((_, reject) => { setTimeout(() => reject(new Error("runPi stayed pending after its bounded window and owned termination")), 40_000); }),
        ]),
        /exceeded the bounded run window/,
        "a run whose descendant releases the pipes but survives must still fail bounded",
      );
      // Settling above is only legitimate if the group descendant is already
      // dead. Rejecting while it lived is exactly the defect this pins.
      const pid = Number(readFileSync(pidFile, "utf8"));
      assert.ok(Number.isInteger(pid) && pid > 0, "the fixture must record its descendant pid");
      assert.throws(
        () => process.kill(pid, 0),
        (error) => error.code === "ESRCH",
        `owned group descendant ${pid} survived the run's cleanup`,
      );
      // Verified cleanup means the scratch is safe to reclaim.
      rmSync(home, { recursive: true, force: true });
      assert.equal(existsSync(home), false, "verified cleanup must leave the scratch removable");
    } finally {
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, "utf8"));
        try { process.kill(pid, "SIGKILL"); } catch {}
      }
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reaps a live group descendant behind an already-closed leader", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "bifrost-closed-leader-"));
    // The descendant takes no inherited pipes at all, so it cannot influence
    // when the leader's close event arrives. Only the owned group's death says
    // anything about it.
    const leader = spawnOwned(execPath, ["-e", [
      "const { spawn } = require('node:child_process');",
      "const d = spawn(process.execPath, ['-e', \"process.send({ pid: process.pid }); setInterval(() => {}, 1000);\"], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });",
      "d.once('message', (m) => process.stdout.write(JSON.stringify(m) + '\\n', () => process.exit(0)));",
    ].join("\n")], { stdio: ["ignore", "pipe", "ignore"], cwd: scratch });
    try {
      const pid = await new Promise((resolve, reject) => {
        let seen = "";
        leader.stdout.setEncoding("utf8");
        leader.stdout.on("data", (chunk) => {
          seen += chunk;
          try { resolve(JSON.parse(seen).pid); } catch { /* wait for the record */ }
        });
        leader.once("error", reject);
      });
      await once(leader, "close");
      // Safety: cleanup may only ever signal this child's own isolated group,
      // never a parent or shared one.
      assert.equal(processGroupExists(leader.pid), true, "the owned child must lead its own live process group");
      assert.equal(await stopChild(leader), true, "an already-closed leader still needs verified group cleanup");
      assert.equal(processGroupExists(leader.pid), false, "the owned process group must be dead");
      assert.throws(
        () => process.kill(pid, 0),
        (error) => error.code === "ESRCH",
        `owned group descendant ${pid} survived behind a closed leader`,
      );
    } finally {
      await stopChild(leader);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("reports a cleanup failure as its own cause instead of a bare timeout", async () => {
    // Forced, not simulated: the child really does exit, but its cleanup
    // reports failure so the caller's cause-clause can be asserted. Both
    // seams are attached synchronously, before close can possibly fire.
    const unverified = spawnOwned(execPath, ["-e", "process.exit(3)"], { stdio: ["ignore", "pipe", "ignore"] });
    forceCleanupFailure(unverified);
    await assert.rejects(
      waitForFakeReady(unverified),
      (error) => {
        assert.match(error.message, /fake provider/, "the startup cause must survive alongside the cleanup cause");
        assert.match(
          error.message,
          /cleanup failure: the owned process group did not reach a verified dead state/,
          "an unverified cleanup must be named as its own cause",
        );
        return true;
      },
      "a startup failure whose cleanup is unverified must name the cleanup failure",
    );
    // Contrast: the same caller with verified cleanup keeps only the startup
    // cause, so the clause above can never be mistaken for ordinary output.
    const verified = spawnOwned(execPath, ["-e", "process.exit(3)"], { stdio: ["ignore", "pipe", "ignore"] });
    await assert.rejects(
      waitForFakeReady(verified),
      (error) => {
        assert.doesNotMatch(error.message, /cleanup failure/, "verified cleanup must not claim a cleanup failure");
        return true;
      },
      "a verified cleanup must report the startup cause alone",
    );
  });

  it("fails a bounded run and reaps the owned descendant holding inherited pipes", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-child-descendant-home-"));
    const pidFile = join(home, "descendant.pid");
    try {
      // The stand-in CLI exits while a descendant it spawned keeps the
      // inherited stdout pipe open, so the runner's close never arrives on its
      // own. The outer bound keeps the regression from hanging the suite.
      const run = runPi({
        home,
        work: home,
        model: "bifrost/auto",
        prompt: "native faux dispatch marker",
        child: "1",
        command: execPath,
        args: [DESCENDANT_CLI],
        windowMs: 1_000,
        terminationGraceMs: 200,
        extraEnv: { BIFROST_DESCENDANT_PID_FILE: pidFile },
      });
      await assert.rejects(
        Promise.race([
          run,
          new Promise((_, reject) => { setTimeout(() => reject(new Error("runPi stayed pending after its bounded window and owned termination")), 30_000); }),
        ]),
        /exceeded the bounded run window/,
        "a run whose owned descendant holds the pipes must fail, not stay pending",
      );
      // The descendant must actually be gone, not merely unobserved.
      const pid = Number(readFileSync(pidFile, "utf8"));
      assert.ok(Number.isInteger(pid) && pid > 0, "the fixture must record its descendant pid");
      assert.throws(
        () => process.kill(pid, 0),
        (error) => error.code === "ESRCH",
        `owned descendant ${pid} must be terminated, not left alive`,
      );
    } finally {
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, "utf8"));
        try { process.kill(pid, "SIGKILL"); } catch {}
      }
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("records forbidden fetch, socket, and UDP attempts through the same preloaded guard", async () => {
    const home = mkdtempSync(join(tmpdir(), "bifrost-guard-negative-home-"));
    try {
      const violations = join(home, "test-network-violations.log");
      const forbiddenPort = alternatePort(fakePort);
      // Independent boundary regression: the forbidden port stays legal and
      // distinct for every valid provider port, including the top of the
      // range that the previous arithmetic overflowed.
      assertAlternatePortStaysLegalAndDistinct(65535);
      assert.equal(alternatePort(65535), 65534);
      assert.equal(alternatePort(65534), 65535);
      for (let port = 1; port <= 65535; port += 1) assertAlternatePortStaysLegalAndDistinct(port);
      assertAlternatePortStaysLegalAndDistinct(fakePort);
      writeFileSync(violations, "");
      // Same preload, same guard, same allowed-origin contract as runPi.
      // Without the preload (guard-removal mutation) nothing records the
      // forbidden attempts, so the record assertions below go RED.
      const probe = await new Promise((resolve, reject) => {
        const childProcess = spawnOwned(execPath, ["-e", `
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
        let settled = false;
        const finish = (settle, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(killer);
          settle(value);
        };
        childProcess.stderr.setEncoding("utf8");
        childProcess.stderr.on("data", (chunk) => { stderr += chunk; });
        // Bounded termination so a leaking probe cannot hang the suite. The
        // stop result is consumed, so an unverifiable cleanup fails the probe
        // instead of leaving it pending forever.
        const killer = setTimeout(() => {
          timedOut = true;
          void stopChild(childProcess, 1_000).then((closed) => {
            const detail = `guard negative-control probe exceeded its bounded window (stderr=${stderr.length})`;
            finish(reject, closed
              ? new Error(detail)
              : new Error(`${detail}; the owned process group did not reach a verified close`));
          });
        }, 30_000);
        childProcess.once("error", (error) => { finish(reject, error); });
        childProcess.once("close", (code) => {
          if (timedOut) finish(reject, new Error(`guard negative-control probe exceeded its bounded window (stderr=${stderr.length})`));
          else finish(resolve, { code, stderr });
        });
      });
      assert.equal(probe.code, 0, probe.stderr);
      const attempts = readFileSync(violations, "utf8");
      // Exactly three violations: the guard records the forbidden attempt it
      // blocked and nothing else. An allowed-origin request or an overflowing
      // port that fetch rejects before the guard sees it changes this count.
      const records = attempts.split("\n").map((line) => line.trim()).filter(Boolean);
      assert.equal(records.length, 3, `guard recorded ${records.length} violations: ${JSON.stringify(records)}`);
      assert.deepEqual(records, [
        `blocked fetch to http://127.0.0.1:${forbiddenPort}`,
        `blocked socket connection to 127.0.0.1:${forbiddenPort}`,
        "blocked UDP datagram to 127.0.0.1",
      ], "forbidden fetch, socket, and UDP attempts must each be recorded exactly once");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
