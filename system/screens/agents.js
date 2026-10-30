/* agent team — behaviour. The robot artwork and pin geometry are carried over
   verbatim from the earlier study; everything chromatic now comes from the
   foundation. Pins read the signal / metal material from CSS custom properties
   (set in agents.css), so they follow theme with the rest of the page. */

/* data, as it would arrive from app.tsx, carrying the new creation fields:
   model, mcps, skills, knowledge (plus builtin). Two custom agents show "Yours". */
const AGENTS = [
  { id: "qlik", handle: "qlik", name: "Qlik Analyst", desc: "Dashboards, metrics, BI queries", look: 3, tint: "ice", builtin: true,
    model: "opus", mcps: ["qlik", "postgres"], skills: ["charts", "sql"], knowledge: ["Metrics handbook"] },
  { id: "research", handle: "research", name: "Researcher", desc: "Web research with citations", look: 4, tint: "mint", builtin: true,
    mcps: [], skills: ["research", "files"], knowledge: [] },
  { id: "writer", handle: "writer", name: "Writer", desc: "Docs, release notes, briefs", look: 1, tint: "butter", builtin: true,
    model: "sonnet", mcps: ["notion"], skills: ["docs", "release"], knowledge: ["House style guide"] },
  { id: "ops", handle: "ops", name: "Ops", desc: "Runbooks, tickets, on-call", look: 6, tint: "lilac", builtin: true,
    mcps: ["sentry", "jira", "slack"], skills: ["runbook"], knowledge: ["Incident archive"] },
  { id: "agent-1", handle: "designer", name: "Designer", desc: "UI reviews, specs, copy tweaks", look: 9, tint: "peach",
    model: "sonnet", mcps: ["figma"], skills: ["docs"], knowledge: [] },
  { id: "agent-2", handle: "support", name: "Support", desc: "Triage inbox, draft replies", look: 5, tint: "ice",
    model: "haiku", mcps: ["slack"], skills: ["files"], knowledge: [] },
];

/* robot looks — verbatim from app.tsx LOOKS (printed artwork) */
const LOOKS = [
  { body: "#3A4750", visor: "#1F2A30", glow: "#BCDEE8", face: "line" },
  { body: "#F4F7F8", visor: "#2B3F6B", glow: "#BCDEE8", face: "eyes", acc: "antenna" },
  { body: "#2E4470", visor: "#16213A", glow: "#BCDEE8", face: "line" },
  { body: "#D5DDE1", visor: "#2B3F6B", glow: "#BCDEE8", face: "happy", acc: "headphones", accColor: "#3691CD" },
  { body: "#D8C3A0", visor: "#3A4750", glow: "#EBCB8B", face: "line", acc: "cap", accColor: "#E07B6E" },
  { body: "#F4F7F8", visor: "#2B3F6B", glow: "#BCDEE8", face: "eyes", acc: "chef" },
  { body: "#F4F7F8", visor: "#3A4750", glow: "#EBCB8B", face: "eyes", acc: "hardhat", accColor: "#F2C94C" },
  { body: "#3A4750", visor: "#1F2A30", glow: "#F0B999", face: "happy", acc: "scarf", accColor: "#E07B6E" },
  { body: "#BFE3CF", visor: "#1F2A30", glow: "#A9D5BE", face: "eyes", acc: "antenna" },
  { body: "#CFC8EC", visor: "#2B3F6B", glow: "#C4BDE3", face: "happy", acc: "bow", accColor: "#F0A3B5" },
];
/* polaroid tints — the agent identity pastel (photo wash + frame). Printed artwork. */
const TINTS = [
  { id: "ice", bg: "#EAF5F8", dot: "#3691CD" }, { id: "mint", bg: "#E7F4ED", dot: "#A9D5BE" },
  { id: "butter", bg: "#FFF3D9", dot: "#EBCB8B" }, { id: "peach", bg: "#FBE9DD", dot: "#F0B999" },
  { id: "lilac", bg: "#EFEDF8", dot: "#C4BDE3" },
];
/* the new agent-creation catalogues (labels + accents from app.tsx) */
const SERVERS = {
  qlik: { label: "Qlik Sense", mono: "#3691CD" }, github: { label: "GitHub", mono: "#1F2A30" },
  linear: { label: "Linear", mono: "#5E6AD2" }, jira: { label: "Jira", mono: "#2A72A3" },
  notion: { label: "Notion", mono: "#5F6D73" }, slack: { label: "Slack", mono: "#8C4A86" },
  sentry: { label: "Sentry", mono: "#6B4FA0" }, postgres: { label: "Postgres", mono: "#33658A" },
  figma: { label: "Figma", mono: "#C0563F" },
};
const MODELS = { default: "opus 5.5", opus: "opus 5.5", sonnet: "sonnet 5.5", haiku: "haiku 4.5" };
const TILTS = [-4, 3, -2.5, 4.5, -3.5, 2, -1.5, 3.5];

