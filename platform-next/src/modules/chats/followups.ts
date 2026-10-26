// The Follow Up block a reply may end with. One contract shared by the
// prompt, this parser and the browser's copy (frontend/lib/suggestions.ts);
// both suites run test/support/followups-golden.json so the copies cannot
// drift apart silently.
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
// "ask" is the fallback for a missing or unrecognised intent; it is never
// asked of the model.
export type FollowUpIntent = (typeof FOLLOW_UP_INTENTS)[number] | "ask";

// Unknown values are stored as "unknown": the report then shows how often a
// model drifts from the contract.
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

// ok: 1-3 valid rows; none: a complete but empty block (a deliberate "no
// rows"); missing: no complete block; invalid: a block with rows, none valid.
export type FollowUpStatus = "ok" | "none" | "missing" | "invalid";

export interface FollowUpItem {
  // 1-3, in display order.
  slot: number;
  intent: FollowUpIntent;
  text: string;
}

export interface FollowUpSet {
  status: FollowUpStatus;
  // A shape or stage outside the contract, or absent, is "unknown".
  shape: string;
  stage: string;
  items: FollowUpItem[];
}

export interface ParsedFollowUps {
  // The answer with every suggestion block (and a half-written one at the
  // end) removed. Unchanged when there is no block.
  text: string;
  followUps: FollowUpSet;
}

const OPEN_MARKER = "[truex-suggestions]";
const CLOSE_MARKER = "[/truex-suggestions]";
const OPEN_LINE = /^ {0,3}\[truex-suggestions\][ \t]*$/;
const CLOSE_LINE = /^ {0,3}\[\/truex-suggestions\][ \t]*$/;
const LIST_MARKER = /^(?:[-*•]|\d+[.)])\s+/;
const ROW = /^([A-Za-z][A-Za-z-]*)\s*:\s*(.*)$/;
// A model that bolds the intent tag anyway.
const BOLD_ROW = /^(?:\*\*|__)([A-Za-z][A-Za-z-]*)(?:\*\*|__)\s*:\s*(.*)$/;
// Control characters and the bidi embedding/override/isolate controls. The
// same set chat.ts refuses in a message.
const UNSAFE = /[\p{Cc}\u202A-\u202E\u2066-\u2069]/u;
// Markdown or quotes a model may wrap a whole row in despite the plain-text
// rule. Longest first, so `**` is not read as two `*`.
const WRAPPERS = ["**", "__", '"', "'", "`", "*", "_"] as const;
// A row quoted whole, tag included: `"verify: Check the access sequence"`.
const QUOTED_ROW = /^(["'`])([A-Za-z][A-Za-z-]*\s*:[\s\S]*)\1$/;
const WORD_CHAR = /[\p{L}\p{N}]/u;
const INTENTS = new Set<string>(FOLLOW_UP_INTENTS);
const SHAPES = new Set<string>(FOLLOW_UP_SHAPES);
const STAGES = new Set<string>(FOLLOW_UP_STAGES);

interface Line {
  // Index of the first character of the line in the source.
  start: number;
  // Index just past the line's terminator.
  end: number;
  // The line without its terminator.
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
  // Whether each line is outside a fenced code block. A marker inside a
  // fence is content and is never parsed or stripped.
  outside: boolean[];
  // The line that opened a fence never closed, or null.
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

// A complete block on the last lines of a reply whose code fence was never
// closed: the model forgot the closing fence, not that the block is code.
// Only the block ending the reply counts; a fence line inside it, or
// anything after it, leaves it as content.
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

// True for an unpaired UTF-16 surrogate, which would render as U+FFFD.
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

// Whether every `wrapper` inside `inner` sits between two letters or digits
// (`doesn't`, `BAPI_PO_CREATE1`), so the outer pair wraps the whole row.
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

// Removes wrappers only as a matching pair at both ends, so
// `Explain "COMMIT WORK"` and `"COMMIT WORK" vs "ROLLBACK WORK"` keep every
// quote while `**"Check the release"**` loses both layers.
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

// The shape/stage line, when this line starts like one. Values outside the
// contract are kept as undefined and become "unknown".
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
      } else if (!plain || row[1] === key) {
        // An unknown lowercase or bolded tag (`suggest:`) is dropped; a
        // capitalised word (`SAP: How does MIGO post…`) is the row's text.
        value = row[2]!;
      }
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

  // Strip from the first opening marker to the last closing marker, or to
  // the end when the last block was never closed. Taking the first open
  // keeps nested markers from leaking into the saved answer.
  const lastOpen = opens.at(-1)!;
  const lastClose = closes.at(-1);
  const complete = lastClose !== undefined && lastClose > lastOpen;
  const start = lines[firstOpen]!.start;
  // A trailing opening marker that was never closed removes everything from
  // the first marker to the end, including any complete block before it.
  const end = complete ? lines[lastClose]!.end : text.length;
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

// A marker still arriving at the very end while a browser streams the reply.
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

// Parses a reply's suggestion block and returns the answer without it.
// `streaming` also hides a marker that is still arriving; the server always
// passes false because settle must strip even an interrupted half block.
export function parseFollowUps(
  text: string,
  streaming = false,
): ParsedFollowUps {
  const parsed = parseBlock(text);
  if (parsed.text !== text || parsed.followUps.status !== "missing")
    return parsed;
  if (!streaming) return parsed;
  const { outside } = fencesOf(linesOf(text));
  const lastOutside = outside.at(-1) ?? true;
  if (!lastOutside) return parsed;
  const hidden = hidePartialMarker(text);
  return hidden === null
    ? parsed
    : { text: hidden, followUps: parsed.followUps };
}

export function stripFollowUps(text: string, streaming = false): string {
  return parseFollowUps(text, streaming).text;
}
