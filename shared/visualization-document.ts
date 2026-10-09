import type { Visualization, VisualizationState } from "./visualizations";

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

export type VisualizationAppearance = "light" | "dark";
export const isAppearance = (
  value: unknown,
): value is VisualizationAppearance => value === "light" || value === "dark";

// `appearance` is the host's current theme. Omitted, the page is light, as it
// always was. The host can change it later with a "theme" message.
export function visualizationDocument(
  visual: Visualization,
  saved: VisualizationState | null,
  standalone = false,
  appearance: VisualizationAppearance = "light",
): string {
  // Only ever the two known values reach the stylesheet.
  const scheme = appearance === "dark" ? "dark" : "light";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${visualizationCsp}"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(visual.title)}</title>
<style>
:root { color-scheme:${scheme}; --font-size-base:14px; --background:light-dark(#faf9f6,#20231f); --foreground:light-dark(#282a25,#f0f0e8); --muted-foreground:light-dark(#62685c,#bfc4b8); --border:light-dark(#dedfd6,#454b40); --primary:light-dark(#34492b,#d7e3ce); --primary-foreground:light-dark(#fff,#20231f); --card:var(--background); --card-foreground:var(--foreground); --popover:var(--background); --popover-foreground:var(--foreground); --muted:light-dark(#eeeee8,#32372e); --accent:var(--muted); --accent-foreground:var(--foreground); --secondary:var(--muted); --secondary-foreground:var(--foreground); --input:var(--border); --ring:var(--primary); --destructive:light-dark(#a82525,#ff9e9e); --viz-series-1:light-dark(#4d6244,#a6c493); --viz-series-2:light-dark(#376b98,#8abce7); --viz-series-3:light-dark(#a5642e,#e8b179); --viz-series-4:light-dark(#7751a2,#c9a3f0); --viz-series-5:light-dark(#a04069,#ee98bc); --viz-series-6:light-dark(#2f7c79,#8accc8); --surface:light-dark(#fff,#292d26); --surface-2:light-dark(#f1f0ea,#30352c); --positive:light-dark(#2f7a3e,#8fd19e); --negative:light-dark(#b3261e,#ff9e9e); --radius:10px; --shadow:light-dark(0 1px 2px rgb(40 42 37 / .08),none); }
* { box-sizing:border-box; } body { margin:0; padding:12px; color:var(--foreground); background:var(--background); font:var(--font-size-base)/1.5 system-ui,sans-serif; overflow-wrap:break-word; } h1,h2,h3 { font-weight:500; } svg,canvas,img { max-width:100%; } button,input,select,textarea { font:inherit; color:inherit; } button,.btn { cursor:pointer; } .btn { padding:6px 12px; border:1px solid var(--border); border-radius:6px; background:var(--background); } .btn-primary { background:var(--primary); color:var(--primary-foreground); } .form-control,.form-select { padding:6px; max-width:100%; border:1px solid var(--border); border-radius:4px; background:var(--background); } .form-range { max-width:100%; accent-color:var(--primary); } .viz-row,.viz-controls { display:flex; flex-wrap:wrap; gap:12px; align-items:center; } .viz-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr)); gap:12px; } .text-small { font-size:12px; } .text-muted { color:var(--muted-foreground); } .tabular-nums { font-variant-numeric:tabular-nums; } .viz-title { margin:0 0 2px; font-size:16px; font-weight:600; letter-spacing:-.01em; }
.viz-eyebrow { font-size:11px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; color:var(--muted-foreground); }
.viz-chip { display:inline-flex; align-items:center; gap:6px; padding:2px 8px; border:1px solid var(--border); border-radius:999px; font-size:11px; color:var(--muted-foreground); background:var(--surface-2); }
.viz-card { padding:12px 14px; border:1px solid var(--border); border-radius:var(--radius); background:var(--surface); box-shadow:var(--shadow); }
.viz-kpi { display:flex; flex-direction:column; gap:2px; padding:10px 12px; border:1px solid var(--border); border-radius:var(--radius); background:var(--surface); box-shadow:var(--shadow); transition:border-color .15s; }
.viz-kpi:hover { border-color:var(--primary); }
.viz-kpi-label { font-size:11px; font-weight:600; letter-spacing:.05em; text-transform:uppercase; color:var(--muted-foreground); }
.viz-kpi-value { white-space:nowrap; overflow-wrap:normal; font-size:22px; font-weight:600; line-height:1.15; letter-spacing:-.02em; font-variant-numeric:tabular-nums; }
.viz-kpi-delta { font-size:12px; font-variant-numeric:tabular-nums; }
.viz-up { color:var(--positive); }
.viz-down { color:var(--negative); }
.viz-legend { display:flex; flex-wrap:wrap; gap:6px 14px; font-size:12px; color:var(--muted-foreground); }
.viz-legend > * { display:inline-flex; align-items:center; gap:6px; }
.viz-swatch { width:10px; height:10px; border-radius:3px; background:var(--c,currentColor); flex:none; }
.viz-split { display:grid; gap:12px; grid-template-columns:1fr; align-items:start; }
@media(min-width:640px) { .viz-split { grid-template-columns:minmax(220px,300px) 1fr; } }
.viz-tooltip { position:absolute; z-index:5; pointer-events:none; padding:6px 8px; border:1px solid var(--border); border-radius:8px; background:var(--surface); box-shadow:0 4px 14px rgb(0 0 0 / .18); font-size:12px; font-variant-numeric:tabular-nums; }
.btn,.form-control,.form-select { transition:background-color .15s,border-color .15s,transform .1s; }
.btn:hover { background:var(--surface-2); border-color:var(--muted-foreground); }
.btn:active { transform:translateY(1px); }
.btn-primary:hover { background:var(--primary); filter:brightness(1.08); }
.form-control:focus,.form-select:focus { border-color:var(--ring); }
input[type=range] { cursor:pointer; }
@keyframes viz-in { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:none; } }
body,.viz-fade { animation:viz-in .3s ease-out both; }
.sr-only { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); } :focus-visible { outline:2px solid var(--ring); outline-offset:3px; } @media(prefers-reduced-motion:reduce) { *,*::before,*::after { animation:none!important; transition:none!important; } }
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
  addEventListener("message", (event) => {
    const data = event.data;
    if (event.source === parent && data && data.channel === "truex-visualization" && data.type === "theme" && (data.appearance === "light" || data.appearance === "dark")) document.documentElement.style.colorScheme = data.appearance;
  });
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
