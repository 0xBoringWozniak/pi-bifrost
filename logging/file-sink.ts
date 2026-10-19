// ── Asynchronous file sink ────────────────────────────────────────
// One sink instance owns one physical file. Writes are serialized so rotation
// and append never overlap. A batch is retried at most once; repeated failure
// is reported to the logger, which degrades instead of retrying forever.

import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { LogDestination, LogEntry, LogSink } from "./types.ts";

export interface FileSinkOptions {
  readonly maxFileSizeBytes: number;
  readonly rotatedFiles: number;
  readonly onFailure?: (error: unknown) => void;
}

function isMissingPath(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

export class AsyncFileSink implements LogSink {
  private chain: Promise<void> = Promise.resolve();
  private directoryReady = false;
  private closed = false;
  private readonly destination: LogDestination;
  private readonly options: FileSinkOptions;

  constructor(destination: LogDestination, options: FileSinkOptions) {
    this.destination = destination;
    this.options = options;
  }

  write(batch: readonly LogEntry[]): Promise<void> {
    if (this.closed || batch.length === 0) return Promise.resolve();
    const payload = batch.map((entry) => entry.line).join("");
    const task = this.chain.then(() => this.writeWithRetry(payload));
    // Keep the chain alive after a failure so later batches still run.
    this.chain = task.then(() => undefined, () => undefined);
    return task;
  }

  flush(): Promise<void> {
    return this.chain;
  }

  close(): Promise<void> {
    this.closed = true;
    return this.chain;
  }

  private async writeWithRetry(payload: string): Promise<void> {
    try {
      await this.writeOnce(payload);
    } catch (firstError) {
      // Retry only a missing directory/file race. Retrying after a partial
      // write (ENOSPC, EIO) could duplicate lines, so fail the batch instead.
      if (!isMissingPath(firstError)) {
        this.options.onFailure?.(firstError);
        throw firstError;
      }
      this.directoryReady = false;
      try {
        await this.writeOnce(payload);
      } catch (secondError) {
        this.options.onFailure?.(secondError);
        throw secondError;
      }
    }
  }

  private async writeOnce(payload: string): Promise<void> {
    if (!this.directoryReady) {
      await mkdir(dirname(this.destination.path), { recursive: true, mode: 0o700 });
      this.directoryReady = true;
    }
    await this.rotateIfNeeded();
    await appendFile(this.destination.path, payload, { encoding: "utf-8", flag: "a", mode: 0o600 });
  }

  private async rotateIfNeeded(): Promise<void> {
    if (this.options.rotatedFiles <= 0) return;
    let size = 0;
    try {
      size = (await stat(this.destination.path)).size;
    } catch {
      return; // No current file; the append creates it.
    }
    if (size <= this.options.maxFileSizeBytes) return;
    // Rotation is best-effort: a failed rename must not fail the write.
    try {
      await this.rotate();
    } catch {
      // Ignore; the append continues against the current file.
    }
  }

  private async rotate(): Promise<void> {
    const path = this.destination.path;
    const old = `${path}.old`;
    const keep = this.options.rotatedFiles;
    if (keep <= 1) {
      // Windows refuses to replace an existing target, so remove it first.
      await rm(old, { force: true }).catch(() => undefined);
      await rename(path, old);
      return;
    }
    await rm(`${old}.${keep - 1}`, { force: true }).catch(() => undefined);
    for (let index = keep - 2; index >= 1; index -= 1) {
      await rename(`${old}.${index}`, `${old}.${index + 1}`).catch(() => undefined);
    }
    await rename(old, `${old}.1`).catch(() => undefined);
    await rm(old, { force: true }).catch(() => undefined);
    await rename(path, old);
  }
}
