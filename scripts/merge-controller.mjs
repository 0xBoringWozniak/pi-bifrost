#!/usr/bin/env node
// Bounded merge controller for an eligible PR with a trusted, controller-side
// independent-review receipt.
//
// The caller (local controller operator) designates a receipt file outside the
// candidate checkout and the trusted reviewer/implementer identities. The
// receipt is NOT a cryptographic attestation and does not enforce GitHub review
// policy; it is a local trust boundary. Every check fails closed.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import {
  dependencyEvidence,
  evaluateEligibility,
  getReviewThreads,
  getReviews,
  parseDependencies,
  runEvidence,
  workflowHashesMatch,
} from "./merge-eligibility.mjs";

const WORKFLOW_PATH = ".github/workflows/verification.yml";
const REQUIRED_JOB = "release-gates";
const BASE_BRANCH = "v2";
const SHA40 = /^[0-9a-f]{40}$/;
const SHA256_64 = /^[0-9a-f]{64}$/;
const LIMITATIONS = [
  "GitHub ruleset does not enforce this report; human merge required",
  "Trusted receipt is a local operator trust boundary, not a cryptographic attestation",
];

const RECEIPT_FIELDS = [
  "reviewerAgent",
  "implementerAgent",
  "headSha",
  "baseSha",
  "sourceTreeSha",
  "deltaSha256",
  "changedFiles",
  "unresolvedBlockingFindings",
];

class ControllerError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fail(code, message) {
  throw new ControllerError(code, message);
}

function ghRaw(args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function gh(args) {
  return ghRaw(args).trim();
}

function ghJson(args) {
  return JSON.parse(gh(args));
}

function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

export function parseArgs(argv) {
  const values = { pr: null, receipt: null, expectedReviewer: null, expectedImplementer: null, apply: false, check: false, repo: process.env.GITHUB_REPOSITORY ?? null, base: BASE_BRANCH, outcome: null };
  const valueFlags = new Map([
    ["--receipt", "receipt"],
    ["--expected-reviewer", "expectedReviewer"],
    ["--expected-implementer", "expectedImplementer"],
    ["--repo", "repo"],
    ["--base", "base"],
    ["--outcome", "outcome"],
  ]);
  let i = 0;
  for (; i < argv.length; i++) {
    const raw = argv[i];
    if (raw === "--") { i++; break; }
    const eq = raw.indexOf("=");
    const flag = eq < 0 ? raw : raw.slice(0, eq);
    if (valueFlags.has(flag)) {
      const value = eq < 0 ? argv[++i] : raw.slice(eq + 1);
      if (value === undefined || value.startsWith("--") || value === "") fail("cli", `${flag} requires a value`);
      values[valueFlags.get(flag)] = value;
      continue;
    }
    if (raw === "--apply") { values.apply = true; continue; }
    if (raw === "--check") { values.check = true; continue; }
    if (/^\d+$/.test(raw) && values.pr === null) { values.pr = Number(raw); continue; }
    fail("cli", `unknown merge-controller argument: ${JSON.stringify(raw)}`);
  }
  for (const item of argv.slice(i)) {
    if (/^\d+$/.test(item) && values.pr === null) values.pr = Number(item);
    else fail("cli", `unexpected argument: ${JSON.stringify(item)}`);
  }
  if (values.pr === null) fail("cli", "Usage: node scripts/merge-controller.mjs <pr-number> --receipt <path> --expected-reviewer <id> --expected-implementer <id> [--apply|--check]");
  return values;
}

export function candidateRoot(cwd = process.cwd()) {
  try {
    return realpathSync(execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", cwd }).trim());
  } catch {
    return realpathSync(cwd);
  }
}

export function resolveTrustedReceiptPath(receiptPath, root) {
  let real;
  try {
    real = realpathSync(resolve(receiptPath));
  } catch {
    fail("receipt-missing", `trusted review receipt unavailable: ${receiptPath}`);
  }
  if (real === root || real.startsWith(root + sep)) {
    fail("receipt-candidate-owned", "candidate-owned review receipt rejected");
  }
  return real;
}

export function validateReceiptShape(receipt) {
  const errors = [];
  if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)) {
    return { errors: ["trusted review receipt malformed"] };
  }
  for (const field of RECEIPT_FIELDS) {
    if (!(field in receipt)) errors.push(`trusted review receipt missing required field: ${field}`);
  }
  if (typeof receipt.reviewerAgent !== "string" || !receipt.reviewerAgent) errors.push("trusted review receipt reviewer agent missing");
  if (typeof receipt.implementerAgent !== "string" || !receipt.implementerAgent) errors.push("trusted review receipt implementer agent missing");
  if (receipt.reviewerAgent && receipt.implementerAgent && receipt.reviewerAgent === receipt.implementerAgent) errors.push("reviewer agent must be distinct from implementer");
  if (typeof receipt.unresolvedBlockingFindings !== "number" || !Number.isInteger(receipt.unresolvedBlockingFindings) || receipt.unresolvedBlockingFindings !== 0) {
    errors.push("trusted review receipt must declare exactly zero unresolved blocking findings");
  }
  if (!SHA40.test(receipt.headSha ?? "")) errors.push("trusted review receipt headSha must be a 40-hex commit SHA");
  if (!SHA40.test(receipt.baseSha ?? "")) errors.push("trusted review receipt baseSha must be a 40-hex commit SHA");
  if (!SHA40.test(receipt.sourceTreeSha ?? "")) errors.push("trusted review receipt sourceTreeSha must be a 40-hex tree SHA");
  if (!SHA256_64.test(receipt.deltaSha256 ?? "")) errors.push("trusted review receipt deltaSha256 must be a 64-hex digest");
  if (!Array.isArray(receipt.changedFiles) || receipt.changedFiles.some((file) => typeof file !== "string" || !file)) {
    errors.push("trusted review receipt changedFiles must be a list of non-empty paths");
  }
  return { errors };
}

