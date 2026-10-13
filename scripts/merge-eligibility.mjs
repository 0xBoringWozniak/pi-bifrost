#!/usr/bin/env node
import { execFileSync } from "node:child_process";

export function evaluateEligibility({ pr, checks, dependencies = [] }) {
  const blockers = [];
  const head = pr?.headRefOid;
  if (!pr || !head) return { eligible: false, blockers: ["PR data or head SHA unavailable"] };
  if (pr.baseRefName !== "v2") blockers.push("base branch is not v2");
  if (pr.isDraft) blockers.push("PR is draft");
  if (!pr.body?.match(/Refs #\d+/i)) blockers.push("linked issue reference missing");
  if (!pr.body?.includes(`<!-- bifrost-acceptance: ${head} -->`)) blockers.push("explicit acceptance is not bound to current head");
  if (dependencies.some((dependency) => dependency.state !== "CLOSED")) blockers.push("dependency is missing, unknown, or open");
  if (!Array.isArray(checks) || checks.length === 0) blockers.push("required CI checks missing");
  else if (checks.some((check) => check.status !== "COMPLETED" || check.conclusion !== "SUCCESS")) blockers.push("required CI checks incomplete or failed");
  const reviews = pr.reviews;
  if (!Array.isArray(reviews)) blockers.push("review data unavailable");
  else {
    const approval = reviews.some((review) => review.state === "APPROVED" && review.author?.login && review.author.login !== pr.author?.login && review.commit?.oid === head);
    if (!approval) blockers.push("no independent approval on current head");
    if (reviews.some((review) => review.state === "CHANGES_REQUESTED" && review.commit?.oid === head)) blockers.push("blocking review finding unresolved");
  }
  // GitHub ruleset does not enforce approval; this report is advisory, never merge authorization.
  blockers.push("GitHub policy cannot enforce this script's evidence; human merge required");
  return { eligible: blockers.length === 1, head, blockers };
}

function gh(args) {
  return JSON.parse(execFileSync("gh", args, { encoding: "utf8" }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const repo = process.env.GITHUB_REPOSITORY ?? gh(["repo", "view", "--json", "nameWithOwner"]).nameWithOwner;
    const number = process.argv[2];
    if (!/^\d+$/.test(number ?? "")) throw new Error("Usage: node scripts/merge-eligibility.mjs <pr-number>");
    const pr = gh(["pr", "view", number, "--repo", repo, "--json", "headRefOid,baseRefName,isDraft,body,reviews,author,statusCheckRollup"]);
    const issueRefs = [...(pr.body ?? "").matchAll(/Depends on #([0-9]+)/gi)].map((match) => match[1]);
    const dependencies = issueRefs.map((issue) => gh(["issue", "view", issue, "--repo", repo, "--json", "state"]));
    const checks = pr.statusCheckRollup.map((check) => ({ status: check.status ?? "COMPLETED", conclusion: check.conclusion ?? check.state }));
    const result = evaluateEligibility({ pr, checks, dependencies });
    console.log(JSON.stringify({ ...result, policyLimit: "No merge action performed. Current GitHub ruleset does not enforce approval; human merge required." }, null, 2));
    process.exitCode = result.eligible ? 0 : 1;
  } catch (error) {
    console.error(`Eligibility check failed closed: ${error.message}`);
    process.exitCode = 1;
  }
}
