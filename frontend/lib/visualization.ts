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
const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
const scriptJson = (value: unknown) =>
  JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
export const visualizationCsp =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

export function visualizationDocument(
  visual: Visualization,
  saved: VisualizationState | null,
  standalone = false,
): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${visualizationCsp}"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(visual.title)}</title>
<style>
:root { color-scheme:light; --font-size-base:14px; --background:light-dark(#faf9f6,#20231f); --foreground:light-dark(#282a25,#f0f0e8); --muted-foreground:light-dark(#62685c,#bfc4b8); --border:light-dark(#dedfd6,#454b40); --primary:light-dark(#34492b,#d7e3ce); --primary-foreground:light-dark(#fff,#20231f); --card:var(--background); --card-foreground:var(--foreground); --popover:var(--background); --popover-foreground:var(--foreground); --muted:light-dark(#eeeee8,#32372e); --accent:var(--muted); --accent-foreground:var(--foreground); --secondary:var(--muted); --secondary-foreground:var(--foreground); --input:var(--border); --ring:var(--primary); --destructive:light-dark(#a82525,#ff9e9e); --viz-series-1:light-dark(#4d6244,#a6c493); --viz-series-2:light-dark(#376b98,#8abce7); --viz-series-3:light-dark(#a5642e,#e8b179); --viz-series-4:light-dark(#7751a2,#c9a3f0); --viz-series-5:light-dark(#a04069,#ee98bc); --viz-series-6:light-dark(#2f7c79,#8accc8); }
* { box-sizing:border-box; } body { margin:0; padding:12px; color:var(--foreground); background:var(--background); font:var(--font-size-base)/1.5 system-ui,sans-serif; overflow-wrap:anywhere; } h1,h2,h3 { font-weight:500; } svg,canvas,img { max-width:100%; } button,input,select,textarea { font:inherit; color:inherit; } button,.btn { cursor:pointer; } .btn { padding:6px 12px; border:1px solid var(--border); border-radius:6px; background:var(--background); } .btn-primary { background:var(--primary); color:var(--primary-foreground); } .form-control,.form-select { padding:6px; max-width:100%; border:1px solid var(--border); border-radius:4px; background:var(--background); } .form-range { max-width:100%; accent-color:var(--primary); } .viz-row,.viz-controls { display:flex; flex-wrap:wrap; gap:12px; align-items:center; } .viz-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr)); gap:12px; } .text-small { font-size:12px; } .text-muted { color:var(--muted-foreground); } .tabular-nums { font-variant-numeric:tabular-nums; } .sr-only { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); } :focus-visible { outline:2px solid var(--ring); outline-offset:3px; } @media(prefers-reduced-motion:reduce) { *,*::before,*::after { animation:none!important; transition:none!important; } }
</style>
<script>
(() => {
  let state = ${scriptJson(saved)};
  const send = (type, extra = {}) => parent.postMessage({ channel: "truex-visualization", type, ...extra }, "*");
  const api = {
    get widgetState() { return state; },
    async setWidgetState(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid state");
      const next = { modelContent: value.modelContent ?? null, privateContent: value.privateContent ?? null };
      if (new TextEncoder().encode(JSON.stringify(next)).length > 16384) throw new Error("State exceeds 16 KiB");
      state = next; send("state", { state });
    },
    async sendFollowUpMessage(value) {
      if (!value || typeof value.prompt !== "string" || !value.prompt.trim() || value.prompt.length > 2000) throw new Error("Invalid follow-up");
      if (${standalone}) {
        let note = document.getElementById("truex-export-followup");
        if (!note) { note = document.createElement("p"); note.id = "truex-export-followup"; note.setAttribute("role", "status"); document.body.append(note); }
        note.textContent = "Copy this question into Truex: " + value.prompt;
        return;
      }
      send("followup", { prompt: value.prompt, title: typeof value.title === "string" ? value.title.slice(0,250) : "Ask about this visual" });
    }
  };
  Object.defineProperty(window, "openai", { value: Object.freeze(api), writable:false, configurable:false });
  addEventListener("error", () => send("error"));
  addEventListener("unhandledrejection", () => send("error"));
  addEventListener("DOMContentLoaded", () => {
    let previous = 0;
    const resize = () => { const height = Math.ceil(document.body.getBoundingClientRect().height); if (height !== previous) { previous = height; send("resize", { height }); } };
    new ResizeObserver(resize).observe(document.body); resize(); send("ready");
  });
})();
</script></head><body>${visual.html}</body></html>`;
}

export function visualizationExport(
  visual: Visualization,
  state: VisualizationState | null,
) {
  const source = visualizationDocument(visual, state, true);
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(visual.title)}</title><style>body{margin:0}iframe{border:0;width:100%;height:100vh}</style></head><body><iframe title="${escapeHtml(visual.title)}" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${escapeHtml(source)}"></iframe></body></html>`;
}
