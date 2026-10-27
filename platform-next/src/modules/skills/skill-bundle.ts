import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { gzipSync } from "node:zlib";
import { invalid } from "../../common/validation";

// Packs one skill folder into the archive the runtime adapter unpacks
// (runtime-adapter/src/runtime/skills.ts and tar.ts): gzip of a ustar with
// one top-level directory named by the slug, parents before children, only
// regular files and directories. The same folder always packs to the same
// bytes, so publishing it again is recognised as unchanged.

// Matches the adapter's limits, so a bundle the CLI accepts is never refused
// at chat start.
export const MAX_ARCHIVE_BYTES = 5 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 25 * 1024 * 1024;
const MAX_ENTRIES = 300;
const MAX_DEPTH = 8;
// ustar's name field; no single segment may need more.
const MAX_SEGMENT_BYTES = 100;
const MAX_PATH_BYTES = 255;

// Codex's skill-name rule: lowercase letters, digits and hyphens, ≤ 64.
export const SKILL_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const MAX_DESCRIPTION = 1024;
const MAX_TITLE = 60;
// A Python distribution name as requirements.in writes it.
const PACKAGE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

// The standard skill layout. Anything else at the top is refused.
const TOP_FILES = new Set(["SKILL.md", "LICENSE", "LICENSE.txt", "LICENSE.md"]);
const TOP_DIRS = new Set(["references", "scripts", "assets"]);
// Finder litter, skipped rather than refused.
const IGNORED = new Set([".DS_Store"]);
const UNSAFE_SEGMENT = /[\p{Cc}\u202A-\u202E\u2066-\u2069\\/:*?"<>|]/u;

export interface SkillBundle {
  slug: string;
  displayName: string;
  description: string;
  archive: Buffer;
  sha256: string;
  fileCount: number;
  hasScripts: boolean;
  requires: { python: string[] };
}

export interface PackOptions {
  // Python packages the runtime image ships (the toolchain's requirements.in).
  // Null when unknown: a skill that declares `requires` is then refused.
  toolchain: ReadonlySet<string> | null;
}

interface Entry {
  path: string;
  type: "file" | "directory";
  executable: boolean;
  data: Buffer;
}

export async function packSkillFolder(
  folder: string,
  options: PackOptions,
): Promise<SkillBundle> {
  const slug = basename(folder.replace(/\/+$/, ""));
  if (!SKILL_SLUG.test(slug))
    invalid(
      "The skill folder must be named by its slug: 1-64 lowercase letters, digits or hyphens.",
    );
  const root = await lstat(folder).catch(() => null);
  if (!root?.isDirectory()) invalid("The skill folder does not exist.");

  const entries: Entry[] = [
    { path: slug, type: "directory", executable: true, data: Buffer.alloc(0) },
  ];
  let unpacked = 0;
  const walk = async (dir: string, rel: string, depth: number) => {
    const names = (await readdir(dir)).filter((name) => !IGNORED.has(name));
    names.sort();
    for (const name of names) {
      const path = `${rel}/${name}`;
      checkSegment(name, path, depth);
      const full = join(dir, name);
      const stat = await lstat(full);
      if (depth === 1) {
        if (stat.isDirectory() ? !TOP_DIRS.has(name) : !TOP_FILES.has(name))
          invalid(
            `"${name}" is not part of a skill. A skill holds SKILL.md, an optional LICENSE and the folders references/, scripts/ and assets/.`,
          );
      }
      if (stat.isDirectory()) {
        entries.push({
          path,
          type: "directory",
          executable: true,
          data: Buffer.alloc(0),
        });
        await walk(full, path, depth + 1);
      } else if (stat.isFile()) {
        unpacked += stat.size;
        if (unpacked > MAX_UNPACKED_BYTES)
          invalid("The skill is larger than 25 MB unpacked.");
        entries.push({
          path,
          type: "file",
          executable: (stat.mode & 0o100) !== 0,
          data: await readFile(full),
        });
      } else
        invalid(
          `"${path}" is a link or special file; a skill holds only files and folders.`,
        );
      if (entries.length > MAX_ENTRIES)
        invalid(`A skill holds at most ${MAX_ENTRIES} files and folders.`);
    }
  };
  await walk(folder, slug, 1);

  const skillMd = entries.find((entry) => entry.path === `${slug}/SKILL.md`);
  if (!skillMd) invalid("The skill needs a SKILL.md.");
  const meta = parseFrontmatter(skillMd.data.toString("utf8"));
  if (meta.name !== slug)
    invalid(`SKILL.md's name must be the folder name "${slug}".`);
  for (const pkg of meta.requires) {
    if (!options.toolchain)
      invalid(
        "The skill declares requires, but the runtime toolchain list was not found. Pass --toolchain <requirements.in>.",
      );
    if (!options.toolchain.has(normalizePackage(pkg)))
      invalid(
        `The runtime image does not ship the Python package "${pkg}". Add it to runtime-adapter/toolchain/requirements.in first.`,
      );
  }

  const archive = gzipArchive(tarOf(entries));
  if (archive.length > MAX_ARCHIVE_BYTES)
    invalid("The packed skill is larger than 5 MB.");
  return {
    slug,
    displayName: meta.title ?? titleOf(slug),
    description: meta.description,
    archive,
    sha256: createHash("sha256").update(archive).digest("hex"),
    fileCount: entries.filter((entry) => entry.type === "file").length,
    hasScripts: entries.some(
      (entry) =>
        entry.path.startsWith(`${slug}/scripts/`) && entry.type === "file",
    ),
    requires: { python: meta.requires },
  };
}

function checkSegment(name: string, path: string, depth: number): void {
  if (depth > MAX_DEPTH) invalid(`"${path}" is nested too deeply.`);
  if (
    name.startsWith(".") ||
    name !== name.normalize("NFC") ||
    Buffer.byteLength(name) > MAX_SEGMENT_BYTES ||
    UNSAFE_SEGMENT.test(name)
  )
    invalid(
      `"${path.slice(0, 200)}" is not a plain file name (no hidden files, control characters or path separators).`,
    );
  if (Buffer.byteLength(path) > MAX_PATH_BYTES)
    invalid(`"${path.slice(0, 200)}…" is too long.`);
}

// The SKILL.md frontmatter fields the platform reads. Values must be plain
// one-line YAML scalars, so the platform reads them exactly as Codex's YAML
// parser does; other keys are left to Codex.
export interface SkillMeta {
  name: string;
  description: string;
  title?: string;
  requires: string[];
}

export function parseFrontmatter(text: string): SkillMeta {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0] !== "---")
    invalid("SKILL.md must start with a --- frontmatter block.");
  const end = lines.indexOf("---", 1);
  if (end < 0) invalid("SKILL.md's frontmatter has no closing ---.");
  const fields = new Map<string, string>();
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):(?: (.*))?$/.exec(line);
    if (!match) continue; // a nested or continued value of another key
    const key = match[1]!;
    if (!["name", "description", "title", "requires"].includes(key)) continue;
    if (fields.has(key)) invalid(`SKILL.md's frontmatter sets ${key} twice.`);
    fields.set(key, scalar(match[2] ?? "", key));
  }
  const name = fields.get("name");
  if (!name || !SKILL_SLUG.test(name))
    invalid(
      "SKILL.md's frontmatter needs a name: lowercase letters, digits and hyphens.",
    );
  const description = fields.get("description") ?? "";
  if (
    description.length === 0 ||
    description.length > MAX_DESCRIPTION ||
    /[\p{Cc}\p{Cf}]/u.test(description)
  )
    invalid(
      `SKILL.md's description must be 1-${MAX_DESCRIPTION} visible characters on one line.`,
    );
  const title = fields.get("title");
  if (
    title !== undefined &&
    (title.length === 0 ||
      title.length > MAX_TITLE ||
      /[\p{Cc}\p{Cf}]/u.test(title))
  )
    invalid(`SKILL.md's title must be 1-${MAX_TITLE} visible characters.`);
  const requires = (fields.get("requires") ?? "")
    .split(",")
    .map((pkg) => pkg.trim())
    .filter(Boolean);
  for (const pkg of requires)
    if (!PACKAGE.test(pkg))
      invalid(
        "SKILL.md's requires must list Python package names, separated by commas.",
      );
  if (new Set(requires.map(normalizePackage)).size !== requires.length)
    invalid("SKILL.md's requires lists a package twice.");
  return {
    name,
    description,
    ...(title !== undefined ? { title } : {}),
    requires,
  };
}