export function bindReceiptToExpectedIdentities(receipt, { expectedReviewer, expectedImplementer }) {
  const errors = [];
  if (!expectedReviewer) errors.push("trusted expected reviewer identity is required");
  else if (receipt?.reviewerAgent !== expectedReviewer) errors.push("reviewer agent does not match trusted expected reviewer");
  if (!expectedImplementer) errors.push("trusted expected implementer identity is required");
  else if (receipt?.implementerAgent !== expectedImplementer) errors.push("implementer agent does not match trusted expected implementer");
  return errors;
}

export function bindReceiptToEvidence(receipt, { headSha, baseSha, sourceTreeSha, deltaSha256, changedFiles }) {
  const errors = [];
  if (receipt?.headSha !== headSha) errors.push("trusted review receipt head does not match current PR head");
  if (receipt?.baseSha !== baseSha) errors.push("trusted review receipt base does not match current PR base");
  if (receipt?.sourceTreeSha !== sourceTreeSha) errors.push("trusted review receipt source tree does not match current PR head tree");
  if (receipt?.deltaSha256 !== deltaSha256) errors.push("trusted review receipt delta digest does not match actual PR diff");
  const expected = [...new Set(changedFiles ?? [])].sort();
  const actual = Array.isArray(receipt?.changedFiles) ? [...new Set(receipt.changedFiles)].sort() : [];
  if (expected.length !== actual.length || expected.some((file, index) => file !== actual[index])) {
    errors.push("trusted review receipt changed files do not match actual PR files");
  }
  return errors;
}

function collectEvidence(repo, number) {
  const pr = ghJson(["pr", "view", String(number), "--repo", repo, "--json", "headRefOid,baseRefName,baseRefOid,isDraft,body,author,files"]);
  const workflow = ghJson(["api", `repos/${repo}/actions/workflows/verification.yml`]);
  const baseWorkflow = ghJson(["api", `repos/${repo}/contents/${WORKFLOW_PATH}?ref=${pr.baseRefOid}`]);
  const headWorkflow = ghJson(["api", `repos/${repo}/contents/${WORKFLOW_PATH}?ref=${pr.headRefOid}`]);
  const workflowRuns = runEvidence(repo, workflow.id, pr.headRefOid);
  const reviews = getReviews(repo, number);
  const reviewThreads = getReviewThreads(repo, number);
  const refs = parseDependencies(pr.body ?? "");
  const dependencies = refs.map((ref) => dependencyEvidence(repo, ref, pr.baseRefName, pr.baseRefOid));
  const workflowFileMatchesBase = workflowHashesMatch(baseWorkflow, headWorkflow);
  const eligibility = evaluateEligibility({ pr, workflowFileMatchesBase, workflowRuns, reviews, reviewThreads, dependencies });
  return { pr, workflow, workflowRuns, reviews, reviewThreads, dependencies, workflowFileMatchesBase, eligibility };
}

