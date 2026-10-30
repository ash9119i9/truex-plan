/* activity panel · tab 1 · business activity & traces
   One turn, rendered from data shaped like a real run: eight steps across
   Qlik, Postgres, the web and Jira, one of them done by a helper, one of them
   an approval. Six states share the same data and differ only in where the
   turn is: working, needs you, done, a step failed, a step declined, stopped.
   Stop and steer happen in the chat (chat.js); the panel only records them. */

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ic = (id, cls = "tx-ic") => `<svg class="${cls}" aria-hidden="true"><use href="#i-${id}"/></svg>`;
const MASK = '<span class="mask">masked</span>';

const ASK = {
  q: "Why did EMEA revenue drop in Q3? Pull the numbers from the revenue dashboard, check whether currency played a part, and log a ticket for Finance.",
  at: "2:41 PM",
};

/* k = kind (drives the icon), t / r / p = past, present, planned wording */
const STEPS = [
  { k: "spark", t: "Understood the request", r: "Understanding the request", p: "Understand the request", s: "Planned 8 steps", d: 1.2,
    did: "Broke the ask into eight steps across three systems", result: "Plan ready",
    tool: "planner.plan", input: "8 steps · 3 systems" },
  { k: "chart", t: "Read the revenue dashboard", r: "Reading the revenue dashboard", p: "Read the revenue dashboard", sys: "Qlik", mark: "Q", s: "Revenue by region · 3 sheets", d: 2.4,
    did: "Read three sheets, filtered to EMEA", touched: ["Revenue by region", "Q3 trend", "FX impact"], result: "12 measures read",
    tool: "qlik.get_sheet_data", input: '{ app: "Revenue FY26", sheets: 3, filter: region = "EMEA" }' },
  { k: "db", t: "Pulled Q2 and Q3 orders", r: "Pulling Q2 and Q3 orders", p: "Pull Q2 and Q3 orders", sys: "Postgres", mark: "P", s: "sales.orders · 18,240 rows", d: 3.1,
    did: "Ran one read-only query on the sales warehouse", touched: ["sales.orders", "sales.regions"], result: "18,240 rows returned",
    tool: "postgres.query", input: `SELECT country, quarter, SUM(net)\nFROM sales.orders\nWHERE region = ${MASK}\nGROUP BY 1, 2` },
  { k: "spark", t: "Compared Q2 with Q3 by country", r: "Comparing Q2 with Q3 by country", p: "Compare Q2 with Q3 by country", s: "Germany and France explain 71% of the drop", d: 1.8,
    did: "Compared each country quarter on quarter", result: "Germany −9.4%, France −6.1%; rest flat",
    tool: "analysis.compare", input: "2 quarters · 14 countries" },
  { k: "globe", t: "Checked currency news", r: "Checking currency news", p: "Check currency news", sys: "Web", mark: "W", s: "4 pages kept", d: 4.6,
    did: "Ran two searches and read the strongest pages", touched: ["reuters.com", "ft.com", "gartner.com", "destatis.de"], result: "4 sources kept, 7 dropped",
    cut: "2 pages read, none kept", cutDid: "Ran two searches, stopped while reading pages",
    tool: "web.search × 2", input: '"EUR USD Q3 2026", "EMEA demand Q3 2026"' },
  { k: "hand", t: "Asked you to approve a ticket", r: "Waiting for your approval", p: "Ask you to approve a ticket", sys: "Jira", mark: "J", s: "Create a ticket in FIN", d: 6.8,
    did: "Asked before changing anything in Jira", result: "Approved by you",
    tool: "approval.request", input: "jira.create_issue · FIN" },
  { k: "pen", t: "Created the Finance ticket", r: "Creating the Finance ticket", p: "Create the Finance ticket", sys: "Jira", mark: "J", s: "FIN-482 · EMEA Q3 revenue variance", d: 0.9,
    did: "Created one issue in the FIN project", touched: ["FIN-482"], result: "Created FIN-482",
    tool: "jira.create_issue", input: `{ project: "FIN", summary: "EMEA Q3 revenue variance", assignee: ${MASK} }` },
  { k: "text", t: "Wrote the answer", r: "Writing the answer", p: "Write the answer", s: "312 words · 2 charts · 6 citations", d: 2.2,
    did: "Wrote the reply with charts and citations", result: "Answer delivered",
    tool: "compose.reply", input: "6 citations · 2 charts" },
];

const SOURCES = [
  { m: "Q", n: "Revenue by region", k: "Qlik · dashboard, 3 sheets", step: 1 },
  { m: "P", n: "sales.orders", k: "Postgres · 18,240 rows", step: 2 },
  { m: "W", n: "Euro slides as ECB cuts again", k: "reuters.com · 14 Oct", step: 4 },
  { m: "W", n: "European factory demand cools", k: "ft.com · 9 Oct", step: 4 },
  { m: "W", n: "Q3 EMEA software spend tracker", k: "gartner.com · 2 Oct", step: 4 },
  { m: "W", n: "Industrial output, September", k: "destatis.de · 7 Oct", step: 4 },
];

/* steer: a note you typed in the chat while the turn waited on the approval
   (step index `at`). The agent reads it when the turn continues. */
const STEER = {
  at: 5,
  text: "Add the EMEA controller as a watcher, and put the currency effect in the ticket summary.",
  effect: {
    needs: "Waits with the turn. It's read when you answer the request in chat.",
    done: "Read when the turn continued. Followed in step 7.",
    issue: "Read when the turn continued. Step 7 failed, so it wasn't applied.",
    declined: "Read when the turn continued. Not applied: you declined the ticket.",
  },
  relay: { needs: "Read when you answer", done: "Followed in step 7", issue: "Not applied, step 7 failed", declined: "Not applied, you declined" },
};
const noted = () => ui.steer && ui.state in STEER.effect;

/* who worked on the turn. Agents and their reach mirror the agent model in
   app.tsx (model, mcps, skills, knowledge, builtin). steps = step indexes a
   server, skill or source was used in; an agent's steps are the ones it ran. */
const CREW = {
  solo: {
    lead: {
      name: "Finance Analyst", ini: "FA", id: "main", handle: "finance", builtin: false,
      desc: "Revenue variance, forecasts and finance tickets",
      model: "Claude Opus 5.5", version: 7, saved: "3 Oct", by: "you",
      steps: [0, 1, 2, 3, 4, 5, 6, 7],
      role: "Planned the turn, did every step, wrote the answer",
      instructions: "You support Finance on revenue questions. Start from the governed Qlik apps, then confirm totals in the warehouse. Explain a variance country by country before you summarise a region. Cite the sheet or table every number came from. Never change a system without asking first.",
      limits: [["Changes", "Asks you before any write"], ["Postgres", "Read-only, analytics schema"], ["Budget", "$5 cap per turn"]],
      servers: [
        { m: "Q", n: "Qlik Sense", s: "Apps, sheets, measures", perm: "Read-only", steps: [1] },
        { m: "P", n: "Postgres", s: "Analytics warehouse", perm: "Read-only", steps: [2] },
        { m: "J", n: "Jira", s: "Tickets and boards", perm: "Can change, asks first", steps: [5, 6] },
      ],
      skills: [
        { n: "SQL analyst", s: "Write and explain queries", steps: [2] },
        { n: "Web research", s: "Search, read and cite", steps: [4] },
        { n: "Chart builder", s: "Turn tables into charts", steps: [7] },
      ],
      knowledge: [
        { n: "Metrics handbook", s: "Workspace document", steps: [3] },
        { n: "FX policy.pdf", s: "Uploaded file", steps: [] },
      ],
    },
    helpers: [],
  },
  team: {
    lead: {
      name: "Qlik Analyst", ini: "QA", id: "main", handle: "qlik", builtin: true,
      desc: "Dashboards, metrics, BI queries",
      model: "Claude Opus 5.5", version: 12, saved: "18 Sep", by: "Workspace admin",
      steps: [0, 1, 2, 3, 7],
      role: "Planned the turn, read the numbers, wrote the answer",
      instructions: "You answer questions from the governed Qlik apps. Confirm totals against the warehouse before you report them. Hand web research and ticketing to the specialists who own them. Cite the sheet or table for every number.",
      limits: [["Changes", "None of its own; hands writes to Ops"], ["Postgres", "Read-only, analytics schema"], ["Helpers", "Researcher, Ops"]],
      servers: [
        { m: "Q", n: "Qlik Sense", s: "Apps, sheets, measures", perm: "Read-only", steps: [1] },
        { m: "P", n: "Postgres", s: "Analytics warehouse", perm: "Read-only", steps: [2] },
      ],
      skills: [
        { n: "SQL analyst", s: "Write and explain queries", steps: [2] },
        { n: "Chart builder", s: "Turn tables into charts", steps: [7] },
      ],
      knowledge: [{ n: "Metrics handbook", s: "Workspace document", steps: [3] }],
    },
    helpers: [
      {
        name: "Researcher", ini: "Re", id: "2", handle: "research", builtin: true,
        model: "Claude Sonnet 5.5", steps: [4],
        task: "Find what moved the euro and EMEA demand in Q3",
        asked: "Find what moved EUR/USD and EMEA demand in Q3 2026. Keep sources from the last 30 days and cite each one.",
        ret: {
          live: "Working. 2 searches run, pages still being read.",
          done: "4 sources. The euro fell 3.1% against the dollar after two ECB cuts; factory demand cooled in Germany.",
          stopped: "Stopped by you after 2 pages. Nothing was kept.",
        },
        servers: [],
        skills: [{ n: "Web research", s: "Search, read and cite", steps: [4] }, { n: "PDF & files", s: "Read documents", steps: [] }],
        knowledge: [],
      },
      {
        name: "Ops", ini: "Op", id: "5", handle: "ops", builtin: true,
        model: "Claude Sonnet 5.5", steps: [5, 6],
        task: "Open a Finance ticket for the variance",
        asked: "Open a FIN ticket for the EMEA Q3 revenue variance, assigned to Finance Ops. Ask the person before you create it.",
        ret: {
          live: "Not started. Starts when Researcher hands back.",
          needs: "Waiting for your approval before it creates anything.",
          done: "Created FIN-482, assigned to Finance Ops.",
          issue: "Couldn't create the ticket: no permission in FIN.",
          declined: "Created nothing. You declined.",
          stopped: "Never started. You stopped the turn before the hand-off.",
        },
        servers: [
          { m: "J", n: "Jira", s: "Tickets and boards", perm: "Can change, asks first", steps: [5, 6] },
          { m: "S", n: "Sentry", s: "Errors and releases", perm: "Read-only", steps: [] },
          { m: "S", n: "Slack", s: "Channels and messages", perm: "Can post, asks first", steps: [] },
        ],
        skills: [{ n: "Runbooks", s: "Incident playbooks", steps: [] }],
        knowledge: [{ n: "Incident archive", s: "Workspace folder", steps: [] }],
      },
    ],
  },
};
const crew = () => CREW[ui.crew];
const byOf = (i) => crew().helpers.find((h) => h.steps.includes(i));

