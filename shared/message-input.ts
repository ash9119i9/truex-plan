// Message payloads retain their original whitespace. Limits count JavaScript
// UTF-16 code units, matching the existing platform boundary.
export const MESSAGE_TEXT_MAX_LENGTH = 100_000;

export function messageTextError(value: unknown): string | null {
  return typeof value !== "string" ||
    !value.trim() ||
    value.length > MESSAGE_TEXT_MAX_LENGTH
    ? "Text must contain 1–100000 characters"
    : null;
}
