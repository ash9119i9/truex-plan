import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile, writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
const writeManifest = args[0] === "--write-manifest";
if (writeManifest) args.shift();

async function verify() {
  if (args.length !== 3) {
    throw new Error(
      "Usage: node verify-binary.mjs [--write-manifest] <binary> <manifest> <lock>",
    );
  }
  const [binaryPath, manifestPath, lockPath] = args;
  const pin = JSON.parse(await readFile(lockPath, "utf8"));
  if (
    typeof pin.revision !== "string" ||
    !/^[a-f0-9]{40}$/.test(pin.revision)
  ) {
    throw new Error("The Codex lock must contain a full Git revision");
  }

  const binary = await open(binaryPath, "r");
  try {
    const header = Buffer.alloc(64);
    const { bytesRead } = await binary.read(header, 0, header.length, 0);
    if (
      bytesRead !== header.length ||
      !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
      header[4] !== 2 ||
      header[5] !== 1 ||
      header.readUInt16LE(18) !== 183
    ) {
      throw new Error(
        "Expected a Linux ARM64 ELF binary. An x86-64 or macOS binary cannot run in this image.",
      );
    }
  } finally {
    await binary.close();
  }

  const hash = createHash("sha256");
  for await (const chunk of createReadStream(binaryPath)) hash.update(chunk);
  const sha256 = hash.digest("hex");
  const expected = {
    revision: pin.revision,
    platform: "linux/arm64",
    sha256,
  };

  if (writeManifest) {
    // The artifact builder fetches and verifies the locked source before
    // compiling. Run this mode only when the producer confirms that revision.
    await writeFile(manifestPath, JSON.stringify(expected, null, 2) + "\n");
  }

  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("The Codex artifact manifest must be a JSON object");
  }
  if (manifest.revision !== expected.revision) {
    throw new Error(
      `Codex artifact revision mismatch: expected ${expected.revision}, found ${manifest.revision}`,
    );
  }
  if (manifest.platform !== expected.platform) {
    throw new Error("The Codex artifact manifest must specify linux/arm64");
  }
  if (manifest.sha256 !== expected.sha256) {
    throw new Error("Codex artifact checksum mismatch");
  }
  console.log(`Verified ARM64 Codex artifact for revision ${pin.revision}`);
}

verify().catch((error) => {
  console.error(`Codex artifact verification failed: ${error.message}`);
  process.exitCode = 1;
});
