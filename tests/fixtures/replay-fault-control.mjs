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
//   3. MUTATE  — corrupt one production guard (see REPLAY_GUARD_MUTATORS). The
//      mutant hash must differ.
//   4. RED     — run the SAME named assertion against the mutant. It must fail
//      with the meaningful AssertionError message below, NOT a syntax/startup
//      failure. This is the fault-sensitivity evidence.
//   5. RESTORE — write the original bytes back into the scratch tree, confirm
//      the restored hash matches the baseline, rerun the assertion (GREEN),
//      and confirm the committed index.ts was never modified.
//
// The caller selects a proof with the FAULT_PROOFS spec; the default is the
// original isSideEffectFreeAllowanceFailure output-effect proof.
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
// Every named replay assertion and the guard that is load-bearing for it.
// status: "PROVEN"  — a committed executable proof mutates that guard and turns
//                     this exact named assertion RED (see FAULT_PROOFS).
//         "OUTSTANDING" — no executable proof covers this pair yet.
// `mutation` records the injected fault so the direction of the proof is clear
// (a permissive bypass vs. a restrictive over-fire).
export const NAMED_REPLAY_ASSERTIONS = [
  {
    testFile: "tests/integration/auto-virtual.test.mjs",
    testName: "does not replay a failed Auto turn after the provider emitted output",
    guard: "isSideEffectFreeAllowanceFailure",
    mutation: "return [assistantEntryId]",
    status: "PROVEN",
  },
  {
    testFile: "tests/integration/auto-virtual.test.mjs",
    testName: "does not replay an allowance failure after a synthetic tool side effect",
    guard: "autoBoundaryStillActive",
    mutation: "return false",
    status: "PROVEN",
  },
  {
    testFile: "tests/integration/auto-virtual.test.mjs",
    testName: "does not replay an unsafe tool turn and dispatches its queued follow-up once on a distinct provider",
    guard: null,
    mutation: null,
    status: "OUTSTANDING",
  },
  // reliability-v2-auto titles are mode-parameterized; each concrete mode is listed.
  {
    testFile: "tests/integration/reliability-v2-auto.test.mjs",
    testName: "retries one zero-effect allowance failure with a configured alternate in v1 Auto",
    guard: null,
    mutation: null,
    status: "OUTSTANDING",
  },
  {
    testFile: "tests/integration/reliability-v2-auto.test.mjs",
    testName: "retries one zero-effect allowance failure with a configured alternate in v2 Auto",
    guard: "allowanceRetryBoundaryStillSafe",
    mutation: "return false",
    status: "PROVEN",
  },
  {
    testFile: "tests/integration/reliability-v2-auto.test.mjs",
    testName: "stops after the single alternate allowance attempt in v1 Auto",
    guard: null,
    mutation: null,
    status: "OUTSTANDING",
  },
  {
    testFile: "tests/integration/reliability-v2-auto.test.mjs",
    testName: "stops after the single alternate allowance attempt in v2 Auto",
    guard: null,
    mutation: null,
    status: "OUTSTANDING",
  },
];

/** The original proof; kept as the default so existing callers stay unchanged. */
export const FAULT_PROOF = {
  guard: "isSideEffectFreeAllowanceFailure",
  testFile: "tests/integration/auto-virtual.test.mjs",
  testName: "does not replay a failed Auto turn after the provider emitted output",
  redAssertionMessage: "the failed allowance/output-effect turn must not dispatch to an alternate",
};

/** Named guard × assertion proofs, one per guard, executed by the anchor tests. */
export const FAULT_PROOFS = {
  sideEffectFreeAllowanceOutputEffect: FAULT_PROOF,
  allowanceRetryBoundaryV2: {
    guard: "allowanceRetryBoundaryStillSafe",
    testFile: "tests/integration/reliability-v2-auto.test.mjs",
    testName: "retries one zero-effect allowance failure with a configured alternate in v2 Auto",
    redAssertionMessage: "the prepared usage-limit retry was cancelled because the turn changed; no model was dispatched.",
  },
  autoBoundaryToolSideEffect: {
    guard: "autoBoundaryStillActive",
    testFile: "tests/integration/auto-virtual.test.mjs",
    testName: "does not replay an allowance failure after a synthetic tool side effect",
    redAssertionMessage: "Pi must execute the provider-requested synthetic tool",
  },
};

/** Injected fault per guard. `return false` proves the guard's restrictive half
 * (the assertion depends on the guard permitting the safe path). */
export const REPLAY_GUARD_MUTATORS = {
  isSideEffectFreeAllowanceFailure: (source) => injectGuardStatement(source, "isSideEffectFreeAllowanceFailure", "return [assistantEntryId];"),
  allowanceRetryBoundaryStillSafe: (source) => injectGuardStatement(source, "allowanceRetryBoundaryStillSafe", "return false;"),
  autoBoundaryStillActive: (source) => injectGuardStatement(source, "autoBoundaryStillActive", "return false;"),
};

function injectGuardStatement(source, guard, statement) {
  const anchor = `  function ${guard}(`;
  const anchorIndex = source.indexOf(anchor);
  if (anchorIndex === -1) throw new Error(`replay guard anchor not found: ${guard}`);
  const openBrace = source.indexOf("{\n", anchorIndex);
  if (openBrace === -1) throw new Error(`replay guard body opening brace not found: ${guard}`);
  return `${source.slice(0, openBrace + 1)}\n    ${statement}${source.slice(openBrace + 1)}`;
}

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Inject `return [assistantEntryId];` at the entry of
 * isSideEffectFreeAllowanceFailure so every call approves the failed attempt.
 * Throws if the function anchor is missing.
 */
export function mutateReplayGuard(source) {
  return REPLAY_GUARD_MUTATORS.isSideEffectFreeAllowanceFailure(source);
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
export function runReplayGuardFaultProof({ root, keepScratch = false, log = () => {}, proof = FAULT_PROOF }) {
  const committedPath = join(root, "index.ts");
  const original = readFileSync(committedPath, "utf8");
  const originalHash = sha256(original);
  if (originalHash !== REPLAY_GUARD_BASELINE_SHA256) {
    throw new Error(`G03 replay fault proof requires baseline source; index.ts sha256=${originalHash}`);
  }
  const mutate = REPLAY_GUARD_MUTATORS[proof.guard];
  if (!mutate) throw new Error(`G03 replay fault proof has no mutator for guard ${proof.guard}`);

  const scratch = createReplayScratchTree(root);
  log(`G03 replay fault proof scratch: ${scratch} (created at proof start)`);
  try {
    const { testFile, testName, redAssertionMessage } = proof;

    // 2. GREEN on the pristine copy.
    const green = runNamedReplayAssertion({ scratch, testFile, testName });
    assertGreen(green, "pristine copy");

    // 3. MUTATE.
    const mutant = mutate(original);
    const mutantHash = sha256(mutant);
    if (mutantHash === originalHash) throw new Error("G03 replay fault proof mutation produced no source change");
    writeFileSync(join(scratch, "index.ts"), mutant);
    log(`G03 replay fault proof ${proof.guard} mutant sha256=${mutantHash}`);

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
      guard: proof.guard,
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
