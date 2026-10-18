import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = new URL("../scripts/merge-controller.mjs", import.meta.url).pathname;
const REPO_ROOT = new URL("..", import.meta.url).pathname;
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const TREE = "c".repeat(40);
const MERGE_SHA = "d".repeat(40);
const PROPOSED_SHA = "e".repeat(40);
const PROPOSED_TREE = "f".repeat(40);
const DIFF = "diff --git a/x b/x\n+hello\n";

const FAKE_GH = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const world = JSON.parse(fs.readFileSync(process.env.FAKE_GH_WORLD, "utf8"));
if (process.env.FAKE_GH_LOG) fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + "\\n");
function out(v) { process.stdout.write(typeof v === "string" ? v : JSON.stringify(v)); process.exit(0); }
function die(code) { process.stderr.write(code + "\\n"); process.exit(1); }
const joined = args.join(" ");
if (args[0] === "repo" && args[1] === "view") out({ nameWithOwner: world.repo });
if (args[0] === "pr" && args[1] === "diff") out(world.diff ?? "");
if (args[0] === "pr" && args[1] === "merge") {
  if (world.merge?.fail) die("merge rejected");
  out("merged");
}
if (args[0] === "pr" && args[1] === "view") {
  if (joined.includes("--json files")) out({ files: (world.pr.files ?? []).map((p) => ({ path: p })) });
  if (joined.includes("state,mergeCommit,headRefOid,baseRefOid")) out(world.afterMerge ?? { state: "MERGED", mergeCommit: { oid: world.pr.headRefOid }, headRefOid: world.pr.headRefOid, baseRefOid: world.pr.baseRefOid });
  if (joined.includes("state,mergeCommit")) out(world.afterMerge ?? { state: "MERGED", mergeCommit: { oid: MERGE_SHA } });
  let pr = world.pr;
  if (world.headSequence && joined.includes("headRefOid,baseRefName")) {
    pr = { ...world.pr, headRefOid: world.headSequence.shift() ?? world.pr.headRefOid };
    fs.writeFileSync(process.env.FAKE_GH_WORLD, JSON.stringify(world));
  }
  out(pr);
}
if (args[0] === "api") {
  if (joined.includes("actions/workflows/verification.yml")) out({ id: world.workflowId ?? 123 });
  if (joined.includes("contents/")) out({ sha: joined.includes(world.pr.baseRefOid) ? (world.baseWorkflowSha ?? "1".repeat(40)) : (world.headWorkflowSha ?? "1".repeat(40)) });
  if (joined.includes("/runs?head_sha=")) out({ workflow_runs: joined.includes("event=push") ? (world.pushRuns ?? []) : (world.ciRuns ?? []) });
  if (joined.match(/actions\\/runs\\/\\d+\\/jobs/)) {
    const id = Number(joined.match(/actions\\/runs\\/(\\d+)\\/jobs/)[1]);
    out({ jobs: (world.jobs ?? {})[id] ?? [] });
  }
  if (joined.includes("/reviews")) out((world.reviews ?? []).map((r) => JSON.stringify({ state: r.state, user: { login: r.author }, commit_id: r.commit_id, submitted_at: r.submitted_at })).join("\\n"));
  if (args.includes("graphql")) out({ data: { repository: { pullRequest: { reviewThreads: { nodes: world.threads ?? [], pageInfo: { hasNextPage: false, endCursor: null } } } } } });
  if (joined.match(/\\/pulls\\/\\d+$/)) out(world.pull ?? { merge_commit_sha: PROPOSED_SHA });
  if (joined.match(/\\/issues\\/\\d+$/)) {
    const n = Number(joined.match(/\\/issues\\/(\\d+)$/)[1]);
    out(world.issues?.[n] ?? { number: n, state: "CLOSED" });
  }
  if (joined.match(/\\/commits\\//)) {
    const sha = joined.match(/\\/commits\\/([0-9a-f]+)$/)[1];
    out((world.commits ?? {})[sha] ?? die("unknown commit " + sha));
  }
  if (joined.includes("/git/ref/heads/")) out(world.ref ?? { object: { sha: MERGE_SHA } });
  if (joined.includes("/compare/")) out({ status: world.compareStatus ?? "ahead" });
  die("unhandled api: " + joined);
}
die("unhandled: " + joined);
`;

function makeWorld(overrides = {}) {
  return {
    repo: "org/repo",
    pr: { headRefOid: HEAD, baseRefName: "v2", baseRefOid: BASE, isDraft: false, body: "Refs #1", author: { login: "author-bot" }, files: ["x"] },
    diff: DIFF,
    pull: { merge_commit_sha: PROPOSED_SHA },
    commits: {
      [HEAD]: { commit: { tree: { sha: TREE } } },
      [PROPOSED_SHA]: { parents: [{ sha: BASE }, { sha: HEAD }], commit: { tree: { sha: PROPOSED_TREE } } },
      [MERGE_SHA]: { parents: [{ sha: BASE }, { sha: HEAD }], commit: { tree: { sha: PROPOSED_TREE } } },
    },
    ciRuns: [{ id: 10, run_attempt: 1, head_sha: HEAD, event: "pull_request", workflow_id: 123, path: ".github/workflows/verification.yml", conclusion: "success", created_at: "2026-01-01T00:00:00Z" }],
    pushRuns: [{ id: 20, head_sha: MERGE_SHA, event: "push", workflow_id: 123, path: ".github/workflows/verification.yml", conclusion: "success" }],
    jobs: { 10: [{ name: "release-gates", conclusion: "success" }], 20: [{ name: "release-gates", conclusion: "success" }] },
    reviews: [],
    threads: [],
    ref: { object: { sha: MERGE_SHA } },
    afterMerge: { state: "MERGED", mergeCommit: { oid: MERGE_SHA }, headRefOid: HEAD, baseRefOid: BASE },
    merge: { fail: false },
    ...overrides,
  };
}

function defaultReceipt(overrides = {}) {
  return {
    reviewerAgent: "reviewer-agent",
    implementerAgent: "implementer-agent",
    headSha: HEAD,
    baseSha: BASE,
    sourceTreeSha: TREE,
    deltaSha256: createHash("sha256").update(DIFF).digest("hex"),
    changedFiles: ["x"],
    unresolvedBlockingFindings: 0,
    ...overrides,
  };
}

const cleanups = [];
test.after(() => cleanups.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function scaffold({ world = makeWorld(), receipt = defaultReceipt(), receiptText = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mc-fixture-"));
  cleanups.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  symlinkSync(process.execPath, join(bin, "node"));
  const ghPath = join(bin, "gh");
  writeFileSync(ghPath, FAKE_GH, { mode: 0o755 });
  const worldPath = join(dir, "world.json");
  const logPath = join(dir, "gh.log");
  writeFileSync(worldPath, JSON.stringify(world));
  const receiptPath = join(dir, "receipt.json");
  writeFileSync(receiptPath, receiptText ?? JSON.stringify(receipt));
  return { dir, bin, worldPath, logPath, receiptPath, world };
}

function runController(fixture, extraArgs = [], cwd = REPO_ROOT) {
  const env = { ...process.env, PATH: fixture.bin + ":" + process.env.PATH, FAKE_GH_WORLD: fixture.worldPath, FAKE_GH_LOG: fixture.logPath };
  const args = [SCRIPT, "1", "--receipt", fixture.receiptPath, "--expected-reviewer", "reviewer-agent", "--expected-implementer", "implementer-agent", ...extraArgs];
  const result = spawnSync(process.execPath, args, { encoding: "utf8", env, cwd });
  const calls = existsSync(fixture.logPath) ? readFileSync(fixture.logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const mergeCalls = calls.filter((call) => call[0] === "pr" && call[1] === "merge");
  let json = null;
  try { json = JSON.parse(result.stdout); } catch { /* non-JSON */ }
  return { ...result, calls, mergeCalls, json };
}

test("valid dry-run passes without invoking merge", () => {
  const fixture = scaffold();
  const result = runController(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.outcome, "dry-run");
  assert.equal(result.mergeCalls.length, 0);
});

test("valid apply merges exactly once and verifies push gates", () => {
  const fixture = scaffold();
  const result = runController(fixture, ["--apply"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.outcome, "merged-and-verified");
  assert.equal(result.mergeCalls.length, 1);
  assert.deepEqual(result.mergeCalls[0], ["pr", "merge", "1", "--repo", "org/repo", "--merge", "--match-head-commit", HEAD]);
});

const rejectionCases = [
  ["missing receipt file", (fixture) => { rmSync(fixture.receiptPath); }, /receipt/],
  ["missing blocking findings field", (fixture) => { const r = defaultReceipt(); delete r.unresolvedBlockingFindings; writeFileSync(fixture.receiptPath, JSON.stringify(r)); }, /zero unresolved blocking findings/],
  ["non-zero blocking findings", (fixture) => { writeFileSync(fixture.receiptPath, JSON.stringify(defaultReceipt({ unresolvedBlockingFindings: 1 }))); }, /zero unresolved blocking findings/],
  ["self review", (fixture) => { writeFileSync(fixture.receiptPath, JSON.stringify(defaultReceipt({ reviewerAgent: "implementer-agent" }))); }, /distinct from implementer/],
  ["wrong expected reviewer", (fixture) => { writeFileSync(fixture.receiptPath, JSON.stringify(defaultReceipt({ reviewerAgent: "someone-else" }))); }, /does not match trusted expected reviewer/],
  ["stale head", (fixture) => { writeFileSync(fixture.receiptPath, JSON.stringify(defaultReceipt({ headSha: "0".repeat(40) }))); }, /head does not match current PR head/],
  ["wrong base", (fixture) => { writeFileSync(fixture.receiptPath, JSON.stringify(defaultReceipt({ baseSha: "0".repeat(40) }))); }, /base does not match current PR base/],
  ["wrong source tree", (fixture) => { writeFileSync(fixture.receiptPath, JSON.stringify(defaultReceipt({ sourceTreeSha: "0".repeat(40) }))); }, /source tree does not match/],
  ["unverified delta", (fixture) => { writeFileSync(fixture.receiptPath, JSON.stringify(defaultReceipt({ deltaSha256: "0".repeat(64) }))); }, /delta digest does not match/],
  ["wrong changed files", (fixture) => { writeFileSync(fixture.receiptPath, JSON.stringify(defaultReceipt({ changedFiles: ["y"] }))); }, /changed files do not match/],
  ["failed CI", (fixture) => { fixture.world.ciRuns[0].conclusion = "failure"; writeFileSync(fixture.worldPath, JSON.stringify(fixture.world)); }, /release-gates/],
  ["missing CI", (fixture) => { fixture.world.ciRuns = []; writeFileSync(fixture.worldPath, JSON.stringify(fixture.world)); }, /release-gates/],
  ["unresolved thread", (fixture) => { fixture.world.threads = [{ isResolved: false }]; writeFileSync(fixture.worldPath, JSON.stringify(fixture.world)); }, /unresolved/],
  ["open dependency", (fixture) => { fixture.world.pr.body = "Refs #1\nDependencies: #9"; fixture.world.issues = { 9: { number: 9, state: "OPEN" } }; writeFileSync(fixture.worldPath, JSON.stringify(fixture.world)); }, /dependency/],
  ["draft PR", (fixture) => { fixture.world.pr.isDraft = true; writeFileSync(fixture.worldPath, JSON.stringify(fixture.world)); }, /draft/],
  ["wrong PR base branch", (fixture) => { fixture.world.pr.baseRefName = "main"; writeFileSync(fixture.worldPath, JSON.stringify(fixture.world)); }, /base branch/],
  ["proposed merge parents mismatch", (fixture) => { fixture.world.commits[PROPOSED_SHA].parents = [{ sha: HEAD }, { sha: BASE }]; writeFileSync(fixture.worldPath, JSON.stringify(fixture.world)); }, /proposed merge parents/],
];

for (const [name, mutate, pattern] of rejectionCases) {
  test(`rejects ${name} without invoking merge`, () => {
    const fixture = scaffold();
    mutate(fixture);
    fixture.world = JSON.parse(readFileSync(fixture.worldPath, "utf8"));
    const result = runController(fixture, ["--apply"]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, pattern);
    assert.equal(result.mergeCalls.length, 0);
  });
}

test("rejects candidate-owned receipt inside the candidate checkout", () => {
  const fixture = scaffold();
  const inside = join(REPO_ROOT, "candidate-receipt.json");
  writeFileSync(inside, JSON.stringify(defaultReceipt()));
  cleanups.push(inside);
  const result = runController({ ...fixture, receiptPath: inside }, ["--apply"]);
  assert.match(result.stdout, /candidate-owned review receipt rejected/);
  assert.equal(result.mergeCalls.length, 0);
});

test("rejects symlink escaping into the candidate checkout", () => {
  const fixture = scaffold();
  const inside = join(REPO_ROOT, "candidate-receipt.json");
  writeFileSync(inside, JSON.stringify(defaultReceipt()));
  cleanups.push(inside);
  const link = join(fixture.dir, "link-receipt.json");
  symlinkSync(inside, link);
  const result = runController({ ...fixture, receiptPath: link }, ["--apply"]);
  assert.match(result.stdout, /candidate-owned review receipt rejected/);
  assert.equal(result.mergeCalls.length, 0);
});

test("rejects TOCTOU head change before merge", () => {
  const ALT_HEAD = "0".repeat(40);
  const world = makeWorld({ headSequence: [HEAD, ALT_HEAD] });
  world.commits[ALT_HEAD] = { commit: { tree: { sha: TREE } } };
  const fixture = scaffold({ world });
  const result = runController(fixture, ["--apply"]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /rejected-toctou/);
  assert.equal(result.mergeCalls.length, 0);
});

test("postmerge parents mismatch is not merged-and-verified", () => {
  const world = makeWorld();
  world.commits[MERGE_SHA] = { parents: [{ sha: BASE }], commit: { tree: { sha: PROPOSED_TREE } } };
  const fixture = scaffold({ world });
  const result = runController(fixture, ["--apply"]);
  assert.equal(result.status, 1);
  assert.equal(result.json.outcome, "postmerge-verification-failed");
  assert.match(result.stdout, /merge parents mismatch/);
});

test("postmerge tree mismatch is not merged-and-verified", () => {
  const world = makeWorld();
  world.commits[MERGE_SHA].commit.tree.sha = "0".repeat(40);
  const fixture = scaffold({ world });
  const result = runController(fixture, ["--apply"]);
  assert.equal(result.status, 1);
  assert.equal(result.json.outcome, "postmerge-verification-failed");
  assert.match(result.stdout, /merge tree mismatch/);
});

test("missing exact push stops as waiting, not merged-and-verified", () => {
  const world = makeWorld({ ref: { object: { sha: "0".repeat(40) } } });
  const fixture = scaffold({ world });
  const result = runController(fixture, ["--apply"]);
  assert.equal(result.status, 1);
  assert.equal(result.json.outcome, "waiting-for-push-verification");
  assert.equal(result.mergeCalls.length, 1);
});

test("failed post-push release gates stop as waiting", () => {
  const world = makeWorld();
  world.jobs[20] = [{ name: "release-gates", conclusion: "failure" }];
  const fixture = scaffold({ world });
  const result = runController(fixture, ["--apply"]);
  assert.equal(result.status, 1);
  assert.equal(result.json.outcome, "waiting-for-push-verification");
});

test("merge command failure preserves outcome", () => {
  const world = makeWorld({ merge: { fail: true } });
  const fixture = scaffold({ world });
  const result = runController(fixture, ["--apply"]);
  assert.equal(result.status, 1);
  assert.equal(result.json.outcome, "merge-failed");
  assert.equal(result.mergeCalls.length, 1);
});

test("check mode verifies an already merged PR without merging", () => {
  const fixture = scaffold();
  const result = runController(fixture, ["--check"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.outcome, "merged-and-verified");
  assert.equal(result.mergeCalls.length, 0);
});

test("guard removal control: bypassing receipt validation reddens the named assertion, restore is green", () => {
  const source = readFileSync(SCRIPT, "utf8");
  const sourceHash = createHash("sha256").update(source).digest("hex");
  const fixture = scaffold({ receipt: defaultReceipt({ unresolvedBlockingFindings: 1 }) });
  const red = runController(fixture, ["--apply"]);
  assert.equal(red.status, 1);
  assert.match(red.stdout, /zero unresolved blocking findings/);

  // Load-bearing control: a copy that silently clears the validator must NOT reject.
  const bypass = source.replace(
    'if (typeof receipt.unresolvedBlockingFindings !== "number" || !Number.isInteger(receipt.unresolvedBlockingFindings) || receipt.unresolvedBlockingFindings !== 0) {',
    'if (false) {',
  );
  assert.notEqual(bypass, source, "control must change the guard source");
  const bypassPath = join(fixture.dir, "merge-controller-bypass.mjs");
  writeFileSync(bypassPath, bypass);
  const bypassRun = spawnSync(process.execPath, [bypassPath, "1", "--receipt", fixture.receiptPath, "--expected-reviewer", "reviewer-agent", "--expected-implementer", "implementer-agent", "--apply"], {
    encoding: "utf8",
    cwd: REPO_ROOT,
    env: { ...process.env, PATH: fixture.bin + ":" + process.env.PATH, FAKE_GH_WORLD: fixture.worldPath, FAKE_GH_LOG: fixture.logPath },
  });
  assert.doesNotMatch(bypassRun.stdout, /zero unresolved blocking findings/);

  // Restore: source is byte-identical and the real guard is green on a valid receipt.
  assert.equal(createHash("sha256").update(readFileSync(SCRIPT, "utf8")).digest("hex"), sourceHash);
  const greenFixture = scaffold();
  const green = runController(greenFixture, ["--apply"]);
  assert.equal(green.status, 0, green.stderr);
  assert.equal(green.json.outcome, "merged-and-verified");
});
