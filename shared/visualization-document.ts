import {
  parse,
  parseFragment,
  serializeOuter,
  type DefaultTreeAdapterMap,
} from "parse5";
import type { VisualizationState } from "./visualizations";

type Element = DefaultTreeAdapterMap["element"];
export type VisualAppearance = "light" | "dark";
export interface VisualizationSource {
  title: string;
  html: string;
  sourceFormat?: "fragment" | "document";
}
export interface VisualizationDocumentOptions {
  appearance?: VisualAppearance;
  standalone?: boolean;
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

// Tokens mirror docs/truex-design-spec.html and frontend/styles/v2/tokens.css.
// Kept pure so preview, reader and standalone export use identical preparation.
export const visualizationThemeCss = `/* Copied unedited from docs/truex-design-spec.html → Appendix (index.html:12–111, app.tsx:2651–2658).
   Single source of truth for color, type, radius, shadow. Do not add literal hex in components. */
/* Blue Brand System — light-mode-first.
   Primary blue #3691CD carries actions, focus and progress (white content on it).
   Pastel #BCDEE8 is the soft companion: signature, mist borders, glows (graphite content on it). */
:root {
  --brand-50: #F8FCFD; --brand-100: #F4FAFC; --brand-200: #EAF5F8; --brand-300: #D8EBF0;
  --brand-400: #BCDEE8; --brand-500: #3691CD; --brand-600: #2A7DB4; --brand-700: #226A9B;
  --bg: #FFFFFF;
  --surface: #FFFFFF;
  --surface-2: #FFFFFF;
  --surface-3: #F6F9FA;     /* soft surface */
  --line: #E3ECEF;
  --line-strong: #D8E0E4;
  --border-control: #D8E0E4;
  --ink: #1F2A30;           /* graphite */
  --ink-2: #5F6D73;         /* secondary */
  --ink-3: #849198;         /* muted */
  --ink-disabled: #B4BEC3;
  --accent: #3691CD;        /* primary action: buttons, active controls */
  --accent-2: #2A7DB4;      /* strong: hover, dots, progress, focus */
  --accent-hover: #2A7DB4;
  --accent-pressed: #226A9B;
  --accent-soft: #EAF5F8;   /* ice: selected + secondary */
  --accent-soft-2: #BCDEE8; /* pastel companion border */
  --signature: #BCDEE8;
  --accent-fg: #2A72A3;     /* blue text/icons, AA on white and ice */
  --accent-text: #2A72A3;
  --accent-ink: #1F2A30;    /* content on pastel fills */
  --on-accent: #FFFFFF;     /* content on #3691CD fills */
  --warn: #7D5D1D;
  --success-bg: #E7F4ED; --success-text: #35624E;
  --warning-bg: #FFF3D9; --warning-text: #7D5D1D;
  --error-bg: #FBE7E7;   --error-text: #8D4545;
  --info-bg: #EAF5F8;    --info-text: #2A72A3;
  --neutral-bg: #F6F9FA; --neutral-text: #5F6D73;
  --glow-1: rgb(188 222 232 / 60%);
  --glow-2: rgb(234 245 248 / 90%);
  --shadow-sm: 0 1px 2px rgb(31 42 48 / 5%);
  --shadow-md: 0 1px 2px rgb(31 42 48 / 4%), 0 8px 24px -8px rgb(31 42 48 / 10%);
  --shadow-lg: 0 2px 4px rgb(31 42 48 / 4%), 0 10px 35px rgb(31 42 48 / 8%);
  --radius: 16px;
  --font-sans: "Figtree", ui-sans-serif, system-ui, sans-serif;
  --font-display: "Figtree", ui-sans-serif, system-ui, sans-serif;
  --font-accent: "Newsreader", ui-serif, Georgia, serif;
  --font-mono: "JetBrains Mono", ui-monospace, monospace;
  --display-weight: 600; --display-track: -.035em;
  --accent-style: italic; --accent-weight: 400; --accent-scale: 1.04;
  color-scheme: light;
}
/* Dark theme is not in the brand system (light-mode-first); derived from graphite with #3691CD / #BCDEE8 accents. */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #171717; --surface: #171717; --surface-2: #171717; --surface-3: #242424;
    --line: #2A2A2A; --line-strong: #363636; --border-control: #404040;
    --ink: #EEF4F6; --ink-2: #B7C3C8; --ink-3: #8B999F; --ink-disabled: #4E5C62;
    --accent: #3691CD; --accent-2: #5AA8DC; --accent-hover: #2A7DB4; --accent-pressed: #226A9B;
    --accent-soft: #14283A; --accent-soft-2: #1F4461; --accent-fg: #BCDEE8; --accent-text: #BCDEE8; --accent-ink: #1F2A30; --on-accent: #FFFFFF;
    --warn: #E6C27A;
    --success-bg: #16291F; --success-text: #A8D8BE; --warning-bg: #2E2512; --warning-text: #E6C27A;
    --error-bg: #2F1A1A; --error-text: #EDB0B0; --info-bg: #14283A; --info-text: #BCDEE8;
    --neutral-bg: #242424; --neutral-text: #8B999F;
    --glow-1: rgb(54 145 205 / 16%); --glow-2: rgb(188 222 232 / 6%);
    --shadow-md: 0 1px 2px rgb(0 0 0 / 30%), 0 8px 24px -8px rgb(0 0 0 / 50%);
    --shadow-lg: 0 2px 4px rgb(0 0 0 / 30%), 0 24px 48px -16px rgb(0 0 0 / 70%);
    color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --bg: #171717; --surface: #171717; --surface-2: #171717; --surface-3: #242424;
  --line: #2A2A2A; --line-strong: #363636; --border-control: #404040;
  --ink: #EEF4F6; --ink-2: #B7C3C8; --ink-3: #8B999F; --ink-disabled: #4E5C62;
  --accent: #3691CD; --accent-2: #5AA8DC; --accent-hover: #2A7DB4; --accent-pressed: #226A9B;
  --accent-soft: #14283A; --accent-soft-2: #1F4461; --accent-fg: #BCDEE8; --accent-text: #BCDEE8; --accent-ink: #1F2A30; --on-accent: #FFFFFF;
  --warn: #E6C27A;
  --success-bg: #16291F; --success-text: #A8D8BE; --warning-bg: #2E2512; --warning-text: #E6C27A;
  --error-bg: #2F1A1A; --error-text: #EDB0B0; --info-bg: #14283A; --info-text: #BCDEE8;
  --neutral-bg: #242424; --neutral-text: #8B999F;
  --glow-1: rgb(54 145 205 / 16%); --glow-2: rgb(188 222 232 / 6%);
  --shadow-md: 0 1px 2px rgb(0 0 0 / 30%), 0 8px 24px -8px rgb(0 0 0 / 50%);
  --shadow-lg: 0 2px 4px rgb(0 0 0 / 30%), 0 24px 48px -16px rgb(0 0 0 / 70%);
  color-scheme: dark;
}
/* ---- Helper tones (validated: dataviz validate_palette.js, --pairs all, both modes) ---- */
:root { --tone-0: #2872b8; --tone-0-soft: #eef5fc; --tone-1: #0f7a55; --tone-1-soft: #e6f5ee; --tone-2: #b84a1b; --tone-2-soft: #fcece4; --tone-main: #6b6b6b; --tone-main-soft: #f0f0f0; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --tone-0: #3691cd; --tone-0-soft: #0f1f2c; --tone-1: #199e70; --tone-1-soft: #0e211a; --tone-2: #d95926; --tone-2-soft: #24120a; --tone-main: #8f8f8f; --tone-main-soft: #262626; } }
:root[data-theme="dark"] { --tone-0: #3691cd; --tone-0-soft: #0f1f2c; --tone-1: #199e70; --tone-1-soft: #0e211a; --tone-2: #d95926; --tone-2-soft: #24120a; --tone-main: #8f8f8f; --tone-main-soft: #262626; }

:root { --font-size-base:14px; --background:var(--bg); --foreground:var(--ink); --muted-foreground:var(--ink-2); --border:var(--line); --primary:var(--accent); --primary-foreground:var(--on-accent); --card:var(--surface); --card-foreground:var(--ink); --popover:var(--surface); --popover-foreground:var(--ink); --muted:var(--surface-3); --accent-foreground:var(--accent-fg); --secondary:var(--surface-3); --secondary-foreground:var(--ink); --input:var(--border-control); --ring:var(--accent-fg); --destructive:var(--error-text); --viz-series-1:var(--tone-0); --viz-series-2:var(--tone-1); --viz-series-3:var(--tone-2); --viz-series-4:var(--accent-fg); --viz-series-5:var(--warning-text); --viz-series-6:var(--ink-2); }
* { box-sizing:border-box; } body { margin:0; padding:12px; color:var(--foreground); background:var(--background); font:14px/1.5 var(--font-sans); overflow-wrap:anywhere; } h1,h2,h3 { font-weight:500; } svg,canvas,img { max-width:100%; } button,input,select,textarea { font:inherit; color:inherit; } button,.btn { cursor:pointer; } .btn { padding:6px 12px; border:1px solid var(--border); border-radius:6px; background:var(--background); } .btn-primary { background:var(--primary); color:var(--primary-foreground); } .form-control,.form-select { padding:6px; max-width:100%; border:1px solid var(--border); border-radius:4px; background:var(--background); } .form-range { max-width:100%; accent-color:var(--primary); } .viz-row,.viz-controls { display:flex; flex-wrap:wrap; gap:12px; align-items:center; } .viz-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr)); gap:12px; } .text-small { font-size:12px; } .text-muted { color:var(--muted-foreground); } .tabular-nums { font-variant-numeric:tabular-nums; } .sr-only { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); } :focus-visible { outline:2px solid var(--ring); outline-offset:2px; } @media(prefers-reduced-motion:reduce) { *,*::before,*::after { animation:none!important; transition:none!important; } }
`;

function rootElements(html: string, locations = false) {
  const document = parse(html, { sourceCodeLocationInfo: locations });
  const root = document.childNodes.find(
    (node): node is Element => "tagName" in node && node.tagName === "html",
  )!;
  const head = root.childNodes.find(
    (node): node is Element => "tagName" in node && node.tagName === "head",
  )!;
  const body = root.childNodes.find(
    (node): node is Element => "tagName" in node && node.tagName === "body",
  )!;
  return { root, head, body };
}

export const maximumVisualizationDepth = 128;
function assertDocumentDepth(root: Element) {
  const pending: {
    node: Element | DefaultTreeAdapterMap["documentFragment"];
    depth: number;
  }[] = [{ node: root, depth: 0 }];
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (depth > maximumVisualizationDepth)
      throw new Error("Visual source exceeds maximum nesting (128)");
    for (const child of node.childNodes) {
      if (!("tagName" in child)) continue;
      pending.push({ node: child, depth: depth + 1 });
      if ("content" in child)
        pending.push({
          node: child.content as DefaultTreeAdapterMap["documentFragment"],
          depth: depth + 1,
        });
    }
  }
}