export function fetchHeadTree(repo, headSha) {
  const commit = ghJson(["api", `repos/${repo}/commits/${headSha}`]);
  const tree = commit.commit?.tree?.sha ?? commit.tree?.sha;
  if (!SHA40.test(tree ?? "")) fail("evidence", "head commit tree unavailable");
  return tree;
}

export function fetchPrDiffDigest(repo, number) {
  return sha256Text(ghRaw(["pr", "diff", String(number), "--repo", repo]));
}

export function fetchChangedFiles(repo, number) {
  const pr = ghJson(["pr", "view", String(number), "--repo", repo, "--json", "files"]);
  return Array.isArray(pr.files) ? pr.files.map((file) => file.path).filter((path) => typeof path === "string" && path) : null;
}

export function fetchProposedMerge(repo, number) {
  const pr = ghJson(["api", `repos/${repo}/pulls/${number}`]);
  if (!SHA40.test(pr.merge_commit_sha ?? "")) fail("proposed-merge-unavailable", "proposed merge commit unavailable");
  const commit = ghJson(["api", `repos/${repo}/commits/${pr.merge_commit_sha}`]);
  const parents = Array.isArray(commit.parents) ? commit.parents.map((parent) => parent.sha) : [];
  const tree = commit.commit?.tree?.sha ?? commit.tree?.sha;
  if (!SHA40.test(tree ?? "")) fail("proposed-merge-unavailable", "proposed merge tree unavailable");
  return { sha: pr.merge_commit_sha, parents, tree };
}

export function pushGatePassed(repo, workflowId, sha) {
  const runs = ghJson(["api", `repos/${repo}/actions/workflows/${workflowId}/runs?head_sha=${sha}&event=push&per_page=100`]).workflow_runs ?? [];
  const successful = runs.filter((run) => run?.head_sha === sha && run.event === "push" && run.conclusion === "success");
  if (!successful.length) return false;
  const latest = successful.sort((a, b) => Number(b.id) - Number(a.id))[0];
  const jobs = ghJson(["api", `repos/${repo}/actions/runs/${latest.id}/jobs?per_page=100`]).jobs ?? [];
  return jobs.some((job) => job?.name === REQUIRED_JOB && job.conclusion === "success");
}

function writeOutcome(path, payload) {
  if (!path) return;
  try { writeFileSync(resolve(path), JSON.stringify(payload, null, 2)); } catch { /* outcome preservation is best effort */ }
}

function emit(payload, outcomePath) {
  writeOutcome(outcomePath, payload);
  console.log(JSON.stringify(payload, null, 2));
  process.exitCode = payload.outcome === "dry-run" || payload.outcome === "merged-and-verified" ? 0 : 1;
}

