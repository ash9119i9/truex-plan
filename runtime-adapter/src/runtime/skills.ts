import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, open, rename, rm, symlink } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { Readable } from "node:stream";
import { gunzipSync } from "node:zlib";
import type { SkillSpec } from "../contract";
import { AdapterError } from "../errors";
import { readTar, TarError } from "./tar";

// Skill bundles the platform pushes before a chat's thread starts. Each is
// one archive, unpacked once into `<state>/skills/<sha256>/<slug>/` and never
// changed: the directory name is the archive's digest, so two chats with the
// same skill version share it and a different version is a different
// directory. Codex reads them as capability roots (`selectedCapabilityRoots`,
// see config.ts); they sit outside every workspace, so the model can't edit
// them and they never appear among a chat's files. The path holds no tenant
// or chat ID, because Codex shows it to the model.

export const SKILLS_DIR = "skills";
// Archive bytes over the wire (the platform's packer caps bundles at this).
export const MAX_SKILL_ARCHIVE_BYTES = 5 * 1024 * 1024;
// Unpacked bytes, which bounds a decompression bomb.
const MAX_SKILL_BYTES = 25 * 1024 * 1024;
const MAX_ENTRIES = 300;
const MAX_DEPTH = 8;
const MAX_SEGMENT_BYTES = 255;
// Control characters and bidi controls never appear in a skill's paths.
const UNSAFE_SEGMENT = /[\p{Cc}\u202A-\u202E\u2066-\u2069\\]/u;
export const SKILL_SHA256 = /^[0-9a-f]{64}$/;
// The skill's directory name, as the platform's catalog writes it: Codex's
// own rule for skill names (lowercase letters, digits and hyphens, at most
// 64 characters).
export const SKILL_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function skillsRoot(stateDir: string): string {
  return join(stateDir, SKILLS_DIR);
}

// The capability root of one skill version.
export function skillRoot(stateDir: string, sha256: string): string {
  return join(skillsRoot(stateDir), sha256);
}

