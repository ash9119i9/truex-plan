import { DomainError } from "./domain-error";

// Input checks shared by request bodies and operator definitions. Each throws
// INVALID_INPUT naming the field, never echoing the rejected value.

const UNSAFE_TEXT = /[\p{Cc}\p{Cf}]/u;

export function invalid(message: string): never {
  throw new DomainError("INVALID_INPUT", message);
}

// Trimmed NFC text with no control or invisible format characters (bidi
// overrides and the like render differently from what was stored).
export function cleanText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") invalid(`${field} must be a string.`);
  const text = value.normalize("NFC").trim();
  if (text.length === 0 || text.length > max || UNSAFE_TEXT.test(text))
    invalid(`${field} must be 1-${max} visible characters.`);
  return text;
}

export function integer(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  )
    invalid(`${field} must be a whole number from ${min} to ${max}.`);
  return value;
}

export function oneOf<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !allowed.includes(value as T))
    invalid(`${field} must be one of: ${allowed.join(", ")}.`);
  return value as T;
}

// A plain object with no fields outside `allowed`, so a typo or a field from
// another API version is reported instead of silently ignored.
export function objectWith(
  input: unknown,
  allowed: readonly string[],
  what: string,
): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    invalid(`${what} must be a JSON object.`);
  for (const key of Object.keys(input))
    if (!allowed.includes(key)) invalid(`Unknown field "${key.slice(0, 64)}".`);
  return input as Record<string, unknown>;
}
