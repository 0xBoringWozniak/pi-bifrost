import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execPath } from "node:process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const child = join(root, "tests", "fixtures", "native-tool-continuation-child.mjs");
const guard = join(root, "scripts", "test-outbound-guard.cjs");
const credentials = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "TYPESAFE_API_KEY", "HF_TOKEN", "HUGGINGFACE_HUB_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"];

function runNode(args, options) {
  return new Promise((resolve, reject) => {
    const childProcess = spawn(execPath, args, {
      ...options,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    if (childProcess.stdout) childProcess.stdout.setEncoding("utf8");
    if (childProcess.stderr) childProcess.stderr.setEncoding("utf8");
    if (childProcess.stdout) childProcess.stdout.on("data", (chunk) => { stdout += chunk; });
    if (childProcess.stderr) childProcess.stderr.on("data", (chunk) => { stderr += chunk; });

    const timeoutMs = options.timeoutMs || 20000;
    let settled = false;
    let timer = null;
    let termTimer = null;

    function cleanupTimers() {
      if (timer) clearTimeout(timer);
      if (termTimer) clearTimeout(termTimer);
      timer = null;
      termTimer = null;
    }

    function finish(error, result) {
      if (settled) return;
      settled = true;
      cleanupTimers();
      try { process.kill(-childProcess.pid, "SIGKILL"); } catch {}
      if (error) reject(error); else resolve(result);
    }

    childProcess.once("error", (error) => finish(error));
    childProcess.once("close", (status, signal) => {
      finish(null, { status, signal, stdout, stderr });
    });

    timer = setTimeout(() => {
      try { process.kill(-childProcess.pid, "SIGTERM"); } catch {}
      termTimer = setTimeout(() => {
        try { process.kill(-childProcess.pid, "SIGKILL"); } catch {}
        finish(new Error("runNode timed out after " + timeoutMs + "ms\n" + stdout + "\n" + stderr));
      }, 2000);
    }, timeoutMs);
  });
}

it("routes real AgentSession behind tested HTTP, HTTPS, TCP, and UDP outbound fence", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "bifrost-native-tool-continuation-"));
  const violations = join(scratch, "network-violations.log");
  const server = createServer((_request, response) => response.end("allowed loopback fixture"));
  const port = 65534;
  const previousCredentials = Object.fromEntries(credentials.map((name) => [name, process.env[name]]));
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    for (const name of credentials) process.env[name] = "ambient-secret-fixture";
    const isolatedEnv = {
      PATH: process.env.PATH,
      HOME: join(scratch, "home"),
      BIFROST_TEST_ALLOWED_ORIGIN: `http://127.0.0.1:${port}`,
      BIFROST_TEST_NETWORK_VIOLATIONS: violations,
      BIFROST_NATIVE_TOOL_CONTINUATION_SCRATCH: scratch,
      NODE_OPTIONS: `--require=${guard}`,
    };
    const childEnv = { ...isolatedEnv };
    delete childEnv.BIFROST_TEST_ALLOWED_ORIGIN;
    childEnv.BIFROST_NATIVE_TOOL_CONTINUATION_CHILD = "1";
    childEnv.BIFROST_TEST_DENY_ALL = "1";
    for (const name of credentials) assert.equal(isolatedEnv[name], undefined, `${name} must not enter child env`);

    const probe = await runNode(["-e", `
      const net = require("node:net");
      const tls = require("node:tls");
      const dgram = require("node:dgram");
      (async () => {
        const allowed = await fetch("http://127.0.0.1:${port}");
        if (await allowed.text() !== "allowed loopback fixture") process.exitCode = 8;
        for (const attempt of [
          () => fetch("https://127.0.0.1:${port}"),
          () => fetch("http://127.0.0.1:65535"),
          () => new net.Socket().connect({ port: 65535, host: "127.0.0.1" }),
          () => tls.connect({ port: 65535, host: "127.0.0.1" }),
          () => dgram.createSocket("udp4").send(Buffer.from("fixture"), ${port}, "127.0.0.1"),
        ]) { try { await attempt(); } catch {} }
        if (${JSON.stringify(credentials)}.some((name) => process.env[name] !== undefined)) process.exitCode = 9;
      })();
    `], { cwd: root, env: isolatedEnv });
    assert.equal(probe.status, 0, `${probe.stdout}\n${probe.stderr}`);
    const attempts = readFileSync(violations, "utf8");
    assert.match(attempts, /blocked fetch to https:\/\/127\.0\.0\.1:/);
    assert.match(attempts, /blocked fetch to http:\/\/127\.0\.0\.1:/);
    assert.match(attempts, /blocked socket connection to 127\.0\.0\.1:/);
    assert.match(attempts, /blocked UDP datagram to 127\.0\.0\.1/);

    writeFileSync(violations, "");
    const result = await runNode(["--test", "--experimental-strip-types", child], { cwd: root, env: childEnv });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(readFileSync(violations, "utf8"), "", "faux AgentSession made blocked outbound attempt");
  } finally {
    for (const [name, value] of Object.entries(previousCredentials)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await new Promise((resolve) => server.close(resolve));
    rmSync(scratch, { recursive: true, force: true });
  }
});
