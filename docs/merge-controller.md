# Merge controller

Small, fail-closed helper for merging an eligible pull request after a
controller-side independent review.

```bash
node scripts/merge-controller.mjs <pr-number> \
  --receipt <path-outside-candidate-checkout> \
  --expected-reviewer <agent-id> \
  --expected-implementer <agent-id> \
  [--repo <owner/name>] [--base <branch>] [--outcome <path>] \
  [--apply | --check]
```

- Default mode is dry-run. `--apply` merges once. `--check` re-verifies an
  already merged PR without merging.
- No admin bypass: merge is `gh pr merge <pr> --repo <repo> --merge
  --match-head-commit <head>`.
- The receipt path must resolve outside the real candidate checkout; symlink
  escapes and candidate-owned receipts are rejected.
- The trusted reviewer and implementer identities are supplied by the local
  controller operator. There is no candidate-supplied approval comment or file
  trust path.

## Trusted receipt schema

One explicit schema. Every field is required. Missing
`unresolvedBlockingFindings` is never treated as zero.

```json
{
  "reviewerAgent": "reviewer-agent-id",
  "implementerAgent": "implementer-agent-id",
  "headSha": "<40-hex commit sha>",
  "baseSha": "<40-hex commit sha>",
  "sourceTreeSha": "<40-hex tree sha>",
  "deltaSha256": "<64-hex sha256 of the raw PR diff>",
  "changedFiles": ["path/one", "path/two"],
  "unresolvedBlockingFindings": 0
}
```

- `sourceTreeSha` is the actual GitHub head-commit tree, not a caller string.
- `deltaSha256` is the sha256 of the raw `gh pr diff` output.
- `changedFiles` must exactly match the PR file inventory.
- `reviewerAgent` must differ from `implementerAgent` and match the trusted
  expected reviewer; `implementerAgent` must match the trusted expected
  implementer.

The receipt is a local operator trust boundary. It does not enforce GitHub
review policy and is not a cryptographic attestation.

## Bounds and outcomes

Before merging with `--apply`, the controller re-queries head, base, receipt,
threads, dependencies, CI, the changed-file inventory, and the proposed merge
parents/tree. Any change is a TOCTOU rejection and no merge is invoked.

After merge it verifies exact merge parents `[base, head]` and the proposed
tree. Then it requires the exact base-branch push and a successful
`release-gates` push run. Outcomes:

- `dry-run` — eligible, no merge.
- `merged-and-verified` — merge plus exact parents, tree, push, and release
  gates all pass.
- `rejected`, `rejected-toctou`, `merge-failed` — no verified merge.
- `postmerge-verification-failed` — merge parents or tree mismatch.
- `waiting-for-push-verification` — exact push or required release gates not
  yet observed; dependent continuation stays stopped.

Re-verify a pending merge without merging by running the same command with
`--check` (a receipt is not needed for `--check`).
