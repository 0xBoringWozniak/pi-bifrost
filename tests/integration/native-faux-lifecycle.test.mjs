import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, it } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
let scratch;
let runtime;
let session;
let providers = [];
const invocations = [];
const previous = { cwd: process.cwd(), environment: { ...process.env } };
after(async () => {
  try {
    await session?.dispose();
  } finally {
    for (const provider of providers) runtime?.unregisterProvider(provider.provider.id);
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, previous.environment);
    process.chdir(previous.cwd);
  }
});

it("routes real AgentSession turns by direct rules, tier override precedence, and default", async () => {
  scratch = mkdtempSync(join(tmpdir(), "bifrost-native-lifecycle-"));
  const home = join(scratch, "home");
  const cwd = join(scratch, "workspace");
  const agentDir = join(home, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(agentDir, "auth.json"), "{}\n");
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));

  for (const name of Object.keys(process.env)) delete process.env[name];
  for (const name of ["PATH", "TMPDIR", "LANG", "TERM"]) {
    if (previous.environment[name] !== undefined) process.env[name] = previous.environment[name];
  }
  const violationPath = join(scratch, "network-violations.log");
  process.env.BIFROST_TEST_ALLOWED_ORIGIN = "http://127.0.0.1:1";
  process.env.BIFROST_TEST_NETWORK_VIOLATIONS = violationPath;
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  createRequire(import.meta.url)(join(root, "scripts", "test-outbound-guard.cjs"));
  const [{ createAgentSession, ModelRuntime, DefaultResourceLoader }, { fauxProvider, fauxAssistantMessage, fauxText }] = await Promise.all([
    import("@earendil-works/pi-coding-agent"),
    import("@earendil-works/pi-ai"),
  ]);

  const routes = [
    { provider: "faux-seed", id: "physical", response: "seed response" },
    { provider: "faux-alpha", id: "physical", response: "alpha response" },
    { provider: "faux-beta", id: "physical", response: "beta response" },
    { provider: "faux-frontier", id: "physical", response: "frontier response" },
    { provider: "faux-default", id: "physical", response: "default response" },
    { provider: "faux-collision", id: "physical", response: "collision response" },
  ];
  providers = routes.map(({ provider, id, response }) => {
    const faux = fauxProvider({ provider, models: [{ id, reasoning: false }] });
    faux.setResponses([(_context, _options, _state, model) => {
      invocations.push(`${model.provider}/${model.id}`);
      return fauxAssistantMessage(fauxText(response));
    }]);
    return faux;
  });
  writeFileSync(join(cwd, ".pi", "bifrost.json"), JSON.stringify({
    enabled: true,
    default: "quick",
    models: { quick: ["faux-default/physical"], frontier: ["faux-frontier/physical"] },
    classifier: { enabled: false },
    cache: { enabled: false },
    rules: [
      { pattern: "direct alpha marker", model: "faux-alpha/physical" },
      { pattern: "direct beta marker", model: "faux-beta/physical" },
      { pattern: "override collision marker", model: "faux-collision/physical" },
    ],
  }));
  process.chdir(cwd);

  runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  for (const faux of providers) {
    runtime.registerNativeProvider(faux.provider);
    await runtime.setRuntimeApiKey(faux.provider.id, "fixture-only");
  }
  await runtime.refresh({ allowNetwork: false });
  const seed = runtime.getModel("faux-seed", "physical");
  assert.ok(seed, "seed model must be available and differ from every route target");
  const { default: bifrostExtension } = await import(join(root, "index.ts"));
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, extensionFactories: [bifrostExtension] });
  await resourceLoader.reload();
  ({ session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model: seed, noTools: "all", resourceLoader }));
  await session.bindExtensions({ mode: "print" });

  const turns = [
    { prompt: "direct alpha marker", model: "faux-alpha/physical", response: "alpha response" },
    { prompt: "direct beta marker", model: "faux-beta/physical", response: "beta response" },
    { prompt: "frontier override collision marker", model: "faux-frontier/physical", response: "frontier response" },
    { prompt: "plain request with no configured marker", model: "faux-default/physical", response: "default response" },
  ];
  for (const [index, turn] of turns.entries()) {
    await session.prompt(turn.prompt);
    assert.equal(session.getLastAssistantText(), turn.response, `turn ${index + 1} must complete with its own scripted response`);
    assert.equal(`${session.model.provider}/${session.model.id}`, turn.model, `turn ${index + 1} must leave Pi on selected physical model`);
  }

  assert.deepEqual(invocations, turns.map(({ model }) => model), "provider model arguments must match exact per-turn routing with no extra calls");
  assert.equal(existsSync(violationPath) ? readFileSync(violationPath, "utf8") : "", "", "socket, UDP, and fetch guard must record zero outbound attempts");
  for (const faux of providers) {
    const expectedCalls = turns.some(({ model }) => model === `${faux.provider.id}/physical`) ? 1 : 0;
    assert.equal(faux.state.callCount, expectedCalls, `${faux.provider.id} must receive only expected calls`);
    assert.equal(faux.getPendingResponseCount(), 1 - expectedCalls, `${faux.provider.id} queue must match expected calls`);
  }
});