const tintOf = id => TINTS.find(t => t.id === id) || TINTS[0];
/* Mix a hex toward white (amt > 0) or black (amt < 0); shades the robots. */
const tone = (hex, amt) => {
  const n = parseInt(hex.slice(1), 16), t = amt < 0 ? 0 : 255, k = Math.abs(amt);
  const ch = sh => Math.round(((n >> sh) & 255) + (t - ((n >> sh) & 255)) * k).toString(16).padStart(2, "0");
  return "#" + ch(16) + ch(8) + ch(0);
};
/* Caption ink: pick black or white against the frame tint. */
const inkOn = hex => {
  const n = parseInt(hex.slice(1), 16), c = s => ((n >> s) & 255) / 255;
  return .2126 * c(16) + .7152 * c(8) + .0722 * c(0) < .45 ? "#FFFFFF" : "#1F2A30";
};
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad2 = n => String(n).padStart(2, "0");

/* Robot — a string port of app.tsx's <Robot> (the graphics, unchanged). */
let uid = 0;
function robot(look) {
  const L = LOOKS[look] || LOOKS[0], id = "rb" + (++uid), u = n => `url(#${id}-${n})`;
  const edge = tone(L.body, -.45), acc = L.accColor || L.body, accEdge = tone(acc, -.4);
  const limb = `fill="${u("limb")}" stroke="${edge}" stroke-width="1.5"`;
  const accL = (fill = u("acc")) => `fill="${fill}" stroke="${accEdge}" stroke-width="1.4" stroke-linejoin="round"`;
  const face = { line: `<rect x="51" y="50" width="22" height="5.6" rx="2.8" fill="${L.glow}"/>`,
    eyes: `<circle cx="52" cy="53" r="4.1" fill="${L.glow}"/><circle cx="72" cy="53" r="4.1" fill="${L.glow}"/>`,
    happy: `<path d="M47 55.5q5-6.2 10 0M67 55.5q5-6.2 10 0" fill="none" stroke="${L.glow}" stroke-width="3.2" stroke-linecap="round"/>` }[L.face];
  const accs = {
    antenna: `<path d="M60 23V10" stroke="${edge}" stroke-width="3" stroke-linecap="round"/><rect x="54.5" y="20" width="11" height="4.5" rx="2.25" fill="${tone(L.body, -.2)}" stroke="${edge}" stroke-width="1.2"/><circle cx="60" cy="8.5" r="9" fill="${L.glow}" opacity=".28"/><circle cx="60" cy="8.5" r="5.2" fill="${L.glow}" stroke="${tone(L.glow, -.4)}" stroke-width="1.2"/><circle cx="58.3" cy="6.8" r="1.6" fill="#fff" opacity=".85"/>`,
    cap: `<path d="M80 33.5c10-1 21 0 27 3 2 1.2 1 4-1.5 4-8 0-17-1-26-2.5z" ${accL(tone(acc, -.1))}/><path d="M26 38C26 10 94 10 94 38c-10-3-58-3-68 0z" ${accL()}/><path d="M60 15v21" stroke="${accEdge}" stroke-opacity=".45" stroke-width="1.2"/><path d="M36 28c5-7 12-10 19-11" fill="none" stroke="#fff" stroke-opacity=".4" stroke-width="2.2" stroke-linecap="round"/><circle cx="60" cy="14.5" r="2.6" fill="${tone(acc, -.15)}" stroke="${accEdge}" stroke-width="1"/>`,
    hardhat: `<path d="M26 33C26 4 94 4 94 33z" ${accL()}/><rect x="55" y="7.5" width="10" height="25" rx="4" fill="${tone(acc, .3)}" stroke="${accEdge}" stroke-width="1.2"/><rect x="17" y="30" width="86" height="7" rx="3.5" ${accL(tone(acc, -.08))}/><path d="M34 24c3-7 9-11 16-13" fill="none" stroke="#fff" stroke-opacity=".45" stroke-width="2.2" stroke-linecap="round"/>`,
    chef: `<g fill="${u("chef")}"><circle cx="44" cy="18" r="10.5"/><circle cx="76" cy="18" r="10.5"/><circle cx="60" cy="13" r="12.5"/></g><path d="M41 11c2-2 5-3 8-3M56 5c2-1 5-1.4 7-1" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/><rect x="36" y="18" width="48" height="15" rx="5" fill="${u("chef")}" stroke="#B9C4CA" stroke-width="1.2"/><path d="M48 21v9M60 21v9M72 21v9" stroke="#B9C4CA" stroke-opacity=".7" stroke-width="1" stroke-linecap="round"/>`,
    headphones: `<path d="M22 54C22 10 98 10 98 54" fill="none" stroke="${tone(acc, -.4)}" stroke-width="7" stroke-linecap="round"/><path d="M22 54C22 10 98 10 98 54" fill="none" stroke="${tone(acc, .25)}" stroke-opacity=".6" stroke-width="2" stroke-linecap="round"/><rect x="13" y="43" width="17" height="27" rx="7.5" ${accL()}/><rect x="90" y="43" width="17" height="27" rx="7.5" ${accL()}/><path d="M17 49v10M94 49v10" stroke="#fff" stroke-opacity=".45" stroke-width="2" stroke-linecap="round"/>`,
    bow: `<path d="M78 20l-11-7c-2-1.2-4 .4-4 2.6v9c0 2.2 2.2 3.4 4 2.4z" ${accL()}/><path d="M78 20l11-7c2-1.2 4 .4 4 2.6v9c0 2.2-2.2 3.4-4 2.4z" ${accL()}/><circle cx="78" cy="20" r="3.6" ${accL(tone(acc, -.12))}/><path d="M66.5 16.5l3 1.8M89.5 16.5l-3 1.8" stroke="#fff" stroke-opacity=".5" stroke-width="1.6" stroke-linecap="round"/>`,
  };
  const scarf = L.acc === "scarf" ? `<path d="M72 79l3.5 21c.4 2.2 3.2 2.8 4.6 1.1L87 93l-5.5-15z" ${accL()}/><path d="M77 97l1.2 4M81 95.5l1.6 3.6" stroke="${accEdge}" stroke-width="1.2" stroke-linecap="round"/><path d="M25 71c20 8.5 50 8.5 70 0v9c-20 8.5-50 8.5-70 0z" ${accL()}/><path d="M31 75c16 5.5 42 5.5 58 0" fill="none" stroke="#fff" stroke-opacity=".35" stroke-width="1.6" stroke-linecap="round"/>` : "";
  return `<svg class="robot" viewBox="0 0 120 120" aria-hidden="true">
<defs>
<linearGradient id="${id}-body" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${tone(L.body, .38)}"/><stop offset=".55" stop-color="${L.body}"/><stop offset="1" stop-color="${tone(L.body, -.3)}"/></linearGradient>
<linearGradient id="${id}-limb" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${tone(L.body, -.06)}"/><stop offset="1" stop-color="${tone(L.body, -.34)}"/></linearGradient>
<radialGradient id="${id}-sheen" cx=".3" cy=".2" r=".6"><stop offset="0" stop-color="#fff" stop-opacity=".6"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
<linearGradient id="${id}-visor" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${tone(L.visor, .24)}"/><stop offset="1" stop-color="${tone(L.visor, -.38)}"/></linearGradient>
<radialGradient id="${id}-screen" cx=".5" cy=".55" r=".6"><stop offset="0" stop-color="${L.glow}" stop-opacity=".3"/><stop offset="1" stop-color="${L.glow}" stop-opacity="0"/></radialGradient>
<linearGradient id="${id}-acc" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${tone(acc, .32)}"/><stop offset="1" stop-color="${tone(acc, -.22)}"/></linearGradient>
<linearGradient id="${id}-chef" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#D6DEE2"/></linearGradient>
<radialGradient id="${id}-shadow"><stop offset="0" stop-color="#101820" stop-opacity=".3"/><stop offset="1" stop-color="#101820" stop-opacity="0"/></radialGradient>
<filter id="${id}-glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.8" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
</defs>
<ellipse cx="60" cy="109" rx="36" ry="6.5" fill="${u("shadow")}"/>
<rect x="13" y="50" width="20" height="38" rx="9" ${limb}/><rect x="37" y="82" width="19" height="25" rx="8.5" ${limb}/><rect x="64" y="82" width="19" height="25" rx="8.5" ${limb}/>
<path d="M41 101.5h11M68 101.5h11" stroke="#fff" stroke-opacity=".18" stroke-width="2" stroke-linecap="round"/>
<rect x="24" y="22" width="72" height="72" rx="31" fill="${u("body")}" stroke="${edge}" stroke-width="1.5"/>
<rect x="24" y="22" width="72" height="72" rx="31" fill="${u("sheen")}"/>
<path d="M90 46c3.6 10 3.4 24-2 34" fill="none" stroke="#fff" stroke-opacity=".24" stroke-width="3" stroke-linecap="round"/>
${L.acc !== "scarf" ? `<circle cx="73" cy="81" r="2.2" fill="${L.glow}" filter="${u("glow")}"/>` : ""}${scarf}
<rect x="35" y="36" width="54" height="33" rx="15" fill="${tone(L.visor, -.55)}"/>
<rect x="37.5" y="38.5" width="49" height="28" rx="12.5" fill="${u("visor")}"/>
<rect x="37.5" y="38.5" width="49" height="28" rx="12.5" fill="${u("screen")}"/>
<g filter="${u("glow")}">${face}</g>
${L.face === "eyes" ? `<circle cx="53.4" cy="51.6" r="1.2" fill="#fff"/><circle cx="73.4" cy="51.6" r="1.2" fill="#fff"/>` : ""}
<path d="M43.5 45c3-2.8 8-3.8 13-3.6" fill="none" stroke="#fff" stroke-opacity=".6" stroke-width="2.6" stroke-linecap="round"/>
<circle cx="80.5" cy="61" r="1.5" fill="#fff" fill-opacity=".35"/>
${accs[L.acc] || ""}
</svg>`;
}

