// A strict reader for the ustar archives the platform's skill packer writes
// (platform-next/src/modules/skills/skill-bundle.ts). Only regular files and
// directories are accepted: links, devices, pax and GNU extension headers
// are refused rather than interpreted, so an archive can never name anything
// outside the directory it is unpacked into.

export interface TarEntry {
  // "/"-separated, relative, without a trailing slash.
  readonly path: string;
  readonly type: "file" | "directory";
  // Owner execute bit, kept for scripts.
  readonly executable: boolean;
  readonly data: Buffer;
}

const BLOCK = 512;

export class TarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TarError";
  }
}

export function readTar(archive: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  for (;;) {
    if (offset + BLOCK > archive.length) throw new TarError("truncated header");
    const header = archive.subarray(offset, offset + BLOCK);
    offset += BLOCK;
    // Two zero blocks end the archive; one is enough to stop reading.
    if (header.every((byte) => byte === 0)) return entries;
    if (checksumOf(header) !== octal(header, 148, 8))
      throw new TarError("bad header checksum");
    if (header.toString("latin1", 257, 263) !== "ustar\0")
      throw new TarError("not a ustar archive");
    const name = field(header, 0, 100);
    const prefix = field(header, 345, 155);
    const path = (prefix ? `${prefix}/${name}` : name).replace(/\/$/, "");
    const typeflag = header.toString("latin1", 156, 157);
    const mode = octal(header, 100, 8);
    const size = octal(header, 124, 12);
    let type: TarEntry["type"];
    if (typeflag === "0" || typeflag === "\0") type = "file";
    else if (typeflag === "5") type = "directory";
    else throw new TarError("unsupported entry type");
    if (type === "directory" && size !== 0)
      throw new TarError("directory with data");
    if (offset + size > archive.length) throw new TarError("truncated data");
    entries.push({
      path,
      type,
      executable: (mode & 0o100) !== 0,
      data: archive.subarray(offset, offset + size),
    });
    offset += Math.ceil(size / BLOCK) * BLOCK;
  }
}

// A NUL-terminated (or full-width) UTF-8 field.
function field(header: Buffer, start: number, length: number): string {
  const raw = header.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end < 0 ? length : end).toString("utf8");
}

function octal(header: Buffer, start: number, length: number): number {
  const text = header
    .toString("latin1", start, start + length)
    .replace(/[\0 ]+$/, "")
    .trim();
  if (!/^[0-7]{1,11}$/.test(text)) throw new TarError("bad number field");
  return parseInt(text, 8);
}

// The header's byte sum with the checksum field read as spaces.
function checksumOf(header: Buffer): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++)
    sum += i >= 148 && i < 156 ? 0x20 : header[i]!;
  return sum;
}
