import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("artifact verification rejects x86 binaries, a different pin and a changed binary", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "truex-codex-artifact-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pin = JSON.parse(
    await readFile(new URL("../codex.lock.json", import.meta.url), "utf8"),
  );
  const binary = join(dir, "codex"),
    manifest = join(dir, "codex.json"),
    lock = join(dir, "lock.json");
  const elf = Buffer.alloc(64);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(elf);
  elf.writeUInt16LE(183, 18);
  await writeFile(binary, elf);
  await writeFile(lock, JSON.stringify(pin));
  const metadata = {
    revision: pin.revision,
    platform: "linux/arm64",
    sha256: createHash("sha256").update(elf).digest("hex"),
  };
  await writeFile(manifest, JSON.stringify(metadata));
  const verify = () =>
    execFileSync(
      process.execPath,
      [
        fileURLToPath(new URL("./codex-artifact.mjs", import.meta.url)),
        "verify",
        binary,
        manifest,
        lock,
      ],
      { stdio: "pipe" },
    );
  assert.match(verify().toString(), /Verified ARM64/);
  await writeFile(
    manifest,
    JSON.stringify({ ...metadata, revision: "0".repeat(40) }),
  );
  assert.throws(verify, /does not match/);
  await writeFile(manifest, JSON.stringify(metadata));
  elf[63] = 1;
  await writeFile(binary, elf);
  assert.throws(verify, /does not match/);
  elf.writeUInt16LE(62, 18);
  await writeFile(binary, elf);
  assert.throws(verify, /x86-64/);
});
