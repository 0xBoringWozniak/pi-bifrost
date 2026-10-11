import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { after, before, describe, it } from "node:test";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PI = join(ROOT, "node_modules", ".bin", "pi");
const EXTENSION = join(ROOT, "index.ts");
const OUTBOUND_GUARD = join(ROOT, "scripts", "test-outbound-guard.cjs");
let server;
let requests;

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function startFakeProvider() {
  requests = [];
  server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      return json(response, 200, { object: "list", data: [{ id: "healthy" }, { id: "credits-exhausted" }] });
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") return json(response, 404, {});
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const model = JSON.parse(body).model;
      requests.push(model);
      if (model === "credits-exhausted") {
        return json(response, 402, { error: { message: "No remaining credits" } });
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function fixture(port, models) {
  const home = mkdtempSync(join(tmpdir(), "bifrost-init-home-"));
  const work = mkdtempSync(join(tmpdir(), "bifrost-init-work-"));
  const agent = join(home, ".pi", "agent");
  mkdirSync(agent, { recursive: true });
  mkdirSync(join(work, ".pi"), { recursive: true });
  writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { fake: {
    baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "fixture-only",
    models: models.map((id) => ({ id, reasoning: false, contextWindow: 8192, maxTokens: 512 })),
  } } }));
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ retry: { enabled: false }, enabledModels: ["fake/*"] }));
  return { home, work };
}

function ownership(generated) {
  const sourceId = `pi-models-v1-${createHash("sha256").update(JSON.stringify(["fake", "quick"])).digest("hex").slice(0, 40)}`;
  return JSON.stringify({ version: 1, sources: { [sourceId]: { generated: { quick: generated }, tombstones: {} } } });
}

