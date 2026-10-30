import { Inflate } from "fflate";
import { OFFICE_LIMITS, PreviewError, type OfficeLimits } from "./limits.ts";

// Reads only the parts a preview asks for. A part's declared size is checked
// against the limits before anything is inflated, and inflating stops the
// moment the output passes that declared size, so a small file can't expand
// into gigabytes in memory however its headers lie.

const END = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
// Fed to the inflater in pieces this small, so one piece can expand to at
// most about 1 MB (deflate's largest ratio is about 1032:1).
const INPUT_CHUNK = 1024;

type Entry = {
  name: string;
  flags: number;
  method: number;
  packed: number;
  size: number;
  offset: number;
};

export type Zip = {
  names: readonly string[];
  has: (name: string) => boolean;
  read: (name: string) => Uint8Array;
  text: (name: string) => string;
};

const corrupt = (what: string) =>
  new PreviewError("corrupt", `Not a readable file: ${what}.`);

export function openZip(
  bytes: Uint8Array,
  limits: OfficeLimits = OFFICE_LIMITS,
): Zip {
  if (bytes.length > limits.fileBytes)
    throw new PreviewError("too-large", "The file is too large to preview.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const u16 = (at: number) => view.getUint16(at, true);
  const u32 = (at: number) => view.getUint32(at, true);

  // The end record sits in the last 22 bytes, before a comment of up to 64 KB.
  let end = -1;
  for (
    let at = bytes.length - 22;
    at >= Math.max(0, bytes.length - 65_557);
    at--
  )
    if (u32(at) === END) {
      end = at;
      break;
    }
  if (end < 0) throw corrupt("no zip directory");
  const count = u16(end + 10);
  const size = u32(end + 12);
  const start = u32(end + 16);
  if (count === 0xffff || start === 0xffffffff)
    throw new PreviewError("unsupported", "Zip64 files can't be previewed.");
  if (count > limits.entries)
    throw new PreviewError(
      "too-large",
      "The file has too many parts to preview.",
    );
  if (start + size > end) throw corrupt("zip directory out of bounds");

  const decoder = new TextDecoder();
  const entries = new Map<string, Entry>();
  let at = start;
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || u32(at) !== CENTRAL) throw corrupt("bad zip entry");
    const nameLength = u16(at + 28);
    const next = at + 46 + nameLength + u16(at + 30) + u16(at + 32);
    if (next > end) throw corrupt("zip entry out of bounds");
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    entries.set(name, {
      name,
      flags: u16(at + 8),
      method: u16(at + 10),
      packed: u32(at + 20),
      size: u32(at + 24),
      offset: u32(at + 42),
    });
    at = next;
  }

  let used = 0;
  const read = (name: string): Uint8Array => {
    const entry = entries.get(name);
    if (!entry) throw corrupt(`missing ${name}`);
    if (entry.flags & 1)
      throw new PreviewError(
        "unsupported",
        "Encrypted files can't be previewed.",
      );
    if (entry.size > limits.entryBytes || entry.size > limits.totalBytes - used)
      throw new PreviewError("too-large", "The file is too large to preview.");
    const local = entry.offset;
    if (local + 30 > bytes.length || u32(local) !== LOCAL)
      throw corrupt(`bad header for ${name}`);
    const from = local + 30 + u16(local + 26) + u16(local + 28);
    if (from + entry.packed > bytes.length)
      throw corrupt(`${name} is cut short`);
    const data = bytes.subarray(from, from + entry.packed);
    let out: Uint8Array;
    if (entry.method === 0) out = data.slice();
    else if (entry.method === 8) out = inflate(data, entry.size, name);
    else
      throw new PreviewError(
        "unsupported",
        "This file uses a compression the preview doesn't read.",
      );
    if (out.length !== entry.size) throw corrupt(`${name} has the wrong size`);
    used += out.length;
    return out;
  };
  return {
    names: [...entries.keys()],
    has: (name) => entries.has(name),
    read,
    text: (name) => decoder.decode(read(name)),
  };
}

// Inflates at most `size` bytes; more means the header lied.
function inflate(data: Uint8Array, size: number, name: string): Uint8Array {
  const out = new Uint8Array(size);
  let produced = 0;
  const inflater = new Inflate((chunk) => {
    if (produced + chunk.length > size)
      throw new PreviewError(
        "corrupt",
        `Not a readable file: ${name} is larger than it says.`,
        produced + chunk.length,
      );
    out.set(chunk, produced);
    produced += chunk.length;
  });
  try {
    for (let at = 0; at < data.length; at += INPUT_CHUNK)
      inflater.push(
        data.subarray(at, at + INPUT_CHUNK),
        at + INPUT_CHUNK >= data.length,
      );
    if (data.length === 0) inflater.push(new Uint8Array(0), true);
  } catch (error) {
    if (error instanceof PreviewError) throw error;
    throw corrupt(`${name} can't be unzipped`);
  }
  return produced === size ? out : out.subarray(0, produced);
}
