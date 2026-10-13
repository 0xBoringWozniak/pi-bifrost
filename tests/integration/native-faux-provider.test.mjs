import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { after, it } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scratch = mkdtempSync(join(tmpdir(), "bifrost-native-faux-"));
const home = join(scratch, "home");
const cwd = join(scratch, "workspace");
const agentDir = join(home, ".pi", "agent");
mkdirSync(agentDir, { recursive: true });
mkdirSync(join(cwd, ".pi"), { recursive: true });
writeFileSync(join(agentDir, "auth.json"), "{}\n");
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
writeFileSync(join(cwd, ".pi", "bifrost.json"), JSON.stringify({
  enabled: true,
  models: { quick: ["faux/physical-fast"], general: ["faux/physical-capable"], frontier: ["faux/physical-capable"] },
  default: "quick",
  classifier: { enabled: false },
  rules: [{ pattern: "native faux dispatch marker", model: "faux/physical-capable" }],
}));
const previous = { cwd: process.cwd(), HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY, fetch: globalThis.fetch };
process.chdir(cwd);
let externalRequests = 0;
globalThis.fetch = async () => { externalRequests++; throw new Error("native faux integration must not make external requests"); };
process.env.HOME = home;
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.TYPESAFE_API_KEY;
const [{ createAgentSession, ModelRuntime, DefaultResourceLoader }, { fauxProvider, fauxAssistantMessage, fauxText }] = await Promise.all([
  import("@earendil-works/pi-coding-agent"),
  import("@earendil-works/pi-ai"),
]);
const faux = fauxProvider({ provider: "faux", models: [
  { id: "physical-fast", reasoning: false }, { id: "physical-capable", reasoning: true },
] });
const invocations = [];
faux.setResponses([(_context, _options, _state, model) => {
  invocations.push(`${model.provider}/${model.id}`);
  return fauxAssistantMessage(fauxText("native faux response"));
}]);
let session;
let runtime;
after(() => {
  session?.dispose();
  if (runtime) runtime.unregisterProvider("faux");
  rmSync(scratch, { recursive: true, force: true });
  if (previous.HOME === undefined) delete process.env.HOME; else process.env.HOME = previous.HOME;
  if (previous.PI_CODING_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous.PI_CODING_AGENT_DIR;
  if (previous.TYPESAFE_API_KEY === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = previous.TYPESAFE_API_KEY;
  globalThis.fetch = previous.fetch;
  process.chdir(previous.cwd);
});

it("routes real AgentSession request to configured physical faux model", async () => {
  runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  runtime.registerNativeProvider(faux.provider);
  await runtime.setRuntimeApiKey("faux", "fixture-only");
  await runtime.refresh({ allowNetwork: false });
  const model = runtime.getModel("faux", "physical-fast");
  assert.ok(model, "registered physical model must be available");
  assert.deepEqual((await runtime.getAvailable("faux")).map(({ id }) => id), ["physical-fast", "physical-capable"]);
  const { default: bifrostExtension } = await import(join(root, "index.ts"));
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, extensionFactories: [bifrostExtension] });
  await resourceLoader.reload();
  ({ session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model, noTools: "all", resourceLoader }));
  await session.bindExtensions({ mode: "print" });
  await runtime.getAvailable("faux");
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => { errors.push(args.join(" ")); originalError(...args); };
  try {
    await session.prompt("native faux dispatch marker");
  } finally {
    console.error = originalError;
  }
  assert.equal(session.getLastAssistantText(), "native faux response");
  assert.equal(faux.state.callCount, 1);
  assert.equal(externalRequests, 0);
  assert.deepEqual(invocations, ["faux/physical-capable"]);
  assert.equal(errors.some((line) => line.includes("requested_tier_unavailable")), false);
  assert.equal(errors.some((line) => line.includes("faux/physical-capable")), true);
  assert.equal(errors.some((line) => line.includes("typesafe") || line.includes("pi-native")), false);
  assert.equal(faux.getPendingResponseCount(), 0);
  assert.equal(session.model.provider, "faux");
  assert.equal(session.model.id, "physical-capable");
  assert.deepEqual(runtime.getModels("faux").map(({ id }) => id), ["physical-fast", "physical-capable"]);
});
