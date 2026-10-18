import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, it } from "node:test";

// Parent owns scratch lifetime. This child never deletes scratch so the parent
// can reclaim it only after the owned process group is independently gone.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scratch = process.env.BIFROST_NATIVE_ACTIVATION_SCRATCH;
assert.ok(scratch, "BIFROST_NATIVE_ACTIVATION_SCRATCH is required by the parent");
const violationPath = process.env.BIFROST_TEST_NETWORK_VIOLATIONS;
const scenario = process.env.BIFROST_NATIVE_ACTIVATION_SCENARIO ?? "cancel-late-classifier";
// Captured before the child wipes its environment so the parent can point at a
// private mutant copy without leaking ambient credentials.
const activationExtensionPath = process.env.BIFROST_NATIVE_ACTIVATION_EXTENSION;
for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "TYPESAFE_API_KEY", "HF_TOKEN", "HUGGINGFACE_HUB_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]) {
  assert.equal(process.env[name], undefined, `${name} leaked into the isolated activation child`);
}

// cancel-late-classifier: a steer input is routed while the pi-native classifier
// is still pending; the host aborts the turn, then the classifier result arrives
// late. The routed physical model must never be dispatched.
// manual-override: the same pending-classifier window, but the user makes a newer
// explicit model selection instead of aborting; the late classifier result must
// not override the newer selection and must not dispatch the routed model.
const SCENARIOS = {
  "cancel-late-classifier": {
    abort: true,
    hardAdmission: true,
    tiers: { restricted: ["faux/physical-target"], seed: ["faux-seed/physical"] },
    expectedModel: "faux-seed/physical",
  },
  "manual-override": {
    abort: false,
    hardAdmission: false,
    tiers: { restricted: ["faux/physical-target"], seed: ["faux-seed/physical"], manual: ["faux-manual/physical"] },
    expectedModel: "faux-manual/physical",
  },
};
const current = SCENARIOS[scenario];
assert.ok(current, `unknown native activation scenario: ${scenario}`);

let runtime;
let session;
const providers = [];
const previous = { cwd: process.cwd(), environment: { ...process.env } };
after(() => {
  session?.dispose();
  for (const id of providers) {
    try { runtime?.unregisterProvider(id); } catch {}
  }
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, previous.environment);
  process.chdir(previous.cwd);
});

function modelKey(model) {
  return model ? `${model.provider}/${model.id}` : "";
}

