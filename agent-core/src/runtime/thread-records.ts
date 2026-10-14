import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HttpError } from "../errors";

export function threadMarker(home: string, id: string) {
  if (!/^[\w-]+$/.test(id)) throw new HttpError(400, "Invalid conversation");
  return join(home, "business-threads", id + ".json");
}

export function readThreadRecord(marker: string): any {
  return JSON.parse(readFileSync(marker, "utf8"));
}

export function writeThreadRecord(marker: string, record: unknown) {
  writeFileSync(marker, JSON.stringify(record), { mode: 0o600 });
}
