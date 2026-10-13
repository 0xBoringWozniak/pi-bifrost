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
  rules: [{ pattern: "native faux dispatch marker", tier: "general" }],
}));
const previous = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
process.env.HOME = home;
process.env.PI_CODING_AGENT_DIR = agentDir;
const [{ createAgentSession, ModelRuntime }, { fauxProvider, fauxAssistantMessage, fauxText }] = await Promise.all([
  import("@earendil-works/pi-coding-agent"),
  import("@earendil-works/pi-ai"),
]);
const faux = fauxProvider({ provider: "faux", models: [
  { id: "physical-fast", reasoning: false }, { id: "physical-capable", reasoning: true },
] });
faux.setResponses([fauxAssistantMessage(fauxText("native faux response"))]);
let session;
let runtime;
after(() => {
  session?.dispose();
  if (runtime) runtime.unregisterProvider("faux");
  rmSync(scratch, { recursive: true, force: true });
  if (previous.HOME === undefined) delete process.env.HOME; else process.env.HOME = previous.HOME;
  if (previous.PI_CODING_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous.PI_CODING_AGENT_DIR;
});

it("routes real AgentSession request to configured physical faux model", async () => {
  runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  runtime.registerNativeProvider(faux.provider);
  await runtime.setRuntimeApiKey("faux", "fixture-only");
  const model = runtime.getModel("faux", "physical-fast");
  assert.ok(model, "registered physical model must be available");
  ({ session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model, noTools: "all" }));
  await session.prompt("native faux dispatch marker");
  assert.equal(session.getLastAssistantText(), "native faux response");
  assert.equal(faux.state.callCount, 1);
  assert.equal(faux.getPendingResponseCount(), 0);
  assert.equal(session.model.provider, "faux");
  assert.equal(session.model.id, "physical-fast");
  assert.deepEqual(runtime.getModels("faux").map(({ id }) => id), ["physical-fast", "physical-capable"]);
});
