import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

// Builds skill archives the way the platform's packer does (ustar, one
// top-level directory, parents before children), plus hand-made malformed
// entries for refusal tests.

export interface ArchiveEntry {
  readonly path: string;
  // "0" file, "5" directory, anything else to test refusal ("2" symlink).
  readonly type?: string;
  readonly data?: string | Buffer;
  readonly mode?: number;
  readonly linkName?: string;
}

function header(entry: ArchiveEntry, size: number): Buffer {
  const block = Buffer.alloc(512);
  const name = Buffer.from(entry.path);
  if (name.length > 100) {
    // Split into prefix/name at a "/" the way ustar writers do.
    const cut = entry.path.lastIndexOf("/", 155);
    block.write(entry.path.slice(0, cut), 345, "utf8");
    block.write(entry.path.slice(cut + 1), 0, "utf8");
  } else name.copy(block, 0);
  const type = entry.type ?? "0";
  const mode = entry.mode ?? (type === "5" ? 0o755 : 0o644);
  block.write(mode.toString(8).padStart(7, "0") + "\0", 100, "latin1");
  block.write("0000000\0", 108, "latin1");
  block.write("0000000\0", 116, "latin1");
  block.write(size.toString(8).padStart(11, "0") + "\0", 124, "latin1");
  block.write("00000000000\0", 136, "latin1");
  block.write(type, 156, "latin1");
  if (entry.linkName) block.write(entry.linkName, 157, "utf8");
  block.write("ustar\0", 257, "latin1");
  block.write("00", 263, "latin1");
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "latin1");
  return block;
}

export function tarOf(entries: readonly ArchiveEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const data =
      entry.data === undefined
        ? Buffer.alloc(0)
        : Buffer.isBuffer(entry.data)
          ? entry.data
          : Buffer.from(entry.data);
    parts.push(header(entry, data.length), data);
    const pad = (512 - (data.length % 512)) % 512;
    parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

export function archiveOf(entries: readonly ArchiveEntry[]): Buffer {
  return gzipSync(tarOf(entries));
}

export function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

// A valid skill folder: SKILL.md, a reference and an executable script.
export function sampleSkill(
  slug = "po-check",
  description = "Check SAP purchase orders for approval issues.",
): Buffer {
  return archiveOf([
    { path: slug, type: "5" },
    {
      path: `${slug}/SKILL.md`,
      data: `---\nname: ${slug}\ndescription: ${description}\n---\n\nBODY-${slug}. For details read references/detail.md.\n`,
    },
    { path: `${slug}/references`, type: "5" },
    { path: `${slug}/references/detail.md`, data: `REFERENCE-BODY-${slug}` },
    { path: `${slug}/scripts`, type: "5" },
    {
      path: `${slug}/scripts/hello.sh`,
      data: `#!/bin/sh\necho SCRIPT-RAN-${slug}\n`,
      mode: 0o755,
    },
  ]);
}
