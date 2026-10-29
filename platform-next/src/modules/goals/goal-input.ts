import { invalid, objectWith } from "../../common/validation";
import { CLIENT_ID, UNSAFE } from "../chats/chat";

// Codex's limit on a goal objective, counted in Unicode characters as Codex
// counts them (chars().count()), not UTF-16 units.
export const MAX_GOAL_OBJECTIVE = 4000;

// In a /u regex a surrogate matches only when it is not half of a pair.
const LONE_SURROGATE = /\p{Cs}/u;

export interface GoalStartInput {
  // A retry with the same ID returns the goal it started.
  clientRequestId: string;
  // Absent only when starting the goal the model proposed.
  objective?: string;
  // One of the tenant's presets.
  tokenBudget: number;
}

// Characters as Codex counts them.
export function goalLength(text: string): number {
  return [...text].length;
}

// Kept as typed (newlines, inner spacing) after NFC; refuses control
// characters, bidi overrides and broken characters (lone surrogates), which
// Codex cannot read.
function goalText(value: unknown, field: string): string {
  if (typeof value !== "string") invalid(`${field} must be a string.`);
  const text = value.normalize("NFC");
  if (
    text.trim().length === 0 ||
    goalLength(text) > MAX_GOAL_OBJECTIVE ||
    LONE_SURROGATE.test(text)
  )
    invalid(`${field} must be 1-${MAX_GOAL_OBJECTIVE} characters.`);
  if (UNSAFE.test(text.replace(/[\n\r\t]/g, "")))
    invalid(`${field} contains unsupported control characters.`);
  return text;
}

function objectiveOf(value: unknown): string {
  return goalText(value, "objective");
}

// A whole number of tokens; the service checks it against the goal.
function tokenBudgetOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1)
    invalid("tokenBudget must be a whole number of tokens.");
  return value;
}

export interface RequestChangesInput {
  // Merged into the objective (mergeFeedback), trimmed.
  feedback: string;
  // A higher budget for the reopened goal.
  tokenBudget?: number;
}

export function parseRequestChanges(body: unknown): RequestChangesInput {
  const raw = objectWith(body, ["feedback", "tokenBudget"], "Request body");
  const feedback = goalText(raw.feedback, "feedback").trim();
  return {
    feedback,
    ...(raw.tokenBudget !== undefined
      ? { tokenBudget: tokenBudgetOf(raw.tokenBudget) }
      : {}),
  };
}

export function parseRaiseBudget(body: unknown): { tokenBudget: number } {
  const raw = objectWith(body, ["tokenBudget"], "Request body");
  return { tokenBudget: tokenBudgetOf(raw.tokenBudget) };
}

// The objective a reopened goal works to: the original, then the owner's
// feedback, so the model's completion check covers both.
export function mergeFeedback(objective: string, feedback: string): string {
  return `${objective}\n\nChanges requested: ${feedback}`;
}

export function parseGoalStart(body: unknown): GoalStartInput {
  const raw = objectWith(
    body,
    ["clientRequestId", "objective", "tokenBudget"],
    "Request body",
  );
  if (
    typeof raw.clientRequestId !== "string" ||
    !CLIENT_ID.test(raw.clientRequestId)
  )
    invalid('clientRequestId must be 8-64 letters, digits, "_" or "-".');
  const tokenBudget = raw.tokenBudget;
  if (
    typeof tokenBudget !== "number" ||
    !Number.isInteger(tokenBudget) ||
    tokenBudget < 1
  )
    invalid("tokenBudget must be one of the workspace's goal budgets.");
  return {
    clientRequestId: raw.clientRequestId,
    ...(raw.objective !== undefined
      ? { objective: objectiveOf(raw.objective) }
      : {}),
    tokenBudget,
  };
}

export function parseGoalEdit(body: unknown): { objective: string } {
  const raw = objectWith(body, ["objective"], "Request body");
  return { objective: objectiveOf(raw.objective) };
}
