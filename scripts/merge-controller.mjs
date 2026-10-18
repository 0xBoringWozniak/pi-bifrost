#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
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
const LIMITATIONS = ["GitHub ruleset does not enforce this report; human merge required"];

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8" }).trim();
}

function ghJson(args) {
  return JSON.parse(gh(args));
}

function parseArgs(argv) {
  const values = {
    pr: null,
    receipt: null,
    apply: false,
    dryRun: true,
    repo: process.env.GITHUB_REPOSITORY ?? null,
    base: null,
    outcome: null,
  };
  const receiptFlags = new Set(["--receipt", "--receipt-path", "--trusted-receipt", "--independent-review-receipt", "--review-receipt", "--receipt-file"]);
  const applyFlags = new Set(["--apply", "--execute", "--merge", "--run"]);
  const dryFlags = new Set(["--dry-run", "--dryrun"]);
  let i = 0;
  for (; i < argv.length; i++) {
    const raw = argv[i];
    if (raw === "--") { i++; break; }
    const eq = raw.indexOf("=");
    const flag = eq < 0 ? raw : raw.slice(0, eq);
    const value = eq < 0 ? undefined : raw.slice(eq + 1);
    if (/^\d+$/.test(raw) && values.pr === null) { values.pr = Number(raw); continue; }
    if (receiptFlags.has(flag)) {
      const v = value === undefined ? argv[++i] : value;
      if (!v || v.startsWith("--")) throw new Error(`${flag} requires a value`);
      values.receipt = v;
      continue;
    }
    if (flag === "--repo") {
      const v = value === undefined ? argv[++i] : value;
      if (!v || v.startsWith("--")) throw new Error("--repo requires a value");
      values.repo = v;
      continue;
    }
    if (flag === "--base") {
      const v = value === undefined ? argv[++i] : value;
      if (!v || v.startsWith("--")) throw new Error("--base requires a value");
      values.base = v;
      continue;
    }
    if (flag === "--outcome" || flag === "--outcome-file" || flag === "--result" || flag === "--result-file") {
      const v = value === undefined ? argv[++i] : value;
      if (!v || v.startsWith("--")) throw new Error(`${flag} requires a value`);
      values.outcome = v;
      continue;
    }
    if (applyFlags.has(flag)) { values.apply = true; values.dryRun = false; continue; }
    if (dryFlags.has(flag)) { values.dryRun = true; values.apply = false; continue; }
    if (flag === "--no-apply" || flag === "--no-merge") { values.apply = false; values.dryRun = true; continue; }
    throw new Error(`unknown merge-controller flag: ${JSON.stringify(raw)}`);
  }
  const rest = argv.slice(i);
  for (const item of rest) {
    if (/^\d+$/.test(item) && values.pr === null) values.pr = Number(item);
    else throw new Error(`unexpected argument: ${JSON.stringify(item)}`);
  }
  if (values.pr === null) throw new Error("Usage: node scripts/merge-controller.mjs <pr-number> --receipt <path> [--apply]");
  if (!values.repo) {
    values.repo = ghJson(["repo", "view", "--json", "nameWithOwner"]).nameWithOwner;
  }
  return values;
}

function collectEvidence(repo, number) {
  const pr = ghJson(["pr", "view", String(number), "--repo", repo, "--json", "headRefOid,baseRefName,baseRefOid,isDraft,body,author"]);
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
  return { pr, workflow, baseWorkflow, headWorkflow, workflowRuns, reviews, reviewThreads, refs, dependencies, workflowFileMatchesBase, eligibility };
}

function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

function getPrDiffHash(repo, number) {
  try {
    const diff = gh(["pr", "diff", String(number), "--repo", repo]);
    return sha256Text(diff);
  } catch {
    return null;
  }
}

