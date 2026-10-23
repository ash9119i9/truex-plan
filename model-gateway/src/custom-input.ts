// Decodes the `input` string of a custom tool's function arguments while the
// provider is still streaming them, so Codex can show apply_patch progress
// (response.custom_tool_call_input.delta). The arguments arrive as raw JSON
// text in arbitrary pieces: `{"input": "*** Begin Patch\n...`.
//
// Only progress depends on this. Codex applies the input from the finished
// call (customInput in responses.ts), so arguments in any other shape simply
// stream nothing. Text is emitted only once it is unambiguous: an escape cut
// at a chunk boundary, or a high surrogate whose pair has not arrived, waits
// for the next piece. A lone surrogate in a delta would make Codex reject the
// event.

const PREFIX = /^\s*\{\s*"input"\s*:\s*"/;
// Longest arguments prefix that can still turn into PREFIX; beyond it, give up.
const MAX_PREFIX = 256;
const SIMPLE_ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

export class CustomInputDecoder {
  // Raw text not yet decoded: the prefix while seeking it, then any cut
  // escape sequence.
  private pending = "";
  private state: "prefix" | "string" | "done" = "prefix";
  // A decoded high surrogate waiting for its low half.
  private high = "";

  // Feeds the next piece of the arguments; returns newly decoded input text.
  push(piece: string): string {
    if (this.state === "done" || !piece) return "";
    let raw = this.pending + piece;
    this.pending = "";
    if (this.state === "prefix") {
      const match = PREFIX.exec(raw);
      if (!match) {
        // Still possibly a prefix: wait. Otherwise not the expected shape.
        if (raw.length < MAX_PREFIX && couldStartPrefix(raw))
          this.pending = raw;
        else this.state = "done";
        return "";
      }
      this.state = "string";
      raw = raw.slice(match[0].length);
    }
    let out = "";
    let i = 0;
    while (i < raw.length) {
      const ch = raw[i]!;
      if (ch === '"') {
        this.state = "done";
        break;
      }
      if (ch !== "\\") {
        out += ch;
        i++;
        continue;
      }
      const kind = raw[i + 1];
      if (kind === undefined) {
        this.pending = raw.slice(i);
        break;
      }
      if (kind === "u") {
        const hex = raw.slice(i + 2, i + 6);
        if (hex.length < 4) {
          this.pending = raw.slice(i);
          break;
        }
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          this.state = "done";
          break;
        }
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
        continue;
      }
      const simple = SIMPLE_ESCAPES[kind];
      if (simple === undefined) {
        this.state = "done";
        break;
      }
      out += simple;
      i += 2;
    }
    return this.complete(out);
  }

  // Holds a trailing high surrogate back until its pair arrives; drops
  // surrogates that can never be paired.
  private complete(text: string): string {
    let value = this.high + text;
    this.high = "";
    const last = value.charCodeAt(value.length - 1);
    if (this.state !== "done" && last >= 0xd800 && last <= 0xdbff) {
      this.high = value.slice(-1);
      value = value.slice(0, -1);
    }
    return value.replace(
      /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g,
      "",
    );
  }
}

// Whether `raw` is a prefix of some text PREFIX matches.
function couldStartPrefix(raw: string): boolean {
  const compact = raw.replace(/\s+/g, "");
  return '{"input":"'.startsWith(compact);
}
