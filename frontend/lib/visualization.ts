import type { VisualizationState } from "../../shared/visualizations";

export type VisualPart =
  { type: "markdown"; text: string } | { type: "visualization"; id: string };
// Only complete, standalone references outside code fences become active visuals.
export function splitVisualizations(
  text: string,
  streaming = false,
  published: readonly string[] = [],
): VisualPart[] {
  const parts: VisualPart[] = [];
  let buffer = "",
    fence = "";
  const lines = text.split(/(?<=\n)/);
  for (const [index, line] of lines.entries()) {
    const delimiter = line.trim().match(/^(`{3,}|~{3,})/);
    if (delimiter) {
      if (!fence) fence = delimiter[1];
      else if (
        delimiter[1][0] === fence[0] &&
        delimiter[1].length >= fence.length
      )
        fence = "";
    }
    const match =
      !fence &&
      line.match(
        /^ {0,3}\[truex-visualization:([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\][ \t]*(?:\r?\n)?$/,
      );
    if (match) {
      if (buffer) parts.push({ type: "markdown", text: buffer });
      buffer = "";
      if (!published.includes(match[1]))
        parts.push({ type: "visualization", id: match[1] });
    } else if (!(
      streaming &&
      !fence &&
      index === lines.length - 1 &&
      /^\[truex-visualization:[^\]]*$/.test(line.trim())
    ))
      buffer += line;
  }
  if (buffer) parts.push({ type: "markdown", text: buffer });
  return parts;
}
export function validWidgetState(value: unknown): value is VisualizationState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.some((key) => !["modelContent", "privateContent"].includes(key)))
    return false;
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length <= 16384;
  } catch {
    return false;
  }
}
