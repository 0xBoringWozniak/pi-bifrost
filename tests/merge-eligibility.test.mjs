import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateEligibility, parseDependencies } from "../scripts/merge-eligibility.mjs";

const head = "abc123";
const valid = {
  pr: {
    headRefOid: head, baseRefName: "v2", baseRefOid: "base456", isDraft: false, author: { login: "author" },
    body: "Refs #41",
  },
  workflowFileMatchesBase: true,
  workflowRuns: [{
    head_sha: head, event: "pull_request", workflow_path: ".github/workflows/verification.yml",
    conclusion: "success", jobs: [{ name: "release-gates", conclusion: "success" }],
  }],
  reviews: [{ state: "APPROVED", author: "reviewer", commit_id: head, submitted_at: "2026-01-02" }],
  reviewThreads: [],
  dependencies: [],
};

function evaluate(patch = {}) {
  return evaluateEligibility({ ...valid, ...patch, pr: { ...valid.pr, ...patch.pr } });
}

test("requires successful release-gates from trusted workflow on exact head", () => {
  for (const workflowRuns of [
    [{ ...valid.workflowRuns[0], jobs: [{ name: "CodeRabbit", conclusion: "success" }] }],
    [{ ...valid.workflowRuns[0], head_sha: "stale" }],
    [{ ...valid.workflowRuns[0], workflow_path: ".github/workflows/other.yml" }],
    [{ ...valid.workflowRuns[0], event: "push" }],
    [{ ...valid.workflowRuns[0], conclusion: "failure" }],
  ]) assert.equal(evaluate({ workflowRuns }).eligible, false);
  assert.equal(evaluate({ workflowFileMatchesBase: false }).eligible, false);
  assert.equal(evaluate().eligible, true);
});

test("uses latest effective review per reviewer and blocks active change requests across revisions", () => {
  const oldRequestThenOtherApproval = [
    { state: "CHANGES_REQUESTED", author: "reviewer-a", commit_id: "old", submitted_at: "2026-01-01" },
    { state: "APPROVED", author: "reviewer-b", commit_id: head, submitted_at: "2026-01-02" },
  ];
  assert.equal(evaluate({ reviews: oldRequestThenOtherApproval }).eligible, false);
  assert.equal(evaluate({ reviews: [
    ...oldRequestThenOtherApproval,
    { state: "DISMISSED", author: "reviewer-a", commit_id: head, submitted_at: "2026-01-03" },
  ] }).eligible, true);
  assert.equal(evaluate({ reviewThreads: [{ isResolved: false }] }).eligible, false);
  assert.equal(evaluate({ reviewThreads: [{ isResolved: true }] }).eligible, true);
});

test("rejects missing author identity and unknown draft state", () => {
  assert.equal(evaluate({ pr: { author: null } }).eligible, false);
  assert.equal(evaluate({ pr: { isDraft: undefined } }).eligible, false);
  assert.equal(evaluate({ pr: { isDraft: true } }).eligible, false);
});

test("requires issue reference and all declared dependencies to be integrated into v2", () => {
  const merged = { kind: "pr", number: 35, state: "CLOSED", mergedAt: "2026-01-01T00:00:00Z", base: "v2", integrated: true };
  assert.equal(evaluate({ dependencies: [merged] }).eligible, true);
  for (const dependency of [
    { ...merged, state: "OPEN", mergedAt: undefined },
    { ...merged, mergedAt: undefined },
    { ...merged, base: "main" },
    { ...merged, integrated: false },
    { kind: "issue", number: 37, state: "OPEN" },
    { kind: "unknown", number: 37 },
  ]) assert.equal(evaluate({ dependencies: [dependency] }).eligible, false);
});

test("parses every dependency in lists and GitHub URLs; rejects unknown declaration syntax", () => {
  assert.deepEqual(parseDependencies("Dependencies: #35, https://github.com/org/repo/pull/36"), [
    { kind: "ref", number: 35 }, { kind: "pr", number: 36, repo: "org/repo" },
  ]);
  assert.deepEqual(parseDependencies("Depends on #37"), [{ kind: "ref", number: 37 }]);
  assert.deepEqual(parseDependencies("Dependencies:\n- https://github.com/org/repo/issues/40"), [
    { kind: "issue", number: 40, repo: "org/repo" },
  ]);
  assert.throws(() => parseDependencies("Dependencies: #35 and maybe #36"), /unsupported dependency syntax/);
});

test("fails closed when review or required-check data is unknown", () => {
  assert.equal(evaluate({ reviews: undefined }).eligible, false);
  assert.equal(evaluate({ workflowRuns: undefined }).eligible, false);
  assert.equal(evaluate({ reviewThreads: undefined }).eligible, false);
});

test("CLI main-module detection works when script path contains spaces", () => {
  const temp = mkdtempSync(join(tmpdir(), "merge-eligibility-cli-"));
  try {
    const spacedDir = join(temp, "directory with spaces");
    mkdirSync(spacedDir);
    const script = join(spacedDir, "merge eligibility.mjs");
    copyFileSync(new URL("../scripts/merge-eligibility.mjs", import.meta.url), script);
    chmodSync(script, 0o755);
    const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage: node scripts\/merge-eligibility\.mjs/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
