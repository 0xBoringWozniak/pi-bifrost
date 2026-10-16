import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import {
  REPO_ROOT,
  assertFenceBlocked,
  assertNoViolations,
  fenceProbeScript,
  fixtureChildEnv,
  isolateAmbientCredentials,
  runFauxFixtureChild,
  runNode,
} from "../fixtures/faux-harness.mjs";

const CHILD = join(REPO_ROOT, "tests", "fixtures", "native-faux-lifecycle-child.mjs");

it("routes real AgentSession turns by direct rules, tier override precedence, and default", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "bifrost-native-lifecycle-"));
  const violations = join(scratch, "network-violations.log");
  const restoreCredentials = isolateAmbientCredentials();
  try {
    const env = fixtureChildEnv({ scratch, violations, allowedOrigin: "http://127.0.0.1:1" });
    writeFileSync(violations, "");
    const probe = await runNode(["-e", fenceProbeScript({ allowedUrl: "http://127.0.0.1:1", blockedPort: 2 })], { cwd: REPO_ROOT, env });
    assert.equal(probe.status, 0, `${probe.stdout}\n${probe.stderr}`);
    assertFenceBlocked(violations, [
      /blocked fetch to https?:\/\/[^:\s]+:\d/,
      /blocked socket connection to [^\s]+:\d/,
      /blocked UDP datagram to/,
    ]);

    writeFileSync(violations, "");
    await runFauxFixtureChild({
      child: CHILD,
      env: { ...env, BIFROST_NATIVE_LIFECYCLE_SCRATCH: scratch },
    });
    assertNoViolations(violations, "socket, UDP, and fetch guard must record zero outbound attempts");
  } finally {
    restoreCredentials();
    rmSync(scratch, { recursive: true, force: true });
  }
});