/* where the turn is, per state: one status per step */
const PLAN = {
  live:     ["done", "done", "done", "done", "run", "next", "next", "next"],
  needs:    ["done", "done", "done", "done", "done", "wait", "next", "next"],
  done:     ["done", "done", "done", "done", "done", "done", "done", "done"],
  issue:    ["done", "done", "done", "done", "done", "done", "fail", "done"],
  declined: ["done", "done", "done", "done", "done", "decl", "skip", "done"],
  stopped:  ["done", "done", "done", "done", "stop", "skip", "skip", "skip"],
};

const ui = {
  state: "live",
  crew: "team",
  steer: true, // demo: you added a note while the turn waited
  pick: null, // the agent the Sub-agents tab shows; null = follow the work
  instr: false,
  tab: "activity",
  tech: false,
  open: new Set(),
  fopen: new Set(["csv"]),
  moreSrc: false,
  elapsed: 0, // seconds on the live / waiting step
};

const fmt = (s) => {
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60), r = Math.round(s % 60);
  return `${m}m ${String(r).padStart(2, "0")}s`;
};
const stat = () => PLAN[ui.state];
const liveIdx = () => stat().findIndex((x) => x === "run" || x === "wait");
const stopIdx = () => stat().indexOf("stop");
const timed = (x) => x === "done" || x === "fail" || x === "run" || x === "wait" || x === "decl" || x === "stop";
const durOf = (i) => {
  const x = stat()[i];
  if (x === "run" || x === "wait") return ui.elapsed;
  if (x === "fail") return 1.4;
  if (x === "decl") return 5.2;
  if (x === "stop") return 2.9;
  return STEPS[i].d;
};
const cutTitle = (x) => `Stopped while ${x.r.charAt(0).toLowerCase()}${x.r.slice(1)}`;
const skipText = () => (ui.state === "stopped" ? "Didn't run · you stopped the turn" : "Skipped, not approved");
const total = () => stat().reduce((a, x, i) => a + (timed(x) ? durOf(i) : 0), 0);
const startOf = (i) => stat().slice(0, i).reduce((a, x, j) => a + (timed(x) ? durOf(j) : 0), 0);

/* ---------- 01 · the ask ---------------------------------------------------- */
function vAsk() {
  const s = ui.state, n = STEPS.length;
  const pill = {
    live: `<span class="tx-pill tx-pill-live"><span class="tx-spin"></span>Working</span>`,
    needs: `<span class="tx-pill tx-pill-warn">${ic("hand")}Needs your approval</span>`,
    done: `<span class="tx-pill tx-pill-ok">${ic("check")}Done</span>`,
    issue: `<span class="tx-pill tx-pill-warn">${ic("alert")}Done, 1 step failed</span>`,
    declined: `<span class="tx-pill tx-pill-ok">${ic("check")}Done</span>`,
    stopped: `<span class="tx-pill tx-pill-line">${ic("stop")}Stopped by you</span>`,
  }[s];
  const at = liveIdx(), cut = stopIdx();
  const where = at > -1
    ? `<span>Step <b class="num">${at + 1}</b> of <b class="num">${n}</b></span>`
    : cut > -1 ? `<span>At step <b class="num">${cut + 1}</b> of <b class="num">${n}</b></span>`
    : s === "declined" ? `<span><b class="num">1</b> declined</span>` : `<span><b class="num">${n}</b> steps</span>`;
  const note = noted() ? `<span><b class="num">1</b> note from you</span>` : "";
  return `
    <section class="sec" aria-label="Request">
      <div class="ask-when t-micro"><span>You asked · ${ASK.at}</span><span>${esc(crew().lead.name)}</span></div>
      <p class="ask-q">${esc(ASK.q)}</p>
      <div class="ask-status">${pill}<span class="ask-facts">${where}${note}<span><b class="num" id="tick-total">${fmt(total())}</b>${at > -1 ? " so far" : ""}</span></span></div>
    </section>`;
}

/* ---------- 02 · waiting on you --------------------------------------------- */
/* The panel only reports. Approvals, retries and every other decision live in
   the chat; this notice says what is pending and where to act on it. */