// The parser distinguishes real document tags from lookalikes inside comments,
// JavaScript strings or templates; HTML error recovery alone is not validation.
export function validateVisualizationDocument(html: string): boolean {
  if (typeof html !== "string" || !html.trim()) return false;
  try {
    const { root, head, body } = rootElements(html, true);
    assertDocumentDepth(root);
    return [root, head, body].every(
      (node) =>
        !!node?.sourceCodeLocation?.startTag &&
        !!node?.sourceCodeLocation?.endTag,
    );
  } catch {
    return false;
  }
}

export function prepareVisualizationDocument(
  visual: VisualizationSource,
  saved: VisualizationState | null,
  options: VisualizationDocumentOptions = {},
): string {
  const { root, head } = rootElements(visual.html);
  assertDocumentDepth(root);
  // Remove source-controlled document policies/redirects and duplicate host
  // metadata. Everything executable is serialized only after our first CSP.
  const parents: (Element | DefaultTreeAdapterMap["documentFragment"])[] = [
    root,
  ];
  while (parents.length) {
    const parent = parents.pop()!;
    parent.childNodes = parent.childNodes.filter((node) => {
      if (!("tagName" in node)) return true;
      if (node.tagName === "base" || node.tagName === "title") return false;
      if (
        node.tagName === "meta" &&
        node.attrs.some(
          (attr) =>
            attr.name === "http-equiv" ||
            attr.name === "charset" ||
            (attr.name === "name" &&
              ["viewport", "referrer"].includes(attr.value.toLowerCase())),
        )
      )
        return false;
      parents.push(node);
      if ("content" in node)
        parents.push(node.content as DefaultTreeAdapterMap["documentFragment"]);
      return true;
    });
  }
  const appearance = options.appearance === "dark" ? "dark" : "light";
  root.attrs = root.attrs.filter((attr) => attr.name !== "data-theme");
  root.attrs.push({ name: "data-theme", value: appearance });
  const host =
    parseFragment(`<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${visualizationCsp}"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(visual.title)}</title><style>${visualizationThemeCss}</style>
<script>
(() => {
  let state = ${scriptJson(saved)};
  const send = (type, extra = {}) => parent.postMessage({ channel: "truex-visualization", type, ...extra }, "*");
  addEventListener("message", (event) => {
    const value = event.data;
    if (event.source !== parent || !value || typeof value !== "object" ||
        value.channel !== "truex-visualization" || value.type !== "theme" ||
        (value.appearance !== "light" && value.appearance !== "dark")) return;
    document.documentElement.dataset.theme = value.appearance;
    document.documentElement.style.colorScheme = value.appearance;
    dispatchEvent(new CustomEvent("truex:theme", { detail: { appearance: value.appearance } }));
  });
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
      if (${options.standalone === true}) {
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
    const resize = () => { const height = Math.ceil(Math.max(document.body.getBoundingClientRect().height, document.body.scrollHeight)); if (height !== previous) { previous = height; send("resize", { height }); } };
    new ResizeObserver(resize).observe(document.body); resize(); send("ready");
  });
})();
</script>`);
  for (const node of host.childNodes) node.parentNode = head;
  head.childNodes.unshift(...host.childNodes);
  return "<!doctype html>" + serializeOuter(root);
}

export function visualizationExport(
  visual: VisualizationSource,
  state: VisualizationState | null,
  appearance: VisualAppearance = "light",
): string {
  const source = prepareVisualizationDocument(visual, state, {
    standalone: true,
    appearance,
  });
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(visual.title)}</title><style>body{margin:0}iframe{border:0;width:100%;height:100vh}</style></head><body><iframe title="${escapeHtml(visual.title)}" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${escapeHtml(source)}"></iframe></body></html>`;
}
