import type { ObjectId } from "mongodb";
import { integer, invalid, objectWith } from "../../common/validation";
import {
  parseAgentDescription,
  parseAgentName,
  parseLook,
  parseTint,
  type AgentTint,
} from "./agent-fields";

// Agents the product team ships to every tenant, in the catalog's
// `builtin_agents`. One copy serves all tenants, so an update is one write
// rather than a migration across tenant databases.
export const BUILTIN_AGENTS_COLLECTION = "builtin_agents";
export const BUILTIN_INSTRUCTIONS_MAX = 20_000;

// Control characters other than tab and line breaks.
const PROMPT_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;

// What the product team writes. The model is named by its slug.
export interface BuiltinAgentSpec {
  slug: string;
  name: string;
  description: string;
  // Product-written prompt. Server-side only, never sent to a browser.
  instructions: string;
  model: string;
  look: number;
  tint: AgentTint;
  sortOrder: number;
}

export interface BuiltinAgentDoc extends Omit<BuiltinAgentSpec, "model"> {
  _id: ObjectId;
  modelId: ObjectId;
  enabled: boolean;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
  updatedBy: string;
}

const FIELDS = [
  "slug",
  "name",
  "description",
  "instructions",
  "model",
  "look",
  "tint",
  "sortOrder",
];

export function parseBuiltinAgentSpec(input: unknown): BuiltinAgentSpec {
  const raw = objectWith(input, FIELDS, "The built-in agent definition");
  if (typeof raw.slug !== "string" || !SLUG.test(raw.slug))
    invalid(
      "slug must be 1-48 lowercase letters, digits or hyphens, starting and ending with a letter or digit.",
    );
  if (typeof raw.model !== "string" || !SLUG.test(raw.model))
    invalid("model must be the slug of a model.");
  if (
    typeof raw.instructions !== "string" ||
    raw.instructions.trim().length === 0 ||
    raw.instructions.length > BUILTIN_INSTRUCTIONS_MAX ||
    PROMPT_CONTROL.test(raw.instructions)
  )
    invalid(
      `instructions must be 1-${BUILTIN_INSTRUCTIONS_MAX} characters of text.`,
    );
  return {
    slug: raw.slug,
    name: parseAgentName(raw.name),
    description: parseAgentDescription(raw.description),
    // Multi-line prose: normalized and trimmed, newlines kept.
    instructions: raw.instructions.normalize("NFC").trim(),
    model: raw.model,
    look: parseLook(raw.look),
    tint: parseTint(raw.tint),
    sortOrder: integer(raw.sortOrder ?? 100, "sortOrder", 0, 100_000),
  };
}
