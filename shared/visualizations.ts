export const visualizationIdPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export interface Visualization {
  id: string;
  title: string;
  description: string;
  html: string;
  mode: "inline" | "wide";
  heights?: Array<[number, number]>;
  height?: number;
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
