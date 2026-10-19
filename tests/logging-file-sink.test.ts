import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AsyncFileSink } from "../logging/file-sink.ts";
import type { LogDestination, LogEntry } from "../logging/types.ts";

interface FakeHandle {
  write(
    data: Buffer | string,
    offset?: number | null,
    length?: number | string | null,
    position?: number | null,
  ): Promise<{ bytesWritten: number; buffer: Buffer }>;
  close(): Promise<void>;
}

function entry(line: string, id: number, destination: LogDestination): LogEntry {
  return {
    id,
    level: "debug",
    retention: 1,
    destination,
    identity: { rootSessionId: "session", sessionId: "session", runId: "run", processId: 1 },
    line,
    bytes: Buffer.byteLength(line),
  };
}

function chunkedHandle(
  chunkSize: number,
  onWrite?: (written: number) => void,
): { handle: FakeHandle; chunks: Buffer[]; closes: () => number } {
  const chunks: Buffer[] = [];
  let closes = 0;
  const handle: FakeHandle = {
    async write(data, offset, length) {
      const buffer = typeof data === "string" ? Buffer.from(data, "utf8") : data;
      const start = typeof offset === "number" ? offset : 0;
      const size = typeof length === "number" ? Math.min(length, buffer.length - start) : buffer.length - start;
      const count = Math.min(chunkSize, size);
      chunks.push(Buffer.from(buffer.subarray(start, start + count)));
      onWrite?.(count);
      return { bytesWritten: count, buffer };
    },
    async close() {
      closes += 1;
    },
  };
  return { handle, chunks, closes: () => closes };
}

describe("async file sink writes", () => {
  it("writes the complete payload across controlled short writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "bifrost-file-sink-short-"));
    try {
      const destination: LogDestination = {
        key: "short",
        path: join(root, "session", "run.jsonl"),
        shared: false,
        root,
      };
      const lines = ['{"event":"one"}\n', '{"event":"two-é"}\n'];
      const { handle, chunks, closes } = chunkedHandle(3);
      const sink = new AsyncFileSink(destination, {
        maxFileSizeBytes: 1_048_576,
        rotatedFiles: 0,
        openFile: async () => handle,
      });

      await sink.write(lines.map((line, index) => entry(line, index + 1, destination)));

      assert.equal(Buffer.concat(chunks).toString("utf8"), lines.join(""));
      assert.equal(closes(), 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports a failure after a short write instead of treating the batch as persisted", async () => {
    const root = await mkdtemp(join(tmpdir(), "bifrost-file-sink-fail-"));
    try {
      const destination: LogDestination = {
        key: "fail",
        path: join(root, "session", "run.jsonl"),
        shared: false,
        root,
      };
      const line = '{"event":"partial"}\n';
      let writes = 0;
      const failure = new Error("simulated disk failure");
      (failure as { code?: string }).code = "EIO";
      let opens = 0;
      let reported: unknown;
      const handle: FakeHandle = {
        async write(data) {
          writes += 1;
          if (writes === 1) {
            return { bytesWritten: 4, buffer: Buffer.from(data as string) };
          }
          throw failure;
        },
        async close() {},
      };
      const sink = new AsyncFileSink(destination, {
        maxFileSizeBytes: 1_048_576,
        rotatedFiles: 0,
        onFailure: (error) => { reported = error; },
        openFile: async () => {
          opens += 1;
          return handle;
        },
      });

      await assert.rejects(sink.write([entry(line, 1, destination)]), /simulated disk failure/);
      assert.equal(writes, 2, "the sink must continue until the payload is complete or a write fails");
      assert.equal(opens, 1, "an uncertain partial failure must not replay the batch");
      assert.equal(reported, failure);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not replay a batch when a missing-path failure follows a partial write", async () => {
    const root = await mkdtemp(join(tmpdir(), "bifrost-file-sink-partial-enoent-"));
    try {
      const destination: LogDestination = {
        key: "partial-enoent",
        path: join(root, "session", "run.jsonl"),
        shared: false,
        root,
      };
      const line = '{"event":"partial"}\n';
      let writes = 0;
      let opens = 0;
      let reported: unknown;
      const missing = new Error("missing after partial write");
      (missing as { code?: string }).code = "ENOENT";
      const handle: FakeHandle = {
        async write(data) {
          writes += 1;
          if (writes === 1) {
            return { bytesWritten: 4, buffer: Buffer.from(data as string) };
          }
          throw missing;
        },
        async close() {},
      };
      const sink = new AsyncFileSink(destination, {
        maxFileSizeBytes: 1_048_576,
        rotatedFiles: 0,
        onFailure: (error) => { reported = error; },
        openFile: async () => {
          opens += 1;
          return handle;
        },
      });

      await assert.rejects(sink.write([entry(line, 1, destination)]), /missing after partial write/);
      assert.equal(writes, 2);
      assert.equal(opens, 1, "a missing path after bytes were written is still an uncertain partial failure");
      assert.equal(reported, missing);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retries a missing-path failure only when no bytes were written", async () => {
    const root = await mkdtemp(join(tmpdir(), "bifrost-file-sink-enoent-"));
    try {
      const destination: LogDestination = {
        key: "enoent",
        path: join(root, "session", "run.jsonl"),
        shared: false,
        root,
      };
      const lines = ['{"event":"retried"}\n'];
      const missing = new Error("directory briefly missing");
      (missing as { code?: string }).code = "ENOENT";
      let opens = 0;
      let writes = 0;
      const second = chunkedHandle(5);
      const sink = new AsyncFileSink(destination, {
        maxFileSizeBytes: 1_048_576,
        rotatedFiles: 0,
        openFile: async () => {
          opens += 1;
          if (opens === 1) {
            return {
              async write() {
                writes += 1;
                throw missing;
              },
              async close() {},
            };
          }
          return second.handle;
        },
      });

      await sink.write(lines.map((line, index) => entry(line, index + 1, destination)));

      assert.equal(opens, 2);
      assert.equal(writes, 1);
      assert.equal(Buffer.concat(second.chunks).toString("utf8"), lines.join(""));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