// Captures the host abort signal observed by an extension input handler while the
// session is streaming, so the test waits on the real abort instead of a sleep.
function signalProbeExtension(probe) {
  return (pi) => {
    pi.on("input", (event, ctx) => {
      if (event.streamingBehavior && ctx.signal && !probe.signal) {
        probe.signal = ctx.signal;
        probe.aborted = ctx.signal.aborted
          ? Promise.resolve()
          : new Promise((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
      }
      return { action: "continue" };
    });
  };
}

it(`real AgentSession activation cancellation (${scenario})`, async () => {
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
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const [{ createAgentSession, ModelRuntime, DefaultResourceLoader }, { fauxProvider, fauxAssistantMessage, fauxText, createProvider }] = await Promise.all([
    import("@earendil-works/pi-coding-agent"),
    import("@earendil-works/pi-ai"),
  ]);

  let releaseClassify;
  const classifyGate = new Promise((resolve) => { releaseClassify = resolve; });
  let markClassifyStarted;
  const classifyStarted = new Promise((resolve) => { markClassifyStarted = resolve; });
  const classifySeen = [];
  const classifierProvider = createProvider({
    id: "fixture-class",
    auth: { apiKey: { name: "fixture", resolve: async () => ({ auth: {} }) } },
    models: [{
      type: "classifier",
      provider: "fixture-class",
      id: "fixture-jev",
      name: "fixture-jev",
      api: "fixture-classify",
      baseUrl: "http://127.0.0.1/",
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32768,
    }],
    classifiers: {
      "fixture-classify": {
        classify: async (model, context) => {
          classifySeen.push({ provider: model.provider, id: model.id, api: model.api, prompt: context.state?.prompt });
          markClassifyStarted();
          await classifyGate;
          const tierNames = Object.keys(context.questions?.tier?.criteria ?? {});
          const probabilities = Object.fromEntries(tierNames.map((tier) => [tier, tier === "restricted" ? 0.8 : +(0.2 / Math.max(1, tierNames.length - 1)).toFixed(6)]));
          return {
            api: "fixture-classify",
            provider: "fixture-class",
            model: "fixture-jev",
            answers: { tier: { type: "choice", choice: "restricted", confidence: 0.9, probabilities } },
            stopReason: "stop",
            timestamp: Date.now(),
          };
        },
      },
    },
  });

  let releaseSeed;
  let markSeedStarted;
  const seedStarted = new Promise((resolve) => { markSeedStarted = resolve; });
  const seedGate = new Promise((resolve) => { releaseSeed = resolve; });
  const seedFaux = fauxProvider({ provider: "faux-seed", models: [{ id: "physical", reasoning: false }] });
  const seedCalls = [];
  seedFaux.setResponses([async (_context, _options, _state, model) => {
    seedCalls.push(`${model.provider}/${model.id}`);
    markSeedStarted();
    await seedGate;
    return fauxAssistantMessage(fauxText("seed response"));
  }]);

  const targetFaux = fauxProvider({ provider: "faux", models: [{ id: "physical-target", reasoning: false }] });
  const targetCalls = [];
  targetFaux.setResponses([(_context, _options, _state, model) => {
    targetCalls.push(`${model.provider}/${model.id}`);
    return fauxAssistantMessage(fauxText("forbidden target response"));
  }]);

  const manualFaux = fauxProvider({ provider: "faux-manual", models: [{ id: "physical", reasoning: false }] });
  const manualCalls = [];
  manualFaux.setResponses([(_context, _options, _state, model) => {
    manualCalls.push(`${model.provider}/${model.id}`);
    return fauxAssistantMessage(fauxText("manual response"));
  }]);

  const criteria = Object.fromEntries(Object.keys(current.tiers).map((tier) => [tier, `Bounded ${tier} criterion.`]));
  // Hard admission turns an aborted classifier result into a default-tier
  // fallback before the late-abort guard, so removing the guard would dispatch
  // the routed target. Reliability is off so provider admission adds no abort
  // gate; this mirrors the reviewed handler fault's load-bearing setup.
  const economics = current.hardAdmission ? {
    mode: "policy",
    scopes: { selected: { kind: "model", model: "faux/physical-target" } },
    sources: [{ id: "manual", scopeRef: "selected", authority: "declared" }],
    admission: [{ id: "daily", scopeRef: "selected", windowId: "day", reserveRatio: 0.2, unknown: "block" }],
    observations: [{
      sourceId: "manual", scopeRef: "selected", billing: "metered", observedAt: 100,
      expiresAt: 8_000_000_000_000_000, revision: 1,
      windows: [{ id: "day", period: { id: "p1", sequence: 1 }, unit: "ratio", remaining: 0.4 }],
    }],
  } : undefined;
  writeFileSync(join(cwd, ".pi", "bifrost.json"), JSON.stringify({
    schemaVersion: 2,
    enabled: true,
    default: "restricted",
    models: current.tiers,
    ...(economics ? { economics } : {}),
    reliability: { enabled: false },
    classifier: {
      enabled: true,
      backend: "pi-native",
      criteria,
      piNative: { model: "fixture-class/fixture-jev", timeoutMs: 5000, maxAttempts: 1 },
      fallback: "regex",
      minConfidence: 0.1,
    },
    cache: { enabled: false },
    rules: [],
  }));
  process.chdir(cwd);

  runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  runtime.registerNativeProvider(classifierProvider);
  runtime.registerNativeProvider(seedFaux.provider);
  runtime.registerNativeProvider(targetFaux.provider);
  runtime.registerNativeProvider(manualFaux.provider);
  providers.push("fixture-class", "faux-seed", "faux", "faux-manual");
  await runtime.setRuntimeApiKey("fixture-class", "fixture-only");
  await runtime.setRuntimeApiKey("faux-seed", "fixture-only");
  await runtime.setRuntimeApiKey("faux", "fixture-only");
  await runtime.setRuntimeApiKey("faux-manual", "fixture-only");
  await runtime.refresh({ allowNetwork: false });
  const seed = runtime.getModel("faux-seed", "physical");
  assert.ok(seed, "the distinct seed model must be available");

  const { default: bifrostExtension } = await import(activationExtensionPath ? activationExtensionPath : join(root, "index.ts"));
  const probe = { signal: undefined, aborted: undefined };
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, extensionFactories: [signalProbeExtension(probe), bifrostExtension] });
  await resourceLoader.reload();
  ({ session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model: seed, noTools: "all", resourceLoader }));
  await session.bindExtensions({ mode: "print" });
  assert.equal(modelKey(session.model), "faux-seed/physical");

  const errors = [];
  const originalError = console.error;
  console.error = (...args) => { errors.push(args.join(" ")); originalError(...args); };
  let first;
  let steer;
  let abortPromise;
  try {
    // Warm the session into streaming on the seed model with an inline tier
    // override so the first turn never consults the classifier or the target.
    first = session.prompt("seed warmup turn");
    await seedStarted;
    assert.equal(session.isStreaming, true, "the warmup turn must hold the session streaming");

    // A steer input while streaming is the host boundary that carries a real
    // abort signal into the extension input handler.
    steer = session.prompt("please handle the steer", { streamingBehavior: "steer" });
    await classifyStarted;
    assert.equal(classifySeen.length, 1, "the steer must invoke the pi-native classifier exactly once");
    assert.equal(modelKey(session.model), "faux-seed/physical", "routing must not change the model before the abort");

    if (current.abort) {
      abortPromise = session.abort();
      assert.ok(probe.signal, "the extension input handler must observe the host abort signal");
      await probe.aborted;
    } else {
      const manual = runtime.getModel("faux-manual", "physical");
      await session.setModel(manual);
      assert.equal(modelKey(session.model), "faux-manual/physical", "the newer manual selection must take effect");
    }

    // Late completion: release the classifier result only after the abort or the
    // newer manual selection has taken effect.
    releaseClassify();
    releaseSeed();
    await Promise.allSettled([first, steer]);
    await abortPromise?.catch(() => {});
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(targetCalls, [], `${scenario}: the routed physical model must never receive a provider callback`);
  assert.equal(targetFaux.state.callCount, 0, `${scenario}: the routed target provider must have zero calls`);
  assert.equal(modelKey(session.model), current.expectedModel, `${scenario}: the newer selection must win (forbidden late dispatch observable)`);
  assert.equal(session.isStreaming, false, `${scenario}: the session must settle to idle`);
  assert.equal(existsSync(violationPath) ? readFileSync(violationPath, "utf8") : "", "", `${scenario}: AgentSession made a blocked outbound attempt`);
  if (current.abort) {
    assert.ok(errors.some((message) => /cancelled|stale|not sent/i.test(message)), `expected an actionable cancellation message, got: ${errors.join(" | ")}`);
  }
  assert.equal(existsSync(scratch), true, "child must not delete the parent-owned scratch");
});