function validateReceipt(receipt, { head, repoRoot }) {
  const errors = [];
  if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)) {
    return { valid: false, errors: ["trusted review receipt missing or malformed"], blockingCount: 0 };
  }
  if (receipt.candidateOwned === true || receipt.candidate_owned === true || receipt.ownedByCandidate === true) {
    errors.push("candidate-owned review receipt rejected");
  }
  if (Array.isArray(receipt.receipts) || Array.isArray(receipt.reviews) && receipt.reviews.length > 1) {
    errors.push("ambiguous review receipt");
  }
  const reviewer = receipt.reviewerAgent ?? receipt.reviewer_agent ?? receipt.reviewer ?? receipt.reviewedBy ?? receipt.reviewed_by ?? receipt.agent;
  const implementer = receipt.implementerAgent ?? receipt.implementer_agent ?? receipt.implementer ?? receipt.implementerId ?? receipt.subjectAgent ?? receipt.subject_agent ?? receipt.authorAgent ?? receipt.author_agent;
  const reviewedHead = receipt.reviewedHead ?? receipt.reviewed_head ?? receipt.head ?? receipt.headSha ?? receipt.head_sha ?? receipt.reviewedCommit ?? receipt.reviewed_commit ?? receipt.commit ?? receipt.commitId ?? receipt.commit_id;
  const blockingRaw = receipt.unresolvedBlockingFindings ?? receipt.blockingFindings ?? receipt.blocking_findings ?? receipt.findings ?? receipt.unresolved_findings ?? receipt.blocking ?? 0;
  const deltaHash = receipt.deltaHash ?? receipt.delta_hash ?? receipt.patchHash ?? receipt.patch_hash ?? receipt.diffHash ?? receipt.diff_hash ?? receipt.patchDigest ?? receipt.patch_digest;
  const sourceHash = receipt.sourceHash ?? receipt.source_hash ?? receipt.baseHash ?? receipt.base_hash ?? receipt.sourceDigest ?? receipt.source_digest;
  const receiptPathInside = false;

  if (typeof reviewer !== "string" || !reviewer) errors.push("trusted reviewer agent missing");
  if (typeof implementer !== "string" || !implementer) errors.push("implementer agent missing");
  if (reviewer && implementer && reviewer === implementer) errors.push("reviewer agent must be distinct from implementer");
  if (reviewer && implementer && receipt.self === true) errors.push("self review rejected");

  let blockingCount = 0;
  if (Array.isArray(blockingRaw)) blockingCount = blockingRaw.length;
  else if (typeof blockingRaw === "number") blockingCount = blockingRaw;
  else if (typeof blockingRaw === "string") blockingCount = blockingRaw.trim() === "" ? 0 : 1;
  else if (blockingRaw) blockingCount = 1;
  if (blockingCount !== 0) errors.push("unresolved blocking findings present");

  if (typeof deltaHash !== "string" || !deltaHash) errors.push("delta hash missing or unverified");
  if (typeof sourceHash !== "string" || !sourceHash) errors.push("source hash missing");

  // reviewed head or byte-identical independently bound patch
  let headBindingOk = reviewedHead === head;
  let patchBindingOk = false;
  if (!headBindingOk && typeof deltaHash === "string" && deltaHash) {
    const currentDiffHash = getPrDiffHash(process.env.GITHUB_REPOSITORY ?? "", 0) ? null : null;
    // placeholder; handled by caller with repo/number
  }
  if (!headBindingOk && !patchBindingOk) {
    // allow reviewedHead stale only if delta hash matches independently computed diff
  }

  if (typeof reviewedHead !== "string" || !reviewedHead) errors.push("reviewed head missing");
  else if (reviewedHead !== head) {
    // stale unless patch binding verified by caller; mark for caller
    errors.push("stale reviewed head");
  }

  return {
    valid: errors.length === 0,
    errors,
    reviewer,
    implementer,
    reviewedHead,
    blockingCount,
    deltaHash,
    sourceHash,
    headBindingOk,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repo = args.repo;
  const candidateRoot = resolve(process.cwd());
  const receiptPath = args.receipt ? resolve(args.receipt) : null;
  if (!receiptPath) {
    console.error("trusted review receipt path is required");
    process.exitCode = 1;
    return;
  }
  if (receiptPath === candidateRoot || receiptPath.startsWith(candidateRoot + sep)) {
    console.error("candidate-owned review receipt rejected");
    process.exitCode = 1;
    return;
  }
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  } catch (error) {
    console.error(`trusted review receipt unavailable: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  let evidence;
  try {
    evidence = collectEvidence(repo, args.pr);
  } catch (error) {
    console.error(`eligibility evidence unavailable: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const head = evidence.pr.headRefOid;
  const baseOid = evidence.pr.baseRefOid;

  // verify delta hash binding for stale reviewed head
  let receiptValidation = validateReceipt(receipt, { head, repoRoot: candidateRoot });
  if (receiptValidation.reviewedHead && receiptValidation.reviewedHead !== head) {
    const diffHash = getPrDiffHash(repo, args.pr);
    if (diffHash && receiptValidation.deltaHash === diffHash) {
      // byte-identical independently bound patch: clear stale-head error
      receiptValidation = { ...receiptValidation, valid: receiptValidation.errors.filter((e) => e !== "stale reviewed head").length === 0, errors: receiptValidation.errors.filter((e) => e !== "stale reviewed head") };
    }
  }

  const githubBlockers = (evidence.eligibility.blockers ?? []).filter((b) => b !== "no independent approval on current head");
  const eligible = githubBlockers.length === 0 && receiptValidation.valid === true;
  const blockers = [...githubBlockers, ...receiptValidation.errors];

  const summary = {
    pr: args.pr,
    repo,
    mode: args.apply ? "apply" : "dry-run",
    eligible,
    head,
    base: baseOid,
    blockers,
    trustedReview: {
      valid: receiptValidation.valid,
      reviewer: receiptValidation.reviewer,
      implementer: receiptValidation.implementer,
      reviewedHead: receiptValidation.reviewedHead,
      blockingFindings: receiptValidation.blockingCount,
    },
    limitations: LIMITATIONS,
  };

  // TOCTOU requery before apply
  let currentEvidence = evidence;
  if (args.apply && eligible) {
    let rechecked;
    try {
      rechecked = collectEvidence(repo, args.pr);
    } catch (error) {
      console.error(`requery failed: ${error.message}`);
      process.exitCode = 1;
      console.log(JSON.stringify({ ...summary, outcome: "requery-failed" }, null, 2));
      return;
    }
    const reReceipt = receipt;
    const reValidation = validateReceipt(reReceipt, { head: rechecked.pr.headRefOid, repoRoot: candidateRoot });
    const reGithubBlockers = (rechecked.eligibility.blockers ?? []).filter((b) => b !== "no independent approval on current head");
    const changed = rechecked.pr.headRefOid !== head || rechecked.pr.baseRefOid !== baseOid || reGithubBlockers.length !== 0 || !reValidation.valid;
    if (changed) {
      console.log(JSON.stringify({ ...summary, head: rechecked.pr.headRefOid, base: rechecked.pr.baseRefOid, eligible: false, blockers: [...(rechecked.eligibility.blockers ?? []), ...reValidation.errors, "TOCTOU requery mismatch"], outcome: "rejected-toctou" }, null, 2));
      process.exitCode = 1;
      return;
    }
    currentEvidence = rechecked;
  }

  if (!eligible) {
    console.log(JSON.stringify({ ...summary, outcome: "rejected" }, null, 2));
    process.exitCode = 1;
    return;
  }

  if (!args.apply) {
    console.log(JSON.stringify({ ...summary, outcome: "dry-run" }, null, 2));
    process.exitCode = 0;
    return;
  }

  // apply merge
  const mergeHead = currentEvidence.pr.headRefOid;
  const mergeResult = spawnSync("gh", ["pr", "merge", String(args.pr), "--repo", repo, "--merge", "--match-head-commit", mergeHead], { encoding: "utf8" });
  if (mergeResult.status !== 0) {
    const out = { ...summary, outcome: "merge-failed", merge: { status: mergeResult.status, stdout: mergeResult.stdout, stderr: mergeResult.stderr } };
    console.log(JSON.stringify(out, null, 2));
    if (args.outcome) writeFileSync(resolve(args.outcome), JSON.stringify(out, null, 2));
    process.exitCode = 1;
    return;
  }

  // post-merge verification
  let postVerified = false;
  let postDetails = {};
  try {
    const after = ghJson(["pr", "view", String(args.pr), "--repo", repo, "--json", "state,mergeCommit,baseRefName,headRefOid"]);
    const mergeCommit = after.mergeCommit?.oid;
    const commit = mergeCommit ? ghJson(["api", `repos/${repo}/commits/${mergeCommit}`]) : null;
    const parents = Array.isArray(commit?.parents) ? commit.parents.map((p) => p.sha) : [];
    const ref = after.baseRefName ? ghJson(["api", `repos/${repo}/git/ref/heads/${after.baseRefName}`]) : null;
    const refSha = ref?.object?.sha ?? ref?.sha;
    postDetails = { state: after.state, mergeCommit, parents, refSha };
    postVerified = after.state === "MERGED" && !!mergeCommit && parents.includes(mergeHead) && refSha === mergeCommit;
  } catch (error) {
    postDetails = { error: error.message };
  }

  const outcome = postVerified ? "merged-and-verified" : "postmerge-verification-failed";
  const final = { ...summary, outcome, merge: { status: 0, stdout: mergeResult.stdout, stderr: mergeResult.stderr }, postMerge: { verified: postVerified, ...postDetails } };
  console.log(JSON.stringify(final, null, 2));
  if (args.outcome) writeFileSync(resolve(args.outcome), JSON.stringify(final, null, 2));
  process.exitCode = postVerified ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) {
    console.error(`Merge controller failed closed: ${error.message}`);
    process.exitCode = 1;
  }
}