function mergeAndVerify({ args, repo, baseBranch, headSha, baseSha, proposedTree, workflowId }) {
  const mergeResult = spawnSync("gh", ["pr", "merge", String(args.pr), "--repo", repo, "--merge", "--match-head-commit", headSha], { encoding: "utf8" });
  if (mergeResult.status !== 0) {
    return { outcome: "merge-failed", details: { status: mergeResult.status, stdout: mergeResult.stdout, stderr: mergeResult.stderr } };
  }
  let after;
  try {
    after = ghJson(["pr", "view", String(args.pr), "--repo", repo, "--json", "state,mergeCommit"]);
  } catch (error) {
    return { outcome: "waiting-for-push-verification", details: { error: error.message } };
  }
  const mergeSha = after?.mergeCommit?.oid;
  if (after?.state !== "MERGED" || !SHA40.test(mergeSha ?? "")) {
    return { outcome: "merge-failed", details: { state: after?.state, mergeCommit: mergeSha } };
  }
  let commit;
  try {
    commit = ghJson(["api", `repos/${repo}/commits/${mergeSha}`]);
  } catch (error) {
    return { outcome: "waiting-for-push-verification", details: { error: error.message } };
  }
  const parents = Array.isArray(commit.parents) ? commit.parents.map((parent) => parent.sha) : [];
  const tree = commit.commit?.tree?.sha ?? commit.tree?.sha;
  if (parents.length !== 2 || parents[0] !== baseSha || parents[1] !== headSha) {
    return { outcome: "postmerge-verification-failed", details: { reason: "merge parents mismatch", parents, mergeSha } };
  }
  if (tree !== proposedTree) {
    return { outcome: "postmerge-verification-failed", details: { reason: "merge tree mismatch", tree, proposedTree, mergeSha } };
  }
  let ref;
  try {
    ref = ghJson(["api", `repos/${repo}/git/ref/heads/${baseBranch}`]);
  } catch (error) {
    return { outcome: "waiting-for-push-verification", details: { reason: "push verification unavailable", error: error.message, mergeSha } };
  }
  const refSha = ref?.object?.sha ?? ref?.sha;
  if (refSha !== mergeSha) {
    return { outcome: "waiting-for-push-verification", details: { reason: "exact push not observed", refSha, mergeSha } };
  }
  if (!pushGatePassed(repo, workflowId, mergeSha)) {
    return { outcome: "waiting-for-push-verification", details: { reason: "required release gates not successful after push", mergeSha } };
  }
  return { outcome: "merged-and-verified", details: { mergeSha, parents, tree, refSha } };
}

