import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execPath } from "node:process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const child = join(root, "tests", "fixtures", "concurrent-sessions-child.mjs");
const guard = join(root, "scripts", "test-outbound-guard.cjs");
const credentials = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "TYPESAFE_API_KEY", "HF_TOKEN"];

function runNode(args, options) {
  return new Promise((resolve, reject) => {
    const process = spawn(execPath, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    process.stdout.setEncoding("utf8");
    process.stderr.setEncoding("utf8");
    process.stdout.on("data", (chunk) => { stdout += chunk; });
    process.stderr.on("data", (chunk) => { stderr += chunk; });
    process.once("error", reject);
    process.once("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

function scrubbedEnv(scratch, port, violations) {
  return {
    PATH: process.env.PATH,
    HOME: join(scratch, "home"),
    BIFROST_CONCURRENT_SCRATCH: scratch,
    BIFROST_TEST_ALLOWED_ORIGIN: `http://127.0.0.1:${port}`,
    BIFROST_TEST_NETWORK_VIOLATIONS: violations,
    NODE_OPTIONS: `--require=${guard}`,
  };
}

it("proves concurrent native AgentSession dispatch and isolation behind non-vacuous network fence", { timeout: 90_000 }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), "bifrost-concurrent-"));
  const violations = join(scratch, "network-violations.log");
  const server = createServer((_request, response) => response.end("allowed fixture"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const previousCredentials = Object.fromEntries(credentials.map((name) => [name, process.env[name]]));
  try {
    for (const name of credentials) process.env[name] = "ambient-secret-fixture";
    const env = scrubbedEnv(scratch, port, violations);
    for (const name of credentials) assert.equal(env[name], undefined, `${name} entered isolated child env`);

    const probe = await runNode(["-e", `
      const net = require("node:net");
      const dgram = require("node:dgram");
      (async () => {
        await (await fetch("http://127.0.0.1:${port}")).text();
        for (const attempt of [
          () => fetch("https://127.0.0.1:${port}"),
          () => fetch("http://127.0.0.1:${port + 1}"),
          () => new net.Socket().connect({ host: "127.0.0.1", port: ${port + 1} }),
          () => dgram.createSocket("udp4").send(Buffer.from("probe"), ${port}, "127.0.0.1"),
        ]) { try { await attempt(); } catch {} }
      })();
    `], { cwd: root, env });
    assert.equal(probe.status, 0, `${probe.stdout}\n${probe.stderr}`);
    const probeLog = readFileSync(violations, "utf8");
    assert.match(probeLog, /blocked fetch to https/);
    assert.match(probeLog, /blocked fetch to http/);
    assert.match(probeLog, /blocked socket connection/);
    assert.match(probeLog, /blocked UDP datagram/);
    writeFileSync(violations, "");

    const result = await runNode(["--test", "--experimental-strip-types", child], { cwd: root, env });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.signal, null, "child required forced termination; cleanup leaked a handle");
    assert.equal(readFileSync(violations, "utf8"), "", "native sessions made blocked outbound request");
    const report = JSON.parse(readFileSync(join(scratch, "concurrent-report.json"), "utf8"));
    assert.equal(report.host.separateRuntimeRegistries, true);
    assert.equal(report.cancellation.sessionBUnaffected, true);
    assert.equal(report.cleanup.fauxAPending, 0);
    assert.equal(report.cleanup.fauxBPending, 0);
    assert.ok(report.invocations.some(({ model }) => model === "faux-a/session-a-model"));
    assert.ok(report.invocations.some(({ model }) => model === "faux-b/session-b-model"));
  } finally {
    for (const [name, value] of Object.entries(previousCredentials)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await new Promise((resolve) => server.close(resolve));
    rmSync(scratch, { recursive: true, force: true });
  }
});
