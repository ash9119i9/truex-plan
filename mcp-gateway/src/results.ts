// What a provider sends back is cleaned before Codex sees it:
// - known token values (the member's access and refresh token) are replaced
//   with "[redacted]", in results, errors and notifications alike;
// - a tool result is marked untrusted in its `_meta`, so later layers can
//   treat its text as data, not instructions;
// - a message larger than the cap is cut, keeping whole content items first
//   and ending with a note that says it was cut.

export const UNTRUSTED_META = "ai.truex/untrusted";
const REDACTED = "[redacted]";
// Shorter values would match ordinary text; real tokens are far longer.
const MIN_SECRET_LENGTH = 8;

// A message too large to cut down (no content to cut, or an SSE event past
// the read limit).
export class ResultTooLargeError extends Error {
  constructor() {
    super("A provider message was larger than the Truex gateway accepts.");
    this.name = "ResultTooLargeError";
  }
}

export interface Protected {
  readonly message: unknown;
  readonly redacted: boolean;
  readonly truncated: boolean;
}

export interface ProtectOptions {
  // Only tool results are marked; true by default.
  readonly markUntrusted?: boolean;
}

export function protectMessage(
  message: unknown,
  secrets: readonly string[],
  maxBytes: number,
  options: ProtectOptions = {},
): Protected {
  // Working on the JSON text reaches every string at any depth, and
  // re-serialising undoes any \u-escaping a provider used to hide a value.
  let text = JSON.stringify(message);
  let redacted = false;
  for (const secret of usableSecrets(secrets)) {
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (!text.includes(escaped)) continue;
    text = text.split(escaped).join(REDACTED);
    redacted = true;
  }
  const clean: unknown = JSON.parse(text);
  if (
    (options.markUntrusted ?? true) &&
    isRecord(clean) &&
    isRecord(clean.result)
  )
    clean.result._meta = {
      ...(isRecord(clean.result._meta) ? clean.result._meta : {}),
      [UNTRUSTED_META]: true,
    };
  if (sizeOf(clean) <= maxBytes)
    return { message: clean, redacted, truncated: false };
  return { message: truncate(clean, maxBytes), redacted, truncated: true };
}

export function redactText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of usableSecrets(secrets))
    out = out.split(secret).join(REDACTED);
  return out;
}

function usableSecrets(secrets: readonly string[]): string[] {
  // Longest first, so a token that contains another is replaced whole.
  return [...new Set(secrets)]
    .filter((s) => s.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length);
}

// Keeps content items in order while they fit, cuts the first text item
// that doesn't, and ends with a note. structuredContent can't be cut
// meaningfully, so it's dropped. A message with nothing to cut becomes a
// JSON-RPC error when it has an id.
function truncate(message: unknown, maxBytes: number): unknown {
  const kb = Math.round(maxBytes / 1024);
  const id = isRecord(message) ? message.id : undefined;
  const fallback = () => {
    if (typeof id !== "string" && typeof id !== "number")
      throw new ResultTooLargeError();
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message: `The result was larger than the ${kb} KB the Truex gateway passes on.`,
      },
    };
  };
  if (
    !isRecord(message) ||
    !isRecord(message.result) ||
    !Array.isArray(message.result.content)
  )
    return fallback();
  const { structuredContent: _dropped, content, ...rest } = message.result;
  const note = {
    type: "text",
    text: `[The rest of this result was cut by the Truex gateway: it was larger than ${kb} KB.]`,
  };
  const build = (items: unknown[]) => ({
    ...message,
    result: { ...rest, content: [...items, note] },
  });
  if (sizeOf(build([])) > maxBytes) return fallback();
  const kept: unknown[] = [];
  for (const item of content as unknown[]) {
    if (sizeOf(build([...kept, item])) <= maxBytes) {
      kept.push(item);
      continue;
    }
    if (
      isRecord(item) &&
      item.type === "text" &&
      typeof item.text === "string"
    ) {
      const full = item.text;
      // The longest prefix that still fits.
      let low = 0;
      let high = full.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        const fits =
          sizeOf(build([...kept, { ...item, text: full.slice(0, mid) }])) <=
          maxBytes;
        if (fits) low = mid;
        else high = mid - 1;
      }
      if (low > 0) kept.push({ ...item, text: full.slice(0, low) });
    }
    break;
  }
  return build(kept);
}

// Rewrites a provider's SSE stream message by message, as it arrives.
// Comments become an empty keep-alive; events that aren't JSON are dropped;
// an event's `id` is kept so Codex can resume. An event larger than
// `maxEventBytes`, or a stream that never ends one, stops the stream.
export async function* rewriteSse(
  source: AsyncIterable<Uint8Array>,
  transform: (message: unknown) => unknown,
  maxEventBytes: number,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of source) {
    buffer += decoder.decode(chunk, { stream: true });
    // CRLF and lone CR end lines too. A CR at the very end may be the first
    // half of a CRLF split across chunks, so it waits.
    buffer = buffer.replace(/\r\n/g, "\n").replace(/\r(?=[\s\S])/g, "\n");
    let end = buffer.indexOf("\n\n");
    while (end >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const event = rewriteEvent(block, transform, maxEventBytes);
      if (event) yield event;
      end = buffer.indexOf("\n\n");
    }
    if (Buffer.byteLength(buffer) > maxEventBytes)
      throw new ResultTooLargeError();
  }
  buffer += decoder.decode();
  const last = buffer.replace(/\r/g, "\n").trim();
  if (last) {
    const event = rewriteEvent(last, transform, maxEventBytes);
    if (event) yield event;
  }
}

function rewriteEvent(
  block: string,
  transform: (message: unknown) => unknown,
  maxEventBytes: number,
): string | undefined {
  if (Buffer.byteLength(block) > maxEventBytes) throw new ResultTooLargeError();
  const data: string[] = [];
  let id: string | undefined;
  let comment = false;
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) {
      comment = true;
      continue;
    }
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "id") id = value;
  }
  if (data.length === 0) return comment ? ":\n\n" : undefined;
  let message: unknown;
  try {
    message = JSON.parse(data.join("\n"));
  } catch {
    return undefined;
  }
  const idLine = id !== undefined ? `id: ${id}\n` : "";
  return `${idLine}event: message\ndata: ${JSON.stringify(transform(message))}\n\n`;
}

function sizeOf(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
