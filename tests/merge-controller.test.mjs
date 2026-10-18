import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = new URL("../scripts/merge-controller.mjs", import.meta.url).pathname;

function makeFakeGh(dir, handler) {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  if (!existsSync(join(bin, "node"))) symlinkSync(process.execPath, join(bin, "node"));
  const ghPath = join(bin, "gh");
  writeFileSync(ghPath, `#!/usr/bin/env node\n${handler}\n`, { mode: 0o755 });
  return bin;
}

test("rejects missing receipt", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-"));
  try {
    const bin = makeFakeGh(dir, `process.exit(1);`);
    const res = spawnSync(process.execPath, [script, "1"], { encoding: "utf8", env: { ...process.env, PATH: bin } });
    assert.notEqual(res.status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("dry-run passing does not invoke merge", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-"));
  try {
    const receiptPath = join(dir, "receipt.json");
    writeFileSync(receiptPath, JSON.stringify({
      reviewerAgent: "reviewer-agent",
      implementerAgent: "implementer-agent",
      reviewedHead: "abc123",
      sourceHash: "src",
      deltaHash: "delta",
      unresolvedBlockingFindings: 0,
    }));
    const handler = `
const args = process.argv.slice(2);
function out(v){ process.stdout.write(JSON.stringify(v)); process.exit(0); }
if (args[0]==="repo" && args[1]==="view") out({nameWithOwner:"org/repo"});
if (args[0]==="pr" && args[1]==="view") out({headRefOid:"abc123",baseRefName:"v2",baseRefOid:"base456",isDraft:false,body:"Refs #1",author:{login:"author"}});
if (args[0]==="api" && args[1].includes("actions/workflows/verification.yml")) out({id:123});
if (args[0]==="api" && args[1].includes("contents/")) out({sha:"a".repeat(40)});
if (args[0]==="api" && args[1].includes("actions/workflows/123/runs")) out({workflow_runs:[{id:10,run_attempt:1,head_sha:"abc123",event:"pull_request",workflow_id:123,path:".github/workflows/verification.yml",conclusion:"success",created_at:"2026-01-01T00:00:00Z"}]});
if (args[0]==="api" && args[1].includes("actions/runs/")) out({jobs:[{name:"release-gates",conclusion:"success"}]});
if (args[0]==="api" && args.join(" ").includes("pulls/1/reviews")) { process.stdout.write(""); process.exit(0); }
if (args[0]==="api" && args[1].includes("graphql")) out({data:{repository:{pullRequest:{reviewThreads:{nodes:[],pageInfo:{hasNextPage:false,endCursor:null}}}}}});
process.stderr.write("unhandled: "+args.join(" ")+"\\n"); process.exit(1);
`;
    const bin = makeFakeGh(dir, handler);
    const res = spawnSync(process.execPath, [script, "1", "--receipt", receiptPath], { encoding: "utf8", env: { ...process.env, PATH: bin } });
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.match(res.stdout, /"outcome": "dry-run"/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});