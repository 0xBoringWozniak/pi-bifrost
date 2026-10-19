import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  bindDebugSession,
  debug,
  debugLoggerStats,
  endDebugSession,
  flushDebug,
  isDebugEnabled,
  setupDebug,
} from "../debug.ts";

async function logFiles(cwd: string): Promise<string[]> {
  const root = join(cwd, ".pi", "bifrost", "logs");
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

async function rows(paths: readonly string[]): Promise<Array<Record<string, unknown> & { file: string }>> {
  const output: Array<Record<string, unknown> & { file: string }> = [];
  for (const path of paths) {
    const contents = await readFile(path, "utf8").catch(() => "");
    for (const line of contents.split("\n")) {
      if (!line.trim()) continue;
      output.push({ ...(JSON.parse(line) as Record<string, unknown>), file: path });
    }
  }
  return output;
}

describe("debug facade with session-scoped storage", () => {
  it("writes a run file under the bound session", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "bifrost-facade-session-"));
    try {
      setupDebug({ enabled: true }, cwd);
      bindDebugSession({ getHeader: () => ({ id: "sess-1" }) });
      debug("router", "selected", { model: "provider/model" }, { level: "info" });
      await flushDebug(1_000);
      assert.equal(isDebugEnabled(), true);
      const files = await logFiles(cwd);
      assert.equal(files.length, 1);
      assert.match(files[0]!, /sess-1[\\/]main[\\/].+\.jsonl$/);
      const [row] = await rows(files);
      assert.equal(row!.event, "selected");
      assert.equal(row!.level, "info");
      assert.equal(row!.session_id, "sess-1");
      assert.equal(row!.root_session_id, "sess-1");
      assert.equal(typeof row!.run_id, "string");
      assert.equal(debugLoggerStats()?.batchesWritten, 1);
    } finally {
      setupDebug({ enabled: false }, cwd);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("adopts startup events once the session is known", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "bifrost-facade-boot-"));
    try {
      setupDebug({ enabled: true }, cwd);
      debug("bifrost", "startup", { phase: "boot" }, { level: "info", protected: true });
      bindDebugSession({ getHeader: () => ({ id: "sess-boot" }) });
      await flushDebug(1_000);
      const files = await logFiles(cwd);
      assert.equal(files.length, 1);
      assert.match(files[0]!, /sess-boot[\\/]main[\\/]/);
      const output = await rows(files);
      assert.deepEqual(output.map((row) => row.event), ["startup"]);
    } finally {
      setupDebug({ enabled: false }, cwd);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns contextless events to an unattributed run after the session ends", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "bifrost-facade-end-"));
    try {
      setupDebug({ enabled: true }, cwd);
      bindDebugSession({ getHeader: () => ({ id: "sess-end" }) });
      debug("router", "in-session");
      await flushDebug(1_000);
      endDebugSession();
      debug("router", "after-session");
      await flushDebug(1_000);
      const files = await logFiles(cwd);
      assert.equal(files.length, 2);
      const output = await rows(files);
      const inSession = output.find((row) => row.event === "in-session");
      const afterSession = output.find((row) => row.event === "after-session");
      assert.match(inSession!.file, /sess-end[\\/]main[\\/]/);
      assert.match(afterSession!.file, /_unattributed[\\/]main[\\/]/);
    } finally {
      setupDebug({ enabled: false }, cwd);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("drains accepted events when logging is disabled before flush", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "bifrost-facade-pending-"));
    const path = join(cwd, "trace.jsonl");
    try {
      setupDebug({ enabled: true, path }, cwd);
      debug("router", "pending-before-disable");
      setupDebug({ enabled: false }, cwd);
      await flushDebug(1_000);
      const contents = await readFile(path, "utf8");
      assert.match(contents, /pending-before-disable/);
    } finally {
      setupDebug({ enabled: false }, cwd);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("is idempotent for identical setup and starts a new run after a config change", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "bifrost-facade-reload-"));
    try {
      setupDebug({ enabled: true }, cwd);
      bindDebugSession({ getHeader: () => ({ id: "sess-reload" }) });
      setupDebug({ enabled: true }, cwd);
      debug("router", "first");
      await flushDebug(1_000);
      assert.equal((await logFiles(cwd)).length, 1);

      setupDebug({ enabled: true, level: "info" }, cwd);
      bindDebugSession({ getHeader: () => ({ id: "sess-reload" }) });
      debug("router", "filtered-out");
      debug("router", "second", undefined, { level: "info" });
      await flushDebug(1_000);
      const files = await logFiles(cwd);
      assert.equal(files.length, 2, "a config change starts a new run file");
      const output = await rows(files);
      assert.deepEqual(output.map((row) => row.event).sort(), ["first", "second"]);
    } finally {
      setupDebug({ enabled: false }, cwd);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("stops new events while disabled and works after re-enabling", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "bifrost-facade-toggle-"));
    try {
      setupDebug({ enabled: true }, cwd);
      bindDebugSession({ getHeader: () => ({ id: "sess-toggle" }) });
      debug("router", "before");
      await flushDebug(1_000);
      setupDebug({ enabled: false }, cwd);
      assert.equal(isDebugEnabled(), false);
      debug("router", "while-disabled");
      await flushDebug(1_000);
      setupDebug({ enabled: true }, cwd);
      bindDebugSession({ getHeader: () => ({ id: "sess-toggle" }) });
      debug("router", "after");
      await flushDebug(1_000);
      const output = await rows(await logFiles(cwd));
      assert.deepEqual(output.map((row) => row.event).sort(), ["after", "before"]);
    } finally {
      setupDebug({ enabled: false }, cwd);
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