function runInit({ home, work, args }) {
  const base = Object.fromEntries(["PATH", "TMPDIR", "LANG", "TERM"]
    .filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
  return new Promise((resolve, reject) => {
    const child = spawn(PI, ["-e", EXTENSION, "--approve", "--no-tools", "--no-session", "-p", `/bifrost init ${args}`], {
      cwd: work,
      env: { ...base, HOME: home, PI_CODING_AGENT_DIR: join(home, ".pi", "agent"), PI_SKIP_VERSION_CHECK: "1", PI_OFFLINE: "1",
        NODE_OPTIONS: `--require=${OUTBOUND_GUARD}`, BIFROST_TEST_ALLOWED_ORIGIN: `http://127.0.0.1:${server.address().port}`,
        BIFROST_TEST_NETWORK_VIOLATIONS: join(home, "network-violations.log") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let killTimer;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
    }, 30_000);
    child.once("error", reject);
    child.once("close", (code) => {
      const timedOut = Boolean(killTimer);
      clearTimeout(timer);
      clearTimeout(killTimer);
      let violations = "";
      try { violations = readFileSync(join(home, "network-violations.log"), "utf8"); }
      catch (error) { if (error.code !== "ENOENT") { reject(error); return; } }
      resolve({ code, stdout, stderr, violations, timedOut });
    });
  });
}

describe("Pi init probe regression", { concurrency: 1, timeout: 120_000 }, () => {
  let port;
  before(async () => { port = await startFakeProvider(); });
  after(async () => { await new Promise((resolve) => server?.close(resolve)); });

  it("probes on ordinary init and saves only successful models", async () => {
    const env = fixture(port, ["healthy", "credits-exhausted"]);
    writeFileSync(join(env.work, ".pi", "bifrost-routes.json"), "[]\n");
    try {
      const result = await runInit({ ...env, args: "--write" });
      assert.equal(result.timedOut, false);
      assert.equal(result.violations, "", "Pi attempted a non-fixture network connection");
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual([...new Set(requests)], ["healthy", "credits-exhausted"]);
      assert.ok(requests.length >= 2, "expected provider probes for both catalog models");
      assert.equal(requests.filter((model) => model === "credits-exhausted").length, 1, "a provider error must not trigger a second session probe");
      const config = JSON.parse(readFileSync(join(env.work, ".pi", "bifrost.json"), "utf8"));
      assert.ok(Object.values(config.models).flat().includes("fake/healthy"));
      assert.equal(Object.values(config.models).flat().includes("fake/credits-exhausted"), false, JSON.stringify({ requests, stdout: result.stdout, stderr: result.stderr, config }));
      assert.equal(config.cache.threshold, 0.88);
      assert.equal(config.reliability.failureThreshold, 3);
      assert.equal(config.debug.enabled, false);
      assert.deepEqual(Object.keys(config.categoryStrategies), Object.keys(config.models));
    } finally { rmSync(env.home, { recursive: true, force: true }); rmSync(env.work, { recursive: true, force: true }); }
  });

  it("fills an empty config from verified pools without shadowing its default", async () => {
    requests = [];
    const env = fixture(port, ["healthy", "credits-exhausted"]);
    writeFileSync(join(env.work, ".pi", "bifrost.json"), "{}\n");
    try {
      const result = await runInit({ ...env, args: "--write" });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.violations, "");
      const config = JSON.parse(readFileSync(join(env.work, ".pi", "bifrost.json"), "utf8"));
      assert.ok(config.models[config.default]?.includes("fake/healthy"));
      assert.equal(Object.values(config.models).flat().includes("fake/credits-exhausted"), false);
      assert.deepEqual(Object.keys(config.categoryStrategies), Object.keys(config.models));
    } finally { rmSync(env.home, { recursive: true, force: true }); rmSync(env.work, { recursive: true, force: true }); }
  });

  it("removes failed generated memberships, keeps handwritten entries and preserves settings", async () => {
    requests = [];
    const env = fixture(port, ["healthy", "credits-exhausted"]);
    const original = Buffer.from(JSON.stringify({
      enabled: true,
      default: "quick",
      strategy: "cheapest",
      classifier: {
        enabled: false,
        criteria: { general: "keep classifier criteria" },
        typesafe: { timeoutMs: 1234, maxAttempts: 2, debug: true, metrics: { enabled: false } },
        piNative: { timeoutMs: 2345, maxAttempts: 2, metrics: { enabled: false } },
      },
      cache: { enabled: false },
      models: { quick: ["fake/credits-exhausted", "handwritten/model"] },
      retained: { owner: "user" },
    }, null, 2) + "\n");
    writeFileSync(join(env.work, ".pi", "bifrost.json"), original);
    writeFileSync(join(env.work, ".pi", "bifrost-reconcile-ownership.json"), ownership(["fake/credits-exhausted"]));
    try {
      const result = await runInit({ ...env, args: "--write" });
      assert.equal(result.timedOut, false);
      assert.equal(result.violations, "");
      assert.equal(result.code, 0, result.stderr);
      const saved = JSON.parse(readFileSync(join(env.work, ".pi", "bifrost.json"), "utf8"));
      assert.deepEqual(saved.models.quick, ["handwritten/model", "fake/healthy"]);
      assert.equal(saved.cache.enabled, false);
      assert.equal(saved.strategy, "cheapest");
      assert.deepEqual(saved.classifier.criteria, { general: "keep classifier criteria" });
      assert.deepEqual(saved.classifier.typesafe, { timeoutMs: 1234, maxAttempts: 2, debug: true, metrics: { enabled: false } });
      assert.deepEqual(saved.classifier.piNative, { timeoutMs: 2345, maxAttempts: 2, metrics: { enabled: false } });
      assert.deepEqual(saved.retained, { owner: "user" });
      assert.match(result.stdout + result.stderr, /handwritten entries are preserved/u);
    } finally { rmSync(env.home, { recursive: true, force: true }); rmSync(env.work, { recursive: true, force: true }); }
  });

  it("leaves existing config untouched when forced probes have zero successes", async () => {
    requests = [];
    const env = fixture(port, ["credits-exhausted"]);
    const original = Buffer.from('{\n  "enabled": true,\n  "default": "general",\n  "models": { "general": ["handwritten/model"] },\n  "retained": { "owner": "user" }\n}\n');
    writeFileSync(join(env.work, ".pi", "bifrost.json"), original);
    try {
      const result = await runInit({ ...env, args: "-f --write" });
      assert.equal(result.timedOut, false);
      assert.equal(result.violations, "", "Pi attempted a non-fixture network connection");
      assert.equal(result.code, 0, result.stderr);
      assert.ok(requests.length > 0 && requests.every((model) => model === "credits-exhausted"));
      assert.deepEqual(readFileSync(join(env.work, ".pi", "bifrost.json")), original);
    } finally { rmSync(env.home, { recursive: true, force: true }); rmSync(env.work, { recursive: true, force: true }); }
  });

  it("does not create config or ownership when a fresh probe has zero successes", async () => {
    requests = [];
    const env = fixture(port, ["credits-exhausted"]);
    try {
      const result = await runInit({ ...env, args: "--write" });
      assert.equal(result.timedOut, false);
      assert.equal(result.violations, "");
      assert.equal(result.code, 0, result.stderr);
      assert.ok(requests.length > 0 && requests.every((model) => model === "credits-exhausted"));
      assert.throws(() => readFileSync(join(env.work, ".pi", "bifrost.json")), { code: "ENOENT" });
      assert.throws(() => readFileSync(join(env.work, ".pi", "bifrost-reconcile-ownership.json")), { code: "ENOENT" });
    } finally { rmSync(env.home, { recursive: true, force: true }); rmSync(env.work, { recursive: true, force: true }); }
  });

  it("does not replace an all-failed fresh probe cache with the full registry", async () => {
    requests = [];
    const env = fixture(port, ["credits-exhausted"]);
    const original = Buffer.from('{"enabled":true,"models":{"general":["handwritten/model"]}}\n');
    writeFileSync(join(env.work, ".pi", "bifrost.json"), original);
    writeFileSync(join(env.work, ".pi", "bifrost-probe.json"), JSON.stringify([
      { provider: "fake", model: "credits-exhausted", status: "error", cost_input: 0, cost_output: 0, duration_ms: 10 },
    ]));
    try {
      const result = await runInit({ ...env, args: "--write" });
      assert.equal(result.timedOut, false);
      assert.equal(result.violations, "");
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(requests, []);
      assert.deepEqual(readFileSync(join(env.work, ".pi", "bifrost.json")), original);
    } finally { rmSync(env.home, { recursive: true, force: true }); rmSync(env.work, { recursive: true, force: true }); }
  });
});
