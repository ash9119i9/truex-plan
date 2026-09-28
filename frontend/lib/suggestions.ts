// Follow-up questions the model appends to a final answer:
// [truex-suggestions] / "- question" lines / [/truex-suggestions]
const openMarker = "[truex-suggestions]";
const open = /^ {0,3}\[truex-suggestions\][ \t]*$/;
const close = /^ {0,3}\[\/truex-suggestions\][ \t]*$/;
const item = /^\s*(?:[-*•]|\d+[.)])\s+(.+?)\s*$/;
const maxSuggestions = 3;
const maxLength = 160;

export interface SuggestionSplit {
  body: string;
  suggestions: string[];
}

function clean(line: string): string | null {
  const match = line.match(item);
  if (!match) return null;
  const text = match[1]
    .replace(/^["'`*_]+|["'`*_]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text && text.length <= maxLength ? text : null;
}

export function splitSuggestions(
  text: string,
  streaming = false,
): SuggestionSplit {
  const lines = text.split(/(?<=\n)/);
  let fence = "",
    start = -1;
  for (const [index, line] of lines.entries()) {
    const delimiter = line.trim().match(/^(`{3,}|~{3,})/);
    if (delimiter) {
      if (!fence) fence = delimiter[1];
      else if (
        delimiter[1][0] === fence[0] &&
        delimiter[1].length >= fence.length
      )
        fence = "";
      continue;
    }
    if (!fence && open.test(line.replace(/\r?\n$/, ""))) start = index;
  }
  if (start < 0) {
    // Hide a marker that is still arriving.
    const tail = lines.at(-1)?.trim() ?? "";
    if (
      streaming &&
      !fence &&
      tail.startsWith("[") &&
      openMarker.startsWith(tail)
    )
      return { body: lines.slice(0, -1).join(""), suggestions: [] };
    return { body: text, suggestions: [] };
  }
  const end = lines.findIndex(
    (line, index) => index > start && close.test(line.replace(/\r?\n$/, "")),
  );
  const before = lines.slice(0, start).join("").trimEnd();
  // An unfinished block (still streaming or interrupted) stays hidden.
  if (end < 0) return { body: before, suggestions: [] };
  const block = lines.slice(start + 1, end);
  const after = lines.slice(end + 1).join("");
  const seen = new Set<string>();
  const suggestions: string[] = [];
  for (const line of block) {
    const value = clean(line);
    if (!value || seen.has(value.toLowerCase())) continue;
    seen.add(value.toLowerCase());
    suggestions.push(value);
    if (suggestions.length === maxSuggestions) break;
  }
  return {
    body: after.trim() ? `${before}\n\n${after.trimStart()}` : before,
    suggestions: streaming ? [] : suggestions,
  };
}

export function stripSuggestions(text: string, streaming = false): string {
  return splitSuggestions(text, streaming).body;
}