function checkMerged({ args, repo, baseBranch, workflowId }) {
  const after = ghJson(["pr", "view", String(args.pr), "--repo", repo, "--json", "state,mergeCommit,headRefOid,baseRefOid"]);
  if (after?.state !== "MERGED" || !SHA40.test(after?.mergeCommit?.oid ?? "")) {
    return { outcome: "not-merged", details: { state: after?.state } };
  }
  const mergeSha = after.mergeCommit.oid;
  const commit = ghJson(["api", `repos/${repo}/commits/${mergeSha}`]);
  const parents = Array.isArray(commit.parents) ? commit.parents.map((parent) => parent.sha) : [];
  const tree = commit.commit?.tree?.sha ?? commit.tree?.sha;
  if (parents.length !== 2 || parents[0] !== after.baseRefOid || parents[1] !== after.headRefOid) {
    return { outcome: "postmerge-verification-failed", details: { reason: "merge parents mismatch", parents, mergeSha } };
  }
  const ref = ghJson(["api", `repos/${repo}/git/ref/heads/${baseBranch}`]);
  const refSha = ref?.object?.sha ?? ref?.sha;
  if (refSha !== mergeSha) return { outcome: "waiting-for-push-verification", details: { reason: "exact push not observed", refSha, mergeSha } };
  if (!pushGatePassed(repo, workflowId, mergeSha)) return { outcome: "waiting-for-push-verification", details: { reason: "required release gates not successful after push", mergeSha } };
  return { outcome: "merged-and-verified", details: { mergeSha, parents, tree } };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = candidateRoot();
  const repo = args.repo ?? ghJson(["repo", "view", "--json", "nameWithOwner"]).nameWithOwner;

  if (args.check) {
    const result = checkMerged({ args, repo, baseBranch: args.base, workflowId: ghJson(["api", `repos/${repo}/actions/workflows/verification.yml`]).id });
    emit({ pr: args.pr, repo, mode: "check", ...result, limitations: LIMITATIONS }, args.outcome);
    return;
  }

  if (!args.receipt) fail("cli", "--receipt is required");
  const receiptPath = resolveTrustedReceiptPath(args.receipt, root);
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  } catch {
    fail("receipt-malformed", "trusted review receipt is not valid JSON");
  }

  const baseBranch = args.base;
  const evidence = collectEvidence(repo, args.pr);
  const pr = evidence.pr;
  if (pr.baseRefName !== baseBranch) fail("wrong-base", `PR base branch is not ${baseBranch}`);
  const headSha = pr.headRefOid;
  const baseSha = pr.baseRefOid;
  const sourceTreeSha = fetchHeadTree(repo, headSha);
  const deltaSha256 = fetchPrDiffDigest(repo, args.pr);
  const changedFiles = fetchChangedFiles(repo, args.pr);
  if (changedFiles === null) fail("evidence", "PR changed files unavailable");
  const proposed = fetchProposedMerge(repo, args.pr);
  if (proposed.parents.length !== 2 || proposed.parents[0] !== baseSha || proposed.parents[1] !== headSha) {
    fail("proposed-merge-mismatch", "proposed merge parents do not match current base and head");
  }

  const shape = validateReceiptShape(receipt);
  const identityErrors = bindReceiptToExpectedIdentities(receipt, { expectedReviewer: args.expectedReviewer, expectedImplementer: args.expectedImplementer });
  const evidenceErrors = bindReceiptToEvidence(receipt, { headSha, baseSha, sourceTreeSha, deltaSha256, changedFiles });
  const receiptErrors = [...shape.errors, ...identityErrors, ...evidenceErrors];
  const githubBlockers = (evidence.eligibility.blockers ?? []).filter((blocker) => blocker !== "no independent approval on current head");
  const blockers = [...githubBlockers, ...receiptErrors];

  const summary = {
    pr: args.pr,
    repo,
    mode: args.apply ? "apply" : "dry-run",
    head: headSha,
    base: baseSha,
    sourceTree: sourceTreeSha,
    proposedMerge: { sha: proposed.sha, parents: proposed.parents, tree: proposed.tree },
    trustedReview: { reviewerAgent: receipt?.reviewerAgent, implementerAgent: receipt?.implementerAgent, valid: receiptErrors.length === 0 },
    blockers,
    limitations: LIMITATIONS,
  };

  if (blockers.length) {
    emit({ ...summary, outcome: "rejected" }, args.outcome);
    return;
  }

  if (!args.apply) {
    emit({ ...summary, outcome: "dry-run" }, args.outcome);
    return;
  }

  // TOCTOU requery: every bound value must be identical immediately before merge.
  const recheck = collectEvidence(repo, args.pr);
  const reHead = recheck.pr.headRefOid;
  const reBase = recheck.pr.baseRefOid;
  const reTree = fetchHeadTree(repo, reHead);
  const reDelta = fetchPrDiffDigest(repo, args.pr);
  const reFiles = fetchChangedFiles(repo, args.pr);
  const reProposed = fetchProposedMerge(repo, args.pr);
  const reShape = validateReceiptShape(receipt);
  const reEvidenceErrors = bindReceiptToEvidence(receipt, { headSha: reHead, baseSha: reBase, sourceTreeSha: reTree, deltaSha256: reDelta, changedFiles: reFiles ?? [] });
  const reGithubBlockers = (recheck.eligibility.blockers ?? []).filter((blocker) => blocker !== "no independent approval on current head");
  const toctouMismatch = reHead !== headSha || reBase !== baseSha || reTree !== sourceTreeSha || reDelta !== deltaSha256
    || JSON.stringify([...(reFiles ?? [])].sort()) !== JSON.stringify([...changedFiles].sort())
    || reProposed.sha !== proposed.sha || reProposed.tree !== proposed.tree
    || JSON.stringify(reProposed.parents) !== JSON.stringify(proposed.parents)
    || reShape.errors.length !== 0 || reEvidenceErrors.length !== 0 || reGithubBlockers.length !== 0;
  if (toctouMismatch) {
    emit({ ...summary, head: reHead, base: reBase, proposedMerge: { sha: reProposed.sha, parents: reProposed.parents, tree: reProposed.tree }, outcome: "rejected-toctou" }, args.outcome);
    return;
  }

  const workflowId = evidence.workflow.id;
  const result = mergeAndVerify({ args, repo, baseBranch, headSha, baseSha, proposedTree: proposed.tree, workflowId });
  emit({ ...summary, outcome: result.outcome, postMerge: result.details }, args.outcome);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  try {
    main();
  } catch (error) {
    const payload = { outcome: error.code === "cli" ? "usage-error" : "rejected", error: error.message, code: error.code ?? "unknown", limitations: LIMITATIONS };
    const outcomeIndex = process.argv.indexOf("--outcome");
    const outcomePath = outcomeIndex >= 0 ? process.argv[outcomeIndex + 1] : process.argv.find((arg) => arg.startsWith("--outcome="))?.slice("--outcome=".length);
    writeOutcome(outcomePath, payload);
    console.log(JSON.stringify(payload, null, 2));
    process.exitCode = 1;
  }
}
