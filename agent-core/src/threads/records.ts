import {
  mkdirSync,
  writeFileSync,
  renameSync,
  readdirSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { HttpError } from "../errors";
import type { DomainEvent } from "../../../shared/contracts";

export function recordPath(
  home: string,
  id: string,
  generation: string,
  seq: number,
) {
  const dir = join(home, "adapter-records", id);
  const file = join(dir, `${generation}-${String(seq).padStart(12, "0")}.json`);
  return { dir, file };
}

export function writeRecord(dir: string, file: string, event: DomainEvent) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(file + ".tmp", JSON.stringify(event));
  renameSync(file + ".tmp", file);
}

export function records(home: string, id: string) {
  const dir = join(home, "adapter-records", id);
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .slice(0, 100)
      .map((f) => ({
        key: f,
        event: JSON.parse(readFileSync(join(dir, f), "utf8")),
      }));
  } catch (e: any) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}

export function ack(home: string, id: string, keys: string[]) {
  for (const key of keys) {
    if (!/^[\w-]+\.json$/.test(key))
      throw new HttpError(400, "Invalid record key");
    try {
      unlinkSync(join(home, "adapter-records", id, key));
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
  }
}
