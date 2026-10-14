import { join } from "node:path";
import { HttpError } from "../errors";

export const DEFAULT_TENANT = "default";
// At most 32 characters, so a tenant folder can never look like a workspace UUID.
export const TENANT_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const SKILL_LIMITS = {
  count: 50,
  description: 1024,
  body: 64 * 1024,
  // Every skill rides in the base instructions of every model request.
  total: 256 * 1024,
};

const invalid = (field: string, why: string) =>
  new HttpError(400, `Invalid ${field}: ${why}`, "INVALID_INPUT");

// Absent means the default tenant.
export function tenantId(value: unknown): string {
  if (value === undefined) return DEFAULT_TENANT;
  if (typeof value !== "string" || !TENANT_ID.test(value))
    throw invalid("tenantId", `must match ${TENANT_ID.source}`);
  return value;
}

// New workspaces of a tenant live in its own folder. Threads created before
// tenancy keep the flat path recorded in their marker.
export const tenantWorkspaces = (home: string, tenant: string) =>
  join(home, "business-workspaces", tenantId(tenant));

export interface Skill {
  name: string;
  description: string;
  body: string;
  version: number;
}

// Catalog skills chosen for the thread's agent, sorted by name so the same set
// always renders the same instructions.
export function skillSet(value: unknown): Skill[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalid("skills", "must be an array");
  if (value.length > SKILL_LIMITS.count)
    throw invalid("skills", `at most ${SKILL_LIMITS.count} skills`);
  const seen = new Set<string>();
  let total = 0;
  const skills = value.map((skill: any, i): Skill => {
    const at = `skills/${i}`;
    if (!skill || typeof skill !== "object" || Array.isArray(skill))
      throw invalid(at, "must be an object");
    const { name, description, body, version } = skill;
    if (typeof name !== "string" || !SKILL_NAME.test(name))
      throw invalid(`${at}/name`, `must match ${SKILL_NAME.source}`);
    if (seen.has(name)) throw invalid(`${at}/name`, `duplicate ${name}`);
    seen.add(name);
    if (
      typeof description !== "string" ||
      !description.trim() ||
      description.length > SKILL_LIMITS.description
    )
      throw invalid(
        `${at}/description`,
        `must be 1-${SKILL_LIMITS.description} characters`,
      );
    if (typeof body !== "string")
      throw invalid(`${at}/body`, "must be a string");
    const size = Buffer.byteLength(body);
    if (size > SKILL_LIMITS.body)
      throw invalid(`${at}/body`, `at most ${SKILL_LIMITS.body} bytes`);
    if (!Number.isSafeInteger(version) || version < 1)
      throw invalid(`${at}/version`, "must be a positive integer");
    total += size + Buffer.byteLength(description);
    return { name, description: description.trim(), body, version };
  });
  if (total > SKILL_LIMITS.total)
    throw invalid("skills", `at most ${SKILL_LIMITS.total} bytes in total`);
  return skills.sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
}

// Skill text cannot close or open the delimiting tags.
const fence = (text: string) =>
  text.replace(/<(\/?)(skill|description)\b/gi, "&lt;$1$2");

// Skills reach the model only through this section. Codex cannot limit a
// thread to chosen skills, so no skill folder is ever exposed to threads.
export function skillInstructions(skills: Skill[]): string {
  if (!skills.length) return "";
  return (
    "\n\nAgent skills:\nThese skills come from this agent's configuration. When a request matches a skill's description, follow that skill's instructions. The rules above still apply.\n" +
    skills
      .map(
        (s) =>
          `<skill name="${s.name}" version="${s.version}">\n<description>${fence(s.description)}</description>\n${fence(s.body.trim())}\n</skill>`,
      )
      .join("\n")
  );
}