function vAttn() {
  if (ui.state === "needs") return `
    <section class="sec" aria-label="Waiting on you">
      <div class="attn" role="status" aria-labelledby="attn-h">
        <span class="attn-ic">${ic("hand")}</span>
        <div><h3 id="attn-h">Waiting for your approval in the chat</h3>
          <p>It asked before creating a Jira ticket. Nothing is created until you answer there.</p></div>
        <dl><dt>Project</dt><dd>FIN · Finance</dd><dt>Title</dt><dd>EMEA Q3 revenue variance</dd><dt>Assignee</dt><dd>Finance Ops</dd></dl>
        ${noted() ? `<p class="attn-note">${ic("chat", "tx-ic tx-ic-sm")}<span>You added a note to this turn. It's read when you answer.</span></p>` : ""}
        <div class="attn-act">
          <button class="tx-btn tx-ghost tx-sm" type="button" data-act="to-chat">${ic("chat", "tx-ic tx-ic-sm")}Show in chat</button>
          <span class="wait num">Waiting <span id="tick-wait">${fmt(ui.elapsed)}</span></span>
        </div>
        <p class="attn-hint">Answer, add a note, or stop the turn from the chat.</p>
      </div>
    </section>`;
  if (ui.state === "stopped") {
    const cut = stopIdx(), x = STEPS[cut];
    return `
    <section class="sec" aria-label="Stopped">
      <div class="attn is-line" role="status" aria-labelledby="attn-h">
        <span class="attn-ic">${ic("stop")}</span>
        <div><h3 id="attn-h">You stopped this turn at step ${cut + 1}</h3>
          <p>It stopped while ${esc(x.r.toLowerCase())}, after ${fmt(durOf(cut))}. Steps 1 to ${cut} finished and are kept below. Nothing was changed in any system, and no answer was written.</p></div>
        <dl><dt>Finished</dt><dd>${cut} of ${STEPS.length} steps</dd><dt>Cut off</dt><dd>${esc(x.t)} · ${esc(x.cut)}</dd><dt>Didn't run</dt><dd>Steps ${cut + 2} to ${STEPS.length}, including the Jira ticket</dd></dl>
        <div class="attn-act">
          <button class="tx-btn tx-ghost tx-sm" type="button" data-act="to-chat">${ic("chat", "tx-ic tx-ic-sm")}Show in chat</button>
        </div>
      </div>
    </section>`;
  }
  if (ui.state === "issue") return `
    <section class="sec" aria-label="Step failed">
      <div class="attn is-bad" role="status" aria-labelledby="attn-h">
        <span class="attn-ic">${ic("alert")}</span>
        <div><h3 id="attn-h">The Finance ticket wasn't created</h3>
          <p>Jira refused: this agent can't create issues in FIN. The answer was still written and says so. You can retry from the chat.</p></div>
        <div class="attn-act">
          <button class="tx-btn tx-ghost tx-sm" type="button" data-act="open-fail">Open trace</button>
          <button class="tx-btn tx-ghost tx-sm" type="button" data-act="to-chat">${ic("chat", "tx-ic tx-ic-sm")}Show in chat</button>
        </div>
      </div>
    </section>`;
  return "";
}

/* ---------- 03 · footprint: read kept apart from changed -------------------- */
function vReach() {
  const st = stat();
  const reads = STEPS.map((x, i) => ({ ...x, i, st: st[i] }))
    .filter((x) => ["chart", "db", "globe"].includes(x.k) && (x.st === "done" || x.st === "run" || x.st === "stop"));
  const readRows = reads.length
    ? reads.map((x) => `<div class="sys"><span class="mono-mark">${x.mark}</span><span class="sys-name">${x.sys}</span><span class="sys-what">${esc(x.st === "stop" ? x.cut : x.s)}</span>${x.st === "run" ? '<span class="tx-dot tx-dot-live" title="Reading now"></span>' : ""}</div>`).join("")
    : `<div class="reach-none">Nothing yet</div>`;

  const chg = {
    live: `<div class="reach-none">${ic("shield")}Nothing changed so far</div>`,
    needs: `<div class="reach-none is-warn">${ic("hand")}Nothing yet. 1 change waits for you in chat</div>`,
    done: `<div class="chg"><div class="sys"><span class="mono-mark">J</span><span class="sys-name">Jira</span><span class="sys-what">Created FIN-482</span></div>
             <div class="chg-diff"><span>FIN tickets</span><s class="num">41</s>→<ins class="num">42</ins></div></div>`,
    issue: `<div class="reach-none is-bad">${ic("alert")}Nothing. The one change failed</div>`,
    declined: `<div class="reach-none">${ic("shield")}Nothing. You declined the change</div>`,
    stopped: `<div class="reach-none">${ic("shield")}Nothing. You stopped it before the Jira step</div>`,
  }[ui.state];

  return `
    <section class="sec" aria-label="Footprint">
      <div class="sec-h"><span class="t-micro">Footprint</span><span class="sec-meta">Read-only unless listed under Changed</span></div>
      <div class="reach">
        <div class="reach-row"><span class="reach-k">${ic("eye", "tx-ic tx-ic-sm")}Read</span><div class="reach-v">${readRows}</div></div>
        <div class="reach-row"><span class="reach-k">${ic("pen", "tx-ic tx-ic-sm")}Changed</span><div class="reach-v">${chg}</div></div>
      </div>
    </section>`;
}

/* ---------- 04 · steps on one time scale ------------------------------------ */
function vWaterfall() {
  const st = stat(), at = liveIdx();
  const segs = st.map((x, i) => {
    if (!timed(x)) return "";
    const cls = { run: "is-run", wait: "is-wait", fail: "is-fail", decl: "is-skip", stop: "is-stop" }[x] || "";
    return `<span class="wf-seg ${cls}" id="seg-${i}" data-i="${i}" style="--d:${durOf(i).toFixed(2)}" title="${esc(STEPS[i].t)} · ${fmt(durOf(i))}"></span>`;
  }).join("");
  return `
    <div class="wf" aria-hidden="true">
      <div class="wf-bar" id="wf">${segs}</div>
      <div class="wf-axis"><span>0s</span><span id="tick-axis">${fmt(total())}${at > -1 ? " so far" : ""}</span></div>
    </div>`;
}

function stepSub(x, s, i) {
  const parts = [];
  if (x.sys) parts.push(`<span class="st-sys">${x.sys}</span>`);
  const by = byOf(i);
  if (by && s !== "next") parts.push(`<span class="st-by" style="--id:var(--id-${by.id});--id-ink:var(--id-${by.id}-ink)"><span class="tx-dot"></span>${by.name}</span>`);
  if (s === "fail") parts.push(`<span class="st-err">Jira refused · no permission in FIN</span>`);
  else if (s === "wait") parts.push(`<span class="st-wait">Waiting for you in chat</span>`);
  else if (s === "decl") parts.push(`<span>You declined</span>`);
  else if (s === "stop") parts.push(`<span>You pressed Stop · ${esc(x.cut)}</span>`);
  else if (s === "skip") parts.push(`<span>${skipText()}</span>`);
  else if (s !== "next") parts.push(`<span>${esc(x.s)}</span>`);
  return parts.join('<span class="sep">·</span>');
}

function trace(x, s, i) {
  const res = {
    fail: `<span class="bad">Refused · 403, no create permission in FIN</span>`,
    decl: `<span class="warn">Declined by you</span>`,
    stop: `<span>Stopped by you · ${esc(x.cut)}</span>`,
    run: `<span>In progress</span>`,
    wait: `<span class="warn">Waiting for you</span>`,
  }[s] || `<span class="ok">${esc(x.result)}</span>`;
  const touched = x.touched && s !== "stop" ? `<dt>Touched</dt><dd><ul>${x.touched.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></dd>` : "";
  const rw = x.k === "pen" ? "Write" : x.k === "hand" ? "Asks first" : x.sys ? "Read-only" : "No system";
  // the step that acted on your note says so
  const fromYou = noted() && i === STEER.at + 1 && s === "done" ? `<dt>Your note</dt><dd>Followed · watcher added, currency effect in the summary</dd>` : "";
  const tech = ui.tech ? `
    <dl class="tr-tech">
      <dt>Tool</dt><dd>${esc(x.tool)}</dd>
      <dt>Input</dt><dd><code>${x.input.includes('class="mask"') ? x.input : esc(x.input)}</code></dd>
      <dt>Span</dt><dd>sp_${(0x3a10 + i * 0x2b7).toString(16)}</dd>
    </dl>` : "";
  return `
    <div class="tr" id="tr-${i}">
      <dl>
        <dt>Did</dt><dd>${esc(s === "stop" ? x.cutDid : x.did)}</dd>
        ${x.sys ? `<dt>System</dt><dd>${x.sys} · ${rw}</dd>` : ""}
        ${touched}
        <dt>Started</dt><dd class="num">+${fmt(startOf(i))}</dd>
        <dt>Took</dt><dd class="num">${s === "run" || s === "wait" ? `<span data-tick="dur">${fmt(ui.elapsed)}</span>` : fmt(durOf(i))}</dd>
        <dt>Result</dt><dd>${res}</dd>
        ${fromYou}
      </dl>
      ${tech}
    </div>`;
}

function vSteer() {
  return `
    <li class="st is-you">
      <div class="st-row">
        <span class="node">${ic("chat")}</span>
        <span class="st-main">
          <span class="st-t">You added a note</span>
          <span class="you-q">${esc(STEER.text)}</span>
          <span class="st-s">Steer · from the chat<span class="sep">·</span>${esc(STEER.effect[ui.state])}</span>
        </span>
        <span class="st-r"><span class="st-d">2:43 PM</span></span>
      </div>
    </li>`;
}

function vSteps() {
  const st = stat(), done = st.filter((x) => x !== "next" && x !== "skip").length;
  const rows = STEPS.map((x, i) => {
    const s = st[i];
    const cls = { run: "is-run", wait: "is-wait", fail: "is-fail", next: "is-next", skip: "is-skip", decl: "is-wait", stop: "is-stop" }[s] || "";
    const title = s === "next" || s === "skip" ? x.p : s === "run" || s === "wait" ? x.r : s === "decl" ? "You declined the ticket" : s === "stop" ? cutTitle(x) : x.t;
    const icon = s === "fail" ? "x" : s === "decl" || s === "skip" ? "ban" : s === "stop" ? "stop" : x.k;
    const open = ui.open.has(i) && s !== "next" && s !== "skip";
    const dur = s === "next" || s === "skip" ? "" : s === "run" || s === "wait" ? `<span id="tick-step">${fmt(ui.elapsed)}</span>` : fmt(durOf(i));
    const inner = `
      <span class="node">${ic(icon)}</span>
      <span class="st-main"><span class="st-t${s === "run" ? " tx-shimmer" : ""}">${esc(title)}</span><span class="st-s">${stepSub(x, s, i)}</span></span>
      <span class="st-r"><span class="st-d">${dur}</span>${ic("chev", "tx-ic tx-ic-sm st-chev")}</span>`;
    const row = s === "next" || s === "skip"
      ? `<div class="st-row">${inner}</div>`
      : `<button class="st-row" type="button" data-step="${i}" aria-expanded="${open}" aria-controls="tr-${i}">${inner}</button>`;
    return `<li class="st ${cls}${open ? " is-open" : ""}" data-i="${i}">${row}${open ? trace(x, s, i) : ""}</li>${noted() && i === STEER.at ? vSteer() : ""}`;
  }).join("");
  return `
    <section class="sec" aria-label="Steps">
      <div class="sec-h">
        <span class="t-micro">Steps <span class="num">${done}/${STEPS.length}</span></span>
        <div class="tx-seg tx-seg-sm" role="group" aria-label="Detail level">
          <button type="button" data-tech="0" aria-pressed="${!ui.tech}">Plain</button>
          <button type="button" data-tech="1" aria-pressed="${ui.tech}">Technical</button>
        </div>
      </div>
      ${vWaterfall()}
      <ol class="tl" id="tl">${rows}</ol>
    </section>`;
}

/* ---------- 05 · sources ---------------------------------------------------- */
function vSources() {
  const st = stat();
  const have = SOURCES.filter((x) => st[x.step] === "done");
  const live = liveIdx() > -1 && ui.state === "live";
  const shown = ui.moreSrc ? have : have.slice(0, 4);
  const list = have.length
    ? `<ul class="src">${shown.map((x) => `
        <li><button class="src-row" type="button" data-src="${x.step}">
          <span class="mono-mark">${x.m}</span>
          <span><span class="src-n">${esc(x.n)}</span><span class="src-k">${esc(x.k)}</span></span>
          <span class="src-step">Step ${x.step + 1}</span>
        </button></li>`).join("")}</ul>
       ${have.length > 4 ? `<button class="tx-btn tx-ghost tx-xs src-more" type="button" data-act="more-src">${ui.moreSrc ? "Show fewer" : `Show ${have.length - 4} more`}</button>` : ""}`
    : `<p class="src-empty">No sources yet.</p>`;
  return `
    <section class="sec" aria-label="Sources">
      <div class="sec-h"><span class="t-micro">${ui.state === "stopped" ? "Read before you stopped it" : "Answer built from"}</span><span class="sec-meta"><span class="num">${have.length}</span> ${live ? "so far" : "sources"}</span></div>
      ${list}
      ${ui.state === "stopped" ? `<p class="fl-idle">${ic("stop", "tx-ic tx-ic-sm")}No answer was written. The web pages it had opened weren't kept.</p>` : ""}
    </section>`;
}

/* ---------- tab 2 · agent, or sub-agents when helpers were spawned ---------- */
const usedSt = (x) => x && x !== "next" && x !== "skip";
const avatar = (a, cls = "") => `<span class="ava ${cls}" style="--a:var(--id-${a.id});--a-soft:var(--id-${a.id}-soft);--a-ink:var(--id-${a.id}-ink)" aria-hidden="true">${a.ini}</span>`;
const stepRefs = (ids) => ids.map((i) => `<button class="tx-chip tx-chip-ref" type="button" data-goto="${i}" aria-label="Open step ${i + 1} in Activity">Step ${i + 1}</button>`).join("");
const reachOf = (a) => [...a.servers, ...a.skills, ...a.knowledge];

/* one server, skill or source the agent may use, and whether it did */
function capRow(c, kind) {
  const st = stat();
  const used = c.steps.filter((i) => usedSt(st[i]));
  const planned = c.steps.some((i) => st[i] === "next");
  const mark = kind === "server"
    ? `<span class="mono-mark">${c.m}</span>`
    : `<span class="cap-ic">${ic(kind === "skill" ? "spark" : "book")}</span>`;
  const right = used.length ? `<span class="cap-refs">${stepRefs(used)}</span>`
    : `<span class="cap-off">${planned ? "Planned" : "Not used"}</span>`;
  const perm = c.perm ? `<span class="cap-perm${c.perm.startsWith("Can") ? " is-w" : ""}">${c.perm}</span><span class="sep">·</span>` : "";
  return `<li class="cap${used.length ? "" : " is-off"}">${mark}<span class="cap-main"><span class="cap-n">${esc(c.n)}</span><span class="cap-s">${perm}${esc(c.s)}</span></span>${right}</li>`;
}

function capGroups(a) {
  const g = [["Servers", a.servers, "server"], ["Skills", a.skills, "skill"], ["Knowledge", a.knowledge, "know"]];
  return g.map(([h, list, k]) => `
    <div class="cap-g">
      <p class="cap-h t-micro">${h}</p>
      ${list.length ? `<ul class="caps">${list.map((c) => capRow(c, k)).join("")}</ul>` : `<p class="cap-none">None connected</p>`}
    </div>`).join("");
}

function usedCount(a) {
  const st = stat(), all = reachOf(a);
  return [all.filter((c) => c.steps.some((i) => usedSt(st[i]))).length, all.length];
}

function instructions(a) {
  return `
    <div class="instr${ui.instr ? " is-open" : ""}">
      <p class="instr-t" id="instr-t">${esc(a.instructions)}</p>
      <button class="tx-btn tx-ghost tx-xs" type="button" data-act="instr" aria-expanded="${ui.instr}" aria-controls="instr-t">${ui.instr ? "Show less" : "Show all"}</button>
    </div>`;
}

/* -- one agent --------------------------------------------------------------- */
function vAgentSolo() {
  const a = crew().lead, [u, n] = usedCount(a);
  return `
    <section class="sec" aria-label="Agent">
      <div class="who">
        ${avatar(a, "ava-lg")}
        <div class="who-main">
          <h3 class="who-n">${esc(a.name)}<span class="tx-pill tx-pill-line tx-pill-sm">${a.builtin ? "Built-in" : "Yours"}</span></h3>
          <p class="who-d">${esc(a.desc)}</p>
          <p class="who-m">@${a.handle}<span class="sep">·</span>${a.model}</p>
        </div>
      </div>
    </section>
    <section class="sec" aria-label="Reach this turn">
      <div class="sec-h"><span class="t-micro">Allowed, and used this turn</span><span class="sec-meta">Used <span class="num">${u}</span> of <span class="num">${n}</span></span></div>
      ${capGroups(a)}
    </section>
    <section class="sec" aria-label="Rules">
      <div class="sec-h"><span class="t-micro">Rules it worked under</span></div>
      ${instructions(a)}
      <dl class="lim">${a.limits.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
    </section>
    ${vSnap(a)}`;
}

function vSnap(a) {
  return `
    <section class="sec" aria-label="Setup">
      <div class="snap">
        ${ic("clock", "tx-ic tx-ic-sm")}
        <span class="snap-t">Ran on version <b class="num">${a.version}</b>, saved ${a.saved} by ${a.by}</span>
        <span class="snap-ok">${ic("check", "tx-ic tx-ic-sm")}Unchanged since</span>
      </div>
    </section>`;
}

/* -- lead + helpers ---------------------------------------------------------- */
function agentStatus(a, isLead) {
  const st = a.steps.map((i) => stat()[i]);
  if (st.includes("run")) return ["live", "Working"];
  if (st.includes("wait")) return ["warn", "Needs you"];
  if (st.includes("fail")) return ["bad", "Failed"];
  if (st.includes("decl")) return ["line", "Stopped"];
  if (ui.state === "stopped") return st.every((x) => x === "skip") ? ["line", "Didn't start"] : ["line", "Stopped"];
  if (isLead && liveIdx() > -1) return ["line", "Waiting"];
  if (st.every((x) => x === "next")) return ["line", "Queued"];
  return ["ok", "Done"];
}
const agentTime = (a) => a.steps.reduce((t, i) => t + (timed(stat()[i]) ? durOf(i) : 0), 0);
const pillFor = ([k, t]) => {
  const icon = { live: '<span class="tx-spin"></span>', ok: ic("check"), warn: ic("hand"), bad: ic("alert") }[k] || "";
  return `<span class="tx-pill tx-pill-sm tx-pill-${k}">${icon}${t}</span>`;
};
const idStyle = (a) => `--a:var(--id-${a.id});--a-soft:var(--id-${a.id}-soft);--a-ink:var(--id-${a.id}-ink)`;
const agentOf = (k) => (k === "lead" ? crew().lead : crew().helpers[+k]);
const keyOf = (a) => (a === crew().lead ? "lead" : String(crew().helpers.indexOf(a)));
const writes = (a) => a.servers.some((x) => x.perm.startsWith("Can") && x.steps.length);

/* the agent the panel is showing: the one you picked, else whoever is live
   or blocked, else the lead */
function picked() {
  if (ui.pick && agentOf(ui.pick)) return ui.pick;
  const k = crew().helpers.findIndex((h) => h.steps.some((i) => ["run", "wait", "fail"].includes(stat()[i])));
  return k > -1 ? String(k) : "lead";
}

/* -- crew: one card per agent, its status and its share of the turn ---------- */
function vCrew() {
  const c = crew(), all = [c.lead, ...c.helpers], pk = picked();
  const cards = all.map((a) => {
    const k = keyOf(a), [tone, label] = agentStatus(a, k === "lead");
    return `
      <button class="cc${k === pk ? " is-picked" : ""}" type="button" data-pick="${k}" aria-pressed="${k === pk}" style="${idStyle(a)}">
        <span class="cc-top">${avatar(a, "ava-sm")}<span class="cc-role">${k === "lead" ? "Lead" : "Helper"}</span>${writes(a) ? `<span class="cc-w" title="Can change a system">${ic("pen", "tx-ic tx-ic-sm")}</span>` : ""}</span>
        <span class="cc-n">${esc(a.name)}</span>
        <span class="cc-s is-${tone}"><span class="cc-dot"></span>${label}</span>
        <span class="cc-bar" aria-hidden="true"><span data-share="${k}"></span></span>
        <span class="cc-f"><span class="num" data-agent-time="${k}">${fmt(agentTime(a))}</span><span class="sep">·</span><span class="num">${a.steps.length}</span> step${a.steps.length > 1 ? "s" : ""}</span>
      </button>`;
  }).join("");
  const outs = relayEvents().filter((e) => e.t === "out" && e.s === "done").length;
  return `
    <section class="sec" aria-label="Crew">
      <div class="sec-h"><span class="t-micro">Crew</span><span class="sec-meta"><span class="num">${outs}</span> of <span class="num">${c.helpers.length}</span> hand-offs made</span></div>
      <div class="crew-g" style="--n:${all.length}" role="group" aria-label="Pick an agent to see its brief">${cards}</div>
    </section>`;
}

/* -- relay: the turn as a branch graph. The lead is the spine; each helper
   branches off where it was handed work and merges back where it returned. */
function relayEvents() {
  const st = stat(), ev = [];
  let cur = null;
  const close = (h) => {
    const s = h.steps.map((i) => st[i]);
    const open = s.some((x) => x === "run" || x === "wait" || x === "next");
    ev.push({ t: "back", a: h, s: open ? "next" : s.every((x) => x === "skip") ? "skip" : s.includes("stop") ? "stop" : s.includes("fail") ? "fail" : s.includes("decl") ? "decl" : "done" });
  };
  STEPS.forEach((x, i) => {
    const h = byOf(i) || null;
    if (h !== cur) {
      if (cur) close(cur);
      if (h) { const f = st[h.steps[0]]; ev.push({ t: "out", a: h, s: f === "next" || f === "skip" ? f : "done" }); }
      cur = h;
    }
    ev.push({ t: "step", i, a: h || crew().lead, s: st[i] });
    // your note joins the turn on the lane of whoever holds the paused work
    if (noted() && i === STEER.at) ev.push({ t: "note", a: h || crew().lead, s: "done" });
  });
  if (cur) close(cur);
  return ev;
}

function relayRow(e) {
  const k = keyOf(e.a), lead = crew().lead, pend = e.s === "next" || e.s === "skip";
  const cls = `rl rl-${e.t} is-${e.s}`;
  const attrs = `data-own="${k}" style="${idStyle(e.a)}"`;
  if (e.t === "note") return `
    <li class="${cls}" ${attrs}>
      <div class="rl-row">
        <span class="rl-pin"></span>
        <span class="rl-main"><span class="rl-t">${ic("chat", "tx-ic tx-ic-sm rl-ic is-you")}<span>You added a note</span></span><span class="rl-s">Steer<span class="sep">·</span>${esc(STEER.relay[ui.state])}</span></span>
        <span class="rl-d">2:43 PM</span>
      </div>
    </li>`;
  if (e.t === "step") {
    const x = STEPS[e.i], s = e.s;
    const title = pend ? x.p : s === "run" || s === "wait" ? x.r : s === "decl" ? "You declined the ticket" : s === "stop" ? cutTitle(x) : x.t;
    const note = { fail: '<span class="bad">Jira refused</span>', wait: '<span class="warn">Waiting for you in chat</span>', decl: "Declined", stop: "You pressed Stop", skip: ui.state === "stopped" ? "Didn't run" : "Skipped" }[s];
    const sub = [x.sys, note].filter(Boolean).join('<span class="sep">·</span>');
    const dur = pend ? "" : s === "run" || s === "wait" ? `<span data-tick="dur">${fmt(ui.elapsed)}</span>` : fmt(durOf(e.i));
    const inner = `<span class="rl-pin"></span><span class="rl-main"><span class="rl-t${s === "run" ? " tx-shimmer" : ""}">${esc(title)}</span>${sub ? `<span class="rl-s">${sub}</span>` : ""}</span><span class="rl-d">${dur}</span>`;
    return `<li class="${cls}" ${attrs}>${pend
      ? `<div class="rl-row">${inner}</div>`
      : `<button class="rl-row" type="button" data-goto="${e.i}" aria-label="${esc(title)}, open in Activity">${inner}</button>`}</li>`;
  }
  const at = e.t === "out" ? startOf(e.a.steps[0]) : startOf(e.a.steps.at(-1)) + durOf(e.a.steps.at(-1));
  const ret = e.a.ret[ui.state] || e.a.ret.done;
  const title = e.t === "out"
    ? e.s === "skip" ? `Not handed to <b>${esc(e.a.name)}</b>` : `${pend ? "Hands" : "Handed"} to <b>${esc(e.a.name)}</b>`
    : e.s === "skip" ? `<b>${esc(e.a.name)}</b> never started`
    : e.s === "stop" ? `<b>${esc(e.a.name)}</b> stopped`
    : pend ? `Hands back to <b>${esc(lead.name)}</b>` : `<b>${esc(e.a.name)}</b> handed back`;
  const sub = e.t === "out" ? (e.s === "skip" ? "You stopped the turn first" : esc(e.a.task)) : e.s === "skip" ? "Nothing to hand back" : pend ? "When its steps finish" : esc(ret);
  const tone = { fail: "bad", decl: "warn" }[e.s] || "";
  return `
    <li class="${cls}" ${attrs}>
      <button class="rl-row" type="button" data-pick="${k}" aria-label="${e.t === "out" ? "Brief" : "Return"} of ${esc(e.a.name)}">
        <span class="rl-pin"></span>
        <span class="rl-main"><span class="rl-t">${ic(e.t === "out" ? "out" : "back", "tx-ic tx-ic-sm rl-ic")}<span>${title}</span></span><span class="rl-s ${tone}">${sub}</span></span>
        <span class="rl-d">${pend ? "" : `+${fmt(at)}`}</span>
      </button>
    </li>`;
}

function vRelay() {
  const ev = relayEvents(), n = crew().helpers.length;
  return `
    <section class="sec" aria-label="How the work moved">
      <div class="sec-h"><span class="t-micro">How the work moved</span><span class="sec-meta">Open a step for its trace</span></div>
      <div class="relay" id="relay" style="--lanes:${n + 1}">
        <svg class="rl-svg" aria-hidden="true"></svg>
        <ol class="rl-list">${ev.map(relayRow).join("")}</ol>
      </div>
    </section>`;
}

/* lanes are drawn after layout, from where each row's pin actually landed */
const LANE = 16, LANE0 = 9;
function drawRelay() {
  const box = $("relay");
  if (!box) return;
  const svg = box.querySelector(".rl-svg"), top = box.getBoundingClientRect().top;
  const rows = [...box.querySelectorAll(".rl")];
  const y = rows.map((li) => { const p = li.querySelector(".rl-pin").getBoundingClientRect(); return p.top + p.height / 2 - top; });
  const ev = relayEvents();
  const laneX = (a) => LANE0 + (a === crew().lead ? 0 : (crew().helpers.indexOf(a) + 1) * LANE);
  const x0 = LANE0, pend = (s) => s === "next" || s === "skip";
  const out = [];
  const line = (d, c, dash, extra = "") => out.push(`<path class="rl-ln${dash ? ` is-${dash}` : ""}${extra}" d="${d}" style="--c:${c}"/>`);

  // the spine: solid while the lead works, dotted while a helper holds the work, dashed ahead
  let held = false;
  for (let j = 0; j < ev.length - 1; j++) {
    if (ev[j].t === "out") held = true;
    if (ev[j].t === "back") held = false;
    line(`M${x0} ${y[j]}V${y[j + 1]}`, "var(--ink-3)", pend(ev[j + 1].s) ? "ahead" : held ? "held" : "", ` own-lead`);
  }
  // each helper's branch: off the spine at its brief, back at its return
  ev.forEach((e, j) => {
    if (e.t !== "out") return;
    const jb = ev.findIndex((f, m) => m > j && f.t === "back" && f.a === e.a);
    const xk = laneX(e.a), c = `var(--id-${e.a.id})`, own = ` own-${keyOf(e.a)}`;
    for (let m = j; m < jb; m++) {
      const y1 = y[m], y2 = y[m + 1], r = Math.min(12, (y2 - y1) / 2);
      const d = m === j ? `M${x0} ${y1}Q${xk} ${y1} ${xk} ${y1 + r}V${y2}`
        : m === jb - 1 ? `M${xk} ${y1}V${y2 - r}Q${xk} ${y2} ${x0} ${y2}`
        : `M${xk} ${y1}V${y2}`;
      line(d, c, pend(ev[m + 1].s) ? "ahead" : "", own);
    }
  });
  // nodes last, so they sit on the lines
  ev.forEach((e, j) => {
    const own = keyOf(e.a), c = e.a === crew().lead ? "var(--ink-2)" : `var(--id-${e.a.id})`;
    if (e.t === "step") {
      const x = laneX(e.a);
      if (e.s === "run") out.push(`<circle class="rl-halo own-${own}" cx="${x}" cy="${y[j]}" r="8"/>`);
      out.push(`<circle class="rl-node is-${e.s} own-${own}" cx="${x}" cy="${y[j]}" r="4.5" style="--c:${c}"/>`);
    } else if (e.t === "note") {
      // your note: a small square on the lane of the work it joined
      out.push(`<rect class="rl-you own-${own}" x="${laneX(e.a) - 3.5}" y="${y[j] - 3.5}" width="7" height="7" rx="1.5"/>`);
    } else {
      out.push(`<circle class="rl-hand is-${e.s} own-${own}" cx="${x0}" cy="${y[j]}" r="3" style="--c:var(--id-${e.a.id})"/>`);
    }
  });
  svg.setAttribute("viewBox", `0 0 ${LANE0 * 2 + LANE * crew().helpers.length} ${box.offsetHeight}`);
  svg.style.height = `${box.offsetHeight}px`;
  svg.innerHTML = out.join("");
}

/* hovering a crew card quiets everyone else's rows and lanes */
function focusAgent(k) {
  const box = $("relay");
  if (!box) return;
  box.classList.toggle("has-focus", k != null);
  box.querySelectorAll(".rl").forEach((li) => li.classList.toggle("is-dim", k != null && li.dataset.own !== k));
  box.querySelectorAll(".rl-svg > *").forEach((el) => el.classList.toggle("is-dim", k != null && !el.classList.contains(`own-${k}`)));
}

/* -- dossier: the picked agent's brief, return, footprint and access --------- */
function changedText(a) {
  if (!writes(a)) return ['<span class="cap-off">Nothing</span>', ""];
  return {
    live: ["Nothing yet", ""], needs: ["Nothing yet, 1 waits for you in chat", "warn"], done: ["Created FIN-482 in Jira", "ok"],
    issue: ["Nothing, the change failed", "bad"], declined: ["Nothing, you declined", ""],
    stopped: ["Nothing, you stopped the turn first", ""],
  }[ui.state];
}
function readText(a) {
  const st = stat();
  const r = a.servers.filter((x) => x.perm === "Read-only" && x.steps.some((i) => usedSt(st[i]))).map((x) => x.n);
  if (a.steps.includes(4) && st[4] === "done") r.push("4 web pages");
  if (a.steps.includes(4) && st[4] === "run") r.push("Web pages, still reading");
  if (a.steps.includes(4) && st[4] === "stop") r.push("2 web pages, then you stopped it");
  return r.length ? r.join(", ") : '<span class="cap-off">Nothing</span>';
}
function chips(a) {
  const st = stat(), all = [...a.servers.map((c) => ({ ...c, k: "server" })), ...a.skills.map((c) => ({ ...c, k: "skill" })), ...a.knowledge.map((c) => ({ ...c, k: "know" }))];
  return `<ul class="chips">${all.map((c) => {
    const used = c.steps.some((i) => usedSt(st[i]));
    const mark = c.k === "server" ? `<span class="mono-mark">${c.m}</span>` : ic(c.k === "skill" ? "spark" : "book", "tx-ic tx-ic-sm");
    return `<li class="chip${used ? " is-used" : ""}" title="${used ? "Used this turn" : "Allowed, not used"}">${mark}${esc(c.n)}${c.perm?.startsWith("Can") ? `<span class="chip-w">writes</span>` : ""}</li>`;
  }).join("")}</ul>`;
}

function vDossier() {
  const k = picked(), a = agentOf(k), isLead = k === "lead", lead = crew().lead;
  const ran = a.steps.filter((i) => usedSt(stat()[i]));
  const [u, n] = usedCount(a);
  const [chg, tone] = changedText(a);
  let ticket;
  if (isLead) {
    ticket = `
      <div class="tk">
        <div class="tk-p"><p class="t-micro">Its part</p><p class="tk-t">${esc(a.role)}</p></div>
        <div class="tk-p"><p class="t-micro">Instructions</p>${instructions(a)}</div>
      </div>`;
  } else {
    const first = a.steps[0], last = a.steps.at(-1);
    const back = relayEvents().find((e) => e.t === "back" && e.a === a);
    const pend = back.s === "next" || back.s === "skip";
    const rtone = { fail: "bad", decl: "warn" }[back.s] || (ui.state === "needs" && a.steps.some((i) => stat()[i] === "wait") ? "warn" : "");
    const unsent = ["next", "skip"].includes(stat()[first]);
    ticket = `
      <div class="tk">
        <div class="tk-p">
          <p class="t-micro tk-h"><span>Brief from ${esc(lead.name)}</span><span class="num">${unsent ? "Not sent" : `+${fmt(startOf(first))}`}</span></p>
          <p class="tk-q">${esc(a.asked)}</p>
        </div>
        <div class="tk-p">
          <p class="t-micro tk-h"><span>${back.s === "skip" ? "No return" : pend ? "Return so far" : "Returned"}</span><span class="num">${pend ? "" : `+${fmt(startOf(last) + durOf(last))}`}</span></p>
          <p class="tk-t ${rtone}">${esc(a.ret[ui.state] || a.ret.done)}</p>
        </div>
      </div>`;
  }
  return `
    <section class="sec dos" aria-label="${esc(a.name)}" style="${idStyle(a)}">
      <div class="dos-h">
        ${avatar(a, "ava-lg")}
        <div class="dos-id">
          <h3 class="dos-n">${esc(a.name)}<span class="tx-pill tx-pill-line tx-pill-sm">${a.builtin ? "Built-in" : "Yours"}</span></h3>
          <p class="dos-m">@${a.handle}<span class="sep">·</span>${a.model}</p>
        </div>
        ${pillFor(agentStatus(a, isLead))}
      </div>
      ${ticket}
      <dl class="dos-kv">
        <dt>Steps</dt><dd>${ran.length ? `<span class="cap-refs">${stepRefs(ran)}</span>` : '<span class="cap-off">None yet</span>'}</dd>
        <dt>${ic("eye", "tx-ic tx-ic-sm")}Read</dt><dd>${readText(a)}</dd>
        <dt>${ic("pen", "tx-ic tx-ic-sm")}Changed</dt><dd class="${tone}">${chg}</dd>
        <dt>Allowed</dt><dd>${chips(a)}<span class="dos-used">Used <span class="num">${u}</span> of <span class="num">${n}</span></span></dd>
      </dl>
      <div class="dos-foot"><button class="tx-btn tx-ghost tx-xs" type="button" data-act="open-agent" data-name="${esc(a.name)}">View ${esc(a.name)}'s setup</button></div>
    </section>`;
}

function syncTeam() {
  const T = total() || 1;
  document.querySelectorAll("[data-agent-time]").forEach((el) => { el.textContent = fmt(agentTime(agentOf(el.dataset.agentTime))); });
  document.querySelectorAll("[data-share]").forEach((el) => { el.style.width = `${(agentTime(agentOf(el.dataset.share)) / T) * 100}%`; });
}

function vAgentTeam() {
  return vCrew() + vRelay() + vDossier() + vSnap(crew().lead);
}

const vAgent = () => (crew().helpers.length ? vAgentTeam() : vAgentSolo());


/* ---------- tab 3 · files: what the turn made, read and edited -------------- */
/* step = the step that made the file; a file whose step hasn't run yet shows
   as planned. Nothing here edits a file: Open and Download only view it. */
const FILES = [
  { id: "csv", type: "CSV", n: "emea-orders-q2-q3.csv", step: 2, size: "1.2 MB", m: "18,240 rows · 6 columns",
    from: "sales.orders · Postgres", at: "2:41 PM",
    pv: { kind: "table", cols: ["country", "quarter", "net_usd"], rows: [["DE", "Q2", "12.40M"], ["DE", "Q3", "11.24M"], ["FR", "Q2", "8.92M"]], more: "18,237 more rows" } },
  { id: "c1", type: "PNG", n: "Q3 change by country", step: 7, size: "84 KB", m: "Chart · in the answer",
    from: "Steps 3 and 4 · sales.orders", at: "2:42 PM",
    pv: { kind: "bars", unit: "%", rows: [["Germany", -9.4, 1], ["France", -6.1, 1], ["UK", -0.8], ["Italy", -0.3], ["Nordics", 0.2], ["Spain", 0.4]] } },
  { id: "c2", type: "PNG", n: "Q3 revenue at Q2 exchange rates", step: 7, size: "61 KB", m: "Chart · in the answer",
    from: "Step 5 · reuters.com, ft.com", at: "2:42 PM",
    pv: { kind: "bars", unit: "M", rows: [["Reported", 41.2], ["At Q2 rates", 43.6, 1]] } },
];

const fileState = (f) => stat()[f.step];
const madeBy = (i) => byOf(i) || crew().lead;

function fPreview(pv) {
  if (pv.kind === "table") return `
    <div class="fl-pv"><table class="fl-tbl"><thead><tr>${pv.cols.map((c) => `<th>${c}</th>`).join("")}<th>region</th></tr></thead>
      <tbody>${pv.rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}<td>${MASK}</td></tr>`).join("")}</tbody></table>
      <p class="fl-more num">${pv.more}</p></div>`;
  const max = Math.max(...pv.rows.map((r) => Math.abs(r[1])));
  const div = pv.rows.some((r) => r[1] < 0);
  return `<div class="fl-pv fl-bars${div ? " is-div" : ""}" role="img" aria-label="Preview of the chart">${pv.rows.map(([k, v, hi]) => {
    const w = (Math.abs(v) / max) * (div ? 50 : 100);
    const l = div ? (v < 0 ? 50 - w : 50) : 0;
    const lab = pv.unit === "%" ? `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)}%` : `$${v.toFixed(1)}M`;
    return `<div class="fb"><span class="fb-k">${k}</span><span class="fb-t"><span class="fb-b${hi ? " is-hi" : ""}" style="left:${l}%;width:${w}%"></span></span><span class="fb-v num">${lab}</span></div>`;
  }).join("")}</div>`;
}

