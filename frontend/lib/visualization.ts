import type {
  Visualization,
  VisualizationState,
} from "../../shared/visualizations";

export type VisualPart =
  { type: "markdown"; text: string } | { type: "visualization"; id: string };
// Only complete, standalone references outside code fences become active visuals.
export function splitVisualizations(
  text: string,
  streaming = false,
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
export {
  visualizationDocument,
  visualizationExport,
  visualizationCsp,
} from "../../shared/visualization-document.ts";

export function visualizationFrameHeight(
  visual: Visualization,
  width: number,
  reportedHeight?: number,
): number {
  const measured = visual.heights
    ?.filter(
      ([w, h]) => Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0,
    )
    .reduce<[number, number] | undefined>(
      (best, pair) =>
        !best || Math.abs(pair[0] - width) < Math.abs(best[0] - width)
          ? pair
          : best,
      undefined,
    );
  const initial = measured
    ? Math.min(measured[1], visual.height ?? Infinity)
    : 360;
  const candidate = Number.isFinite(reportedHeight)
    ? reportedHeight! + 4
    : initial;
  return Math.min(900, Math.max(160, Math.ceil(candidate)));
}
