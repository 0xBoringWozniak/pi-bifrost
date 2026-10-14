import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, it } from "node:test";

const root = new URL("../..", import.meta.url).pathname;
const scratch = process.env.BIFROST_CONCURRENT_SCRATCH;
assert.ok(scratch);
for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "TYPESAFE_API_KEY", "GOOGLE_API_KEY"]) {
  assert.equal(process.env[name], undefined, `${name} leaked into concurrent-session child`);
}

const home = join(scratch, "home");
const cwd = join(scratch, "workspace");
const agentA = join(home, "agent-a");
const agentB = join(home, "agent-b");
for (const dir of [agentA, agentB, join(cwd, ".pi")]) mkdirSync(dir, { recursive: true });
writeFileSync(join(agentA, "auth.json"), "{}\n");
writeFileSync(join(agentB, "auth.json"), "{}\n");
for (const dir of [agentA, agentB]) writeFileSync(join(dir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
writeFileSync(join(cwd, ".pi", "bifrost.json"), JSON.stringify({
  enabled: true,
  default: "alpha",
  classifier: { enabled: false },
  models: {
    alpha: ["faux-a/session-a-model"],
    beta: ["faux-b/session-b-model"],
  },
  rules: [
    { pattern: "session a dispatch marker", model: "faux-a/session-a-model" },
    { pattern: "session b dispatch marker", model: "faux-b/session-b-model" },
  ],
}));

const previous = { cwd: process.cwd(), HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
process.chdir(cwd);
process.env.HOME = home;
const [{ createAgentSession, ModelRuntime, DefaultResourceLoader, SessionManager }, { fauxProvider, fauxAssistantMessage, fauxText }] = await Promise.all([
  import("@earendil-works/pi-coding-agent"),
  import("@earendil-works/pi-ai"),
]);
const { default: bifrostExtension } = await import(join(root, "index.ts"));

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
function barrier(count) {
  let arrived = 0;
  let release;
  const promise = new Promise((r) => { release = r; });
  return () => { arrived += 1; if (arrived === count) release(); return promise; };
}
function contextText(context) {
  return context.messages.map((message) => JSON.stringify(message)).join("\n");
}

let runtimeA;
let runtimeB;
let fauxA;
let fauxB;
let sessionA;
let sessionB;
let loaderA;
let loaderB;
const report = { invocations: [], events: [], host: {}, cancellation: {} };

async function setup() {
  runtimeA = await ModelRuntime.create({ authPath: join(agentA, "auth.json"), modelsPath: null, refreshOnCreate: false });
  runtimeB = await ModelRuntime.create({ authPath: join(agentB, "auth.json"), modelsPath: null, refreshOnCreate: false });
  fauxA = fauxProvider({ provider: "faux-a", models: [{ id: "session-a-model" }] });
  fauxB = fauxProvider({ provider: "faux-b", models: [{ id: "session-b-model" }] });
  runtimeA.registerNativeProvider(fauxA.provider);
  runtimeB.registerNativeProvider(fauxB.provider);
  await runtimeA.setRuntimeApiKey("faux-a", "fixture-only");
  await runtimeB.setRuntimeApiKey("faux-b", "fixture-only");
  await runtimeA.refresh({ allowNetwork: false });
  await runtimeB.refresh({ allowNetwork: false });
  loaderA = new DefaultResourceLoader({ cwd, agentDir: agentA, extensionFactories: [bifrostExtension] });
  loaderB = new DefaultResourceLoader({ cwd, agentDir: agentB, extensionFactories: [bifrostExtension] });
  await loaderA.reload();
  await loaderB.reload();
  ({ session: sessionA } = await createAgentSession({ cwd, agentDir: agentA, modelRuntime: runtimeA, model: runtimeA.getModel("faux-a", "session-a-model"), noTools: "all", resourceLoader: loaderA, sessionManager: SessionManager.inMemory(cwd) }));
  ({ session: sessionB } = await createAgentSession({ cwd, agentDir: agentB, modelRuntime: runtimeB, model: runtimeB.getModel("faux-b", "session-b-model"), noTools: "all", resourceLoader: loaderB, sessionManager: SessionManager.inMemory(cwd) }));
  await sessionA.bindExtensions({ mode: "print" });
  await sessionB.bindExtensions({ mode: "print" });
}

function installSuccessResponses() {
  const arrive = barrier(2);
  fauxA.setResponses([async (context, _options, _state, model) => {
    const text = contextText(context);
    assert.match(text, /session a dispatch marker/);
    assert.doesNotMatch(text, /session b dispatch marker/);
    report.invocations.push({ session: "a", model: `${model.provider}/${model.id}`, text });
    report.events.push("a:arrived");
    await arrive();
    report.events.push("a:released");
    return fauxAssistantMessage(fauxText("session-a response"));
  }]);
  fauxB.setResponses([async (context, _options, _state, model) => {
    const text = contextText(context);
    assert.match(text, /session b dispatch marker/);
    assert.doesNotMatch(text, /session a dispatch marker/);
    report.invocations.push({ session: "b", model: `${model.provider}/${model.id}`, text });
    report.events.push("b:arrived");
    await arrive();
    report.events.push("b:released");
    return fauxAssistantMessage(fauxText("session-b response"));
  }]);
}

it("dispatches concurrent native sessions to explicit physical identities without cross-session delivery", { timeout: 30_000 }, async () => {
  await setup();
  installSuccessResponses();
  await Promise.all([
    sessionA.prompt("session a dispatch marker alpha"),
    sessionB.prompt("session b dispatch marker beta"),
  ]);
  assert.equal(sessionA.getLastAssistantText(), "session-a response");
  assert.equal(sessionB.getLastAssistantText(), "session-b response");
  assert.equal(sessionA.model.provider, "faux-a");
  assert.equal(sessionA.model.id, "session-a-model");
  assert.equal(sessionB.model.provider, "faux-b");
  assert.equal(sessionB.model.id, "session-b-model");
  assert.deepEqual(fauxA.state.callCount, 1);
  assert.deepEqual(fauxB.state.callCount, 1);
  const arrival = report.events.filter((event) => event.endsWith(":arrived"));
  const release = report.events.filter((event) => event.endsWith(":released"));
  assert.equal(arrival.length, 2);
  assert.equal(release.length, 2);
  assert.ok(Math.max(...arrival.map((event) => report.events.indexOf(event))) < Math.min(...release.map((event) => report.events.indexOf(event))));
  report.host.separateRuntimeRegistries = runtimeA.getModel("faux-b", "session-b-model") === undefined
    && runtimeB.getModel("faux-a", "session-a-model") === undefined;
  assert.equal(report.host.separateRuntimeRegistries, true);
});

it("cancels one native session without affecting other session and cleans pending work", { timeout: 30_000 }, async () => {
  await setup();
  const entered = deferred();
  const release = deferred();
  fauxA.setResponses([async () => { entered.resolve(); await release.promise; return fauxAssistantMessage(fauxText("must not be delivered")); }]);
  fauxB.setResponses([fauxAssistantMessage(fauxText("session-b survives cancellation"))]);
  const cancelledPrompt = sessionA.prompt("session a dispatch marker cancel");
  await entered.promise;
  const abortPromise = sessionA.abort();
  release.resolve();
  await Promise.allSettled([cancelledPrompt, abortPromise]);
  await sessionB.prompt("session b dispatch marker survives");
  assert.equal(sessionB.getLastAssistantText(), "session-b survives cancellation");
  assert.notEqual(sessionA.getLastAssistantText(), "must not be delivered");
  assert.equal(fauxA.getPendingResponseCount(), 0);
  assert.equal(fauxB.getPendingResponseCount(), 0);
  report.cancellation = { sessionASettled: true, sessionBUnaffected: true };
});

after(() => {
  sessionA?.dispose();
  sessionB?.dispose();
  report.cleanup = {
    fauxAPending: fauxA?.getPendingResponseCount() ?? null,
    fauxBPending: fauxB?.getPendingResponseCount() ?? null,
  };
  writeFileSync(join(scratch, "concurrent-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  if (runtimeA) runtimeA.unregisterProvider("faux-a");
  if (runtimeB) runtimeB.unregisterProvider("faux-b");
  if (previous.HOME === undefined) delete process.env.HOME; else process.env.HOME = previous.HOME;
  if (previous.PI_CODING_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous.PI_CODING_AGENT_DIR;
  process.chdir(previous.cwd);
});