// A plain or double-quoted one-line scalar. Anything YAML would read
// differently (a block scalar, a nested mapping, a comment, an escape) is
// refused so the two readings never differ.
function scalar(raw: string, key: string): string {
  const value = raw.trim();
  if (value.startsWith('"')) {
    if (
      value.length < 2 ||
      !value.endsWith('"') ||
      /["\\]/.test(value.slice(1, -1))
    )
      invalid(
        `SKILL.md's ${key} must be one plain line, or quoted without " or \\ inside.`,
      );
    return value.slice(1, -1).trim();
  }
  if (/^[[\]{}&*!|>'%@`#,?-]/.test(value) || / #|: |:$/.test(value))
    invalid(
      `SKILL.md's ${key} must be one plain line; wrap it in double quotes if it holds ": " or " #".`,
    );
  return value;
}

function titleOf(slug: string): string {
  const words = slug.split("-").join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// PEP 503: python_pptx, Python.PPTX and python-pptx are one package.
function normalizePackage(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

// The Python packages a toolchain requirements file pins, normalized.
export function toolchainPackages(requirements: string): Set<string> {
  const packages = new Set<string>();
  for (const line of requirements.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:[=<>!~;[]|$)/.exec(
      line,
    );
    if (match && !line.trimStart().startsWith("#"))
      packages.add(normalizePackage(match[1]!));
  }
  return packages;
}

function header(entry: Entry): Buffer {
  const block = Buffer.alloc(512);
  const name = Buffer.from(entry.path, "utf8");
  if (name.length > 100) {
    // Split at a "/" so the name part fits 100 bytes and the prefix 155.
    let cut = -1;
    for (let i = entry.path.length - 1; i > 0; i--)
      if (
        entry.path[i] === "/" &&
        Buffer.byteLength(entry.path.slice(i + 1)) <= 100 &&
        Buffer.byteLength(entry.path.slice(0, i)) <= 155
      ) {
        cut = i;
        break;
      }
    if (cut < 0) invalid(`"${entry.path.slice(0, 200)}" is too long.`);
    block.write(entry.path.slice(0, cut), 345, "utf8");
    block.write(entry.path.slice(cut + 1), 0, "utf8");
  } else name.copy(block, 0);
  const mode = entry.type === "directory" || entry.executable ? 0o755 : 0o644;
  block.write(mode.toString(8).padStart(7, "0") + "\0", 100, "latin1");
  block.write("0000000\0", 108, "latin1");
  block.write("0000000\0", 116, "latin1");
  block.write(
    entry.data.length.toString(8).padStart(11, "0") + "\0",
    124,
    "latin1",
  );
  block.write("00000000000\0", 136, "latin1");
  block.write(entry.type === "directory" ? "5" : "0", 156, "latin1");
  block.write("ustar\0", 257, "latin1");
  block.write("00", 263, "latin1");
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "latin1");
  return block;
}

function tarOf(entries: readonly Entry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(header(entry), entry.data);
    parts.push(Buffer.alloc((512 - (entry.data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

// gzip writes the host OS into its header; set it to "unknown" so a folder
// packs to the same bytes on every machine.
function gzipArchive(tar: Buffer): Buffer {
  const archive = gzipSync(tar, { level: 9 });
  archive[9] = 0xff;
  return archive;
}
