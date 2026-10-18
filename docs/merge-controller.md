# Merge controller

Small, fail-closed helper for merging an already eligible pull request.

- Default mode is dry-run.
- Reuses `scripts/merge-eligibility.mjs` checks; does not weaken them.
- Requires a caller-designated trusted independent-review receipt outside the candidate checkout.
- Applies with `gh pr merge --merge --match-head-commit <head>` (no admin bypass).
- Verifies post-merge parents, tree, and exact push before success.
