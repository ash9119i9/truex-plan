import type { ObjectId } from "mongodb";

// Agent skills: a global catalog the product team publishes through the
// operator CLI, like models. A skill is one folder (SKILL.md plus optional
// references/, scripts/ and assets/), stored as one archive per version in
// S3. Agents reference the skill (`agent.skillIds`), never a version; a chat
// snapshots each skill's current version when it starts, so a later publish
// or disable changes new chats only.
export const SKILLS_COLLECTION = "truex_skills";
export const SKILL_VERSIONS_COLLECTION = "truex_skill_versions";

// An agent uses at most this many skills (the adapter's cap too).
export const MAX_AGENT_SKILLS = 10;

export interface SkillDoc {
  _id: ObjectId;
  // The folder name and SKILL.md `name`: Codex's skill-name rule.
  slug: string;
  displayName: string;
  description: string;
  // Soft delete: chats keep a version's ID, so nothing is removed.
  enabled: boolean;
  // The version new chats get, with its number and archive digest copied
  // here so starting a chat needs no version read.
  currentVersionId: ObjectId;
  currentVersion: number;
  currentSha256: string;
  // Whether the current version has a scripts/ folder. Scripts run only
  // where the runtime's coding profile is on.
  hasScripts: boolean;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
  updatedBy: string;
}

// One published bundle. Never changed or deleted: chats that snapshot it keep
// reading its archive from S3 when their runtime's storage is reset.
export interface SkillVersionDoc {
  _id: ObjectId;
  skillId: ObjectId;
  // 1, 2, 3… per skill.
  version: number;
  // Of the gzip archive: the adapter checks it and names its directory by it.
  sha256: string;
  sizeBytes: number;
  fileCount: number;
  // Relative to the files bucket's prefix.
  s3Key: string;
  hasScripts: boolean;
  // Python packages the scripts import, each one the runtime image ships.
  requires: { python: string[] };
  createdAt: Date;
  createdBy: string;
}

// What a member sees in the agent dialog.
export interface SkillView {
  id: string;
  slug: string;
  displayName: string;
  description: string;
  hasScripts: boolean;
  // False for a disabled skill an agent still references: new chats leave it
  // out, and the dialog shows it as Unavailable.
  available: boolean;
}

export function skillView(skill: SkillDoc): SkillView {
  return {
    id: skill._id.toHexString(),
    slug: skill.slug,
    displayName: skill.displayName,
    description: skill.description,
    hasScripts: skill.hasScripts,
    available: skill.enabled,
  };
}

// One skill version a chat uses, fixed when the chat starts.
export interface ChatSkill {
  skillId: ObjectId;
  versionId: ObjectId;
  slug: string;
  // The name at chat start, for the transcript's "Used skill" row.
  displayName: string;
  sha256: string;
}

export function skillArchiveKey(skillId: ObjectId, sha256: string): string {
  return `skills/${skillId.toHexString()}/${sha256}.tar.gz`;
}