/* ---- state + render -------------------------------------------------------- */
const state = { q: "", kind: "all", current: "qlik" };
const KINDS = [["all", "All"], ["yours", "Yours"], ["builtin", "Built-in"]];
const $ = id => document.getElementById(id);
const pencil = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>`;
const lock = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`;

/* the reach block: MCP server chips (with each server's catalogue accent dot) */
function reach(a) {
  const mcps = a.mcps || [];
  if (!mcps.length) return `<div class="reach"><span class="none">No servers connected</span></div>`;
  const chips = mcps.map(id => {
    const s = SERVERS[id] || { label: id, mono: "#637077" };
    return `<span class="srv"><span class="sd" style="--c:${s.mono}"></span>${esc(s.label)}</span>`;
  }).join("");
  return `<div class="reach">${chips}</div>`;
}
/* the mono foot line: model · N skills · N sources (sources only when present) */
function metaLine(a) {
  const skills = (a.skills || []).length, src = (a.knowledge || []).length;
  let s = `${MODELS[a.model || "default"]} · ${skills} ${skills === 1 ? "skill" : "skills"}`;
  if (src) s += ` · ${src} ${src === 1 ? "source" : "sources"}`;
  return s;
}

function render() {
  const needle = state.q.trim().toLowerCase();
  const shown = AGENTS.filter(a => (state.kind === "all" || (state.kind === "builtin") === !!a.builtin)
    && `${a.name} ${a.handle} ${a.desc}`.toLowerCase().includes(needle));
  const yours = AGENTS.filter(a => !a.builtin).length;
  $("sub").textContent = `${AGENTS.length} specialists · ${yours} built by you. Pin one to the chat, or build your own.`;
  $("pills").innerHTML = KINDS.map(([id, label]) =>
    `<button role="radio" aria-pressed="${state.kind === id}" aria-checked="${state.kind === id}" data-kind="${id}">${label}</button>`).join("");
  $("filter-tag").textContent = KINDS.find(k => k[0] === state.kind)[1];
  $("count").textContent = `${pad2(shown.length)}/${pad2(AGENTS.length)}`;
  $("count").setAttribute("aria-label", `${shown.length} of ${AGENTS.length} agents shown`);

  if (needle && !shown.length) {
    $("team").innerHTML = `<li class="empty"><strong>No agents match "${esc(state.q.trim())}"</strong><button class="tx-btn tx-sm" data-clear>Clear search</button></li>`;
    drawPins(); return;
  }
  const cards = shown.map((a, i) => {
    const t = tintOf(a.tint), live = a.id === state.current;
    return `<li class="card" data-id="${a.id}" data-live="${live}" style="--tint:${t.bg};--frame:${t.dot};--cap:${inkOn(t.dot)};--tilt:${TILTS[i % TILTS.length]}deg;--i:${i}">
      <span class="pin-anchor"></span>
      <div class="frame">
        <button class="photo" data-edit="${a.id}" aria-label="Edit ${esc(a.name)}">
          ${a.builtin ? `<span class="lock" aria-hidden="true">${lock}built-in</span>` : ""}
          ${robot(a.look)}
          <span class="edit-hint" aria-hidden="true">${pencil}Edit</span>
        </button>
        <div class="caption">${esc(a.name)}</div>
      </div>
      <div class="info">
        <div class="handle">@${esc(a.handle)}${live ? `<span class="tx-pill tx-pill-live tx-pill-sm"><span class="pulse" aria-hidden="true"></span>in chat</span>` : ""}${a.builtin ? `<span class="sr-only"> · built-in</span>` : ""}</div>
        <p class="desc">${esc(a.desc)}</p>
        ${reach(a)}
        <div class="foot">
          <span class="meta">${metaLine(a)}</span>
          <button class="tx-btn tx-sm" data-chat="${a.id}" ${live ? "disabled" : ""}>${live ? "Chatting" : "Chat"}</button>
        </div>
      </div>
    </li>`;
  });
  if (state.kind !== "builtin" && !needle) {
    cards.push(`<li class="card is-new" style="--tilt:${TILTS[shown.length % TILTS.length]}deg;--i:${shown.length}">
      <button class="frame" data-new>
        <span class="photo-empty"><span class="plus"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></span></span>
        <span class="caption" style="display:block">New agent</span>
      </button>
      <span class="note" aria-hidden="true">build your own
        <svg width="40" height="28" viewBox="0 0 46 30"><path d="M4 26c4-16 18-22 36-16M34 4l6 6-8 3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </span>
    </li>`);
  }
  $("team").innerHTML = cards.join("");
  drawPins();
}

