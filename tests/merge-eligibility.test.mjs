import test from "node:test";
import assert from "node:assert/strict";
import { evaluateEligibility } from "../scripts/merge-eligibility.mjs";

const head = "abc123";
const valid = {
  pr: {
    headRefOid: head, baseRefName: "v2", isDraft: false, author: { login: "author" },
    body: `Refs #41\n<!-- bifrost-acceptance: ${head} -->`,
    reviews: [{ state: "APPROVED", author: { login: "reviewer" }, commit: { oid: head } }],
  },
  checks: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
  dependencies: [{ state: "CLOSED" }],
};

test("accepts complete evidence for current head but reports policy limitation", () => {
  const result = evaluateEligibility(valid);
  assert.equal(result.eligible, true);
  assert.deepEqual(result.blockers, ["GitHub policy cannot enforce this script's evidence; human merge required"]);
  assert.equal(result.head, head);
});

for (const [label, patch] of [
  ["missing CI", { checks: [] }],
  ["failed CI", { checks: [{ status: "COMPLETED", conclusion: "FAILURE" }] }],
  ["stale approval", { pr: { reviews: [{ state: "APPROVED", author: { login: "reviewer" }, commit: { oid: "old" } }] } }],
  ["author approval", { pr: { reviews: [{ state: "APPROVED", author: { login: "author" }, commit: { oid: head } }] } }],
  ["wrong base", { pr: { baseRefName: "main" } }],
  ["open dependency", { dependencies: [{ state: "OPEN" }] }],
  ["missing acceptance binding", { pr: { body: "Refs #41" } }],
  ["blocking finding", { pr: { reviews: [{ state: "CHANGES_REQUESTED", commit: { oid: head } }] } }],
  ["draft", { pr: { isDraft: true } }],
]) {
  test(`rejects ${label}`, () => {
    const input = { ...valid, ...patch, pr: { ...valid.pr, ...patch.pr } };
    assert.equal(evaluateEligibility(input).eligible, false);
  });
}

test("unknown PR data fails closed", () => {
  assert.equal(evaluateEligibility({}).eligible, false);
});
