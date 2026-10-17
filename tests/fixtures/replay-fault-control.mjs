// Replay fault control for G03 (P1): fault-sensitivity bindings for replay guards.
//
// This module is a *scratch/process* helper, not a runtime dependency of any
// production code. It executes the controlled fault proof that binds the
// existing replay-safety assertions in tests/integration/auto-virtual.test.mjs
// and tests/integration/reliability-v2-auto.test.mjs to the production guards
// in index.ts.
//
// GUARD INVENTORY (index.ts, baseline a792cb173317744d12950698009d11c7ea0b39b2):
//   - isSideEffectFreeAllowanceFailure (exact line 1764) — proves a failed
//     attempt had no output/tool results/queued work before allowance recovery.
//   - autoBoundaryStillActive (exact line 1707) — confirms the original user
//     boundary is still the active turn.
//   - allowanceRetryBoundaryStillSafe (exact line 2525) — re-checks the boundary
//     immediately before dispatching the prepared allowance retry.
//
// CONTROLLED FAULT PROOF (performed in a disposable scratch copy, never in the
// committed tree; reproduces /Users/mak/.paseo/delivery/g03-replay-fault/proof.log):
//   1. COPY    — build a private scratch tree: symlink every repository entry
//      except index.ts and tests, copy index.ts and tests/ so the test file's
//      ROOT resolves inside the scratch tree.
//   2. GREEN   — run the named replay assertion against the pristine copied
//      index.ts. It must pass (proves the harness and baseline are healthy).
//   3. MUTATE  — bypass isSideEffectFreeAllowanceFailure by returning the
//      assistant entry id at function entry. The mutant hash must differ.
//   4. RED     — run the SAME named assertion against the mutant. It must fail
//      with the meaningful AssertionError message below, NOT a syntax/startup
//      failure. This is the fault-sensitivity evidence.
//   5. RESTORE — write the original bytes back into the scratch tree, confirm
//      the restored hash matches the baseline, rerun the assertion (GREEN),
//      and confirm the committed index.ts was never modified.
//
// No live provider calls. No arbitrary replay in production. Scratch is private
// (mkdtemp, mode 0700), created and torn down by this helper; receipts are
// recorded from the real child processes, and no PID is ever guessed or killed.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const REPLAY_GUARD_BASELINE_SHA256 = "3164a3dbc41a864c68bede2f9e7365c5ed32bbbcd91fc584a3d07446014e3f12";
export const REPLAY_GUARD_FUNCTIONS = [
  "isSideEffectFreeAllowanceFailure",
  "allowanceRetryBoundaryStillSafe",
  "autoBoundaryStillActive",
];

// Guard line anchors are exact against the baseline commit; keep them in sync
// with index.ts when the guards move.
export const REPLAY_GUARD_LINES = {
  autoBoundaryStillActive: 1707,
  isSideEffectFreeAllowanceFailure: 1764,
  allowanceRetryBoundaryStillSafe: 2525,
};

// Concrete test titles as they actually exist in the test files:
//   - auto-virtual.test.mjs titles are literal.
//   - reliability-v2-auto.test.mjs titles are mode-parameterized by the loop
//     `for (const mode of ["v1", "v2"])`, so both concrete variants are listed.
export const NAMED_REPLAY_ASSERTIONS = [
  "tests/integration/auto-virtual.test.mjs :: does not replay a failed Auto turn after the provider emitted output",
  "tests/integration/auto-virtual.test.mjs :: does not replay an allowance failure after a synthetic tool side effect",
  "tests/integration/auto-virtual.test.mjs :: does not replay an unsafe tool turn and dispatches its queued follow-up once on a distinct provider",
  // Template entries (mode ∈ {"v1", "v2"}) — concrete titles are `in v1 Auto` / `in v2 Auto`.
  "tests/integration/reliability-v2-auto.test.mjs :: retries one zero-effect allowance failure with a configured alternate in {v1,v2} Auto",
  "tests/integration/reliability-v2-auto.test.mjs :: stops after the single alternate allowance attempt in {v1,v2} Auto",
];

/** The one guard this helper mutates and the assertion that must go RED. */
export const FAULT_PROOF = {
  guard: "isSideEffectFreeAllowanceFailure",
  testFile: "tests/integration/auto-virtual.test.mjs",
  testName: "does not replay a failed Auto turn after the provider emitted output",
  redAssertionMessage: "the failed allowance/output-effect turn must not dispatch to an alternate",
};

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Inject `return [assistantEntryId];` at the entry of
 * isSideEffectFreeAllowanceFailure so every call approves the failed attempt.
 * Throws if the function anchor is missing.
 */
export function mutateReplayGuard(source) {
  const anchor = "  function isSideEffectFreeAllowanceFailure(";
  const anchorIndex = source.indexOf(anchor);
  if (anchorIndex === -1) throw new Error("replay guard anchor not found: isSideEffectFreeAllowanceFailure");
  const openBrace = source.indexOf("{\n", anchorIndex);
  if (openBrace === -1) throw new Error("replay guard body opening brace not found");
  return `${source.slice(0, openBrace + 1)}\n    return [assistantEntryId];${source.slice(openBrace + 1)}`;
}

/**
 * Build a private scratch copy of `root` where index.ts and tests/ are real
 * files (so the copied test file computes its ROOT inside the scratch tree) and
 * every other repository entry is symlinked. Returns the scratch path.
 */
