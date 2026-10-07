export const visualizationIdPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export interface Visualization {
  id: string;
  title: string;
  description: string;
  html: string;
  mode: "inline" | "wide";
  sourceFormat?: "fragment" | "document";
  height?: number;
}
/** Public association only; executable source is fetched through the authorized viewer. */
export interface VisualAttachment {
  id: string;
  title: string;
  description: string;
  turnId: string;
  callId: string;
  height: number;
}
export function isVisualAttachment(value: unknown): value is VisualAttachment {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const visual = value as Record<string, unknown>;
  return (
    typeof visual.id === "string" &&
    visualizationIdPattern.test(visual.id) &&
    typeof visual.title === "string" &&
    !!visual.title.trim() &&
    visual.title.length <= 120 &&
    typeof visual.description === "string" &&
    visual.description.length <= 1000 &&
    typeof visual.turnId === "string" &&
    !!visual.turnId &&
    visual.turnId.length <= 200 &&
    typeof visual.callId === "string" &&
    !!visual.callId &&
    visual.callId.length <= 200 &&
    typeof visual.height === "number" &&
    Number.isInteger(visual.height) &&
    visual.height >= 160 &&
    visual.height <= 900
  );
}
export interface VisualizationState {
  modelContent: unknown;
  privateContent: unknown;
}
export const visualizationInstructions = `
Use create_visualization when requested, or when an interactive chart, diagram, simulation, comparison or explainer materially improves understanding. Ordinary answers and Markdown tables do not need a visual. This is an in-conversation feature, not project development.
Supply a concise title, a plain-text accessible description, and a self-contained HTML fragment with its CSS and JavaScript. Use native SVG/canvas/HTML; there are no preloaded libraries, icons, or CDN resources. Do not include document/head/body tags, external resources, requests, navigation, forms that submit, embedded frames, or host file paths. Keep all data inline, label hypothetical data, and use actual user/source data when available. Provide sources in the surrounding answer.
Use a unique root ID, scope styles/selectors to it, responsive geometry and ResizeObserver, label axes/units, and provide keyboard-accessible native controls and text alternatives. Support 320px widths; avoid fixed outer dimensions and viewport-height layouts. Use host theme variables --background, --foreground, --muted-foreground, --border and --viz-series-1 through --viz-series-6, and the supplied .btn, .form-control, .form-range, .form-select, .viz-row, .viz-grid, .text-small and .sr-only utilities. Prefer one clear visual, minimal controls, and no decorative panels. Honor prefers-reduced-motion.
Optional host bridge: read window.openai.widgetState (an object with modelContent/privateContent or null), and call window.openai.setWidgetState({modelContent,privateContent}) after meaningful interactions to restore choices on this browser (maximum 16 KiB). State alone never sends a model request. Never store secrets. window.openai.sendFollowUpMessage({prompt,title}) proposes a question outside the visual; the user chooses whether to add it to their message. Other Codex helpers such as Tweak and lucide are not available.
The tool returns a reference [truex-visualization:ID]. Include that exact reference on its own line in the answer to display the visual, with only a short explanation around it. Never invent IDs or output HTML in the answer. To revise, read the saved visual with read_conversation_file and call create_visualization with sourceId; this creates a new version and preserves the original. Use mode wide only for complex comparisons or full application mockups; users can expand any visual.`;

export function visualReplyInstructions(previewAvailable: boolean) {
  return `
Use html_render for an interactive chart, diagram, simulation, comparison or explainer when requested or when it materially improves understanding. Ordinary answers and Markdown tables do not need a visual. Build a complete HTML document with explicit html, head and body elements, inline CSS/JavaScript and inline data. This is an in-conversation reply, not project development. Native HTML/SVG/canvas is available; remote libraries, requests, navigation, form submission, embedded frames and host files are blocked. Do not use CDN resources. Label hypothetical data and use actual supplied data when available; cite sources in the surrounding answer.
${previewAvailable ? "Before publishing, call html_preview, inspect its screenshot and console errors, repair issues and preview again if necessary (at most two repair attempts). Check phone width for complex layouts. A failed or unavailable preview does not prevent publishing a usable document, but accurately mention that visual validation was unavailable." : "HTML preview is not configured in this conversation. Publish a usable visual and accurately note that browser validation was unavailable; do not claim to have inspected a screenshot."}
Call html_render with the finished document, a concise title, frame height between 160 and 900 pixels and a plain-text accessible description. Success attaches the visual automatically before your text reply. Do not output HTML or a visualization reference marker. Never claim publication before the tool succeeds. To revise, read the saved visual with read_conversation_file and publish a new version with sourceId; the original remains available. create_visualization remains available for legacy fragment/reference workflows.
Use responsive geometry, meaningful axis/unit labels, keyboard-accessible native controls, text alternatives and reduced motion. Support 320px widths; avoid viewport-height layouts and fixed outer dimensions. Prefer a clear visual and minimal controls. Use host theme variables --background, --foreground, --muted-foreground, --border and --viz-series-1 through --viz-series-6 and the .btn, .form-control, .form-range, .form-select, .viz-row, .viz-grid, .text-small and .sr-only utilities. The app controls light/dark appearance.
Optional host bridge: read window.openai.widgetState and call window.openai.setWidgetState({modelContent,privateContent}) after meaningful interactions to restore choices on this browser (maximum 16 KiB). Never store secrets. State changes do not send model requests. window.openai.sendFollowUpMessage({prompt,title}) proposes a question outside the visual; the user decides whether to add it to their message. Other Codex helpers are unavailable.`;
}
