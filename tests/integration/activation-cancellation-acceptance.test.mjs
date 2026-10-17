import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { makeModel } from "../helpers.ts";
import bifrostExtension from "../../index.ts";
import { TYPE_SAFE_API_KEY_ENV } from "../../classifier-backends.ts";
import { BIFROST_AUTO_ID, BIFROST_AUTO_PROVIDER } from "../../virtual-model.ts";

function strictConfig(overrides = {}) {
  return {
    schemaVersion: 2,
    enabled: true,
    default: "restricted",
    strategy: "first",
    classifier: { enabled: false },
    models: { restricted: ["fixture/missing"] },
    tierPolicies: { restricted: { fallbackTiers: [] } },
    rules: [],
    ...overrides,
  };
}

function makeHarness(config, available = [], options = {}) {
  const previousCwd = process.cwd();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousTypeSafeKey = process.env[TYPE_SAFE_API_KEY_ENV];
  const cwd = mkdtempSync(join(tmpdir(), "bifrost-activation-cancel-"));
  const agentDir = join(cwd, "agent");
  const configDir = join(cwd, ".pi");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, "bifrost.json");
  const writeConfig = (next) => writeFileSync(configPath, JSON.stringify(next));
  writeConfig(config);
  process.chdir(cwd);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env[TYPE_SAFE_API_KEY_ENV];

  const selected = [];
  const notices = [];
  const editor = { value: "" };
  const active = options.active ?? makeModel("fixture", "active");
  const modelRegistry = {
    getAvailable: () => available,
    find: (provider, id) => available.find((model) => model.provider === provider && model.id === id),
    getProviderAuthStatus: () => ({ configured: false }),
    getModelOfType: (type, provider, id) => options.classifierModel?.provider === provider && options.classifierModel.id === id ? options.classifierModel : undefined,
    getAvailableOfType: async () => options.classifierModel ? [options.classifierModel] : [],
    classify: options.classify ?? (async () => { throw new Error("unexpected fake classifier request"); }),
    refresh: options.refresh ?? (async () => ({ refreshed: [], errors: [] })),
  };
  const sessionManager = { getBranch: () => [] };
  const ui = {
    getEditorText: () => editor.value,
    setEditorText: (text) => { editor.value = text; },
    setWidget: () => {},
    setStatus: () => {
      if (options.statusThrows || (options.statusThrowsAfterSetModel && selected.length > 0)) {
        throw new Error("injected status cleanup failure");
      }
    },
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    notify: (message) => { notices.push(String(message)); },
    custom: async () => null,
    theme: { fg: (color, text) => text },
  };
  const ctx = {
    cwd,
    mode: options.mode ?? "rpc",
    hasUI: options.mode === "tui",
    model: active,
    modelRegistry,
    sessionManager,
    ui,
    signal: undefined,
    thinkingLevel: "low",
  };
  let input;
  const commands = {};
  let definition;
  const pi = {
    registerVirtualModel: (registered) => { definition = registered; },
    registerCommand: (name, opts) => { commands[name] = opts.handler; },
    on: (event, handler) => { if (event === "input") input = handler; return () => {}; },
    setModel: async (model) => {
      selected.push(`${model.provider}/${model.id}`);
      return options.setModel ? options.setModel(model) : true;
    },
  };
  bifrostExtension(pi);
  if (!input || !definition?.route) throw new Error("extension did not register required hooks");

  return {
    cwd,
    ctx,
    input: async (event = { text: "do the task", source: "interactive", streamingBehavior: "steer" }) => input(event, ctx),
    command: async (name, args = "") => {
      if (!commands[name]) throw new Error(`unknown command ${name}`);
      return commands[name](args, ctx);
    },
    route: definition.route,
    selected,
    notices,
    editor,
    cleanup: () => {
      process.chdir(previousCwd);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousTypeSafeKey === undefined) delete process.env[TYPE_SAFE_API_KEY_ENV];
      else process.env[TYPE_SAFE_API_KEY_ENV] = previousTypeSafeKey;
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

function sendInput(harness, text = "do the task") {
  return harness.input({ text, source: "interactive", streamingBehavior: "steer" });
}

describe("activation cancellation acceptance", { timeout: 120_000 }, () => {
  it("handles false and throwing physical activation without late dispatch", async () => {
    for (const activate of [async () => false, async () => { throw new Error("injected activation failure"); }]) {
      const target = makeModel("fixture", "allowed");
      const harness = makeHarness(strictConfig({ models: { restricted: ["fixture/allowed"] } }), [target], {
        setModel: activate,
      });
      try {
        assert.deepEqual(await sendInput(harness), { action: "handled" });
        assert.deepEqual(harness.selected, ["fixture/allowed"]);
      } finally {
        harness.cleanup();
      }
    }
  });

  it("stops an aborted registry wait and preserves a newer editor draft", async () => {
    let markRefreshStarted;
    const refreshStarted = new Promise((resolve) => { markRefreshStarted = resolve; });
    const refreshGate = new Promise(() => {});
    const controller = new AbortController();
    const target = makeModel("fixture", "allowed");
    const harness = makeHarness(strictConfig({ classifier: { enabled: true } }), [target], {
      mode: "tui",
      refresh: async () => { markRefreshStarted(); return refreshGate; },
    });
    harness.ctx.signal = controller.signal;
    harness.editor.value = "original request";
    let deadline;
    try {
      const input = sendInput(harness, "original request");
      const timeout = new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error("strict abort test exceeded 5-second deadline")), 5000);
      });
      await Promise.race([refreshStarted, timeout]);
      harness.editor.value = "newer draft";
      controller.abort();
      assert.deepEqual(await Promise.race([input, timeout]), { action: "handled" });
      assert.equal(harness.editor.value, "newer draft");
      assert.deepEqual(harness.selected, []);
    } finally {
      if (deadline) clearTimeout(deadline);
      harness.cleanup();
    }
  });

  it("does not dispatch after a late classifier result", async () => {
    const controller = new AbortController();
    let markClassificationStarted;
    const classificationStarted = new Promise((resolve) => { markClassificationStarted = resolve; });
    let releaseClassification;
    const classificationGate = new Promise((resolve) => { releaseClassification = resolve; });
    const classifierModel = { type: "classifier", provider: "typesafe", id: "fixture" };
    const target = makeModel("fixture", "allowed");
    const harness = makeHarness(strictConfig({
      models: { restricted: ["fixture/allowed"] },
      classifier: {
        enabled: true,
        backend: "pi-native",
        criteria: { restricted: "Bounded fixture classification criterion." },
        minConfidence: 0.1,
        piNative: { model: "typesafe/fixture", timeoutMs: 5000, maxAttempts: 1 },
      },
    }), [target], {
      classifierModel,
      classify: async () => { markClassificationStarted(); return classificationGate; },
    });
    harness.ctx.signal = controller.signal;
    let deadline;
    try {
      const input = sendInput(harness);
      const timeout = new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error("classifier cancellation test exceeded 5-second deadline")), 5000);
      });
      await Promise.race([classificationStarted, timeout]);
      releaseClassification({
        api: "systemone",
        provider: "typesafe",
        model: "fixture",
        answers: { tier: { type: "choice", choice: "restricted", confidence: 0.9, probabilities: { restricted: 1 } } },
        stopReason: "stop",
        timestamp: Date.now(),
      });
      controller.abort();
      assert.deepEqual(await Promise.race([input, timeout]), { action: "handled" });
      assert.deepEqual(harness.selected, []);
    } finally {
      if (deadline) clearTimeout(deadline);
      harness.cleanup();
    }
  });

  it("lets a manual pin win over an in-flight registry refresh", async () => {
    let markRefreshStarted;
    const refreshStarted = new Promise((resolve) => { markRefreshStarted = resolve; });
    let releaseRefresh;
    const refreshGate = new Promise((resolve) => { releaseRefresh = resolve; });
    const target = makeModel("fixture", "allowed");
    const active = makeModel("fixture", "active");
    const harness = makeHarness(strictConfig({
      models: { restricted: ["fixture/allowed"] },
      classifier: { enabled: true, backend: "prompt", fallback: "regex" },
    }), [target, active], {
      active,
      refresh: async () => { markRefreshStarted(); await refreshGate; return { refreshed: [], errors: [] }; },
    });
    let deadline;
    try {
      const input = sendInput(harness);
      const timeout = new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error("manual pin race exceeded 5-second deadline")), 5000);
      });
      await Promise.race([refreshStarted, timeout]);
      await harness.command("bifrost", "pin");
      releaseRefresh();
      assert.deepEqual(await Promise.race([input, timeout]), { action: "continue" });
      assert.deepEqual(harness.selected, []);
    } finally {
      if (deadline) clearTimeout(deadline);
      releaseRefresh?.();
      harness.cleanup();
    }
  });
});