/* A push-pin at the top of every card. The live card gets a signal pin; every
   idle card gets a neutral metal pin — signal is spent only on live work. The
   gradient stops read the foundation material from CSS custom properties. */
function drawPins() {
  const board = $("board").getBoundingClientRect();
  const pts = [...document.querySelectorAll(".card:not(.is-new)")].map(li => {
    const r = li.querySelector(".pin-anchor").getBoundingClientRect();
    return { x: r.left - board.left, y: r.top - board.top, live: li.dataset.live === "true" };
  });
  const pin = p => `<g transform="translate(${p.x} ${p.y})">
    <ellipse cx="4" cy="15" rx="5" ry="2" fill="var(--pb-pin-cast)"/>
    <path d="M1 2l2 12" stroke="var(--pb-pin-stem)" stroke-width="2" stroke-linecap="round"/>
    <circle cx="0" cy="0" r="10" fill="url(#pin-${p.live ? "live" : "idle"})"/>
    <circle cx="0" cy="0" r="10" fill="none" stroke="rgb(16 20 24 / 25%)"/>
    <ellipse cx="-3.5" cy="-3.5" rx="3.4" ry="2.2" fill="#fff" fill-opacity=".7" transform="rotate(-35 -3.5 -3.5)"/>
  </g>`;
  $("pins").innerHTML = `<defs>
    <radialGradient id="pin-live" cx=".35" cy=".3" r=".75"><stop offset="0" stop-color="var(--pb-live-hi)"/><stop offset=".45" stop-color="var(--pb-live)"/><stop offset="1" stop-color="var(--pb-live-lo)"/></radialGradient>
    <radialGradient id="pin-idle" cx=".35" cy=".3" r=".75"><stop offset="0" stop-color="var(--pb-metal-hi)"/><stop offset=".45" stop-color="var(--pb-metal)"/><stop offset="1" stop-color="var(--pb-metal-lo)"/></radialGradient>
  </defs>${pts.map(pin).join("")}`;
}

