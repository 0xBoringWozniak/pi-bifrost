import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execPath } from "node:process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const child = join(root, "tests", "fixtures", "native-faux-lifecycle-child.mjs");
const guard = join(root, "scripts", "test-outbound-guard.cjs");
const credentials = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "TYPESAFE_API_KEY", "HF_TOKEN", "HUGGINGFACE_HUB_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"];

function runNode(args, options) {
  return new Promise((resolve, reject) => {
    const childProcess = spawn(execPath, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    childProcess.stdout.setEncoding("utf8");
    childProcess.stderr.setEncoding("utf8");
    childProcess.stdout.on("data", (chunk) => { stdout += chunk; });
    childProcess.stderr.on("data", (chunk) => { stderr += chunk; });
    childProcess.once("error", reject);
    childProcess.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

it("routes real AgentSession turns behind a child-close scratch boundary", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "bifrost-native-lifecycle-"));
  const violations = join(scratch, "network-violations.log");
  const previousCredentials = Object.fromEntries(credentials.map((name) => [name, process.env[name]]));
  try {
    for (const name of credentials) process.env[name] = "ambient-secret-fixture";
    const isolatedEnv = {
      PATH: process.env.PATH,
      HOME: join(scratch, "home"),
      BIFROST_TEST_ALLOWED_ORIGIN: "http://127.0.0.1:1",
      BIFROST_TEST_NETWORK_VIOLATIONS: violations,
      BIFROST_NATIVE_LIFECYCLE_SCRATCH: scratch,
      NODE_OPTIONS: `--require=${guard}`,
    };
    for (const name of credentials) assert.equal(isolatedEnv[name], undefined, `${name} must not enter child env`);

    const result = await runNode(["--test", "--experimental-strip-types", child], { cwd: root, env: isolatedEnv });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(existsSync(violations) ? readFileSync(violations, "utf8") : "", "", "faux AgentSession made blocked outbound attempt");
  } finally {
    for (const [name, value] of Object.entries(previousCredentials)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    rmSync(scratch, { recursive: true, force: true });
  }

  // Scoped to this run's own scratch. The child has exited, so no in-process
  // auth work can recreate these paths; a global temp-prefix count would be
  // wrong under concurrent test processes.
  assert.equal(existsSync(scratch), false, "scratch must be gone after the child exits");
  assert.equal(existsSync(join(scratch, "home", ".pi", "agent", "auth.json")), false, "auth.json must not be recreated after the child exits");
});
