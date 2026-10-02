import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { open, readFile, writeFile } from "node:fs/promises";

const [mode, binary, manifestPath, lockPath, source] = process.argv.slice(2);

async function main() {
  if (
    !binary ||
    !manifestPath ||
    !lockPath ||
    !["create", "verify"].includes(mode)
  )
    throw new Error(
      "Usage: codex-artifact.mjs create|verify <binary> <manifest> <lock> [source checkout]",
    );
  const pin = JSON.parse(await readFile(lockPath, "utf8"));
  if (!/^[a-f0-9]{40}$/.test(pin.revision))
    throw new Error("Invalid pinned revision");
  const file = await open(binary, "r");
  try {
    const header = Buffer.alloc(64);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    if (
      bytesRead !== 64 ||
      !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
      header[4] !== 2 ||
      header[5] !== 1 ||
      header.readUInt16LE(18) !== 183
    )
      throw new Error(
        "Expected a Linux ARM64 ELF executable; the local x86-64 binary cannot be used",
      );
  } finally {
    await file.close();
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(binary)) hash.update(chunk);
  const expected = {
    revision: pin.revision,
    platform: "linux/arm64",
    sha256: hash.digest("hex"),
  };
  if (mode === "create") {
    if (!source)
      throw new Error(
        "Creating a manifest requires the producer's pinned source checkout",
      );
    const git = (args) =>
      execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();
    if (
      git(["rev-parse", "HEAD"]) !== pin.revision ||
      git(["status", "--porcelain", "--untracked-files=no"])
    )
      throw new Error(
        "Artifact source must be clean and match codex.lock.json",
      );
    // The build target compiles from this checkout. Git cannot prove an arbitrary binary's origin.
    await writeFile(manifestPath, JSON.stringify(expected, null, 2) + "\n");
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (
    !manifest ||
    Object.entries(expected).some(([key, value]) => manifest[key] !== value)
  )
    throw new Error(
      "Codex artifact revision, platform or checksum does not match",
    );
  console.log(`Verified ARM64 Codex artifact for ${pin.revision}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
