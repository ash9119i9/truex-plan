import { cleanText, integer, oneOf } from "../../common/validation";

// Fields shared by built-in and user agents. Look and tint are the robot
// avatar from docs/truex-design-spec.html (frontend/lib/agent-look.ts).
export const AGENT_TINTS = ["ice", "mint", "butter", "peach", "lilac"] as const;
export type AgentTint = (typeof AGENT_TINTS)[number];
export const AGENT_LOOK_COUNT = 12;
export const AGENT_NAME_MAX = 60;
export const AGENT_DESCRIPTION_MAX = 280;

export const parseAgentName = (value: unknown): string =>
  cleanText(value, "name", AGENT_NAME_MAX);

export const parseAgentDescription = (value: unknown): string =>
  cleanText(value, "description", AGENT_DESCRIPTION_MAX);

export const parseLook = (value: unknown): number =>
  integer(value, "look", 0, AGENT_LOOK_COUNT - 1);

export const parseTint = (value: unknown): AgentTint =>
  oneOf(value, "tint", AGENT_TINTS);