function vFiles() {
  const made = FILES.filter((f) => fileState(f) === "done");
  const plan = FILES.filter((f) => fileState(f) !== "done");
  const know = crew().lead.knowledge;
  const read = know.filter((k) => k.steps.some((i) => stat()[i] === "done"));
  const idle = know.filter((k) => !read.includes(k));
  const live = ui.state === "live" || ui.state === "needs";

  const row = (f) => {
    const open = ui.fopen.has(f.id), a = madeBy(f.step);
    return `
      <li class="fl${open ? " is-open" : ""}">
        <button class="fl-row" type="button" data-file="${f.id}" aria-expanded="${open}">
          <span class="fl-type">${f.type}</span>
          <span class="fl-main"><span class="fl-n">${esc(f.n)}</span><span class="fl-m">${esc(f.m)}</span></span>
          <span class="fl-r"><span class="st-d">${f.size}</span>${ic("chev-down", "tx-ic tx-ic-sm st-chev")}</span>
        </button>
        ${open ? `<div class="fl-det">
          ${fPreview(f.pv)}
          <dl class="fl-kv">
            <dt>Made by</dt><dd>${avatar(a, "ava-xs")}${esc(a.name)}</dd>
            <dt>Built from</dt><dd>${esc(f.from)}</dd>
            <dt>Step</dt><dd><button class="tx-chip tx-chip-ref" type="button" data-goto="${f.step}" aria-label="Open step ${f.step + 1} in Activity">Step ${f.step + 1}</button></dd>
            <dt>Created</dt><dd class="num">${f.at}</dd>
            <dt>Kept</dt><dd>In this chat · not shared outside it</dd>
          </dl>
          <div class="fl-act">
            <button class="tx-btn tx-ghost tx-xs" type="button" data-act="file-open" data-name="${esc(f.n)}">${ic("eye", "tx-ic tx-ic-sm")}Open</button>
            <button class="tx-btn tx-ghost tx-xs" type="button" data-act="file-dl" data-name="${esc(f.n)}">${ic("download", "tx-ic tx-ic-sm")}Download</button>
          </div>
        </div>` : ""}
      </li>`;
  };
  const planRow = (f) => `
      <li class="fl is-plan"><div class="fl-row">
        <span class="fl-type">${f.type}</span>
        <span class="fl-main"><span class="fl-n">${esc(f.n)}</span><span class="fl-m">${ui.state === "stopped" ? `Not made · step ${f.step + 1} didn't run` : `Planned · made in step ${f.step + 1}`}</span></span>
      </div></li>`;

  const editNote = {
    issue: "The failed step was a Jira write, not a file.",
    declined: "The declined step was a Jira write, not a file.",
    stopped: "You stopped it before it wrote anything else.",
  }[ui.state] || "Everything above is new. It lives in this chat.";

  return `
    <section class="sec" aria-label="Files at a glance">
      <dl class="fl-sum">
        <div><dt>Made</dt><dd class="num">${made.length}${plan.length && ui.state !== "stopped" ? `<span>+${plan.length} planned</span>` : ""}</dd></div>
        <div><dt>Read</dt><dd class="num">${read.length}</dd></div>
        <div><dt>Edited</dt><dd class="num">0</dd></div>
      </dl>
    </section>
    <section class="sec" aria-label="Made by this turn">
      <div class="sec-h"><span class="t-micro">Made by this turn</span><span class="sec-meta">${live ? "So far" : "New files only"}</span></div>
      ${made.length || plan.length ? `<ul class="fls">${made.map(row).join("")}${plan.map(planRow).join("")}</ul>` : `<p class="src-empty">Nothing made yet.</p>`}
    </section>
    <section class="sec" aria-label="Read, not changed">
      <div class="sec-h"><span class="t-micro">Read, not changed</span><span class="sec-meta">From its knowledge</span></div>
      ${read.length ? `<ul class="fls">${read.map((k) => `
        <li class="fl"><div class="fl-row is-flat">
          <span class="fl-type">DOC</span>
          <span class="fl-main"><span class="fl-n">${esc(k.n)}</span><span class="fl-m">${esc(k.s)}</span></span>
          <span class="fl-r">${stepRefs(k.steps)}</span>
        </div></li>`).join("")}</ul>` : `<p class="src-empty">No files read yet.</p>`}
      ${idle.length ? `<p class="fl-idle">${ic("book", "tx-ic tx-ic-sm")}Also available, not opened: ${idle.map((k) => esc(k.n)).join(", ")}</p>` : ""}
    </section>
    <section class="sec" aria-label="Edited">
      <div class="sec-h"><span class="t-micro">Edited</span></div>
      <div class="reach-none">${ic("shield")}No existing file was edited. ${editNote}</div>
    </section>`;
}


/* ---------- tab 4 · insights: time, cost, context, checks ------------------- */
/* tokens per step: [input, output]. Cost is an estimate at illustrative rates,
   labelled as such. A running step counts in proportion to its elapsed time. */
const TOK = [[2100, 380], [9800, 620], [12400, 540], [8600, 910], [14200, 760], [3100, 240], [2900, 310], [11800, 1650]];
const RATE = { in: 5, cache: 0.5, out: 25 }; // $ per million tokens
const WINDOW = 200000, BUDGET = 5;
const USUAL = { // this lead agent's last 30 turns
  team: { n: 30, time: [22, 34, 48, 90], cost: [0.18, 0.29, 0.44, 1] },
  solo: { n: 30, time: [18, 29, 41, 90], cost: [0.15, 0.26, 0.4, 1] },
};
const TIME_KIND = (k) => (["chart", "db", "pen"].includes(k) ? "sys" : k === "globe" ? "web" : k === "hand" ? "you" : "think");
const TIME_LAB = { think: "Thinking and writing", sys: "In your systems", web: "On the web", you: "Waiting for you" };
const money = (v) => `$${v.toFixed(2)}`;

function usage() {
  const st = stat();
  let tin = 0, tout = 0, cached = 0;
  const per = new Map();
  STEPS.forEach((x, i) => {
    const f = st[i] === "run" ? Math.min(1, ui.elapsed / x.d) : st[i] === "stop" ? durOf(i) / x.d : timed(st[i]) ? 1 : 0;
    if (!f) return;
    const [a, b] = TOK[i].map((n) => Math.round(n * f));
    const c = i ? Math.round(a * 0.6) : 0; // after the first step most input is cached
    tin += a; tout += b; cached += c;
    const cost = ((a - c) * RATE.in + c * RATE.cache + b * RATE.out) / 1e6;
    const who = madeBy(i);
    per.set(who, (per.get(who) || 0) + cost);
  });
  const cost = [...per.values()].reduce((x, y) => x + y, 0);
  const ctx = tin ? 18000 + tin * 0.5 : 0;
  return { tin, tout, cached, reason: Math.round(tout * 0.4), cost, per, ctx };
}

function strip(lab, v, [p25, med, p75, max], f) {
  const at = (n) => `${Math.min(100, (n / max) * 100)}%`;
  const rel = v > p75 ? "Longer than usual" : v < p25 ? "Shorter than usual" : "About usual";
  return `
    <div class="cmp">
      <div class="cmp-h"><span>${lab}</span><span class="cmp-rel">${lab === "Cost" ? rel.replace("Longer", "More").replace("Shorter", "Less") : rel}</span></div>
      <div class="cmp-t" role="img" aria-label="${lab}: this turn ${f(v)}, usual ${f(med)}">
        <span class="cmp-band" style="left:${at(p25)};width:calc(${at(p75)} - ${at(p25)})"></span>
        <span class="cmp-med" style="left:${at(med)}"></span>
        <span class="cmp-now" style="left:${at(v)}"></span>
      </div>
      <div class="cmp-k num"><span>This turn <b>${f(v)}</b></span><span>Usual ${f(med)}</span></div>
    </div>`;
}

function vInsights() {
  const st = stat(), u = usage(), T = total(), live = liveIdx() > -1;
  const so = live ? " so far" : "";

  // where the time went
  const buckets = { think: 0, sys: 0, web: 0, you: 0 };
  STEPS.forEach((x, i) => { if (timed(st[i])) buckets[TIME_KIND(x.k)] += durOf(i); });
  const order = ["think", "sys", "web", "you"].filter((k) => buckets[k] > 0);
  const tBar = order.map((k) => `<span class="tb tb-${k}" style="flex:${buckets[k]}"></span>`).join("");
  const tRows = order.map((k) => `
      <li><span class="tk tb-${k}"></span><span>${TIME_LAB[k]}</span><span class="num">${fmt(buckets[k])}</span><span class="num tks-pc">${Math.round((buckets[k] / (T || 1)) * 100)}%</span></li>`).join("");
  const youNote = buckets.you ? `<p class="in-note">${fmt(buckets.you)} of this was the turn waiting for your answer in chat, not the agent working.</p>` : "";

  // cost
  const spent = Math.min(100, (u.cost / BUDGET) * 100);
  const byAgent = crew().helpers.length ? `
      <ul class="in-agents">${[...u.per].sort((a, b) => b[1] - a[1]).map(([a, c]) => `
        <li>${avatar(a, "ava-xs")}<span>${esc(a.name)}</span><span class="in-share"><span style="width:${(c / (u.cost || 1)) * 100}%"></span></span><span class="num">${money(c)}</span></li>`).join("")}</ul>` : "";
  const tech = ui.tech ? `
      <dl class="in-tok">
        <dt>Input</dt><dd class="num">${u.tin.toLocaleString()}</dd>
        <dt>From cache</dt><dd class="num">${u.cached.toLocaleString()}</dd>
        <dt>Output</dt><dd class="num">${u.tout.toLocaleString()}</dd>
        <dt>Reasoning</dt><dd class="num">${u.reason.toLocaleString()}</dd>
        <dt>Model</dt><dd>${esc(crew().lead.model)}${crew().helpers.length ? ` · helpers on ${esc(crew().helpers[0].model)}` : ""}</dd>
        <dt>Rates</dt><dd class="num">$${RATE.in} in · $${RATE.cache} cached · $${RATE.out} out, per 1M</dd>
      </dl>` : "";

  // context
  const ctxP = Math.round((u.ctx / WINDOW) * 100);

  // checks
  const has = (i) => st[i] === "done";
  const chk = (ok, t, d) => `<li class="ck is-${ok}"><span class="ck-ic">${ic({ ok: "check", wait: "clock", warn: "alert", off: "ban" }[ok], "tx-ic tx-ic-sm")}</span><span><b>${t}</b><span>${d}</span></span></li>`;
  const rules = {
    issue: chk("warn", "One write failed", "Jira refused: no permission in FIN. Nothing was changed."),
    declined: chk("ok", "Stayed within its rules", "Read-only where required. Asked before the one write; you declined it."),
    needs: chk("ok", "Stayed within its rules", "Read-only so far. It is asking before its one write."),
    stopped: chk("ok", "Stayed within its rules", "Read-only throughout. You stopped it before its one write."),
  }[ui.state] || chk("ok", "Stayed within its rules", "Read-only where required. Asked before its one write.");
  // a check that never ran because you stopped the turn says so, instead of waiting
  const later = (t, d) => ui.state === "stopped" ? chk("off", t, "Not checked. You stopped the turn first.") : chk("wait", t, d);
  const steer = noted() ? {
    needs: chk("wait", "Follows your note", "Read when you answer the request."),
    done: chk("ok", "Followed your note", "Added the watcher and the currency effect to FIN-482."),
    issue: chk("warn", "Your note wasn't applied", "Step 7 failed before it could add the watcher."),
    declined: chk("off", "Your note wasn't needed", "It was about the ticket, and you declined the ticket."),
  }[ui.state] : "";
  const checks = [
    has(2) ? chk("ok", "Totals match across systems", "Qlik and Postgres agree on EMEA Q3 within 0.2%.") : later("Totals match across systems", "Checked once the warehouse is read."),
    has(4) ? chk("ok", "Sources are recent", "All 4 web sources are from the last 30 days.") : later("Sources are recent", "Checked once the search is done."),
    has(7) ? chk("ok", "Every number has a source", "6 citations in the answer, each tied to a step.") : later("Every number has a source", "Checked when the answer is written."),
    steer,
    rules,
    chk("ok", "Within budget", `${money(u.cost)} of its ${money(BUDGET)} cap per turn.`),
  ].join("");

  const us = USUAL[ui.crew];
  return `
    <section class="sec" aria-label="Insights at a glance">
      <dl class="fl-sum">
        <div><dt>Time</dt><dd class="num">${fmt(T)}${live ? "<span>so far</span>" : ""}</dd></div>
        <div><dt>Cost</dt><dd class="num">${money(u.cost)}<span>est.</span></dd></div>
        <div><dt>Context</dt><dd class="num">${ctxP}%<span>used</span></dd></div>
      </dl>
    </section>
    <section class="sec" aria-label="Where the time went">
      <div class="sec-h"><span class="t-micro">Where the time went</span><span class="sec-meta num">${fmt(T)}${so}</span></div>
      <div class="tbar" role="img" aria-label="Time split by kind of work">${tBar}</div>
      <ul class="tks">${tRows}</ul>
      ${youNote}
    </section>
    <section class="sec" aria-label="What it cost">
      <div class="sec-h"><span class="t-micro">What it cost</span>
        <span class="tx-seg tx-seg-sm" role="group" aria-label="Detail">
          <button type="button" data-tech="0" aria-pressed="${!ui.tech}">Plain</button>
          <button type="button" data-tech="1" aria-pressed="${ui.tech}">Technical</button>
        </span></div>
      <div class="in-meter" role="img" aria-label="${money(u.cost)} of a ${money(BUDGET)} budget"><span style="width:${spent}%"></span></div>
      <div class="in-meter-k num"><span>${money(u.cost)} estimated${so}</span><span>${money(BUDGET)} cap per turn</span></div>
      ${byAgent}${tech}
    </section>
    <section class="sec" aria-label="How much it kept in mind">
      <div class="sec-h"><span class="t-micro">How much it kept in mind</span><span class="sec-meta num">${Math.round(u.ctx / 1000)}K of ${WINDOW / 1000}K</span></div>
      <div class="in-meter is-ctx" role="img" aria-label="${ctxP}% of the context window used"><span style="width:${ctxP}%"></span><i style="left:80%"></i></div>
      <p class="in-note">${ctxP < 80 ? `Plenty of room. Past 80% it starts summarising older parts of the chat.` : `Close to full. Older parts of the chat will be summarised.`}</p>
    </section>
    <section class="sec" aria-label="Compared with its usual turn">
      <div class="sec-h"><span class="t-micro">Against its usual turn</span><span class="sec-meta">Last ${us.n} turns</span></div>
      <div class="cmps">${strip("Working time", T - buckets.you, us.time, fmt)}${strip("Cost", u.cost, us.cost, money)}</div>
      <p class="in-note"><span class="cmp-key is-band"></span>Middle half of its turns <span class="cmp-key is-med"></span>Usual${buckets.you ? " · time waiting for you left out" : ""}</p>
    </section>
    <section class="sec" aria-label="How it checked the answer">
      <div class="sec-h"><span class="t-micro">How it checked the answer</span></div>
      <ul class="cks">${checks}</ul>
    </section>`;
}

/* the rationale column: what the open tab answers */
const NOTES = {
  activity: ["What this tab answers", [
    ["Where is it?", "The ask, a status you can read in one glance, and the time it took."],
    ["Is it waiting on me?", "What is pending and why, with a link to the chat. You approve or retry there; the panel never asks or acts."],
    ["What did it touch?", "Systems it only read, kept apart from systems it changed."],
    ["What did it do?", "Every step in plain words, in order, on one time scale."],
    ["Did I step in?", "A note you added while it waited (steer) sits in the steps where it joined the turn, with what it changed. A Stop shows where the turn was cut off, what finished and what never ran. You stop or steer from the chat, not here."],
    ["Can I prove it?", "Open any step for its trace. Technical shows the call itself."],
    ["Why should I trust the answer?", "The sources it was built from, each tied to its step."],
  ]],
  solo: ["What the Agent tab answers", [
    ["Who answered?", "The agent, who owns it, its model, and whether it ships built-in or is yours."],
    ["What could it reach, and what did it use?", "Every server, skill and source it is allowed, each marked with the steps it was used in, or not used."],
    ["What rules did it follow?", "Its standing instructions and the limits it runs under."],
    ["Is this the setup it ran on?", "The version of the agent at the time of the turn, and whether it has changed since."],
  ]],
  team: ["What the Sub-agents tab answers", [
    ["Who was on the crew?", "The lead and each helper, with its status and its share of the turn's time. A pen marks the ones that can change a system."],
    ["How did the work move?", "The lead is the spine. Each helper branches off where it was handed work and merges back where it returned. Open any step for its trace."],
    ["What was each one asked, and what came back?", "Pick an agent for its brief and return on one ticket, the steps it ran, and what it read and changed."],
    ["What was each one allowed?", "Every server, skill and source it may use, with the ones it used this turn filled in."],
  ]],
  files: ["What the Files tab answers", [
    ["What did it make?", "Every new file from this turn: its size, a preview, who made it and the step it came from. Files from steps that haven't run show as planned."],
    ["What did it read?", "The documents it opened, each tied to its step, and the ones it could have opened but didn't."],
    ["Did it edit anything I already had?", "Edits are counted on their own. This turn edited nothing, and the tab says so plainly."],
    ["Where do they live?", "In this chat, not shared outside it. Open and Download only view a file."],
  ]],
  insights: ["What the Insights tab answers", [
    ["How long, and where did the time go?", "Total time split by kind of work. Time spent waiting for you is kept apart, so it isn't counted as the agent being slow."],
    ["What did it cost?", "An estimate against the agent's budget, split by agent when helpers ran. Technical shows the tokens behind it."],
    ["Is it running out of room?", "How much of the context window the chat now uses, and what happens past 80%."],
    ["Was this a normal turn?", "Time and cost against this agent's last 30 turns."],
    ["Can I trust the answer?", "The checks it ran: totals across systems, source dates, citations, its rules and its budget."],
  ]],
};
function renderNotes() {
  const key = ui.tab === "agent" ? (crew().helpers.length ? "team" : "solo") : ui.tab === "files" ? "files" : ui.tab === "insights" ? "insights" : "activity";
  const [h, items] = NOTES[key];
  document.querySelector(".notes-h").textContent = h;
  $("notes").innerHTML = items.map(([b, t]) => `<li><b>${b}</b>${t}</li>`).join("");
  $("bar-title").innerHTML = ui.tab === "agent"
    ? `${key === "team" ? "Sub-agents" : "Agent"} <span>· one turn</span>`
    : ui.tab === "files" ? `Files <span>· one turn</span>`
    : ui.tab === "insights" ? `Insights <span>· one turn</span>`
    : `Business activity &amp; traces <span>· one turn</span>`;
}

/* ---------- render ---------------------------------------------------------- */
function render() {
  const body = $("body");
  const n = crew().helpers.length;
  $("tab-agent").innerHTML = n ? `Sub-agents <span class="num tab-n">${n}</span>` : "Agent";
  const fm = FILES.filter((f) => fileState(f) === "done").length;
  $("tab-files").innerHTML = `Files <span class="num tab-n">${fm}</span>`;
  renderNotes();
  if (ui.tab === "agent") {
    body.innerHTML = vAgent();
    syncTeam();
    drawRelay();
  } else if (ui.tab === "files") {
    body.innerHTML = vFiles();
  } else if (ui.tab === "insights") {
    body.innerHTML = vInsights();
  } else {
    body.innerHTML = vAsk() + vAttn() + vReach() + vSteps() + vSources();
  }
  document.querySelectorAll("#crew button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.c === ui.crew)));
  document.querySelectorAll("#state button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.s === ui.state)));
  document.querySelectorAll("#steer button").forEach((b) => b.setAttribute("aria-pressed", String((b.dataset.n === "1") === ui.steer)));
}

/* live ticking: only the numbers move, so open traces and focus survive */
function tick() {
  const at = liveIdx();
  if (at < 0) return;
  ui.elapsed += 0.1;
  if (ui.state === "live" && ui.elapsed >= STEPS[at].d) {
    // the helper finishes its search; the next step is the approval
    setState("needs", 0);
    return;
  }
  const t = fmt(ui.elapsed);
  ["tick-step", "tick-wait"].forEach((id) => { const n = $(id); if (n) n.textContent = t; });
  document.querySelectorAll('[data-tick="dur"]').forEach((n) => { n.textContent = t; });
  const tot = $("tick-total"); if (tot) tot.textContent = fmt(total());
  const ax = $("tick-axis"); if (ax) ax.textContent = `${fmt(total())} so far`;
  const seg = $(`seg-${at}`); if (seg) seg.style.setProperty("--d", ui.elapsed.toFixed(2));
  if (ui.tab === "agent") syncTeam();
  if (ui.tab === "insights" && Math.round(ui.elapsed * 10) % 10 === 0) render(); // once a second
}
setInterval(tick, 100);

function setState(s, elapsed) {
  ui.state = s;
  ui.elapsed = elapsed ?? (s === "live" ? 2.1 : s === "needs" ? 9 : 0);
  render();
}

/* ---------- toasts ---------------------------------------------------------- */
function toast(h, p) {
  const el = document.createElement("div");
  el.className = "tx-toast";
  el.innerHTML = `<span class="tx-dot tx-dot-live" style="margin-top:0.4em"></span><div><h5>${esc(h)}</h5>${p ? `<p>${esc(p)}</p>` : ""}</div><button class="tx-toast-x" type="button" aria-label="Dismiss">${ic("x", "tx-ic tx-ic-sm")}</button>`;
  const kill = () => { el.classList.add("tx-toast-out"); setTimeout(() => el.remove(), 220); };
  el.querySelector("button").onclick = kill;
  $("toasts").append(el);
  setTimeout(kill, 3200);
}

/* ---------- events ---------------------------------------------------------- */
function focusStep(i) {
  ui.open.add(i);
  render();
  const li = document.querySelector(`.st[data-i="${i}"]`);
  if (!li) return;
  li.scrollIntoView({ block: "nearest", behavior: document.documentElement.dataset.effMotion === "reduce" ? "auto" : "smooth" });
  li.classList.add("is-flash");
  li.querySelector("button")?.focus({ preventScroll: true });
}

$("body").addEventListener("click", (e) => {
  const step = e.target.closest("[data-step]");
  if (step) {
    const i = +step.dataset.step;
    ui.open.has(i) ? ui.open.delete(i) : ui.open.add(i);
    render();
    document.querySelector(`[data-step="${i}"]`)?.focus();
    return;
  }
  const pk = e.target.closest("[data-pick]");
  if (pk) {
    ui.pick = pk.dataset.pick;
    const inCrew = pk.classList.contains("cc");
    render();
    if (inCrew) document.querySelector(`.cc[data-pick="${ui.pick}"]`)?.focus();
    else document.querySelector(".dos")?.scrollIntoView({ block: "nearest", behavior: document.documentElement.dataset.effMotion === "reduce" ? "auto" : "smooth" });
    return;
  }
  const fl = e.target.closest("[data-file]");
  if (fl) {
    const id = fl.dataset.file;
    ui.fopen.has(id) ? ui.fopen.delete(id) : ui.fopen.add(id);
    render();
    document.querySelector(`[data-file="${id}"]`)?.focus();
    return;
  }
  const go = e.target.closest("[data-goto]");
  if (go) { showTab("activity"); focusStep(+go.dataset.goto); return; }
  const tech = e.target.closest("[data-tech]");
  if (tech) { ui.tech = tech.dataset.tech === "1"; render(); return; }
  const src = e.target.closest("[data-src]");
  if (src) { focusStep(+src.dataset.src); return; }
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "to-chat") toast("Scrolls the chat to this turn", {
    needs: "Approve or decline on the request card there. You can also add a note, or press Stop.",
    stopped: "Send a new message there to pick up where it left off.",
  }[ui.state] || "Retry the step from the chat.");
  else if (act === "open-fail") focusStep(6);
  else if (act === "more-src") { ui.moreSrc = !ui.moreSrc; render(); }
  else if (act === "instr") { ui.instr = !ui.instr; render(); document.querySelector('[data-act="instr"]')?.focus(); }
  else if (act === "file-open") toast(`Opens ${e.target.closest("[data-act]").dataset.name}`, "In the file viewer. Read-only.");
  else if (act === "file-dl") toast(`Downloading ${e.target.closest("[data-act]").dataset.name}`);
  else if (act === "open-agent") toast(`Opens ${e.target.closest("[data-act]").dataset.name}`, "Its full setup, in the Agents screen.");
});

/* row ↔ segment: hovering either lights the other */
function hover(i) {
  const bar = $("wf");
  if (!bar) return;
  bar.classList.toggle("has-hover", i != null);
  bar.querySelectorAll(".wf-seg").forEach((s) => s.classList.toggle("is-hover", +s.dataset.i === i));
  document.querySelectorAll(".st").forEach((s) => s.classList.toggle("is-hover", +s.dataset.i === i));
}
$("body").addEventListener("pointerover", (e) => {
  const el = e.target.closest(".wf-seg, .st[data-i]");
  hover(el ? +el.dataset.i : null);
});
$("body").addEventListener("pointerleave", () => { hover(null); focusAgent(null); });
$("body").addEventListener("pointerover", (e) => { const cc = e.target.closest(".cc"); focusAgent(cc ? cc.dataset.pick : null); });
$("body").addEventListener("focusin", (e) => { const cc = e.target.closest(".cc"); focusAgent(cc ? cc.dataset.pick : null); });
new ResizeObserver(() => drawRelay()).observe($("body"));
document.fonts?.ready.then(() => drawRelay());

$("state").addEventListener("click", (e) => {
  const b = e.target.closest("[data-s]");
  if (b) setState(b.dataset.s);
});

function showTab(tab) {
  ui.tab = tab;
  document.querySelectorAll(".ap-tabs [role=tab]").forEach((x) => x.setAttribute("aria-selected", String(x.id === `tab-${tab}`)));
  $("body").setAttribute("aria-labelledby", `tab-${tab}`);
  $("body").scrollTop = 0;
  render();
}
document.querySelectorAll(".ap-tabs [role=tab]").forEach((t) => t.addEventListener("click", () => showTab(t.id.replace("tab-", ""))));

$("crew").addEventListener("click", (e) => {
  const b = e.target.closest("[data-c]");
  if (b) { ui.crew = b.dataset.c; ui.pick = null; render(); }
});

$("steer").addEventListener("click", (e) => {
  const b = e.target.closest("[data-n]");
  if (b) { ui.steer = b.dataset.n === "1"; render(); }
});

$("home").onclick = () => toast("Session view is designed next", "Turn view first; the session stacks these turns.");
$("prev").onclick = () => toast("Turn 3 isn't in this study", "In the product the panel follows the turn you select.");
$("close").onclick = () => toast("Panel closes with ⌘.");
$("export").onclick = () => toast("Audit log exported", "tr_7f3a91c2.json · every step, input and result for this turn.");
$("trace-id").onclick = () => {
  try { navigator.clipboard.writeText("tr_7f3a91c2"); } catch (e) {}
  toast("Trace ID copied", "tr_7f3a91c2");
};

$("theme").addEventListener("click", () => {
  const r = document.documentElement;
  const next = r.dataset.effTheme === "dark" ? "light" : "dark";
  r.dataset.theme = next;
  r.dataset.effTheme = next;
  try { localStorage.setItem("tx-sys-theme", next); } catch (e) {}
});

const q = new URLSearchParams(location.search);
if (PLAN[q.get("state")]) ui.state = q.get("state");
if (q.get("tech") === "1") ui.tech = true;
if (q.get("steer") === "0") ui.steer = false;
if (CREW[q.get("crew")]) ui.crew = q.get("crew");
if (q.get("pick")) ui.pick = q.get("pick");
if (["activity", "agent", "files", "insights"].includes(q.get("tab"))) {
  ui.tab = q.get("tab");
  document.querySelectorAll(".ap-tabs [role=tab]").forEach((x) => x.setAttribute("aria-selected", String(x.id === `tab-${ui.tab}`)));
}
if (q.get("fopen")) q.get("fopen").split(",").forEach((n) => ui.fopen.add(n));
if (q.get("open")) q.get("open").split(",").forEach((n) => ui.open.add(+n));
setState(ui.state);
