// Replay fault control for G03 (P1): fault-sensitivity bindings for replay guards.
//
// This module is a *scratch/process* helper, not a runtime dependency of any
// production code. It documents the controlled fault proof that binds the
// existing replay-safety assertions in tests/integration/auto-virtual.test.mjs
// and tests/integration/reliability-v2-auto.test.mjs to the production guards
// in index.ts.
//
// GUARD INVENTORY (index.ts, baseline a792cb173317744d12950698009d11c7ea0b39b2):
//   - isSideEffectFreeAllowanceFailure  (line ~24xx) — proves a failed attempt
//     had no output/tool results/queued work before allowance recovery.
//   - allowanceRetryBoundaryStillSafe     (line ~2525) — re-checks the boundary
//     immediately before dispatching the prepared allowance retry.
//   - autoBoundaryStillActive             — confirms the original user boundary
//     is still the active turn.
//
// CONTROLLED FAULT PROOF (performed in a disposable scratch copy, never in the
// committed tree):
//   1. GREEN  — run the named replay-safety assertion against the unmodified
//      production source (index.ts sha256 above). Assertion passes.
//   2. RED    — copy index.ts into scratch, remove ONE guard (e.g. the
//      `isSideEffectFreeAllowanceFailure(...)` call inside
//      allowanceRetryBoundaryStillSafe), run the SAME named assertion against
//      the patched copy via the test harness's source-override hook (or a
//      patched -e entry). The assertion must fail with a *meaningful*
//      assertion failure (model dispatched to alternate / tool side effect
//      replayed / host retry observed), NOT a syntax/startup failure.
//   3. GREEN  — restore the original bytes; verify sha256 matches the baseline
//      hash; rerun the assertion; it passes again.
//
// REPORTED (see HANDOFF.md):
//   - source hash before/after restore
//   - named assertion that went RED
//   - model attempts, tool side-effect count, host retry, receipt IDs observed
//   - whether the failure was an assertion failure (not startup/syntax)
//
// No live provider calls. No arbitrary replay in production. Scratch retained
// until observed close + process-group absence.

export const REPLAY_GUARD_BASELINE_SHA256 = "3164a3dbc41a864c68bede2f9e7365c5ed32bbbcd91fc584a3d07446014e3f12";
export const REPLAY_GUARD_FUNCTIONS = [
  "isSideEffectFreeAllowanceFailure",
  "allowanceRetryBoundaryStillSafe",
  "autoBoundaryStillActive",
];
export const NAMED_REPLAY_ASSERTIONS = [
  "tests/integration/auto-virtual.test.mjs :: does not replay a failed Auto turn after the provider emitted output",
  "tests/integration/auto-virtual.test.mjs :: does not replay an allowance failure after a synthetic tool side effect",
  "tests/integration/auto-virtual.test.mjs :: does not replay an unsafe tool turn and dispatches its queued follow-up once on a distinct provider",
  "tests/integration/reliability-v2-auto.test.mjs :: retries one zero-effect allowance failure with a configured alternate in ${mode} Auto",
  "tests/integration/reliability-v2-auto.test.mjs :: stops after the single alternate allowance attempt in ${mode} Auto",
];