// Unpacks one archive into its digest's directory. Repeating it for a digest
// already unpacked changes nothing. The archive must hold exactly one
// top-level directory with a SKILL.md, and only files and directories with
// plain relative names.
export async function writeSkill(
  stateDir: string,
  sha256: string,
  body: Readable,
): Promise<{ readonly slug: string; readonly created: boolean }> {
  if (!SKILL_SHA256.test(sha256))
    throw new AdapterError("INVALID_REQUEST", "sha256 must be a hex digest.");
  const archive = await readBody(body);
  if (createHash("sha256").update(archive).digest("hex") !== sha256)
    throw invalid("The skill does not match its sha256.");
  const { slug, entries } = unpack(archive);

  const root = skillsRoot(stateDir);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const target = skillRoot(stateDir, sha256);
  if (await exists(join(target, slug, "SKILL.md")))
    return { slug, created: false };

  // Built beside the target, then renamed into place in one step, so a run
  // never sees half a skill and a crash leaves only a hidden directory.
  const temp = join(root, `.skill-${randomUUID()}`);
  await mkdir(temp, { mode: 0o700 });
  try {
    for (const entry of entries) {
      const path = join(temp, ...entry.path.split("/"));
      if (entry.type === "directory") {
        await mkdir(path, { mode: 0o700 });
        continue;
      }
      const handle = await open(
        path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        entry.executable ? 0o700 : 0o600,
      );
      try {
        await handle.write(entry.data);
      } finally {
        await handle.close();
      }
    }
    try {
      await rename(temp, target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Another request unpacked the same digest first.
      if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
      if (!(await exists(join(target, slug, "SKILL.md")))) throw error;
      return { slug, created: false };
    }
    return { slug, created: true };
  } finally {
    await rm(temp, { recursive: true, force: true }).catch(() => undefined);
  }
}

// The skills a run names that are not unpacked here: after the runtime's
// storage was reset, or for a chat whose skills this runtime never received.
export async function missingSkills(
  stateDir: string,
  skills: readonly SkillSpec[],
): Promise<SkillSpec[]> {
  const present = await Promise.all(
    skills.map((skill) =>
      exists(join(skillRoot(stateDir, skill.sha256), skill.slug, "SKILL.md")),
    ),
  );
  return skills.filter((_, index) => !present[index]);
}

// Makes `dir` hold exactly one link per skill, named by its slug and pointing
// at the unpacked skill folder: the chat's $SKILLS for commands. Rebuilt every
// run, so a skill pushed again after a storage reset is linked again and
// nothing else stays. The targets are relative, so a listing shows no state
// path. Built beside `dir` and swapped in, so a command never sees it half
// written.
export async function linkSkills(
  stateDir: string,
  dir: string,
  skills: readonly SkillSpec[],
): Promise<void> {
  const temp = `${dir}.${randomUUID()}`;
  await mkdir(temp, { recursive: true, mode: 0o700 });
  try {
    for (const skill of skills) {
      if (!SKILL_SLUG.test(skill.slug) || !SKILL_SHA256.test(skill.sha256))
        throw invalid("A skill names an invalid slug or sha256.");
      const target = join(skillRoot(stateDir, skill.sha256), skill.slug);
      await symlink(relative(dir, target), join(temp, skill.slug));
    }
    await rm(dir, { recursive: true, force: true });
    await rename(temp, dir);
  } finally {
    await rm(temp, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function readBody(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_SKILL_ARCHIVE_BYTES)
      throw new AdapterError("PAYLOAD_TOO_LARGE");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function unpack(archive: Buffer) {
  let tar: Buffer;
  try {
    tar = gunzipSync(archive, { maxOutputLength: MAX_SKILL_BYTES });
  } catch {
    throw invalid("The skill is not a gzip archive within the size limit.");
  }
  let entries;
  try {
    entries = readTar(tar);
  } catch (error) {
    throw invalid(
      error instanceof TarError
        ? `The skill archive is invalid: ${error.message}.`
        : "The skill archive is invalid.",
    );
  }
  if (entries.length === 0 || entries.length > MAX_ENTRIES)
    throw invalid(`A skill holds 1-${MAX_ENTRIES} entries.`);
  const seen = new Set<string>();
  const files = new Set<string>();
  const directories = new Set<string>();
  let slug: string | undefined;
  for (const entry of entries) {
    const segments = entry.path.split("/");
    if (
      segments.length > MAX_DEPTH ||
      segments.some(
        (segment) =>
          segment === "" ||
          segment === "." ||
          segment === ".." ||
          segment !== segment.normalize("NFC") ||
          Buffer.byteLength(segment) > MAX_SEGMENT_BYTES ||
          UNSAFE_SEGMENT.test(segment),
      )
    )
      throw invalid("A skill archive path is not a plain relative path.");
    slug ??= segments[0];
    if (segments[0] !== slug)
      throw invalid("A skill archive holds exactly one top-level directory.");
    if (seen.has(entry.path))
      throw invalid("A skill archive names a path twice.");
    seen.add(entry.path);
    // Parents come first, so no file can be created through a path the
    // archive did not declare as a directory.
    const parent = segments.slice(0, -1).join("/");
    if (parent && !directories.has(parent))
      throw invalid("A skill archive lists a path before its directory.");
    if (entry.type === "directory") directories.add(entry.path);
    else if (segments.length === 1)
      throw invalid("A skill archive holds exactly one top-level directory.");
    else files.add(entry.path);
  }
  if (!SKILL_SLUG.test(slug!))
    throw invalid("A skill's directory must be named by its slug.");
  if (!files.has(`${slug}/SKILL.md`))
    throw invalid("A skill needs a SKILL.md.");
  return { slug: slug!, entries };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function invalid(message: string): AdapterError {
  return new AdapterError("INVALID_REQUEST", message);
}