export function createReplayScratchTree(root, scratchPrefix = "bifrost-g03-fault-") {
  const scratch = mkdtempSync(join(tmpdir(), scratchPrefix));
  for (const entry of readdirSync(root)) {
    if (["node_modules", "index.ts", "tests"].includes(entry)) continue;
    symlinkSync(join(root, entry), join(scratch, entry));
  }
  symlinkSync(join(root, "node_modules"), join(scratch, "node_modules"));
  copyFileSync(join(root, "index.ts"), join(scratch, "index.ts"));
  cpSync(join(root, "tests"), join(scratch, "tests"), { recursive: true });
  return scratch;
}

/**
 * Run one named replay assertion in `scratch` against the scratch index.ts.
 * Returns the raw process receipt (status, signal, stdout, stderr, error).
 */
export function runNamedReplayAssertion({ scratch, testFile, testName, timeoutMs = 180_000, env = process.env }) {
  const childEnv = { ...env };
  // A nested `node --test` must not inherit the runner's child marker.
  delete childEnv.NODE_TEST_CONTEXT;
  // Keep the outer acceptance event stream clean; the nested run has its own.
  delete childEnv.BIFROST_ACCEPTANCE_EVENTS;
  const result = spawnSync(process.execPath, [
    "--test",
    "--experimental-strip-types",
    `--test-name-pattern=${testName}`,
    testFile,
  ], { cwd: scratch, encoding: "utf8", env: childEnv, timeout: timeoutMs });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

function assertGreen(receipt, phase) {
  const output = `${receipt.stdout}\n${receipt.stderr}`;
  if (receipt.status !== 0) {
    throw new Error(`G03 replay fault proof expected GREEN in ${phase} but exit was ${receipt.status}:\n${output}`);
  }
  if (!/ℹ pass 1/u.test(output) || /ℹ fail [1-9]/u.test(output)) {
    throw new Error(`G03 replay fault proof expected exactly one passing assertion in ${phase}:\n${output}`);
  }
}

/**
 * Execute the full copy-mutate-load-assert-restore fault proof. Asserts each
 * phase and returns a receipt. The scratch tree is removed unless keepScratch.
 */
export function runReplayGuardFaultProof({ root, keepScratch = false, log = () => {} }) {
  const committedPath = join(root, "index.ts");
  const original = readFileSync(committedPath, "utf8");
  const originalHash = sha256(original);
  if (originalHash !== REPLAY_GUARD_BASELINE_SHA256) {
    throw new Error(`G03 replay fault proof requires baseline source; index.ts sha256=${originalHash}`);
  }

  const scratch = createReplayScratchTree(root);
  log(`G03 replay fault proof scratch: ${scratch} (created at proof start)`);
  try {
    const { testFile, testName, redAssertionMessage } = FAULT_PROOF;

    // 2. GREEN on the pristine copy.
    const green = runNamedReplayAssertion({ scratch, testFile, testName });
    assertGreen(green, "pristine copy");

    // 3. MUTATE.
    const mutant = mutateReplayGuard(original);
    const mutantHash = sha256(mutant);
    if (mutantHash === originalHash) throw new Error("G03 replay fault proof mutation produced no source change");
    writeFileSync(join(scratch, "index.ts"), mutant);
    log(`G03 replay fault proof mutant sha256=${mutantHash}`);

    // 4. RED against the mutant.
    const red = runNamedReplayAssertion({ scratch, testFile, testName });
    const redOutput = `${red.stdout}\n${red.stderr}`;
    if (red.status === 0) throw new Error(`G03 replay fault proof expected RED but the mutant assertion passed:\n${redOutput}`);
    if (!/AssertionError/u.test(redOutput)) {
      throw new Error(`G03 replay fault proof RED was not an AssertionError (syntax/startup?):\n${redOutput}`);
    }
    if (!redOutput.includes(redAssertionMessage)) {
      throw new Error(`G03 replay fault proof RED missing expected message ${JSON.stringify(redAssertionMessage)}:\n${redOutput}`);
    }
    log(`G03 replay fault proof RED: ${redAssertionMessage}`);

    // 5. RESTORE and verify.
    writeFileSync(join(scratch, "index.ts"), original);
    const restoredHash = sha256(readFileSync(join(scratch, "index.ts"), "utf8"));
    if (restoredHash !== originalHash) throw new Error(`G03 replay fault proof restore hash mismatch: ${restoredHash}`);
    const restoredGreen = runNamedReplayAssertion({ scratch, testFile, testName });
    assertGreen(restoredGreen, "restored copy");

    const committedHashAfter = sha256(readFileSync(committedPath, "utf8"));
    if (committedHashAfter !== originalHash) {
      throw new Error(`G03 replay fault proof modified the committed index.ts: ${committedHashAfter}`);
    }

    return {
      guard: FAULT_PROOF.guard,
      testFile,
      testName,
      baselineSha256: originalHash,
      mutantSha256: mutantHash,
      restoredSha256: restoredHash,
      redAssertionMessage,
      scratch,
      phases: {
        copy: "ok",
        green: green.status,
        red: red.status,
        restoredGreen: restoredGreen.status,
      },
    };
  } finally {
    if (!keepScratch) rmSync(scratch, { recursive: true, force: true });
  }
}
