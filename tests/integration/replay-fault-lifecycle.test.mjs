import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import { processGroupExists } from "../../scripts/acceptance/core.mjs";
import { NORMAL_CLOSE_CLI, ROOT, setOwnedGroupSignalDenial } from "../fixtures/child-auto-inline-harness.mjs";
import {
  FAULT_PROOFS,
  assertAssertionRed,
  removeScratchAfterVerifiedGroupDeath,
  runNamedReplayAssertion,
  runReplayGuardFaultProof,
} from "../fixtures/replay-fault-control.mjs";

// Focused lifecycle controls for the G03 replay fault control itself. Each
// control owns its children and private scratch; nothing here is guessed and
// shared helpers (scripts/acceptance/core.mjs, child-auto-inline-harness.mjs)
// are only reused, never edited. Skips on win32 where process groups do not
// exist as an owned signal target.
const WIN32 = process.platform === "win32";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}

async function waitForGone(pid, group, boundMs = 5_000) {
  const deadline = Date.now() + boundMs;
  while (Date.now() < deadline) {
    const descendantGone = pid == null || !isAlive(pid);
    const groupGone = !Number.isInteger(group) || group <= 0 || !processGroupExists(group);
    if (descendantGone && groupGone) return true;
    await sleep(25);
  }
  return false;
}

describe("G03 replay fault control lifecycle", { concurrency: 1 }, () => {
  it("terminates a hung owned run, verifies group absence, and refuses a timeout as RED evidence", { skip: WIN32 }, async () => {
    const scratch = mkdtempSync(join(tmpdir(), "bifrost-g03-lifecycle-timeout-"));
    const marker = FAULT_PROOFS.sideEffectFreeAllowanceOutputEffect.redAssertionMessage;
    try {
      const hang = `process.stdout.write(${JSON.stringify(`AssertionError [ERR_ASSERTION]: ${marker}`)}); setInterval(() => {}, 1000);`;
      const receipt = await runNamedReplayAssertion({
        scratch,
        command: execPath,
        args: ["-e", hang],
        timeoutMs: 400,
        terminationGraceMs: 1_000,
      });

      assert.equal(receipt.timedOut, true, "the run must report its bounded timeout");
      assert.equal(receipt.verified, true, "the owned group must be proven dead after bounded termination");
      assert.ok(Number.isInteger(receipt.ownedGroup) && receipt.ownedGroup > 0, "the owned group id must be captured at creation");
      assert.equal(processGroupExists(receipt.ownedGroup), false, "the owned process group must be gone");
      assert.match(receipt.stdout, /AssertionError/, "the hung run printed the text that must not be accepted");
      assert.throws(() => assertAssertionRed(receipt, marker), /timed out/i,
        "a timeout that printed the matching text must not be accepted as RED evidence");

      // Verified death: the scratch is safe to reclaim.
      assert.doesNotThrow(() => removeScratchAfterVerifiedGroupDeath([scratch], receipt.ownedGroup));
      assert.equal(existsSync(scratch), false, "verified group death must allow scratch reclamation");
    } finally {
      if (existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("retains the proof scratch and preserves the pending failure when owned-group signals are denied", { skip: WIN32 }, async () => {
    const pidDir = mkdtempSync(join(tmpdir(), "bifrost-g03-lifecycle-denied-"));
    const pidFile = join(pidDir, "descendant.pid");
    let ownedGroup = null;
    let descendantPid = null;
    let retainedScratch = null;
    let restored = false;
    try {
      setOwnedGroupSignalDenial(() => { throw new Error("controlled owned-group signal denial"); });
      await assert.rejects(
        runReplayGuardFaultProof({
          root: ROOT,
          proof: FAULT_PROOFS.autoBoundaryToolSideEffect,
          runOptions: {
            command: execPath,
            args: [NORMAL_CLOSE_CLI],
            env: { ...process.env, BIFROST_DESCENDANT_PID_FILE: pidFile },
            timeoutMs: 5_000,
          },
        }),
        (error) => {
          assert.equal(error.verified, false, "an unverifiable cleanup must be named as such");
          assert.match(error.message, /did not reach a verified dead state/,
            "the cleanup failure must be its own clause on the pending failure");
          assert.ok(Number.isInteger(error.ownedGroup) && error.ownedGroup > 0, "the run must preserve owned-group ownership");
          assert.equal(error.scratchRetained, true, "the pending failure must preserve retained-scratch ownership");
          assert.ok(typeof error.scratch === "string" && error.scratch.length > 0, "the pending failure must carry the retained scratch path");
          assert.deepEqual(error.scratchPaths, [error.scratch], "the receipt paths must point at the retained scratch");
          ownedGroup = error.ownedGroup;
          retainedScratch = error.scratch;
          return true;
        },
      );
      assert.equal(existsSync(retainedScratch), true, "the scratch must be retained while the owned group is not proven dead");
      descendantPid = Number(readFileSync(pidFile, "utf8"));
      assert.ok(Number.isInteger(descendantPid) && descendantPid > 0, "the private fixture must record its descendant pid");
      assert.equal(isAlive(descendantPid), true, "the unverified group descendant must still be alive");
    } finally {
      setOwnedGroupSignalDenial(null);
    }
    // Restore only creation-recorded resources, verify death, then reclaim.
    if (descendantPid) { try { process.kill(descendantPid, "SIGKILL"); } catch {} }
    if (Number.isInteger(ownedGroup) && ownedGroup > 0) { try { process.kill(-ownedGroup, "SIGKILL"); } catch {} }
    assert.equal(await waitForGone(descendantPid, ownedGroup), true, "the retained owned group must reach verified death before reclamation");
    assert.equal(isAlive(descendantPid), false, "the recorded descendant must be gone");
    assert.equal(processGroupExists(ownedGroup), false, "the owned process group must be gone");
    removeScratchAfterVerifiedGroupDeath([retainedScratch], ownedGroup);
    restored = true;
    assert.equal(existsSync(retainedScratch), false, "the retained scratch is reclaimed only after verified death");
    rmSync(pidDir, { recursive: true, force: true });
    assert.equal(restored, true);
  });

  it("preserves a real assertion failure and reclaims scratch once the owned group is verified dead", { skip: WIN32 }, async () => {
    const proof = {
      ...FAULT_PROOFS.allowanceRetryBoundaryV2,
      redAssertionMessage: "this-concrete-observable-is-deliberately-absent",
    };
    await assert.rejects(
      runReplayGuardFaultProof({ root: ROOT, proof }),
      (error) => {
        assert.match(error.message, /RED missing expected message/,
          "the original assertion failure must not be replaced by a scratch-deletion error");
        assert.equal(error.scratchRetained, false, "a verified-dead group must allow reclamation even on failure");
        assert.ok(typeof error.scratch === "string" && error.scratch.length > 0, "the failure must still report the scratch it owned");
        assert.equal(existsSync(error.scratch), false, "the scratch must be reclaimed after verified group death");
        return true;
      },
    );
  });
});
