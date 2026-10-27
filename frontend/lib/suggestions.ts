// The Follow Up block a reply may end with. This is the browser's copy of
// platform-next/src/modules/chats/followups.ts: platform-next does not import
// this package, so both suites run the same golden cases
// (test/support/followups-golden.json) to catch drift.
//
//   [truex-suggestions]
//   shape: how-to; stage: build
//   act: Draft an ABAP report that calls the BAPI and commits the work
//   verify: Check which authorisation objects BAPI_PO_CREATE1 needs
//   [/truex-suggestions]

export const FOLLOW_UP_INTENTS = [
  "act",
  "deepen",
  "verify",
  "next",
  "compare",
  "reply",
] as const;
export type FollowUpIntent = (typeof FOLLOW_UP_INTENTS)[number] | "ask";

export const FOLLOW_UP_SHAPES = [
  "explain",
  "how-to",
  "troubleshoot",
  "compare",
  "verify",
  "locate",
  "decide",
  "reference",
  "chat",
] as const;
export const FOLLOW_UP_STAGES = [
  "understand",
  "locate",
  "design",
  "build",
  "test",
  "transport",
  "operate",
  "none",
] as const;

export const FOLLOW_UPS_MAX_ITEMS = 3;
export const FOLLOW_UPS_MAX_CHARS = 160;

export type FollowUpStatus = "ok" | "none" | "missing" | "invalid";

export interface FollowUpItem {
  slot: number;
  intent: FollowUpIntent;
  text: string;
}

export interface FollowUpSet {
  status: FollowUpStatus;
  shape: string;
  stage: string;
  items: FollowUpItem[];
}

export interface ParsedFollowUps {
  text: string;
  followUps: FollowUpSet;
}