/* ---- events ---------------------------------------------------------------- */
let toastT;
const toast = msg => { const t = $("toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 1800); };
$("q").addEventListener("input", e => { state.q = e.target.value; render(); });
document.addEventListener("click", e => {
  const el = e.target.closest("[data-kind],[data-chat],[data-edit],[data-new],[data-clear]");
  if (!el) return;
  if (el.dataset.kind) { state.kind = el.dataset.kind; render(); }
  else if (el.dataset.chat) { state.current = el.dataset.chat; render(); toast(`Now chatting with @${AGENTS.find(a => a.id === el.dataset.chat).handle}`); }
  else if (el.dataset.edit) toast(`Opens AgentDialog for ${AGENTS.find(a => a.id === el.dataset.edit).name}`);
  else if (el.hasAttribute("data-new")) toast("Opens AgentDialog in create mode");
  else if (el.hasAttribute("data-clear")) { state.q = ""; $("q").value = ""; render(); }
});

/* Theme toggle — drive the foundation's data-theme / data-eff-theme and
   persist like the other screens, so color.css flips the whole page. */
$("theme").addEventListener("click", () => {
  const r = document.documentElement;
  const dark = r.dataset.effTheme === "dark";
  const next = dark ? "light" : "dark";
  r.dataset.theme = next;
  r.dataset.effTheme = next;
  try { localStorage.setItem("tx-sys-theme", next); } catch (e) {}
  requestAnimationFrame(drawPins);
});

new ResizeObserver(() => drawPins()).observe($("board"));
// the entrance animation moves cards; redraw once it settles, and again when fonts load
$("team").addEventListener("animationend", () => requestAnimationFrame(drawPins));
if (document.fonts) document.fonts.ready.then(drawPins);
render();
