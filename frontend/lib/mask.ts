// The one masking function every surface uses (DESIGN-SPEC 12, 17.3, D12):
// tool arguments and output, the activity stream, TurnError and ApprovalRecords.
//   URLs and file paths → "•••"
//   e-mail             → first letter + "•••@domain"
//   key-like tokens    → "•••" (sk- pk- rk- api_ key_ tok_, or any run of 32+)
// Only rooted paths, or relative ones ending in a file extension, count as
// paths, so dates like 10/12/2026 and words like and/or stay readable. Every
// pattern is a single pass without nested repetition, so long input stays fast.

const HIDDEN = "•••";
const URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]+/gi;
const KEY = /\b(?:sk|pk|rk|api|key|tok)[-_][A-Za-z0-9_-]{8,}/gi;
const LONG = /[A-Za-z0-9_-]{32,}/g;
// A rooted path: /…, ~/…, or a drive letter, up to the next space or quote.
const ROOTED = /(^|[\s("'=:,[])(?:[A-Za-z]:\\|~?\/)[^\s"'),\]]+/g;
// E-mail and relative paths are checked per word, so no pattern rescans a
// long run of text from every position.
const WORD = /[^\s"'<>()[\],;]+/g;
const EMAIL =
  /^([A-Za-z0-9])[A-Za-z0-9._%+-]*@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})$/;
const MAX_EMAIL = 320;
const EXTENSION = /\.[A-Za-z0-9]{1,5}$/;
const DATE = /^\d{1,4}[/\\]\d{1,2}[/\\]\d{1,4}$/;

function maskWord(word: string): string {
  // Trailing sentence punctuation is not part of the word.
  const tail = /[.:!?]+$/.exec(word)?.[0] ?? "";
  const core = tail ? word.slice(0, -tail.length) : word;
  if (core.length <= MAX_EMAIL && core.includes("@")) {
    const email = EMAIL.exec(core);
    if (email) return `${email[1]}${HIDDEN}@${email[2]}${tail}`;
  }
  if (
    (core.includes("/") || core.includes("\\")) &&
    EXTENSION.test(core) &&
    !DATE.test(core)
  )
    return HIDDEN + tail;
  return word;
}

export function mask(text: string): string {
  if (text == null) return "";
  return String(text)
    .replace(URL, HIDDEN)
    .replace(KEY, HIDDEN)
    .replace(ROOTED, `$1${HIDDEN}`)
    .replace(WORD, maskWord)
    .replace(LONG, HIDDEN);
}

// Masks every string inside a value (tool arguments, request parameters).
export function maskDeep(value: unknown): unknown {
  if (typeof value === "string") return mask(value);
  if (Array.isArray(value)) return value.map(maskDeep);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, maskDeep(inner)]),
    );
  return value;
}