const OPEN_MARKER = "[truex-suggestions]";
const OPEN_LINE = /^ {0,3}\[truex-suggestions\][ \t]*$/;
const CLOSE_LINE = /^ {0,3}\[\/truex-suggestions\][ \t]*$/;
const LIST_MARKER = /^(?:[-*•]|\d+[.)])\s+/;
const ROW = /^([A-Za-z][A-Za-z-]*)\s*:\s*(.*)$/;
const BOLD_ROW = /^(?:\*\*|__)([A-Za-z][A-Za-z-]*)(?:\*\*|__)\s*:\s*(.*)$/;
const UNSAFE = /[\p{Cc}\u202A-\u202E\u2066-\u2069]/u;
const WRAPPERS = ["**", "__", '"', "'", "`", "*", "_"] as const;
const QUOTED_ROW = /^(["'`])([A-Za-z][A-Za-z-]*\s*:[\s\S]*)\1$/;
const WORD_CHAR = /[\p{L}\p{N}]/u;
const INTENTS = new Set<string>(FOLLOW_UP_INTENTS);
const SHAPES = new Set<string>(FOLLOW_UP_SHAPES);
const STAGES = new Set<string>(FOLLOW_UP_STAGES);

interface Line {
  start: number;
  end: number;
  content: string;
}

function linesOf(text: string): Line[] {
  const lines: Line[] = [];
  for (let index = 0; index < text.length;) {
    let cursor = index;
    while (
      cursor < text.length &&
      text[cursor] !== "\n" &&
      text[cursor] !== "\r"
    )
      cursor++;
    const end =
      text[cursor] === "\r" && text[cursor + 1] === "\n"
        ? cursor + 2
        : cursor < text.length
          ? cursor + 1
          : cursor;
    lines.push({ start: index, end, content: text.slice(index, cursor) });
    index = end;
  }
  return lines;
}

const FENCE_LINE = /^\s*(`{3,}|~{3,})/;

interface Fences {
  outside: boolean[];
  openAt: number | null;
}

function fencesOf(lines: readonly Line[]): Fences {
  const outside: boolean[] = [];
  let fence: { char: string; length: number; at: number } | null = null;
  for (let index = 0; index < lines.length; index++) {
    const delimiter = FENCE_LINE.exec(lines[index]!.content);
    if (delimiter) {
      const run = delimiter[1]!;
      if (!fence) fence = { char: run[0]!, length: run.length, at: index };
      else if (run[0] === fence.char && run.length >= fence.length)
        fence = null;
      outside.push(false);
      continue;
    }
    outside.push(fence === null);
  }
  return { outside, openAt: fence?.at ?? null };
}

// A complete block ending a reply whose code fence was never closed.
function blockAfterOpenFence(
  lines: readonly Line[],
  openAt: number,
): { open: number; close: number } | null {
  let close = lines.length - 1;
  while (close > openAt && !lines[close]!.content.trim()) close--;
  if (close <= openAt || !CLOSE_LINE.test(lines[close]!.content)) return null;
  for (let index = close - 1; index > openAt; index--) {
    const content = lines[index]!.content;
    if (FENCE_LINE.test(content)) return null;
    if (OPEN_LINE.test(content)) return { open: index, close };
  }
  return null;
}

function hasLoneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function wrapsWhole(inner: string, wrapper: string): boolean {
  for (
    let at = inner.indexOf(wrapper);
    at !== -1;
    at = inner.indexOf(wrapper, at + wrapper.length)
  )
    if (
      !WORD_CHAR.test(inner[at - 1] ?? "") ||
      !WORD_CHAR.test(inner[at + wrapper.length] ?? "")
    )
      return false;
  return true;
}

function unwrap(value: string): string {
  let text = value.trim();
  for (let changed = true; changed;) {
    changed = false;
    for (const wrapper of WRAPPERS) {
      if (
        text.length <= wrapper.length * 2 ||
        !text.startsWith(wrapper) ||
        !text.endsWith(wrapper)
      )
        continue;
      const inner = text.slice(wrapper.length, -wrapper.length);
      if (!wrapsWhole(inner, wrapper)) continue;
      text = inner.trim();
      changed = true;
      break;
    }
  }
  return text;
}

function cleanRow(value: string): string | null {
  if (hasLoneSurrogate(value)) return null;
  const text = unwrap(value.normalize("NFC").replace(/\s+/g, " "));
  if (text.length === 0 || text.length > FOLLOW_UPS_MAX_CHARS) return null;
  // A row of only quotes or markdown (`""`, `---`) has nothing to send.
  if (!WORD_CHAR.test(text)) return null;
  if (UNSAFE.test(text)) return null;
  return text;
}

interface Meta {
  shape?: string;
  stage?: string;
}

function metaOf(line: string): Meta | null {
  const trimmed = line.trim();
  if (!/^(?:shape|stage)\s*:/i.test(trimmed)) return null;
  const shape = /\bshape\s*:\s*([A-Za-z-]+)/i.exec(trimmed)?.[1];
  const stage = /\bstage\s*:\s*([A-Za-z-]+)/i.exec(trimmed)?.[1];
  return {
    ...(shape ? { shape: shape.toLowerCase() } : {}),
    ...(stage ? { stage: stage.toLowerCase() } : {}),
  };
}

function blockOf(lines: readonly Line[]): FollowUpSet {
  let shape = "unknown";
  let stage = "unknown";
  let metaSeen = false;
  let attempted = false;
  const items: FollowUpItem[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    let raw = line.content.trim();
    if (!raw) continue;
    const meta = metaOf(raw);
    if (meta) {
      if (!metaSeen) {
        metaSeen = true;
        shape = meta.shape && SHAPES.has(meta.shape) ? meta.shape : "unknown";
        stage = meta.stage && STAGES.has(meta.stage) ? meta.stage : "unknown";
      }
      continue;
    }
    if (OPEN_LINE.test(raw) || CLOSE_LINE.test(raw)) continue;
    raw = raw.replace(LIST_MARKER, "").trim();
    const quoted = QUOTED_ROW.exec(raw);
    if (quoted) raw = quoted[2]!.trim();
    if (!raw || /^(?:[-*•]|\d+[.)])$/.test(raw)) continue;
    attempted = true;
    if (items.length >= FOLLOW_UPS_MAX_ITEMS) continue;
    let intent: FollowUpIntent = "ask";
    let value = raw;
    const plain = ROW.exec(raw);
    const row = plain ?? BOLD_ROW.exec(raw);
    if (row) {
      const key = row[1]!.toLowerCase();
      if (INTENTS.has(key)) {
        intent = key as FollowUpIntent;
        value = row[2]!;
      } else if (!plain || row[1] === key) value = row[2]!;
    }
    const text = cleanRow(value);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ slot: items.length + 1, intent, text });
  }
  return {
    status: items.length > 0 ? "ok" : attempted ? "invalid" : "none",
    shape,
    stage,
    items,
  };
}

function parseBlock(text: string): ParsedFollowUps {
  const lines = linesOf(text);
  const { outside, openAt } = fencesOf(lines);
  const opens: number[] = [];
  const closes: number[] = [];
  lines.forEach((line, index) => {
    if (!outside[index]) return;
    if (OPEN_LINE.test(line.content)) opens.push(index);
    else if (CLOSE_LINE.test(line.content)) closes.push(index);
  });
  const firstOpen = opens[0];
  const fenced =
    firstOpen === undefined && openAt !== null
      ? blockAfterOpenFence(lines, openAt)
      : null;
  if (fenced)
    return {
      text: text.slice(0, lines[fenced.open]!.start).trimEnd(),
      followUps: blockOf(lines.slice(fenced.open + 1, fenced.close)),
    };
  if (firstOpen === undefined)
    return {
      text,
      followUps: {
        status: "missing",
        shape: "unknown",
        stage: "unknown",
        items: [],
      },
    };
  const lastOpen = opens.at(-1)!;
  const lastClose = closes.at(-1);
  const complete = lastClose !== undefined && lastClose > lastOpen;
  const start = lines[firstOpen]!.start;
  const end = complete ? lines[lastClose!]!.end : text.length;
  const head = text.slice(0, start).trimEnd();
  const tail = text.slice(end).trim();
  const stripped = tail ? (head ? `${head}\n\n${tail}` : tail) : head;
  if (!complete)
    return {
      text: stripped,
      followUps: {
        status: "missing",
        shape: "unknown",
        stage: "unknown",
        items: [],
      },
    };
  return {
    text: stripped,
    followUps: blockOf(lines.slice(lastOpen + 1, lastClose)),
  };
}

function hidePartialMarker(text: string): string | null {
  const breakAt = Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r"));
  const tail = text.slice(breakAt + 1);
  const trimmed = tail.trim();
  if (
    !trimmed.startsWith("[") ||
    trimmed.length >= OPEN_MARKER.length ||
    !OPEN_MARKER.startsWith(trimmed)
  )
    return null;
  return text.slice(0, breakAt + 1).trimEnd();
}

export function parseFollowUps(
  text: string,
  streaming = false,
): ParsedFollowUps {
  const parsed = parseBlock(text);
  if (parsed.text !== text || parsed.followUps.status !== "missing")
    return parsed;
  if (!streaming) return parsed;
  const { outside } = fencesOf(linesOf(text));
  if (!(outside.at(-1) ?? true)) return parsed;
  const hidden = hidePartialMarker(text);
  return hidden === null
    ? parsed
    : { text: hidden, followUps: parsed.followUps };
}

export function stripSuggestions(text: string, streaming = false): string {
  return parseFollowUps(text, streaming).text;
}

export interface SuggestionSplit {
  body: string;
  suggestions: string[];
}

// The legacy suggested-questions surface shows the row text only. It keeps
// working for the old bullet format, because those lines parse as ask rows.
export function splitSuggestions(
  text: string,
  streaming = false,
): SuggestionSplit {
  const parsed = parseFollowUps(text, streaming);
  return {
    body: parsed.text,
    suggestions:
      streaming || parsed.followUps.status === "missing"
        ? []
        : parsed.followUps.items.map((item) => item.text),
  };
}
