// Agent skills in the tenant workspace (platform-next /api/v1/skills): the
// catalog the agent dialog picks from, and how a skill appears on an agent.
// A skill is written by the product team; members only attach it.
import { api } from "./api.ts";

export interface SkillRef {
  id: string;
  slug: string;
  displayName: string;
  description: string;
  // Whether the skill ships scripts, which run only where coding is on.
  hasScripts: boolean;
  // False when the product team disabled it: new chats leave it out.
  available: boolean;
}

export interface SkillCatalog {
  skills: SkillRef[];
  // Whether skill scripts can run in this workspace's chats.
  scripts: boolean;
}

// Kept in step with platform-next/src/modules/skills/skill.ts.
export const MAX_SKILLS = 10;

const WIRE_ID = /^[0-9a-f]{24}$/;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

const text = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.length <= max ? value : null;

// A malformed entry from the server is dropped rather than rendered.
export function parseSkillRef(value: unknown): SkillRef | null {
  const s = value as Record<string, unknown> | null;
  if (!s || typeof s !== "object") return null;
  const id = text(s.id, 24);
  const slug = text(s.slug, 64);
  const displayName = text(s.displayName, 200);
  const description = text(s.description, 2000);
  if (!id || !WIRE_ID.test(id) || !slug || !SLUG.test(slug)) return null;
  if (!displayName || description === null) return null;
  return {
    id,
    slug,
    displayName,
    description,
    hasScripts: s.hasScripts === true,
    available: s.available !== false,
  };
}

export const parseSkillRefs = (value: unknown): SkillRef[] =>
  Array.isArray(value)
    ? value.flatMap((entry) => {
        const skill = parseSkillRef(entry);
        return skill ? [skill] : [];
      })
    : [];

export async function fetchSkills(): Promise<SkillCatalog> {
  const data = await api("/api/v1/skills");
  return {
    skills: parseSkillRefs(data?.skills),
    scripts: data?.scripts === true,
  };
}

// The rows the dialog's picker shows: every catalog skill, then any skill the
// agent still has that the catalog no longer offers (Unavailable), so the
// member can see and remove it.
export function skillOptions(
  catalog: readonly SkillRef[],
  attached: readonly SkillRef[],
): SkillRef[] {
  const ids = new Set(catalog.map((skill) => skill.id));
  return [
    ...catalog,
    ...attached
      .filter((skill) => !ids.has(skill.id))
      .map((skill) => ({ ...skill, available: false })),
  ];
}

// The short label shown beside a skill, or null when it can be used as is.
export function skillNote(skill: SkillRef, scripts: boolean): string | null {
  if (!skill.available) return "Unavailable";
  if (skill.hasScripts && !scripts) return "Needs coding";
  return null;
}
