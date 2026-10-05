import {
  mkdirSync,
  readFileSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { HttpError } from "./errors";

export interface StopIntent {
  version: 1;
  threadId: string;
  turnId: string;
  turnIds?: string[];
  reason: "user" | "stalled";
  targets: { threadId: string; turnId: string }[];
}
const identifier = (v: unknown): v is string =>
  typeof v === "string" && /^[\w-]{1,256}$/.test(v);
export class StopStore {
  private dir: string;
  constructor(home: string, directory = "stop-intents") {
    this.dir = join(home, directory);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }
  ids(): string[] {
    try {
      return readdirSync(this.dir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => name.slice(0, -5))
        .map((id) => {
          if (!identifier(id)) throw new Error("Invalid identifier");
          return id;
        });
    } catch {
      throw new HttpError(
        503,
        "Stop recovery storage is invalid",
        "STOP_STORAGE_INVALID",
      );
    }
  }
  read(id: string): StopIntent | undefined {
    let raw: string;
    try {
      raw = readFileSync(join(this.dir, `${id}.json`), "utf8");
    } catch (e: any) {
      if (e.code === "ENOENT") return;
      throw new HttpError(
        503,
        "Stop recovery storage is unavailable",
        "STOP_STORAGE_INVALID",
      );
    }
    try {
      const s = JSON.parse(raw);
      if (
        s.version !== 1 ||
        s.threadId !== id ||
        !identifier(s.threadId) ||
        !identifier(s.turnId) ||
        (s.turnIds !== undefined &&
          (!Array.isArray(s.turnIds) ||
            !s.turnIds.length ||
            s.turnIds.length > 1000 ||
            !s.turnIds.every(identifier) ||
            !s.turnIds.includes(s.turnId))) ||
        !["user", "stalled"].includes(s.reason) ||
        !Array.isArray(s.targets) ||
        !s.targets.length ||
        s.targets.length > 1000 ||
        !s.targets.every(
          (t: any) =>
            identifier(t.threadId) && (t.turnId === "" || identifier(t.turnId)),
        ) ||
        !s.targets.some(
          (t: any) =>
            t.threadId === id && (t.turnId === s.turnId || t.turnId === ""),
        )
      )
        throw new Error("Invalid intent");
      return { ...s, turnIds: s.turnIds ?? [s.turnId] };
    } catch {
      throw new HttpError(
        503,
        "Stop recovery storage is invalid",
        "STOP_STORAGE_INVALID",
      );
    }
  }
  write(intent: StopIntent) {
    const tmp = join(this.dir, `${intent.threadId}.${randomUUID()}.tmp`);
    try {
      const fd = openSync(tmp, "wx", 0o600);
      try {
        writeFileSync(fd, JSON.stringify(intent));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, join(this.dir, `${intent.threadId}.json`));
      this.sync();
    } catch (e) {
      try {
        unlinkSync(tmp);
      } catch {
        /* Preserve the previous complete intent. */
      }
      throw new HttpError(
        503,
        "Stop recovery storage is unavailable",
        "STOP_STORAGE_INVALID",
      );
    }
  }
  clear(id: string) {
    try {
      try {
        unlinkSync(join(this.dir, `${id}.json`));
      } catch (e: any) {
        if (e.code !== "ENOENT") throw e;
      }
      this.sync();
    } catch {
      throw new HttpError(
        503,
        "Stop recovery storage is unavailable",
        "STOP_STORAGE_INVALID",
      );
    }
  }
  private sync() {
    const fd = openSync(this.dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}

// A runtime request can outlive its timeout; always consume its eventual error.
export async function bounded<T>(request: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Stop deadline exceeded")),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
