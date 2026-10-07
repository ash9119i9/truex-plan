// Viewer-only entry point: keep the HTML parser out of ordinary chat loading.
import type {
  Visualization,
  VisualizationState,
} from "../../shared/visualizations";

export {
  visualizationCsp,
  visualizationExport,
  prepareVisualizationDocument,
} from "../../shared/visualization-document.ts";
import { prepareVisualizationDocument } from "../../shared/visualization-document.ts";
import type { VisualAppearance } from "../../shared/visualization-document.ts";
export function visualizationDocument(
  visual: Visualization,
  saved: VisualizationState | null,
  standalone = false,
  appearance: VisualAppearance = "light",
): string {
  return prepareVisualizationDocument(visual, saved, {
    standalone,
    appearance,
  });
}
