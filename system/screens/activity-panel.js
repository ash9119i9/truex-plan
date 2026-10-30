
"use strict";
/* ---------------------------------------------------------------------------
   Activity panel · Turn scope, clean build.
   The chat is where you act (plan todos, approvals, retry); the panel only
   explains. Six turns cover every kind of turn: quick answer, tools only,
   helpers without files, files without helpers, stopped, and turn 6 live.
   Every view reads the same turn objects, so chat and panel always agree.
--------------------------------------------------------------------------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const fmt = s => { s = Math.max(0, Math.floor(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const dur = v => v < 60 ? `${Math.round(v)}s` : fmt(v);
const k1 = v => v >= 10 ? `${Math.round(v)}k` : `${v.toFixed(1)}k`;
const money = v => `$${v < 0.1 ? v.toFixed(3) : v.toFixed(2)}`;
const pct = v => `${Math.round(v * 100)}%`;
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ic = (n, c = "sm") => `<svg class="ic ${c}" aria-hidden="true"><use href="#i-${n}"/></svg>`;
const fav = d => `<img class="fav" alt="" src="https://www.google.com/s2/favicons?domain=${d}&sz=32">`;
const spin = `<svg class="ic sm spin" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 0 1 9 9"/></svg>`;
const sum = a => a.reduce((x, y) => x + y, 0);

// ---------- cast ----------
const AG = {
  main: { name: "Main agent", short: "Main", av: "M", tone: "tm", role: "Leads the turn", model: "Balanced" },
  pauli: { name: "Pauli", short: "Pauli", av: "P", tone: "t0", role: "Training", model: "Balanced" },
  herschel: { name: "Herschel", short: "Herschel", av: "H", tone: "t1", role: "Nutrition", model: "Fast" },
  hubble: { name: "Hubble", short: "Hubble", av: "U", tone: "t2", role: "Pacing & fuel", model: "Fast" },
  you: { name: "You", short: "You", av: "Y", tone: "tu", role: "" },
};
const ORDER = ["main", "pauli", "herschel", "hubble"];
const av = (id, c = "") => `<span class="av ${c} ${AG[id].tone}" aria-hidden="true">${AG[id].av}</span>`;
// Prices are illustrative: $ per 1k tokens by model; reused tokens bill at 10%; paid tools per call.
const PRICE = { Balanced: 0.006, Fast: 0.0015 };
const REUSE_RATE = 0.1;
const TOOLP = { search: 0.01, app: 0.002 };
const RATE = { think: .2, read: .6, tool: .15, write: .45, wait: .01, you: 0 }; // live turn: k tokens per second
const VERB = { think: "Thinking", read: "Reading", tool: "Using", write: "Writing", wait: "Waiting for helpers", you: "Waiting for your OK in chat" };
const TOOLS = { search: "Web search", web: "Read websites", file: "Your files", strava: "Strava · asks you first", garmin: "Garmin Connect · asks you first" };
const TAGCLS = { Changed: "chg", Failed: "bad", Blocked: "bad", Allowed: "ok", Asked: "warn", Skipped: "", Wrote: "ok" };
const KIND = { web: "Web", app: "Apps", file: "Files", ok: "Approvals" };

const sp = rows => rows.map(([a, k, l, s, e]) => ({ a, k, l, s, e }));
const ac = rows => rows.map(([t, a, k, tag, text, dom, res, st]) => ({ t, a, k, tag, text, dom, res, st, ch: tag === "Changed", bad: tag === "Failed" || tag === "Blocked" }));

// ---------- content ----------
const KM = [48, 52, 55, 50, 58, 62, 64, 56, 66, 70, 72, 62, 74, 64, 50, 30];
const LONG = [18, 19, 21, 18, 22, 24, 26, 21, 27, 29, 32, 24, 32, 26, 19, 42.2];
const weekOf = w => { const d = new Date(2026, 5, 8 + 7 * (w - 1)); return `${d.getDate()} ${d.toLocaleString("en-GB", { month: "short" })}`; };
const WEEKS = KM.map((km, i) => [i + 1, weekOf(i + 1), i === 15 ? "Race week" : `${km} km`, i === 15 ? "Race · 42.2 km" : `${LONG[i]} km`]);
const weekTable = (a = 0, b = 16) => `<table class="tbl"><tr><th>Wk</th><th>Week of</th><th>Total</th><th>Long run</th></tr>${WEEKS.slice(a, b).map(r => `<tr>${r.map(c => `<td>${c}</td>`).join("")}</tr>`).join("")}</table>`;
const SPLITS = [["0–5 km", "6:12", 372], ["5–10", "6:05", 365], ["10–15", "6:02", 362], ["15–20", "6:00", 360], ["20–25", "6:00", 360], ["25–30", "6:02", 362], ["30–35", "6:04", 364], ["35–40", "6:06", 366], ["40–42.2", "5:58", 358]];
const splitTable = `<table class="tbl"><tr><th>Section</th><th>Pace /km</th></tr>${SPLITS.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join("")}</table>`;
const MEALS = {
  "Run days": [["Breakfast", "Oats, banana, yoghurt", 520, 85], ["Lunch", "Chicken wrap, salad", 640, 70], ["Snack", "Toast, peanut butter", 300, 32], ["Dinner", "Pasta, veg, salmon", 760, 95]],
  "Rest days": [["Breakfast", "Eggs, wholegrain toast", 450, 40], ["Lunch", "Lentil soup, bread", 560, 75], ["Snack", "Fruit, nuts", 250, 25], ["Dinner", "Rice, chicken, greens", 640, 80]],
  "Long-run days": [["Before", "Toast, honey · 2 h before", 280, 55], ["During", "Gels · see fuel plan", 600, 150], ["Lunch", "Big pasta bowl", 780, 120], ["Dinner", "Potatoes, fish, veg", 900, 110]],
};
const mealTable = `<table class="tbl"><tr><th>Day</th><th>kcal</th><th>Carbs</th></tr>${Object.entries(MEALS).map(([d, m]) => `<tr><td>${d}</td><td>${sum(m.map(r => r[2])).toLocaleString()}</td><td>${sum(m.map(r => r[3]))} g</td></tr>`).join("")}</table>`;
const COMPARE = [["Hansons", "90 km", "26 km", "You can run 6 days a week"], ["Pfitzinger 18/55", "88 km", "32 km", "You want classic long runs"], ["Run-walk", "50 km", "42 km (run-walk)", "You want the gentlest build"]];
const compareTable = `<table class="tbl"><tr><th>Method</th><th>Peak week</th><th>Longest</th><th>Good if…</th></tr>${COMPARE.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join("")}</tr>`).join("")}</table>`;

// ---------- finished turns 1–5 ----------
const TURNS = {
  1: {
    n: 1, at: "6:01 PM", q: "What's a good weekly mileage for a first marathon?", status: "done", dur: 4, reused: .62, mem: 3.1,
    tok: { main: 3.1 }, helpers: [], plan: null, acts: [], think: 2,
    spans: sp([["main", "think", "thinking", 0, 2], ["main", "write", "answer", 2, 4]]),
    reply: ["Most first-time marathoners peak at <b>55–65 km a week</b>. Start near what you run now (about 25–30 km) and add no more than 10% a week, with an easier week every fourth week."],
    crew: {},
  },
  2: {
    n: 2, at: "6:02 PM", q: "Is the Berlin Marathon still on 27 September? Check the official site.", status: "done", dur: 19, reused: .41, mem: 4.6,
    tok: { main: 9.4 }, helpers: [], plan: null,
    spans: sp([["main", "think", "thinking", 0, 2], ["main", "tool", "web search", 2, 5], ["main", "read", "bmw-berlin-marathon.com", 5, 11], ["main", "read", "runnersworld.com", 11, 15], ["main", "write", "answer", 15, 19]]),
    acts: ac([[2, "main", "web", "Searched", "Berlin Marathon 2026 date", "google.com", "6 results"],
      [5, "main", "web", "Read", "bmw-berlin-marathon.com", "bmw-berlin-marathon.com", "Race day confirmed: Sun 27 Sep 2026"],
      [11, "main", "web", "Read", "runnersworld.com", "runnersworld.com", "Start-wave times and cut-offs"]]),
    reply: ["Yes. The official site still lists <b>Sunday 27 September 2026</b>. Start waves run from 9:15 to 10:05, and the course closes 6 h 15 min after the last wave."],
    crew: {},
  },
  3: {
    n: 3, at: "6:05 PM", q: "Compare three ways to train for it — Hanson, Pfitzinger and run-walk.", status: "done", dur: 102, reused: .30, mem: 8.8,
    tok: { main: 14.2, pauli: 17.4, herschel: 12.1, hubble: 18.3 }, helpers: ["pauli", "herschel", "hubble"],
    spans: sp([["main", "think", "planning", 0, 6], ["main", "wait", "helpers", 6, 83], ["main", "think", "comparing", 83, 92], ["main", "write", "reply", 92, 102],
      ["pauli", "tool", "web search", 6, 11], ["pauli", "read", "hansons-running.com", 11, 34], ["pauli", "read", "runnersworld.com", 34, 50], ["pauli", "write", "Hansons summary", 50, 70],
      ["herschel", "tool", "web search", 6, 10], ["herschel", "read", "humankinetics.com", 10, 33], ["herschel", "write", "Pfitzinger summary", 33, 55],
      ["hubble", "tool", "web search", 6, 11], ["hubble", "read", "jeffgalloway.com", 11, 30], ["hubble", "tool", "strava.com · blocked", 30, 33], ["hubble", "read", "runnersworld.com", 33, 58], ["hubble", "write", "run-walk summary", 58, 83]]),
    plan: [
      { t: "Split the question into three methods", who: ["main"], s: 0, e: 6, gave: "Your message", made: "3 research briefs, one per helper" },
      { t: "Research each method", who: ["pauli", "herschel", "hubble"], s: 6, e: 83, gave: "One method each", made: "3 method summaries", change: "Hubble couldn't open strava.com (not on the allowed sites), so it used runnersworld.com instead" },
      { t: "Compare them side by side", who: ["main"], s: 83, e: 102, gave: "The 3 summaries", made: "The comparison table in your reply" }],
    acts: ac([[6, "pauli", "web", "Searched", "Hansons marathon method weekly mileage", "google.com", "8 results", 1],
      [6, "herschel", "web", "Searched", "Pfitzinger 18/55 plan structure", "google.com", "5 results", 1],
      [6, "hubble", "web", "Searched", "Galloway run-walk-run marathon", "google.com", "7 results", 1],
      [10, "herschel", "web", "Read", "humankinetics.com", "humankinetics.com", "Advanced Marathoning · sample chapter", 1],
      [11, "pauli", "web", "Read", "hansons-running.com", "hansons-running.com", "Training philosophy · 3 pages", 1],
      [11, "hubble", "web", "Read", "jeffgalloway.com", "jeffgalloway.com", "Run-walk-run ratios by pace", 1],
      [30, "hubble", "web", "Blocked", "strava.com/blog", "strava.com", "Not on this workspace's allowed sites", 1],
      [33, "hubble", "web", "Read", "runnersworld.com", "runnersworld.com", "Run-walk for first marathons", 1],
      [34, "pauli", "web", "Read", "runnersworld.com", "runnersworld.com", "Hansons vs. traditional plans", 1]]),
    reply: ["All three can get you to Berlin. Here's how they differ:", compareTable, "With 4–5 running days a week, <b>Pfitzinger 18/55</b> fits you best. Want me to turn it into a plan?"],
    crew: {
      main: { task: "Answer the user's comparison using the three helper summaries.", tools: ["file"], usedIn: "Your reply" },
      pauli: { task: "Summarise the Hansons marathon method for a first-timer: weekly structure, peak week and longest run.", tools: ["search", "web"], usedIn: "Comparison table · Hansons row",
        out: ["<h4>Hansons method</h4>", "<p>Six days of running, with the long run <b>capped at 26 km</b>. The idea is cumulative fatigue: you start the long run already tired, so it feels like the last 26 km of the race.</p>", "<ul><li>Peak week: about 90 km</li><li>Hard days: speed, then strength, plus tempo</li></ul>"] },
      herschel: { task: "Summarise Pfitzinger 18/55: structure, peak week, longest run.", tools: ["search", "web"], usedIn: "Comparison table · Pfitzinger row",
        out: ["<h4>Pfitzinger 18/55</h4>", "<p>18 weeks, peaking at <b>88 km</b> (55 miles). Built on medium-long midweek runs and long runs up to <b>32 km</b>, with lactate-threshold work.</p>", "<p>Can be shortened to 16 weeks by merging the first base block.</p>"] },
      hubble: { task: "Summarise the Galloway run-walk-run method for a first marathon.", tools: ["search", "web"], usedIn: "Comparison table · Run-walk row", warn: "strava.com was blocked (not on this workspace's allowed sites). Hubble used runnersworld.com instead.",
        out: ["<h4>Run-walk-run (Galloway)</h4>", "<p>Short walk breaks from the start, at a ratio set by your pace (e.g. 4 min run / 1 min walk). Peak weeks stay near <b>50 km</b>, but the long run goes to full distance, run-walking.</p>"] },
    },
  },
  4: {
    n: 4, at: "6:09 PM", q: "Turn the Pfitzinger one into a printable 16-week plan.", status: "done", dur: 51, reused: .48, mem: 6.2,
    tok: { main: 22 }, helpers: [],
    spans: sp([["main", "think", "planning", 0, 4], ["main", "read", "Pfitzinger notes · turn 3", 4, 9], ["main", "write", "16-week-plan.docx", 9, 34], ["main", "write", "plan-tracker.xlsx", 34, 48], ["main", "write", "reply", 48, 51]]),
    plan: [
      { t: "Lay out 16 weeks from the Pfitzinger notes", who: ["main"], s: 0, e: 9, gave: "Herschel's summary from turn 3", made: "16 weeks, peak 74 km" },
      { t: "Write the printable plan", who: ["main"], s: 9, e: 34, gave: "The 16-week layout", made: "16-week-plan.docx", files: ["f1"] },
      { t: "Build a tracker you can fill in", who: ["main"], s: 34, e: 51, gave: "The same 16 weeks", made: "plan-tracker.xlsx", files: ["f2"] }],
    acts: ac([[4, "main", "file", "Opened", "Herschel's Pfitzinger notes", "", "From turn 3 · no new research needed", 0],
      [34, "main", "file", "Wrote", "16-week-plan.docx", "", "48 KB · 6 pages", 1],
      [48, "main", "file", "Wrote", "plan-tracker.xlsx", "", "21 KB · 3 sheets", 2]]),
    reply: ["Here's your 16-week plan as a printable document, plus a tracker to log each run. It starts the week of <b>8 June</b> and peaks at 74 km in week 13."],
    crew: { main: { task: "Turn the Pfitzinger summary into a 16-week printable plan and a tracker.", tools: ["file"], usedIn: "16-week-plan.docx · plan-tracker.xlsx" } },
  },
  5: {
    n: 5, at: "6:12 PM", q: "Push the plan to my Garmin Connect calendar.", status: "stopped", dur: 42, reused: .55, mem: 1.9,
    tok: { main: 6.8 }, helpers: [],
    stop: { step: 2, title: "Stopped at step 2 of 3", why: "Garmin Connect didn't respond after 20 seconds, so the workouts weren't sent. The empty calendar it created is still in your Garmin account." },
    spans: sp([["main", "think", "planning", 0, 3], ["main", "you", "OK for Garmin", 3, 9], ["main", "think", "formatting workouts", 9, 20], ["main", "tool", "Garmin · create calendar", 20, 22], ["main", "tool", "Garmin · send workouts", 22, 42]]),
    plan: [
      { t: "Format 16 weeks as workouts", who: ["main"], s: 0, e: 20, gave: "16-week-plan.docx", made: "112 workouts" },
      { t: "Send them to Garmin Connect", who: ["main"], s: 20, e: 42, st: "fail", gave: "112 workouts", made: "An empty calendar · 0 of 112 workouts sent", change: "Garmin Connect didn't respond after 20s" },
      { t: "Confirm the calendar synced", who: ["main"], st: "skip", change: "Didn't run, because step 2 stopped" }],
    acts: ac([[3, "main", "ok", "Asked", "Use Garmin Connect · create calendar events", "connect.garmin.com", "Asked you in chat", 0],
      [9, "you", "ok", "Allowed", "Garmin Connect · create calendar events", "connect.garmin.com", "Once, in chat · after 6s", 0],
      [20, "main", "app", "Changed", "Created calendar “Pfitzinger 16”", "connect.garmin.com", "Empty calendar · still in your account", 1],
      [22, "main", "app", "Failed", "Send 112 workouts", "connect.garmin.com", "No response after 20s · 0 of 112 sent", 1]]),
    reply: [],
    crew: { main: { task: "Send the 16-week plan to the user's Garmin Connect calendar.", tools: ["file", "garmin"], usedIn: "Nothing yet · the turn stopped" } },
  },
};

// ---------- files ----------
const DOC1 = `<h1>Your 16-week marathon plan</h1><p class="sub">Pfitzinger 18/55, shortened · Berlin · 27 Sep 2026 · v1</p>
<h2>How it works</h2><p>Four to five runs a week. Midweek you do one medium-long run and one session at threshold pace; the weekend long run grows to 32 km in weeks 11 and 13.</p>
<h2>The 16 weeks</h2>${weekTable()}<h2>Rest and recovery</h2><p>Take Monday off every week. Every fourth week is lighter so your legs can catch up.</p>`;
const DOC2 = DOC1.replace("· v1", "· v2").replace(`<h2>Rest and recovery</h2>`, `<h2>Meals</h2><p>Eat about 2,200 kcal on run days, 1,900 on rest days and 2,560 on long-run days. The full menus are in <b>meal-plan.xlsx</b>.</p>${mealTable}<h2>Race-day pacing</h2><p>Target <b>4:15</b>, about 6:03 per km. Start 10 seconds slower and hold steady. The chart is in <b>pacing.png</b>.</p>${splitTable}<h2>Rest and recovery</h2>`);
const DIFF = `<div class="docp diff"><p class="sub">16-week-plan.docx · v1 (turn 4) → v2 (turn 6)</p><h2>The 16 weeks</h2><p>Unchanged.</p>
<h2><ins>Meals</ins></h2><p><ins>Eat about 2,200 kcal on run days, 1,900 on rest days and 2,560 on long-run days. The full menus are in meal-plan.xlsx.</ins></p>
<h2><ins>Race-day pacing</ins></h2><p><ins>Target 4:15, about 6:03 per km. Start 10 seconds slower and hold steady.</ins></p>
<h2>Rest and recovery</h2><p>Take Monday off every week. Every fourth week is lighter so your legs can catch up.</p></div>`;
const SHEETS = {
  f2: { Weeks: [["Wk", "Week of", "Planned", "Long run", "Actual", "Notes"], ...WEEKS.map(r => [r[0], r[1], r[2], r[3], "", ""])],
    "Long runs": [["Wk", "Planned", "Actual", "Pace /km", "Felt"], ...LONG.map((l, i) => [i + 1, `${l} km`, "", "", ""])],
    Paces: [["Type", "Pace /km", "Use for"], ["Easy", "6:45–7:15", "Most runs"], ["Long", "6:30–6:50", "Weekend"], ["Threshold", "5:30", "Midweek session"], ["Marathon", "6:03", "Race pace blocks"]] },
  f3: Object.fromEntries(Object.entries(MEALS).map(([d, rows]) => [d, [["Meal", "What", "kcal", "Carbs (g)"], ...rows]])),
};
const PACESVG = () => {
  const W = 480, H = 210, x0 = 44, bw = (W - x0 - 10) / SPLITS.length, y = s => 20 + (380 - s) / 30 * 150;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Pace per section for a 4:15 finish">
    <text x="0" y="12" font-family="var(--font-mono)" font-size="10" fill="var(--ink-3)">PACE /KM · 4:15 TARGET</text>
    ${[350, 360, 370].map(s => `<line x1="${x0}" x2="${W - 6}" y1="${y(s)}" y2="${y(s)}" stroke="var(--line)"/><text x="${x0 - 8}" y="${y(s) + 3}" text-anchor="end" font-family="var(--font-mono)" font-size="9.5" fill="var(--ink-3)">${fmt(s)}</text>`).join("")}
    <line x1="${x0}" x2="${W - 6}" y1="${y(363)}" y2="${y(363)}" stroke="var(--accent)" stroke-dasharray="3 3"/>
    ${SPLITS.map(([l, p, s], i) => `<rect x="${x0 + i * bw + 5}" y="${y(s)}" width="${bw - 10}" height="${y(350) + 22 - y(s)}" rx="${(bw - 10) / 2}" fill="var(--t0)" opacity="${i === 0 ? .55 : .9}"/>
      <text x="${x0 + i * bw + bw / 2}" y="${y(s) - 5}" text-anchor="middle" font-family="var(--font-mono)" font-size="9.5" font-weight="600" fill="var(--ink)">${p}</text>
      <text x="${x0 + i * bw + bw / 2}" y="${H - 4}" text-anchor="middle" font-family="var(--font-mono)" font-size="9" fill="var(--ink-3)">${l.replace(" km", "")}</text>`).join("")}</svg>`;
};
const FTYPE = { docx: ["DOC", "Document"], xlsx: ["XLS", "Spreadsheet"], png: ["PNG", "Image"] };
const FILES = [
  { id: "f1", turn: 4, name: "16-week-plan.docx", type: "docx", size: "48 KB", meta: "6 pages", by: "main", from: ["herschel"], ver: 1, next: "f5", doc: DOC1 },
  { id: "f2", turn: 4, name: "plan-tracker.xlsx", type: "xlsx", size: "21 KB", meta: "3 sheets", by: "main", from: [], ver: 1 },
  { id: "f3", turn: 6, name: "meal-plan.xlsx", type: "xlsx", size: "18 KB", meta: "3 sheets", by: "main", from: ["herschel", "hubble"], ver: 1, w: [0, 8] },
  { id: "f4", turn: 6, name: "pacing.png", type: "png", size: "64 KB", meta: "1200 × 525", by: "main", from: ["pauli"], ver: 1, w: [0, 6] },
  { id: "f5", turn: 6, name: "16-week-plan.docx", type: "docx", size: "61 KB", meta: "8 pages", by: "main", from: ["pauli", "herschel", "hubble"], ver: 2, prev: "f1", doc: DOC2, w: [0, 14] },
];
const fileById = id => FILES.find(f => f.id === id);
const ftile = (f, c = "") => `<span class="ftile ${f.type} ${c}" aria-hidden="true">${FTYPE[f.type][0]}</span>`;

// ---------- turn 6 · live simulation ----------
// A tiny scheduler: actions fire at turn-seconds; spans and acts are what every view reads.
const T6BASE = {
  n: 6, at: "6:16 PM", q: "Now add a meal plan and a pacing chart to go with it.", reused: .44, helpers: ["pauli", "herschel", "hubble"],
  crew: {
    main: { task: "Add a meal plan and a pacing chart to the user's 16-week plan, and update the plan document.", tools: ["file"], usedIn: "Your reply · all 3 files" },
    pauli: { task: "Build race-day pacing for a 4:15 finish in Berlin: an even-effort split per 5 km, as data for a chart.", tools: ["search", "web"], usedIn: "pacing.png · plan v2, Race-day pacing",
      out: ["<h4>Pacing for a 4:15 finish</h4>", "<p>Average <b>6:03 per km</b>. Start about 10 seconds slower for the first 5 km, settle at 6:00–6:05, and save anything left for the last 2 km.</p>", splitTable, "<p>Berlin is flat, so even effort ≈ even pace.</p>"] },
    herschel: { task: "Write daily meals for run days, rest days and long-run days that match the 16-week plan.", tools: ["search", "web", "file"], usedIn: "meal-plan.xlsx · plan v2, Meals",
      out: ["<h4>Daily meals</h4>", "<p>About <b>2,200 kcal</b> on run days, 1,900 on rest days and 2,560 on long-run days. Carbs go up the day before and the day of the long run.</p>", mealTable, "<ul><li>Protein within an hour after every run.</li><li>Carb-load for the 2 days before the race.</li></ul>"] },
    hubble: { task: "Plan race-day fuel and fluids. If the user allows it, use their recent long runs from Strava.", tools: ["search", "strava"], usedIn: "meal-plan.xlsx · Long-run days",
      out: ["<h4>Race-day fuel</h4>", "<p>Your last 8 long runs averaged <b>2:05 at 6:20/km</b>. From those: <b>1 gel every 35 min</b> (6 in total) and about 500 ml of water an hour.</p>", "<p>On a warm day, add a salt tab at 15 and 30 km.</p>"],
      outSkipped: ["<h4>Race-day fuel</h4>", "<p>You skipped Strava, so this uses standard guidance instead of your own runs: <b>1 gel every 40 min</b> (5–6 in total) and 400–800 ml of water an hour.</p>"] },
  },
};
const sim = { speed: 1 };
let cur = 0;
const at = (t, fn) => sim.q.push({ t, fn });
const openSpan = a => sim.spans.find(s => s.a === a && s.e == null);
const close = a => { const s = openSpan(a); if (s) s.e = cur; };
const open = (a, k, l) => { close(a); sim.spans.push({ a, k, l, s: cur, e: null }); };
const act = (a, k, tag, text, dom, res, st) => sim.acts.push({ t: cur, a, k, tag, text, dom, res, st, ch: tag === "Changed", bad: tag === "Failed" || tag === "Blocked", born: sim.fired });

function resetSim(from) {
  Object.assign(sim, { t: 0, fired: 0, q: [], spans: [], acts: [], approval: "none", planned: false, D: null, end: null, askAt: null,
    hs: { pauli: "queued", herschel: "queued", hubble: "queued" }, hplan: {}, files: { f3: "queued", f4: "queued", f5: "queued" }, fw: {} });
  at(0, () => open("main", "think", "planning"));
  at(3, () => { open("main", "read", "16-week-plan.docx"); act("main", "file", "Opened", "16-week-plan.docx", "", "v1 from turn 4", 0); });
  at(7, () => {
    sim.planned = true; open("main", "wait", "helpers");
    for (const h of T6BASE.helpers) sim.hs[h] = "run";
    sim.hplan = { pauli: [7, 46], herschel: [7, 40], hubble: [7, 30] };
    open("pauli", "tool", "web search"); act("pauli", "web", "Searched", "Marathon pacing by finish time", "google.com", "9 results", 1);
    open("herschel", "read", "nhs.uk"); act("herschel", "web", "Read", "nhs.uk", "nhs.uk", "Healthy eating for endurance · 2 pages", 1);
    open("hubble", "think", "fuel plan");
  });
  at(10, () => { open("pauli", "read", "runnersworld.com"); act("pauli", "web", "Read", "runnersworld.com", "runnersworld.com", "Marathon pace charts", 1); });
  at(12, () => {
    open("hubble", "you", "Strava OK"); sim.hs.hubble = "wait"; sim.approval = "pending"; sim.askAt = 12;
    act("hubble", "ok", "Asked", "Use Strava · read your last 8 long runs", "strava.com", "Waiting for you in chat", 1);
  });
  at(19, () => { open("herschel", "read", "eatright.org"); act("herschel", "web", "Read", "eatright.org", "eatright.org", "Carb loading before a marathon", 1); });
  at(22, () => { open("pauli", "read", "mcmillanrunning.com"); act("pauli", "web", "Read", "mcmillanrunning.com", "mcmillanrunning.com", "Pace calculator · 4:15 target", 1); });
  at(28, () => open("herschel", "write", "meal targets"));
  at(31, () => open("pauli", "write", "pacing data"));
  at(40, () => finishHelper("herschel"));
  at(46, () => finishHelper("pauli"));
  advance(from);
}
function advance(to) {
  for (;;) {
    const due = sim.q.filter(a => a.t <= to).sort((a, b) => a.t - b.t)[0];
    if (!due) break;
    sim.q.splice(sim.q.indexOf(due), 1);
    cur = due.t; due.fn(); sim.fired++;
  }
  sim.t = sim.end != null ? sim.end : to;
}
function finishHelper(h) {
  close(h); sim.hs[h] = "done";
  if (sim.D != null || !T6BASE.helpers.every(x => sim.hs[x] === "done")) return;
  const D = sim.D = cur;
  open("main", "think", "combining");
  at(D + 8, () => {
    open("main", "write", "your files");
    for (const f of ["f3", "f4", "f5"]) { sim.files[f] = "writing"; const w = fileById(f).w; sim.fw[f] = [D + 8 + w[0], D + 8 + w[1]]; }
  });
  const ready = id => { sim.files[id] = "ready"; const f = fileById(id); act("main", "file", "Wrote", f.name, "", `${f.size} · ${f.meta}${f.ver > 1 ? ` · replaces v${f.ver - 1}` : ""}`, 3); };
  at(D + 14, () => ready("f4"));
  at(D + 16, () => ready("f3"));
  at(D + 22, () => { ready("f5"); close("main"); sim.end = cur; });
}
function decide(allow) {
  if (sim.approval !== "pending") return;
  cur = sim.t; const A = cur;
  sim.approval = allow ? "allowed" : "skipped"; sim.hs.hubble = "run";
  if (allow) {
    act("you", "ok", "Allowed", "Strava · read your last 8 long runs", "strava.com", `Once, in chat · after ${dur(A - sim.askAt)}`, 1);
    open("hubble", "read", "Strava · 8 long runs"); act("hubble", "app", "Read", "8 long runs from Strava", "strava.com", "Read only · avg 2:05 at 6:20/km", 1);
    sim.hplan.hubble = [sim.askAt, A + 16];
    at(A + 5, () => open("hubble", "think", "sweat & fuel"));
    at(A + 9, () => open("hubble", "write", "fuel plan"));
    at(A + 16, () => finishHelper("hubble"));
  } else {
    act("you", "ok", "Skipped", "Strava · read your last 8 long runs", "strava.com", "Hubble uses standard guidance", 1);
    open("hubble", "write", "standard fuel plan");
    sim.hplan.hubble = [sim.askAt, A + 8];
    at(A + 8, () => finishHelper("hubble"));
  }
  sim.fired++;
}

// ---------- accessors (every view reads these) ----------
const live6 = () => sim.end == null;
function tokOf(spans) {
  const t = { main: 2 }; // the main agent starts with the conversation so far
  for (const s of spans) if (s.a !== "you") t[s.a] = (t[s.a] || 0) + RATE[s.k] * ((s.e ?? sim.t) - s.s);
  return t;
}
function steps6() {
  if (!sim.planned) return null;
  const t = sim.t, D = sim.D, E = sim.end;
  const st = (s, e) => e != null && t >= e ? "done" : s != null && t >= s ? "live" : "todo";
  return [
    { t: "Read your 16-week plan", who: ["main"], s: 0, e: 7, st: "done", gave: "16-week-plan.docx (turn 4)", made: "16 weeks, peak 74 km" },
    { t: "Research meals, pacing and race-day fuel", who: T6BASE.helpers, s: 7, e: D, st: D != null ? "done" : "live", gave: "One topic each", made: D != null ? "3 summaries" : "",
      change: sim.approval === "skipped" ? "You skipped Strava in chat, so Hubble used standard fuel guidance" : sim.approval === "allowed" ? "You allowed Strava in chat (once), so Hubble used your own long runs" : sim.approval === "pending" ? "Hubble is waiting for your OK in chat" : "" },
    { t: "Combine into one plan", who: ["main"], s: D, e: D != null ? D + 8 : null, st: st(D, D != null ? D + 8 : null), gave: "The 3 summaries", made: D != null && t >= D + 8 ? "Meals and pacing, matched to each week" : "" },
    { t: "Write your files", who: ["main"], s: D != null ? D + 8 : null, e: E, st: st(D != null ? D + 8 : null, E), gave: "The combined plan", made: E != null ? "3 files" : "", files: ["f3", "f4", "f5"] }];
}
function turn(n) {
  if (n !== 6) return TURNS[n];
  const tok = tokOf(sim.spans);
  return { ...T6BASE, spans: sim.spans, acts: sim.acts, plan: steps6(), status: sim.end != null ? "done" : "live", dur: sim.end ?? sim.t, tok, mem: tok.main * .38 + (sim.end != null ? 0 : 0) };
}
const ALL = [1, 2, 3, 4, 5, 6];
const turnFiles = n => FILES.filter(f => f.turn === n);
const agentsOf = T => ["main", ...T.helpers];
function agStatus(T, a) {
  if (T.n === 6) return a === "main" ? (sim.end != null ? "done" : "run") : sim.hs[a];
  if (T.status === "stopped" && a === "main") return "stopped";
  return "done";
}
function agSpan(T, a) {
  const ss = T.spans.filter(s => s.a === a);
  if (!ss.length) return [0, 0, false];
  const isOpen = ss.some(s => s.e == null);
  return [Math.min(...ss.map(s => s.s)), isOpen ? T.dur : Math.max(...ss.map(s => s.e)), isOpen];
}
const agDur = (T, a) => { const [s, e] = agSpan(T, a); return e - s; };
function agProg(T, a) {
  if (T.n !== 6) return 1;
  const st = sim.hs[a];
  if (a === "main") return sim.end != null ? 1 : clamp(sim.t / ((sim.D ?? 50) + 22));
  if (st === "done") return 1;
  const p = sim.hplan[a]; if (!p) return 0;
  return clamp((sim.t - p[0]) / (p[1] - p[0]), .03, .97);
}
const actsOf = (T, a) => T.acts.filter(x => x.a === a);
function usage(T) {
  const tok = T.tok, r = T.reused, ags = agentsOf(T);
  const toolCost = a => actsOf(T, a).reduce((v, x) => v + (x.tag === "Searched" ? TOOLP.search : x.k === "app" ? TOOLP.app : 0), 0);
  const cost = {}, model = {}, reuse = {};
  for (const a of ags) {
    const t = tok[a] || 0, P = PRICE[AG[a].model];
    model[a] = t * (1 - r) * P; reuse[a] = t * r * P * REUSE_RATE; cost[a] = model[a] + reuse[a] + toolCost(a);
  }
  const total = sum(ags.map(a => tok[a] || 0));
  const time = { work: 0, help: 0, tool: 0, you: 0 };
  for (const s of T.spans.filter(s => s.a === "main")) {
    const d = (s.e ?? T.dur) - s.s;
    time[{ think: "work", write: "work", wait: "help", read: "tool", tool: "tool", you: "you" }[s.k]] += d;
  }
  const hd = T.helpers.map(h => agSpan(T, h));
  const par = hd.length > 1 ? sum(hd.map(([s, e]) => e - s)) - (Math.max(...hd.map(x => x[1])) - Math.min(...hd.map(x => x[0]))) : 0;
  return {
    tok, total, cost, all: sum(Object.values(cost)), model: sum(Object.values(model)), reuse: sum(Object.values(reuse)),
    saved: sum(ags.map(a => (tok[a] || 0) * r * PRICE[AG[a].model] * (1 - REUSE_RATE))),
    tools: sum(ags.map(toolCost)), nSearch: T.acts.filter(x => x.tag === "Searched").length, nApp: T.acts.filter(x => x.k === "app").length,
    nWeb: T.acts.filter(x => x.k === "web" && x.tag === "Read").length, nFiles: T.acts.filter(x => x.tag === "Wrote").length,
    nBad: T.acts.filter(x => x.bad).length, time, par,
  };
}
const avgCost = n => { const o = [1, 2, 3, 4, 5].filter(x => x !== n); return sum(o.map(x => usage(turn(x)).all)) / o.length; };
const MEM_BASE = 6; // system + instructions
const memAfter = n => MEM_BASE + sum(ALL.filter(x => x <= n).map(x => turn(x).mem));
function fstate(f) {
  if (f.turn !== 6) return { s: "ready", p: 1 };
  const s = sim.files[f.id], w = sim.fw[f.id];
  if (s === "writing") return { s, p: clamp((sim.t - w[0]) / (w[1] - w[0]), .04, .97) };
  return { s, p: s === "ready" ? 1 : 0 };
}
function doing(T, a) { // [icon html, sentence] for an agent that's working right now
  const s = openSpan(a);
  if (!s) return [ic("clock"), "Starting…"];
  const d = s.l.match(/^[a-z0-9-]+\.[a-z.]+$/) ? s.l : s.l.startsWith("Strava") ? "strava.com" : "";
  if (s.k === "you") return [ic("lock"), "Waiting for your OK in chat · Strava"];
  if (s.k === "wait") return [spin, `Waiting for ${T.helpers.filter(h => sim.hs[h] !== "done").map(h => AG[h].name).join(", ") || "helpers"}`];
  return [d ? fav(d) : s.k === "write" ? ic("pen") : s.k === "think" ? ic("brain") : ic("search"), `${VERB[s.k]} ${s.l}`];
}
const outBlocks = (T, a) => (T.n === 6 && a === "hubble" && sim.approval === "skipped") ? T.crew.hubble.outSkipped : T.crew[a]?.out ?? [];
function outK(T, a) {
  const n = outBlocks(T, a).length;
  if (T.n !== 6 || agStatus(T, a) === "done") return n;
  const s = openSpan(a);
  return s?.k === "write" ? Math.max(1, Math.floor(agProg(T, a) * n)) : 0;
}
function nowLine(T) {
  if (T.n !== 6 || !live6()) return "";
  if (!sim.planned) return "The main agent is reading your 16-week plan and making a plan.";
  if (sim.D == null) {
    const run = T.helpers.filter(h => sim.hs[h] === "run").map(h => AG[h].name);
    const wait = sim.hs.hubble === "wait" ? " Hubble is waiting for your OK in chat." : "";
    return run.length ? `${run.join(" and ")} ${run.length > 1 ? "are" : "is"} researching.${wait}` : `All helpers are done.${wait}`;
  }
  if (sim.t < sim.D + 8) return "The main agent is combining the three results into one plan.";
  return "The main agent is writing your 3 files.";
}

// ---------- ui state + live-value plumbing ----------
const ui = { open: true, turn: 6, tab: "plan", userTab: null, picker: false, detail: null, wide: false, narrow: false, filter: "all", openStep: null };
const da = (name, data = {}) => `data-act="${name}"${Object.entries(data).map(([k, v]) => ` data-${k}="${esc(v)}"`).join("")}`;
const btnRole = `role="button" tabindex="0"`;
const isWide = () => ui.detail ? !ui.narrow : ui.wide;
// Live text: every number that moves goes through lv(), so first paint and each tick use the same formula.
const LV = {
  dur: n => fmt(turn(+n).dur),
  cost: n => money(usage(turn(+n)).all),
  tok: n => k1(usage(turn(+n)).total),
  reused: n => pct(turn(+n).reused),
  agdur: (n, a) => fmt(agDur(turn(+n), a)),
  agcost: (n, a) => money(usage(turn(+n)).cost[a] || 0),
  agtok: (n, a) => k1(turn(+n).tok[a] || 0),
  agshare: (n, a) => { const u = usage(turn(+n)); return pct((u.cost[a] || 0) / Math.max(u.all, 1e-9)); },
  agcalls: (n, a) => String(actsOf(turn(+n), a).filter(x => x.k !== "ok").length),
  doing: (n, a) => doing(turn(+n), a)[1],
  now: n => nowLine(turn(+n)),
  ask: () => fmt(sim.t - (sim.askAt ?? sim.t)),
  fpct: id => pct(fstate(fileById(id)).p),
  mem: n => k1(memAfter(+n)),
  memadd: n => `+${k1(turn(+n).mem)} this turn`,
  time: (n, k) => dur(usage(turn(+n)).time[k]),
  money: (n, k) => money(usage(turn(+n))[k]),
  tokpart: (n, k) => { const T = turn(+n), u = usage(T); return k1({ fresh: u.total * .8 - u.total * T.reused, reused: u.total * T.reused, out: u.total * .2 }[k]); },
};
const lv = (k, ...a) => `<span data-lv="${k}" data-a="${a.join("|")}">${LV[k](...a.map(String))}</span>`;
const LS = {
  agprog: (n, a) => ["width", pct(agProg(turn(+n), a))],
  fprog: id => ["width", pct(fstate(fileById(id)).p)],
  grow: (n, a) => ["flexGrow", (usage(turn(+n)).cost[a] || 0) * 1000], // flex-grow below 1 leaves the bar part-empty
  tgrow: (n, k) => ["flexGrow", usage(turn(+n)).time[k]],
  kgrow: (n, k) => { const T = turn(+n), u = usage(T); return ["flexGrow", { fresh: .8 - T.reused, reused: T.reused, out: .2 }[k] * u.total]; },
  vs: (n, w) => { const c = usage(turn(+n)).all, a = avgCost(+n), m = Math.max(c, a) * 1.1; return ["width", pct((w === "me" ? c : a) / m)]; },
};
const ls = (k, ...a) => { const [p, v] = LS[k](...a.map(String)); return `data-ls="${k}" data-a="${a.join("|")}" style="${p === "flexGrow" ? "flex-grow" : p}:${v}"`; };

// ---------- which tab, and what each tab holds ----------
const filesIn = T => T.n === 6 && !sim.planned ? [] : turnFiles(T.n);
const has = (T, tab) => ({ files: filesIn(T).length > 0, insights: true, plan: !!T.plan || T.acts.length > 0, agents: T.helpers.length > 0 }[tab]);
function defaultTab(T) {
  if (T.status === "live" || T.status === "stopped") return "plan";
  if (filesIn(T).length) return "files";
  if (T.helpers.length) return "agents";
  if (T.acts.length) return "plan";
  return "insights";
}
function goTurn(n) {
  ui.turn = n; ui.detail = null; ui.picker = false; ui.openStep = null; ui.filter = "all";
  const T = turn(n);
  ui.tab = ui.userTab && has(T, ui.userTab) ? ui.userTab : defaultTab(T);
}
const pending = () => sim.approval === "pending" && live6();
function statusChip(T) {
  if (T.status === "live") return T.n === 6 && pending() ? `<span class="chip warn">${ic("lock")}Waiting for you</span>` : `<span class="chip run">${spin}Running</span>`;
  if (T.status === "stopped") return `<span class="chip bad">${ic("stop")}Stopped</span>`;
  return `<span class="chip ok">${ic("check")}${T.plan ? "Done" : "Answered"}</span>`;
}

// ---------- clean views · shared pieces ----------
// Short names for the step chart; the full step title stays in the list underneath.
const GL = {
  "Split the question into three methods": "Split question", "Research each method": "Research", "Compare them side by side": "Compare",
  "Lay out 16 weeks from the Pfitzinger notes": "Lay out weeks", "Write the printable plan": "Write plan", "Build a tracker you can fill in": "Build tracker",
  "Format 16 weeks as workouts": "Format workouts", "Send them to Garmin Connect": "Send to Garmin", "Confirm the calendar synced": "Confirm sync",
  "Read your 16-week plan": "Read plan", "Research meals, pacing and race-day fuel": "Research", "Combine into one plan": "Combine", "Write your files": "Write files",
};
const gl = s => GL[s.t] ?? s.t;
const youTime = T => sum(T.spans.filter(s => s.k === "you").map(s => (s.e ?? T.dur) - s.s));
const MEM_MAX = 258;
function timeOf(T) {
  const u = usage(T), t = { ...u.time }, hy = sum(T.spans.filter(s => s.k === "you" && s.a !== "main").map(s => (s.e ?? T.dur) - s.s));
  t.you += hy; t.help = Math.max(0, t.help - hy);
  return t;
}
LV.time = (n, k) => dur(timeOf(turn(+n))[k]);
LS.tgrow = (n, k) => ["flexGrow", timeOf(turn(+n))[k]];
const memPrior = n => memAfter(n) - turn(n).mem;
LV.you = n => dur(youTime(turn(+n)));
LV.vsavg = n => { const c = usage(turn(+n)).all, a = avgCost(+n); return c <= a ? `−${pct(1 - c / a)} vs your average` : `+${pct(c / a - 1)} vs your average`; };
LV.mempct = n => pct(memAfter(+n) / MEM_MAX);
LS.vsmk = n => { const c = usage(turn(+n)).all, a = avgCost(+n); return ["left", pct(a / (Math.max(c, a) * 1.1))]; };
LS.meter = (n, a) => { const T = turn(+n); return ["--p", String(agStatus(T, a) === "stopped" ? .66 : agProg(T, a))]; };
LS.memadd = n => ["width", `${(turn(+n).mem / MEM_MAX * 100).toFixed(2)}%`];
// Like ls(), for elements that also carry their own inline style.
const lsS = (css, k, ...a) => { const [p, v] = LS[k](...a.map(String)); return `data-ls="${k}" data-a="${a.join("|")}" style="${css};${p === "flexGrow" ? "flex-grow" : p}:${v}"`; };
const itile = n => `<span class="itile sm" aria-hidden="true">${ic(n, "")}</span>`;
const wch = (icon, title, sub, right = "") => `<div class="wc-h">${itile(icon)}<span class="ct"><b>${title}</b><small>${sub}</small></span>${right}</div>`;
const SQK = [["web", "Web"], ["file", "Files"], ["app", "Apps"], ["ok", "Approvals"], ["chg", "Changed"], ["bad", "Failed"]];
const SD = { run: "run", wait: "warn", queued: "q", stopped: "bad", done: "done" };

// ---------- panel header ----------
function statusPill(T) {
  if (live6() && T.n !== 6) return `<button class="pill run" ${da("jump")}><span class="dot"></span>Turn 6 live · Jump</button>`;
  if (T.status === "live") return pending() ? `<span class="pill warn"><span class="dot"></span>Waiting for you</span>` : `<span class="pill run"><span class="dot"></span>Running</span>`;
  if (T.status === "stopped") return `<span class="pill bad">${ic("stop")}Stopped</span>`;
  return `<span class="pill">${ic("check")}${T.plan ? "Done" : "Answered"}</span>`;
}
function headHTML() {
  const T = turn(ui.turn), nf = filesIn(T), lvT = T.status === "live";
  const ready = nf.filter(f => fstate(f).s === "ready").length;
  const tabs = [
    ["plan", "Business activity", `<span class="n">${T.acts.length}</span>`, !has(T, "plan")],
    ["agents", T.helpers.length ? "Sub-agents" : "Agent", `<span class="n">${agentsOf(T).length}</span>`, false],
    ["files", "Files", `<span class="n${lvT && ready < nf.length ? " pend" : ""}">${nf.length}</span>`, !nf.length],
    ["insights", "Insights", lvT ? `<span class="dot" aria-label="live"></span>` : "", false],
  ].map(([id, name, n, dim]) => `<button class="tab${id === ui.tab ? " on" : ""}${dim ? " dim" : ""}" role="tab" aria-selected="${id === ui.tab}" ${da("tab", { v: id })}>${name}${n}</button>`).join("");
  const picker = !ui.picker ? "" : `<div class="picker" role="listbox" aria-label="Pick a turn"><span class="lbl">Messages in this conversation</span>${[...ALL].reverse().map(n => {
    const P = turn(n), u = usage(P);
    const st = P.status === "live" ? `<span class="chip ok">live</span>` : P.status === "stopped" ? `<span class="chip bad">stopped</span>` : !P.plan && !P.acts.length ? `<span class="chip">quick</span>` : `<span class="chip">done</span>`;
    return `<button class="pk${n === T.n ? " on" : ""}" role="option" aria-selected="${n === T.n}" ${da("pick", { n })}><span class="no">${n}</span><span class="q">${esc(P.q)}</span>${st}<small>${P.at} · ${fmt(P.dur)} · ${money(u.all)} · ${P.helpers.length} helpers · ${filesIn(P).length} files</small></button>`; }).join("")}</div>`;
  const who = T.helpers.length ? `${T.helpers.length} helpers` : "main agent only";
  return `<div class="p-head"><span class="itile" aria-hidden="true">${ic("pulse", "")}</span>
      <span class="ct"><b>Activity</b><small>Turn ${T.n} · ${T.at} · ${who}</small></span>
      <button class="ibtn" ${da("wide")} aria-label="${isWide() ? "Narrow panel" : "Widen panel"}" title="${isWide() ? "Narrow" : "Widen"}">${ic(isWide() ? "shrink" : "expand")}</button>
      <button class="ibtn" ${da("close")} aria-label="Close panel">${ic("x")}</button></div>
    <div class="scope"><div class="seg" role="group" aria-label="Scope">
      <button ${da("toast", { msg: "Session scope is the next thing we design" })} title="Designed next">Session <span class="soon">next</span></button>
      <button class="on" aria-pressed="true" aria-expanded="${ui.picker}" ${da("picker")}>Turn ${T.n} of 6 ${ic("chevd")}</button></div>${statusPill(T)}${picker}</div>
    ${ui.detail ? "" : `<div class="tabs" role="tablist">${tabs}</div>`}`;
}

// ---------- the turn card, on every tab ----------
function strip(T) {
  const lvT = T.status === "live", steps = T.plan, n = T.n;
  const done = steps ? steps.filter(s => (s.st ?? "done") === "done").length : 0;
  const prog = steps ? `<div class="tprog" aria-hidden="true">${steps.map((s, i) => { const st = s.st ?? "done";
    return `<i class="${st === "done" ? "d" : st === "live" ? (n === 6 && pending() && i === 1 ? "w" : "l") : st === "fail" ? "f" : st === "skip" ? "s" : ""}"></i>`; }).join("")}</div>` : "";
  return `<div class="wc"><div class="tq">${av("you")}<q>${esc(T.q)}</q></div>${prog}
    <div class="sfoot c4"><div><span>${lvT ? "Elapsed" : "Took"}</span><b>${lv("dur", n)}</b></div>
      <div><span>Cost${lvT ? " · est." : ""}</span><b>${lv("cost", n)}</b></div>
      <div><span>Steps</span><b>${steps ? `${done} of ${steps.length}` : "—"}</b></div>
      <div><span>On you</span><b class="${n === 6 && pending() ? "warn" : ""}">${lv("you", n)}</b></div></div></div>
    ${n === 6 && pending() ? `<button class="waitline" ${da("gochat")}>${ic("lock")}<span><b>Hubble</b> is waiting for your OK · ${lv("ask")}</span><span class="k">In chat ${ic("ext")}</span></button>` : ""}`;
}

// ---------- empty states: a line drawing in a dark inset, one highlight ----------
const ART = {
  files: `<path class="ln" d="M64 68 120 86 176 68 120 50Z"/><path class="ln" d="M64 68v8l56 18 56-18v-8M120 86v8"/>
    <path class="ln" d="M86 62V22l26-8 10 4v40"/><path class="ln" d="M112 14v8l10-4"/><path class="ln" d="M93 30l20-6M93 38l22-7M93 46l14-4"/>
    <g class="hi"><path d="M132 60V24l24-7 10 4v36" stroke-dasharray="3 3"/></g>`,
  yet: `<rect class="ln" x="90" y="14" width="60" height="74" rx="4"/><path class="ln" d="M101 30h30M101 40h38M101 50h24"/>
    <g class="hi"><path d="M101 60h16"/><path d="M121 60h0"/><path d="M176 34a12 12 0 1 1-12-12"/></g>`,
  stop: `<path class="ln" d="M8 51h34"/><rect class="ln" x="42" y="40" width="40" height="22" rx="4"/><path class="ln" d="M82 46h12M82 56h12"/>
    <rect class="ln" x="146" y="36" width="48" height="30" rx="5"/><path class="ln" d="M194 51h38M146 46h-6M146 56h-6"/>
    <g class="hi"><path d="M114 36l-6 12h10l-6 14"/></g>`,
  trust: `<path class="ln" d="M80 62 120 78 160 62 120 46Z"/><path class="ln" d="M80 62v16l40 16 40-16V62M120 78v16"/>
    <g class="hi"><path d="M120 6l20 7v14c0 11-9 18-20 22-11-4-20-11-20-22V13Z"/><path d="M111 27l6 6 12-12"/></g>`,
  alone: `<circle class="ln" cx="120" cy="36" r="12"/><path class="ln" d="M98 82c0-14 10-22 22-22s22 8 22 22"/>
    <g class="hi" stroke-dasharray="2.5 3.5"><circle cx="64" cy="46" r="9"/><path d="M48 82c0-10 7-16 16-16s16 6 16 16"/><circle cx="176" cy="46" r="9"/><path d="M160 82c0-10 7-16 16-16s16 6 16 16"/></g>`,
};
const ARTOF = { file: "files", clock: "yet", x: "stop", shield: "trust", users: "alone" };
const ESL = { "": "Not needed", yet: "Not yet", bad: "Stopped", trust: "Read-only" };
const es = (cls, icon, title, body, extra = "") => `<div class="es ${cls}"><div class="es-art"><span class="es-lbl"><i></i>${ESL[cls] ?? ""}</span><svg viewBox="0 0 240 100" aria-hidden="true">${ART[ARTOF[icon] ?? "files"]}</svg></div><b>${title}</b><p>${body}</p>${extra}</div>`;
const elsewhere = (T, what) => {
  const n = FILES.filter(f => f.turn !== T.n && (f.turn !== 6 || sim.files[f.id] === "ready")).length;
  return n ? `<div class="elsewhere">${ic("file")}<span>${n} ${what} in other turns</span><button class="lnk" ${da("toast", { msg: "Opens Session scope · designed next" })}>Session ${ic("chevr")}</button></div>` : "";
};

// ---------- Files ----------
function thumb(f, s) {
  const w = s === "writing" ? " w" : "";
  if (f.type === "xlsx") return `<span class="thumb xlsx${w}" aria-hidden="true"><em>XLS</em></span>`;
  if (f.type === "png") return `<span class="thumb png${w}" aria-hidden="true"><span class="bars">${[55, 72, 64, 84, 70, 92].map(h => `<i style="height:${h}%"></i>`).join("")}</span><em>PNG</em></span>`;
  return `<span class="thumb${w}" aria-hidden="true"><i class="h"></i><i></i><i></i><i class="s"></i><i></i><i></i><em>DOC</em></span>`;
}
function fileRow(f) {
  const st = fstate(f), s = st.s, by = AG[f.by].short;
  const base = `class="frow ${s}" ${btnRole} ${da("file", { id: f.id })} data-ref="file:${f.id}" aria-label="Open ${esc(f.name)}"`;
  const vb = f.ver > 1 ? `<span class="vb">v${f.ver}</span>` : "";
  if (s === "queued") return `<div ${base}>${thumb(f, s)}<span class="fn">${esc(f.name)}${vb}</span><span class="sc q" title="Queued"></span><span class="fm">${FTYPE[f.type][1]} · queued · written in the last step</span></div>`;
  if (s === "writing") return `<div ${base}>${thumb(f, s)}<span class="fn">${esc(f.name)}${vb}</span><span class="sc run" title="Writing">${spin}</span><span class="fm">Writing… ${lv("fpct", f.id)} · ${by}</span><div class="wline"><i ${ls("fprog", f.id)}></i></div></div>`;
  let pages = "";
  if (f.type === "docx") {
    const np = parseInt(f.meta, 10), add = f.prev ? np - parseInt(fileById(f.prev).meta, 10) : 0;
    pages = `<div class="pages"><span class="sqs" aria-hidden="true">${Array.from({ length: np }, (_, i) => `<i class="${add && i >= np - 1 - add && i < np - 1 ? "add" : ""}"></i>`).join("")}</span><small>${add ? `<b>+${add} pages</b> · Meals, Race-day pacing` : `${np} pages · 3 sections`}</small></div>`;
  }
  let rail = "";
  if (f.prev) rail = `<div class="vrail"><span class="v">v1</span>turn ${fileById(f.prev).turn}<span class="ln"></span><span class="v cur">v2</span>this turn<button class="lnk ml" ${da("file", { id: f.id, sub: "changes" })}>What changed</button></div>`;
  if (f.next) { const nx = fileById(f.next), ns = fstate(nx).s; rail = `<div class="vrail"><span class="v cur">v1</span>this turn<span class="ln"></span><span class="v">v2</span>${ns === "ready" ? `replaced in turn ${nx.turn}` : `being written in turn ${nx.turn}`}</div>`; }
  return `<div ${base}>${thumb(f, s)}<span class="fn">${esc(f.name)}${vb}</span><span class="end"><span class="sc ok" title="Ready">${ic("check")}</span><button class="dlbtn" ${da("toast", { msg: `Downloading ${f.name}` })} aria-label="Download ${esc(f.name)}">${ic("down")}</button></span>
    <span class="fm">${f.size} · ${f.meta} · ${by}</span>${pages}${rail}</div>`;
}
function filesView(T) {
  const fs = filesIn(T), lvT = T.status === "live";
  if (!fs.length) {
    if (lvT) return strip(T) + es("yet", "clock", "No files planned so far", "If the agent decides to make one, it shows up here straight away.");
    if (T.status === "stopped") return strip(T) + es("bad", "x", "No files were made", `The turn stopped at step ${T.stop.step}, before any files were written.`, `<div class="row"><button class="btn" ${da("tab", { v: "plan" })}>See Plan &amp; activity</button></div>`) + elsewhere(T, "files");
    return strip(T) + es("", "file", "No files in this turn", "The answer is in the chat. Nothing needed a file.") + elsewhere(T, "files");
  }
  const cnt = s => fs.filter(f => fstate(f).s === s).length, ready = cnt("ready");
  const sq = `<div class="fsq"><span class="sqs" aria-hidden="true">${fs.map(f => `<i class="${fstate(f).s}"></i>`).join("")}</span><span>${["ready", "writing", "queued"].filter(k => cnt(k)).map(k => `${cnt(k)} ${k}`).join(" · ")}</span></div>`;
  const from = T.helpers.length ? `<div class="builtfrom">Built from ${T.helpers.map(h => `<button ${da("agent", { turn: T.n, id: h })} data-ref="agent:${T.n}:${h}">${av(h, "xs")}${AG[h].name}</button>`).join("")}</div>` : `<div class="alone">made by the main agent alone</div>`;
  return `${strip(T)}<div class="wc">${wch("file", "Files", `${fs.length} files · turn ${T.n}`,
      `<button class="btn" ${ready < fs.length ? "disabled" : ""} ${da("toast", { msg: `Downloading ${fs.length} files as a .zip` })}>${ic("down")}Download all</button>`)}
    <div class="wc-s">${sq}</div><div class="wc-s flush">${fs.map(fileRow).join("")}</div><div class="wc-s">${from}</div></div>${elsewhere(T, "files")}`;
}

// ---------- Insights ----------
function flagsOf(T) {
  const out = T.acts.filter(x => x.bad).map(x => ({ cls: "bad", icon: x.tag === "Blocked" ? "ban" : "x", text: `${AG[x.a].short}: ${x.tag.toLowerCase()} · ${x.text}`, k: x.k }));
  if (T.n === 6 && pending()) out.push({ cls: "warn", icon: "lock", text: "Hubble is waiting for your OK in chat", k: "ok" });
  const ch = T.acts.filter(x => x.ch).length;
  if (ch) out.push({ cls: "warn", icon: "edit", text: `${ch} change outside the app`, k: "app" });
  return out;
}
function insightsView(T) {
  const u = usage(T), n = T.n, lvT = T.status === "live", single = !T.helpers.length, quick = !T.plan && !T.acts.length;
  const avg = avgCost(n), cmp = u.all < avg ? `${pct(1 - u.all / avg)} cheaper` : `${pct(u.all / avg - 1)} more`;
  const lead = lvT ? `<b>So far:</b> ${lv("dur", n)} and about ${lv("cost", n)}. The cost is an estimate until the turn ends.`
    : T.status === "stopped" ? `<b>Stopped after ${dur(T.dur)}</b>, about ${money(u.all)}. You're only charged for what ran.`
    : quick ? `<b>Answered in ${dur(T.dur)}</b>, about ${money(u.all)}. No tools were used.`
    : `<b>Took ${dur(T.dur)}</b>${single ? " with no helpers" : ` with ${T.helpers.length} helpers`}, about ${money(u.all)}: ${cmp} than your average turn here.`;
  const ags = agentsOf(T);
  const from = single ? `<div class="wc-s"><div class="stub">${ic("users")}<b>Split by agent</b><small>one agent did it all</small></div></div>`
    : `<div class="wc-s"><div class="rh">Where it came from<b>${lv("cost", n)}</b></div>
      <div class="stk">${ags.map(a => `<i class="${AG[a].tone}${lvT && agStatus(T, a) === "run" ? " live" : ""}" ${ls("grow", n, a)} data-ref="agent:${n}:${a}"></i>`).join("")}</div>
      <div class="legend">${ags.map(a => `<div class="${AG[a].tone}" data-ref="agent:${n}:${a}"><i></i><span>${AG[a].name}<small>${AG[a].model}</small></span><b>${lv("agcost", n, a)} <small>· ${lv("agshare", n, a)}</small></b></div>`).join("")}</div></div>`;
  const tools = u.nSearch || u.nApp ? `${u.nSearch} search${u.nSearch === 1 ? "" : "es"} · ${u.nApp} app call${u.nApp === 1 ? "" : "s"}` : "none used";
  const cost = `<div class="wc">${wch("coin", "Cost", lvT ? "This turn · estimate, updates live" : "This turn · final", `<span class="chip">${lvT ? "estimate" : "final"}</span>`)}
    <div class="hero"><div class="big">${lv("cost", n)}</div><div class="sub"><em class="${u.all <= avg ? "down" : "up"}">${lv("vsavg", n)}</em> · avg ${money(avg)}</div></div>
    ${from}
    <div class="wc-s"><div class="rh">By type</div><div class="legend">
      <div><i style="--c:var(--ink)"></i><span>Model tokens<small>new reading and writing</small></span><b>${lv("money", n, "model")}</b></div>
      <div><i style="--c:var(--ink-3)"></i><span>Reused tokens<small>at 10% · saved ${lv("money", n, "saved")}</small></span><b>${lv("money", n, "reuse")}</b></div>
      <div><i style="--c:var(--line-2)"></i><span>Paid tools<small>${tools}</small></span><b>${lv("money", n, "tools")}</b></div></div></div>
    <div class="wc-s"><div class="rh">This turn against your average<b>${money(avg)} avg</b></div>
      <div class="ruler"><div class="trk"><i ${ls("vs", n, "me")}></i></div><span class="mk" ${ls("vsmk", n)}><span>avg</span></span></div></div></div>`;
  const tm = timeOf(T);
  const W = [["work", "Thinking and writing", "w-work"], ["help", "Helpers working", "w-help"], ["tool", "Reading and tools", "w-tool"], ["you", "Waiting on you", "w-you"]].filter(([k]) => tm[k] > 0 || (k === "you" && T.n === 6 && pending()));
  const time = `<div class="wc">${wch("clock", "Time", "Where the time went")}
    <div class="hero"><div class="big">${lv("dur", n)}</div><div class="sub">${single ? "One agent, start to finish" : u.par > 0 ? `Helpers side by side saved <em class="down">${dur(u.par)}</em>` : "Helpers are working side by side"}</div></div>
    <div class="wc-s"><div class="where">${W.map(([k, , c]) => `<i class="${c}" ${ls("tgrow", n, k)}></i>`).join("")}</div>
      <div class="legend">${W.map(([k, l, c]) => `<div><i class="${c}"></i><span>${l}</span><b>${lv("time", n, k)}</b></div>`).join("")}</div></div></div>`;
  const toks = quick ? `<div class="stub">${ic("globe")}<b>Tool use</b><small>none used</small></div>`
    : `<div class="wc">${wch("steps", "Tokens and tools", `${lv("tok", n)} tokens · ${T.acts.length} actions`)}
    <div class="wc-s"><div class="stk"><i class="k-new" ${ls("kgrow", n, "fresh")}></i><i class="k-re" ${ls("kgrow", n, "reused")}></i><i class="k-out" ${ls("kgrow", n, "out")}></i></div>
      <div class="legend"><div class="k-new"><i></i><span>Read, new</span><b>${lv("tokpart", n, "fresh")}</b></div><div class="k-re"><i></i><span>Read, reused</span><b>${lv("tokpart", n, "reused")}</b></div><div class="k-out"><i></i><span>Written</span><b>${lv("tokpart", n, "out")}</b></div></div></div>
    <div class="sfoot c4"><div><span>Websites</span><b>${u.nWeb}</b></div><div><span>App calls</span><b>${u.nApp}</b></div><div><span>Files</span><b>${u.nFiles}</b></div><div><span>Failed</span><b class="${u.nBad ? "bad" : ""}">${u.nBad}</b></div></div></div>`;
  const prior = memPrior(n) / MEM_MAX * 100;
  const mem = `<div class="budget"><div class="bh">Conversation memory <span>· ${lv("mempct", n)}</span><small>summarises at 80%</small></div>
    <div class="bt"><i style="width:${prior.toFixed(2)}%"></i><i class="add" ${lsS(`left:${prior.toFixed(2)}%`, "memadd", n)}></i><span class="cap"></span></div>
    <div class="bf">${lv("mem", n)} <span>of ${MEM_MAX}k</span><em>${lv("memadd", n)}</em></div>
    <p>Grows with every message. Past the dashed line, older messages get summarised. Helpers read in their own memory, so their reading isn't counted here.</p></div>`;
  const fl = flagsOf(T);
  const flags = `<div class="wc">${wch("warn", "Flags", fl.length ? `${fl.length} to look at` : "nothing to look at", fl.length ? "" : `<span class="chip ok">${ic("check")}clear</span>`)}
    ${fl.length ? `<div class="wc-s flush"><div class="flags">${fl.map(f => `<button ${da("flag", { k: f.k })}><span class="sc ${f.cls}">${ic(f.icon)}</span><span>${esc(f.text)}</span>${ic("chevr")}</button>`).join("")}</div></div>` : ""}</div>`;
  return `${strip(T)}<p class="lead">${lead}</p>${cost}${time}${toks}${mem}${flags}`;
}

// ---------- Plan & activity ----------
const overlap = (s, e, a, b) => Math.max(0, Math.min(e, b) - Math.max(s, a));
function stepCost(T, i) {
  const s = T.plan[i]; if (s.s == null) return 0;
  const e = s.e ?? T.dur, u = usage(T);
  return sum(s.who.map(a => {
    const ss = T.spans.filter(x => x.a === a), tot = sum(ss.map(x => (x.e ?? T.dur) - x.s));
    return tot ? u.cost[a] * sum(ss.map(x => overlap(x.s, x.e ?? T.dur, s.s, e))) / tot : 0;
  }));
}
LV.stepcost = (n, i) => money(stepCost(turn(+n), +i));
LV.stepdur = (n, i) => { const T = turn(+n), s = T.plan[+i]; return s.s == null ? "" : fmt((s.e ?? T.dur) - s.s); };
// Where each step sits on the step chart. Steps still to come in the live turn get a forecast.
function stepTimes(T) {
  const t = T.dur, lvT = T.n === 6 && live6(), out = [];
  let prev = 0;
  T.plan.forEach((s, i) => {
    let a = s.s, b = s.e;
    if (lvT) {
      const len = i === 2 ? 8 : 22;
      if (i === 1 && b == null) b = Math.max(...Object.values(sim.hplan).map(p => p[1]), sim.approval === "pending" ? t + 16 : 0, t + 1);
      else if (a == null) { a = Math.max(prev, t); b = a + len; }
      else if (b == null) b = Math.max(t + 1, a + len);
    }
    if (a == null) { a = prev; b = prev + Math.max(4, prev * .12); }
    b = b ?? t; out.push({ a, b }); prev = b;
  });
  return out;
}
function ganttHTML(T) {
  const tt = stepTimes(T);
  const rows = T.plan.map((s, i) => {
    const st = s.st ?? "done", { a, b } = tt[i], multi = s.who.length > 1, tone = multi ? "tm" : AG[s.who[0]].tone;
    let bars = "";
    if (st === "todo" || st === "skip") bars = `<i class="gx${st === "skip" ? " skip" : ""}" data-s="${a}" data-e="${b}"></i>`;
    else {
      if (st === "live") bars += `<i class="gx" data-s="${a}" data-e="${b}"></i>`;
      if (multi) s.who.forEach((h, k) => {
        const [hs, he, open] = agSpan(T, h);
        if (hs === he && !open) return;
        bars += `<i class="gb thin ${AG[h].tone}" style="--o:${k - 1}" data-s="${hs}" data-e="${open ? "" : he}"></i>`;
        for (const y of T.spans.filter(x => x.a === h && x.k === "you")) bars += `<i class="gy thin" style="--o:${k - 1}" data-s="${y.s}" data-e="${y.e ?? ""}"></i>`;
      });
      else {
        bars += `<i class="gb ${tone}${st === "fail" ? " fail" : ""}" data-s="${a}" data-e="${st === "live" ? "" : b}"></i>`;
        for (const y of T.spans.filter(x => x.a === s.who[0] && x.k === "you" && x.s >= a && x.s < b)) bars += `<i class="gy" data-s="${y.s}" data-e="${y.e ?? ""}"></i>`;
      }
      if (st === "live") bars += `<i class="gd" data-at=""></i>`;
    }
    const lab = `<span class="gl${st === "todo" || st === "skip" ? " todo" : ""}" data-s="${a}" data-e="${b}">${multi ? `<span class="stack">${s.who.map(w => av(w, "xs")).join("")}</span>` : ""}${esc(gl(s))}</span>`;
    return `<div class="tl-row ${tone}" ${da("stepx", { i })} title="${esc(s.t)}"><div class="tl-trk">${bars}${lab}</div></div>`;
  }).join("");
  return `<div class="tl gantt" data-turn="${T.n}" aria-hidden="true">${rows}<div class="tl-row tl-axis"><div class="tl-trk"></div></div><div class="tl-layer"></div></div>`;
}
function fileChip(f) {
  const st = fstate(f), a = `${btnRole} ${da("file", { id: f.id })} data-ref="file:${f.id}"`;
  if (st.s === "queued") return `<span class="ghostfile" ${a}>${esc(f.name)}</span>`;
  if (st.s === "writing") return `<span class="chip run" ${a}>${spin}${esc(f.name)} · ${lv("fpct", f.id)}</span>`;
  return `<span class="chip ok" ${a}>${ic("check")}${esc(f.name)}</span>`;
}
function crewLine(T, a) {
  const st = agStatus(T, a);
  let right, line;
  if (st === "run") { right = `<span class="tm">${lv("agdur", T.n, a)}</span>`; line = `${doing(T, a)[0]}<span>${lv("doing", T.n, a)}</span>`; }
  else if (st === "wait") { right = `<span class="tm warn">${lv("ask")}</span>`; line = `${ic("lock")}<span>Asked to read your Strava runs · the OK is in chat</span>`; }
  else { right = `<span class="tm">${fmt(agDur(T, a))}</span>`; line = `${ic("check")}<span>Done · ${actsOf(T, a).filter(x => x.k !== "ok").length} actions</span>`; }
  return `<div class="mate ${AG[a].tone}" ${btnRole} ${da("agent", { turn: T.n, id: a })} data-ref="agent:${T.n}:${a}" aria-label="Open ${AG[a].name}">
    <span class="sd ${SD[st]}"></span><span class="nm">${AG[a].name} <span>· ${AG[a].role}</span></span>${right}<div class="doing">${line}</div></div>`;
}
function stepRow(T, s, i) {
  const st = s.st ?? "done", waitHere = T.n === 6 && pending() && i === 1;
  const sc = st === "done" ? `<span class="sc ok">${ic("check")}</span>` : st === "fail" ? `<span class="sc bad">${ic("x")}</span>`
    : st === "live" ? (waitHere ? `<span class="sc warn">${ic("lock")}</span>` : `<span class="sc run">${spin}</span>`)
    : st === "skip" ? `<span class="sc q skip">–</span>` : `<span class="sc q">${i + 1}</span>`;
  const time = st === "live" ? `<time class="live">${lv("stepdur", T.n, i)}</time>` : st === "done" ? `<time>${fmt(s.e - s.s)}</time>` : st === "fail" ? `<time class="bad">failed</time>` : `<time>${st === "skip" ? "skipped" : "next"}</time>`;
  const res = st === "done" && s.made ? ` <span class="res">${esc(s.made)}</span>` : "";
  const sm = `<div class="sm"><span class="stack">${s.who.map(w => av(w, "xs")).join("")}</span>${s.who.length > 1 ? `${s.who.length} helpers` : AG[s.who[0]].short}${s.s != null ? ` · ${lv("stepcost", T.n, i)}` : ""}</div>`;
  const crew = st === "live" && s.who.length > 1 ? `<div class="crew">${s.who.map(a => crewLine(T, a)).join("")}</div>` : "";
  const files = s.files ? `<div class="fl">${s.files.map(id => fileChip(fileById(id))).join("")}</div>` : "";
  const chg = s.change ? `<div class="chg">${ic(st === "fail" ? "x" : waitHere ? "lock" : "edit")}<span>${esc(s.change)}</span></div>` : "";
  const ex = ui.openStep === i ? `<div class="sx" data-noclose><dl class="kv"><dt>Given</dt><dd>${esc(s.gave ?? "—")}</dd><dt>Made</dt><dd>${esc(s.made || (st === "live" ? "Still working…" : "—"))}</dd>
      <dt>Who</dt><dd>${s.who.map(a => `<button class="chip" ${da("agent", { turn: T.n, id: a })}>${av(a, "xs")}${AG[a].short}</button>`).join("")}</dd>
      ${s.s != null ? `<dt>When</dt><dd class="mono">${fmt(s.s)} → ${s.e != null ? fmt(s.e) : "now"}</dd>` : ""}</dl></div>` : "";
  return `<li class="step ${st}" ${da("stepx", { i })} aria-expanded="${ui.openStep === i}">${sc}<span class="t"><b>${esc(s.t)}</b>${res}</span>${time}${sm}${crew}${files}${chg}${ex}</li>`;
}
function changesBlock(T) {
  const ch = T.acts.filter(x => x.ch), failed = T.acts.filter(x => x.k === "app" && x.bad);
  if (!ch.length) return `<div class="chgrow"><span class="sc ok">${ic("shield")}</span>Nothing changed outside the app${T.status === "live" ? " so far" : ""}<small>0 changes</small></div>`;
  return `<div class="chgcard"><div class="h">${ic("edit")}Changed outside the app<span class="chip warn">${ch.length} change${ch.length > 1 ? "s" : ""}</span></div>
    ${ch.map(x => `<div class="r">${fav(x.dom)}<span>${esc(x.text)}<small>${esc(x.res)}</small></span></div>`).join("")}
    ${failed.map(x => `<div class="r">${ic("x")}<span>Didn't go through: ${esc(x.text)}<small>${esc(x.res)}</small></span></div>`).join("")}</div>`;
}
function actRow(T, x) {
  const f = x.k === "file" ? filesIn(T).find(f => f.name === x.text) : null;
  const click = x.k === "ok" && T.n === 6 && pending() ? da("gochat") : f ? da("file", { id: f.id }) : x.a !== "you" ? da("agent", { turn: T.n, id: x.a }) : "";
  const target = x.dom ? fav(x.dom) : x.k === "file" ? ic("file") : "";
  const cls = [x.ch ? "ch" : "", x.bad ? "bad" : "", T.status === "live" && x.born >= sim.fired - 1 ? "new" : ""].join(" ");
  return `<li class="${cls}" ${click ? `${btnRole} ${click}` : ""} data-ref="${x.a === "you" ? "" : `agent:${T.n}:${x.a}`}"><time>${fmt(x.t)}</time>${av(x.a, "xs")}<span class="tx1">${esc(x.text)}</span><span class="tag ${TAGCLS[x.tag] ?? ""}">${x.tag}</span>
    <small>${target}<span>${x.a === "you" ? "You" : AG[x.a].short} · ${esc(x.res)}</span></small></li>`;
}
function planView(T) {
  const quick = !T.plan && !T.acts.length, lvT = T.status === "live";
  if (quick) {
    const think = T.spans.filter(s => s.k === "think").reduce((v, s) => v + s.e - s.s, 0);
    return strip(T) + es("trust", "shield", "Answered from what it already knew", "No websites, apps or files were used, and nothing outside the app was touched.",
      `<div class="meta"><span class="chip">${ic("brain")}Thought ${dur(think)}</span><span class="chip">${av("main", "xs")}Main agent · ${AG.main.model}</span></div>`)
      + `<div class="stub">${ic("steps")}<b>Plan</b><small>not needed</small></div><div class="stub">${ic("globe")}<b>Activity</b><small>no actions</small></div>`;
  }
  let plan;
  if (T.plan) {
    const done = T.plan.filter(s => (s.st ?? "done") === "done").length, N = T.plan.length;
    plan = `<div class="wc">${wch("steps", "Plan", `${done} of ${N} steps done · tap a step for detail`, `<span class="chip">${lvT ? "live" : fmt(T.dur)}</span>`)}
      ${lvT ? `<div class="working"><span class="wi">${pending() ? ic("lock") : spin}</span><span class="wt">${lv("now", T.n)}</span><span class="wn">${Math.min(done + 1, N)} of ${N}</span></div>` : ""}
      <div class="wc-s">${ganttHTML(T)}</div>
      <div class="wc-s flush"><ol class="steps">${T.plan.map((s, i) => stepRow(T, s, i)).join("")}</ol></div></div>`;
  } else if (lvT) {
    plan = es("yet", "clock", "Making a plan…", "The main agent is reading your 16-week plan. Steps show up here as soon as it has one.");
  } else {
    plan = `<div class="stub">${ic("steps")}<b>Plan</b><small>not needed · answered directly</small></div>`;
  }
  const stopped = T.status === "stopped" ? `<div class="banner bad">${ic("x")}<div class="grow"><b>${T.stop.title}</b><span>${esc(T.stop.why)}</span><div class="row"><button class="lnk" ${da("gochat")}>Retry is in the chat ${ic("ext")}</button></div></div></div>` : "";
  const counts = { all: T.acts.length }; for (const k of Object.keys(KIND)) counts[k] = T.acts.filter(x => x.k === k).length;
  const fl = ui.filter !== "all" && !counts[ui.filter] ? "all" : ui.filter;
  const list = T.acts.filter(x => fl === "all" || x.k === fl).sort((a, b) => a.t - b.t);
  let rows = "";
  if (T.plan && list.length) {
    const groups = [...new Set(list.map(x => x.st ?? 0))].sort((a, b) => a - b);
    for (const g of groups) rows += `<div class="acts-g"><span>Step ${g + 1} · ${esc(T.plan[g].t)}</span></div><ul class="alist">${list.filter(x => (x.st ?? 0) === g).map(x => actRow(T, x)).join("")}</ul>`;
  } else rows = list.length ? `<ul class="alist">${list.map(x => actRow(T, x)).join("")}</ul>` : `<div class="stub">${ic("globe")}<b>No actions yet</b><small>live</small></div>`;
  const sqs = T.acts.slice().sort((a, b) => a.t - b.t).map(x => `<i class="q-${x.ch ? "chg" : x.bad ? "bad" : x.k}${lvT && x.born >= sim.fired - 1 ? " new" : ""}" title="${esc(`${fmt(x.t)} · ${x.text}`)}"></i>`).join("");
  const filters = `<div class="fseg" role="group" aria-label="Filter activity">${[["all", "All"], ...Object.entries(KIND)].map(([k, l]) => `<button class="${k === fl ? "on" : ""}" ${counts[k] ? "" : "disabled"} aria-pressed="${k === fl}" ${da("filter", { v: k })}>${l} <span class="n">${counts[k]}</span></button>`).join("")}</div>`;
  const leadNoPlan = !T.plan && !lvT ? `<p class="lead"><b>Answered directly</b> · no plan needed · ${T.acts.length} actions</p>` : "";
  const activity = `<div class="wc">${wch("globe", "Business activity", `${T.acts.length} actions · in plain words`)}
    ${T.acts.length ? `<div class="wc-s"><div class="rh">One square per action</div><div class="asq" aria-hidden="true">${sqs}${lvT ? `<span class="nowm"><span class="dot"></span>now</span>` : ""}</div>
      <div class="kleg">${SQK.filter(([k]) => T.acts.some(x => k === "chg" ? x.ch : k === "bad" ? x.bad : x.k === k && !x.ch && !x.bad)).map(([k, l]) => `<span><i class="sq q-${k}"></i>${l}</span>`).join("")}</div></div>` : ""}
    <div class="wc-s">${changesBlock(T)}</div>
    <div class="wc-s">${filters}</div>
    <div class="wc-s flush">${rows}</div></div>`;
  return `${strip(T)}${stopped}${leadNoPlan}${plan}${activity}`;
}

// ---------- Agents ----------
function rosterRow(T, a) {
  const st = agStatus(T, a), n = T.n, c = T.crew[a] ?? {}, tone = AG[a].tone, live = T.status === "live" && a !== "main" && (st === "run" || st === "wait");
  const sub = st === "run" ? lv("doing", n, a) : st === "wait" ? "Waiting for your OK in chat · Strava" : st === "queued" ? "Starts when the plan is ready" : st === "stopped" ? `Stopped at step ${T.stop.step} · Garmin didn't respond` : `${AG[a].role} · ${esc(c.usedIn ?? "Your reply")}`;
  const meter = `<span class="meter ${st === "run" ? "" : st}" ${lsS(st === "run" ? `--c:var(--${tone})` : "", "meter", n, a)}></span>`;
  const inset = live ? `<div class="rinset ${st === "wait" ? "wait" : tone}"><div class="rh2"><span>${st === "wait" ? "Waiting on you" : "Tokens per second"}</span><b>${st === "wait" ? lv("ask") : `${AG[a].model} model`}</b></div>
      <svg class="spark" viewBox="0 0 100 34" preserveAspectRatio="none" data-turn="${n}" data-a="${a}" aria-hidden="true"><path class="base" d="M0 30H100"/><path d=""/></svg></div>` : "";
  const warn = c.warn ? ` · <span style="color:var(--warn)">1 site blocked</span>` : "";
  return `<div class="rrow ${tone}${live ? ` open ${st}` : ""}" ${btnRole} ${da("agent", { turn: n, id: a })} data-ref="agent:${n}:${a}" aria-label="Open ${AG[a].name}">
    <span class="sd ${SD[st]}"></span><span class="nm">${AG[a].name}</span>${meter}<span class="v">${lv("agdur", n, a)}</span><span class="v c">${lv("agcost", n, a)}</span>
    <span class="sub">${sub}${warn}</span>${inset}</div>`;
}
function rosterCard(T) {
  const ids = agentsOf(T), n = T.n, u = usage(T), sts = ids.map(a => agStatus(T, a));
  const working = sts.filter(s => s === "run" || s === "wait").length;
  const tiles = T.helpers.length ? `<div class="wc-s"><div class="tiles3">
      <div><span>${T.status === "live" ? "Working" : "Finished"}</span><b>${T.status === "live" ? working : sts.filter(s => s === "done").length}<small> of ${ids.length}</small></b><div class="cells">${sts.map(s => `<i class="${s === "run" ? "run" : s === "wait" ? "warn" : s === "stopped" ? "bad" : s === "done" ? "done" : ""}"></i>`).join("")}</div></div>
      <div><span>Cost</span><b>${lv("cost", n)}</b><div class="cells">${ids.map(a => `<i style="background:var(--${AG[a].tone});flex-grow:${Math.max(.15, (u.cost[a] || 0) / Math.max(u.all, 1e-9) * ids.length)}"></i>`).join("")}</div></div>
      <div><span>${T.status === "live" ? "On you" : "Saved"}</span><b>${T.status === "live" ? lv("you", n) : u.par > 0 ? dur(u.par) : "—"}</b><div class="cells">${T.status === "live" ? `<i class="${pending() ? "warn" : ""}"></i>` : `<i class="done"></i>`}</div></div></div></div>` : "";
  return `<div class="wc">${wch("users", "Agents", T.helpers.length ? `${T.helpers.length} helpers · the main agent leads` : "the main agent only", `<span class="chip">${ids.length}</span>`)}
    ${tiles}<div class="roster-h" aria-hidden="true"><span></span><span>Agent</span><span>Progress</span><span>Time</span><span>Cost</span></div>${ids.map(a => rosterRow(T, a)).join("")}</div>`;
}
function lanesHTML(T) {
  const rows = agentsOf(T).map(a => {
    const ss = T.spans.filter(s => s.a === a);
    if (!ss.length) return "";
    return `<div class="tl-row ${AG[a].tone}" ${btnRole} ${da("agent", { turn: T.n, id: a })} data-ref="agent:${T.n}:${a}"><span class="tl-lab">${av(a, "xs")}${AG[a].short}</span>
      <div class="tl-trk">${ss.map(s => `<i class="ls k-${s.k}" data-s="${s.s}" data-e="${s.e ?? ""}" title="${esc(`${VERB[s.k]} ${s.l}`)}"></i>`).join("")}</div><span class="tl-dur"></span></div>`;
  }).join("");
  return `<div class="wc">${wch("chart", "Who worked when", T.status === "live" ? "Live · one lane per agent" : `${fmt(T.dur)} · one lane per agent`)}
    <div class="wc-s"><div class="tl lanes" data-turn="${T.n}">${rows}<div class="tl-row tl-axis"><span></span><div class="tl-trk"></div><span></span></div><div class="tl-layer"></div></div>
    <div class="kleg"><span><i class="ls k-think"></i>thinking</span><span><i class="ls k-read"></i>reading</span><span><i class="ls k-tool"></i>tools</span><span><i class="ls k-write"></i>writing</span><span><i class="ls k-wait"></i>waiting</span><span><i class="ls k-you"></i>on you</span></div></div></div>`;
}
function agentsView(T) {
  const u = usage(T);
  if (!T.helpers.length || (T.n === 6 && !sim.planned)) {
    const yet = T.status === "live";
    const did = `<div class="wc">${wch("steps", "What the main agent did", `${T.spans.length} steps`)}<div class="wc-s">${txList(T, "main")}</div></div>`;
    return `${strip(T)}${rosterCard(T)}${yet ? es("yet", "users", "No helpers so far", "They show up here, live, if the agent starts any.") : `<div class="alone">handled alone · no helpers needed</div>`}${did}<div class="stub">${ic("chart")}<b>Timeline</b><small>hidden · one agent</small></div>`;
  }
  const lead = `<p class="lead"><b>${T.helpers.length} helpers</b> worked side by side${u.par > 0 && T.status !== "live" ? ` and saved <b>${dur(u.par)}</b>` : ""}. The main agent planned the work and put it together.</p>`;
  return `${strip(T)}${lead}${rosterCard(T)}${lanesHTML(T)}`;
}

// ---------- live layout: timelines and sparklines ----------
function layoutTL() {
  for (const tl of $$(".tl[data-turn]")) {
    const T = turn(Number(tl.dataset.turn)), lvT = T.status === "live", now = T.dur;
    const ends = $$("[data-e]", tl).map(el => el.dataset.e === "" ? now : Number(el.dataset.e));
    const m = Math.max(now, 1, ...ends), step = m > 150 ? 60 : m > 60 ? 30 : m > 24 ? 10 : 5;
    const max = Math.ceil(m * 1.06 / step) * step, X = v => v / max * 100;
    if (tl.dataset.max !== String(max)) {
      tl.dataset.max = max;
      let t = "", g = "";
      for (let v = 0; v <= max; v += step) {
        if (v < max) t += `<span class="tl-tick" style="left:${X(v)}%">${v < 60 ? `${v}s` : fmt(v)}</span>`;
        if (v > 0) g += `<i class="tl-grid" style="left:${X(v)}%"></i>`;
      }
      $(".tl-axis .tl-trk", tl).innerHTML = t;
      const layer = $(".tl-layer", tl);
      $$(".tl-grid", layer).forEach(x => x.remove());
      layer.insertAdjacentHTML("afterbegin", g);
    }
    const layer = $(".tl-layer", tl);
    let nowEl = $(".tl-now", layer);
    if (lvT && !nowEl) { layer.insertAdjacentHTML("beforeend", `<i class="tl-now"><b></b></i>`); nowEl = $(".tl-now", layer); }
    if (!lvT && nowEl) nowEl.remove();
    if (lvT) { nowEl.style.left = `${X(now)}%`; $("b", nowEl).textContent = dur(now); }
    for (const el of $$("[data-s]:not(.gl)", tl)) {
      const s = Number(el.dataset.s), e = el.dataset.e === "" ? now : Number(el.dataset.e);
      el.style.left = `${X(s)}%`; el.style.width = `${X(Math.max(e - s, 0))}%`;
    }
    for (const el of $$("[data-at]", tl)) el.style.left = `${X(el.dataset.at === "" ? now : Number(el.dataset.at))}%`;
    // labels: after the bar, else before it, else a small chip sitting on it
    for (const el of $$(".gl", tl)) {
      const W = el.parentElement.clientWidth, s = X(Number(el.dataset.s)) / 100 * W, e = X(el.dataset.e === "" ? now : Number(el.dataset.e)) / 100 * W;
      el.classList.remove("in");
      const w = el.offsetWidth;
      if (e + 8 + w <= W) el.style.left = `${e + 8}px`;
      else if (s - 8 - w >= 0) el.style.left = `${s - 8 - w}px`;
      else { el.classList.add("in"); el.style.left = `${Math.max(0, Math.min(s + 6, W - el.offsetWidth))}px`; }
    }
    for (const r of $$(".tl-row", tl)) {
      const d = $(".tl-dur", r), bs = $$(".ls", r);
      if (!d || !bs.length) continue;
      const open = bs.some(b => b.dataset.e === ""), s0 = Math.min(...bs.map(b => Number(b.dataset.s))), e1 = Math.max(...bs.map(b => b.dataset.e === "" ? now : Number(b.dataset.e)));
      d.textContent = dur(e1 - s0) + (open ? "+" : "");
    }
  }
}
function layoutSpark() {
  for (const sv of $$(".spark[data-turn]")) {
    const T = turn(Number(sv.dataset.turn)), a = sv.dataset.a, now = T.dur, ss = T.spans.filter(s => s.a === a);
    if (!ss.length) continue;
    const s0 = ss[0].s, span = Math.max(now - s0, 1), N = 56;
    let d = "";
    for (let i = 0; i <= N; i++) {
      const x = s0 + span * i / N, sp = ss.find(s => x >= s.s && x < (s.e ?? Infinity));
      const r = sp ? RATE[sp.k] * (.8 + .2 * Math.sin(x * 1.9 + a.length)) : 0;
      d += `${i ? "L" : "M"}${(i / N * 100).toFixed(2)} ${(30 - r / .6 * 24).toFixed(2)}`;
    }
    $("path:not(.base)", sv).setAttribute("d", d);
  }
}

// ---------- agent detail (560) ----------
function txList(T, a) {
  const ss = T.spans.filter(s => s.a === a);
  return `<ul class="tx">${ss.map(s => {
    const xs = T.acts.filter(x => x.a === a && x.t >= s.s && x.t < (s.e ?? Infinity) && x.k !== "ok");
    const k = s.k === "you" ? "you" : s.l.includes("blocked") ? "bad" : s.k;
    return `<li><time>${fmt(s.s)}</time><span class="k ${k}${s.e == null ? " open" : ""}"></span><span>${VERB[s.k]} ${esc(s.l)}${xs.map(x => `<small>${x.tag} · ${esc(x.res)}</small>`).join("")}</span><span class="dur">${s.e == null ? "now" : dur(s.e - s.s)}</span></li>`; }).join("")}</ul>`;
}
const stabs = (tabs, on) => `<div class="stabs" role="tablist">${tabs.map(([v, n, c]) => `<button class="stab${v === on ? " on" : ""}" role="tab" aria-selected="${v === on}" ${da("sub", { v })}>${n}${c != null ? ` <span class="n">${c}</span>` : ""}</button>`).join("")}</div>`;
const dnav = (crumb, i, n) => `<div class="dnav"><button class="ibtn" ${da("back")} aria-label="Back">${ic("back")}</button><span class="crumb">${crumb}</span><span class="of">${i + 1} of ${n}</span>
  <button class="ibtn" ${da("step", { d: -1 })} ${i ? "" : "disabled"} aria-label="Previous">${ic("chevl")}</button><button class="ibtn" ${da("step", { d: 1 })} ${i < n - 1 ? "" : "disabled"} aria-label="Next">${ic("chevr")}</button></div>`;
function agentDetail(d) {
  const T = turn(d.turn), a = d.id, ids = agentsOf(T), c = T.crew[a] ?? { task: "Answer your message.", tools: [...new Set(T.acts.map(x => x.k === "web" ? "web" : x.k === "file" ? "file" : ""))].filter(Boolean), usedIn: "Your reply" };
  const st = agStatus(T, a), u = usage(T), r = T.reused, t = T.tok[a] || 0, P = PRICE[AG[a].model];
  const blocks = a === "main" ? (T.status === "done" ? T.reply : []) : outBlocks(T, a), k = a === "main" ? blocks.length : outK(T, a);
  const writing = T.n === 6 && st === "run" && k < blocks.length;
  let body = "";
  if (d.sub === "output") {
    body = k ? `<div class="out">${blocks.slice(0, k).join("")}${writing ? `<span class="caret"></span>` : ""}</div>${writing ? `<div class="streaming">${spin}writing · streams in as ${AG[a].name} works</div>` : ""}
      <div class="acts"><button class="btn" ${da("toast", { msg: "Copied" })}>${ic("copy")}Copy</button><button class="btn" ${da("gochat")}>${ic("insert")}See it in chat</button></div>`
      : T.status === "stopped" ? es("bad", "x", "No output", "The turn stopped before the main agent replied.") : `<div class="streaming">${spin}${st === "wait" ? "Waiting for your OK in chat" : "Working"} · output appears here as it's written</div><div class="skel"><i style="width:80%"></i><i></i><i style="width:60%"></i></div>`;
  } else if (d.sub === "task") {
    body = `<blockquote class="quote">${esc(c.task)}</blockquote><dl class="kv"><dt>Sent</dt><dd class="mono">${T.at} + ${fmt(agSpan(T, a)[0])}</dd><dt>Tools</dt><dd>${c.tools.map(x => `<span class="chip">${TOOLS[x]}</span>`).join("") || "none"}</dd><dt>Model</dt><dd><span class="chip">${AG[a].model}</span></dd></dl>`;
  } else if (d.sub === "transcript") {
    body = txList(T, a);
  } else {
    const steps = (T.plan ?? []).map((s, i) => [s, i]).filter(([s]) => s.who.includes(a));
    const files = filesIn(T).filter(f => f.by === a || f.from.includes(a));
    body = `<div class="used">${steps.map(([s, i]) => `<button class="u" ${da("openstep", { i })}><span class="tile">${ic("steps")}</span><span class="ttl">Step ${i + 1} · ${esc(s.t)}</span><small>${esc(s.made || "in progress")}</small></button>`).join("")}
      ${files.map(f => `<button class="u" ${da("file", { id: f.id })} data-ref="file:${f.id}">${ftile(f, "sm")}<span class="ttl">${esc(f.name)}</span><small>${f.by === a ? "Written by" : "Built from"} ${AG[a].name}'s work</small></button>`).join("")}
      <button class="u" ${da("gochat")}><span class="tile">${ic("insert")}</span><span class="ttl">${esc(c.usedIn)}</span><small>in the chat</small></button></div>`;
  }
  return `${dnav(`Agents / <b>${AG[a].name}</b>`, ids.indexOf(a), ids.length)}
    <div class="dhead">${av(a, "xl")}<h3>${AG[a].name}</h3>${statusChip({ ...T, n: st === "wait" ? T.n : 0, status: st === "done" ? "done" : st === "stopped" ? "stopped" : "live", plan: 1 })}<small>${AG[a].role} · turn ${T.n}</small></div>
    <div class="dstats"><div><b>${lv("agdur", T.n, a)}</b><span>time</span></div><div><b>${lv("agcost", T.n, a)}</b><span>cost</span></div><div><b>${lv("agtok", T.n, a)}</b><span>tokens</span></div><div><b>${AG[a].model}</b><span>model</span></div></div>
    <div class="costblock"><div><b>${money(t * (1 - r) * P)}</b><span>model tokens</span></div><div><b>${money(t * r * P * REUSE_RATE)}</b><span>reused · ${pct(r)}</span></div><div><b>${money((u.cost[a] || 0) - t * (1 - r) * P - t * r * P * REUSE_RATE)}</b><span>paid tools</span></div></div>
    ${c.warn ? `<div class="banner">${ic("warn")}<div class="grow">${esc(c.warn)}</div></div>` : ""}
    ${st === "wait" ? `<div class="banner info">${ic("lock")}<div class="grow"><span>Hubble asked to read your Strava runs. The OK is in the chat.</span><div class="row"><button class="lnk" ${da("gochat")}>Go to the request ${ic("ext")}</button></div></div></div>` : ""}
    ${stabs([["output", "Output"], ["task", "Task"], ["transcript", "Transcript", T.spans.filter(s => s.a === a).length], ["used", "Used in"]], d.sub)}${body}`;
}

// ---------- file viewer (560) ----------
function sheetGrid(rows) {
  const [h, ...r] = rows;
  return `<table><tr><th></th>${h.map(c => `<th>${esc(c)}</th>`).join("")}</tr>${r.map((row, i) => `<tr><td class="rn">${i + 1}</td>${row.map(c => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</table>`;
}
const toText = h => h.replace(/<h1>/g, "# ").replace(/<h2>/g, "\n## ").replace(/<tr>/g, "\n| ").replace(/<\/t[dh]>/g, " | ").replace(/<p class="sub">/g, "_").replace(/<\/p>/g, "\n").replace(/<[^>]+>/g, "").replace(/\n{3,}/g, "\n\n").trim();
function fileDetail(d) {
  const f = fileById(d.id), st = fstate(f), T = turn(f.turn), sibs = filesIn(T), i = sibs.indexOf(f);
  const head = `${dnav(`Files / <b>${esc(f.name)}</b>`, i, sibs.length)}
    <div class="dhead">${ftile(f, "xl")}<h3>${esc(f.name)}</h3>${st.s === "ready" ? `<span class="chip ok">${ic("check")}Ready</span>` : st.s === "writing" ? `<span class="chip run">${spin}${lv("fpct", f.id)}</span>` : `<span class="chip">queued</span>`}<small>${FTYPE[f.type][1]} · turn ${f.turn}</small></div>
    <div class="dstats"><div><b>${FTYPE[f.type][0]}</b><span>type</span></div><div><b>${st.s === "ready" ? f.size : "—"}</b><span>size</span></div><div><b>v${f.ver}</b><span>version</span></div><div><b>${av(f.by, "xs")}${AG[f.by].short}</b><span>made by</span></div></div>`;
  if (st.s === "queued") return head + es("yet", "clock", "Queued", "This file is written in the last step, once the plan is combined. It appears here as soon as writing starts.");
  if (st.s === "writing") return head + `<div class="streaming">${spin}Writing · ${lv("fpct", f.id)}</div><div class="trk"><i class="live" ${ls("fprog", f.id)}></i></div><div class="skel"><i style="width:55%;height:14px"></i><i></i><i style="width:90%"></i><i style="width:70%"></i><i></i></div>`;
  const sheets = SHEETS[f.id], names = sheets ? Object.keys(sheets) : [];
  let body;
  if (d.sub === "changes" && f.prev) body = DIFF;
  else if (d.sub === "source") body = `<pre class="src">${esc(f.type === "png" ? `section,pace_per_km\n${SPLITS.map(s => `${s[0]},${s[1]}`).join("\n")}` : sheets ? sheets[names[d.sheet]].map(r => r.join(",")).join("\n") : toText(f.doc))}</pre>${f.type === "png" ? `<span class="sandbox-note">${ic("chart")}the data behind the chart</span>` : ""}`;
  else if (f.type === "docx") body = `<div class="docp">${f.doc}</div>`;
  else if (f.type === "png") body = `<div class="pchart">${PACESVG()}</div>`;
  else body = `<div class="gridp"><div class="scroll">${sheetGrid(sheets[names[d.sheet]])}</div><div class="sheets">${names.map((n, j) => `<button class="${j === d.sheet ? "on" : ""}" ${da("sheet", { i: j })}>${esc(n)}</button>`).join("")}</div></div>`;
  const tabs = [["preview", "Preview"], ["source", f.type === "png" ? "Data" : "Source"], ...(f.prev ? [["changes", "Changes"]] : [])];
  return `${head}${isWide() ? "" : `<div class="hint">${ic("expand")}Wider preview<button class="btn" ${da("wide")}>Expand</button></div>`}${stabs(tabs, d.sub)}${body}
    <div class="acts"><button class="btn" ${da("toast", { msg: `Downloading ${f.name}` })}>${ic("down")}Download</button>${f.type !== "png" ? `<button class="btn" ${da("toast", { msg: "Copied" })}>${ic("copy")}Copy</button>` : ""}<button class="btn" ${da("toast", { msg: "Opens in a new tab" })}>${ic("ext")}Open in new tab</button></div>
    ${f.from.length ? `<div class="builtfrom">Built from ${f.from.map(h => `<button ${da("agent", { turn: T.n, id: h })} data-ref="agent:${T.n}:${h}">${av(h, "xs")}${AG[h].name}</button>`).join("")}</div>` : ""}`;
}

// ---------- chat (where the user acts) ----------
const tkIcon = st => st === "done" ? `<span class="tk d">${ic("check")}</span>` : st === "live" ? `<span class="tk l">${spin}</span>` : st === "fail" ? `<span class="tk f">${ic("x")}</span>` : st === "skip" ? `<span class="tk s"></span>` : `<span class="tk"></span>`;
function todoCard(T) {
  const steps = T.plan, done = steps.filter(s => (s.st ?? "done") === "done").length;
  return `<div class="ccard todo-c"><div class="ccard-h">${ic("steps")}Plan <small>${done} of ${steps.length} done</small><button class="btn" ${da("open", { turn: T.n, tab: "plan" })}>Details</button></div>
    ${steps.map((s, i) => { const st = s.st ?? "done"; return `<div class="crow">${tkIcon(st)}<span class="nm ${st === "done" ? "done" : st === "skip" ? "skip" : ""}">${esc(s.t)}</span><time>${st === "live" ? lv("stepdur", T.n, i) : st === "done" || st === "fail" ? fmt(s.e - s.s) : ""}</time></div>`; }).join("")}</div>`;
}
function helpersCard(T) {
  return `<div class="ccard"><div class="ccard-h">${ic("users")}${T.helpers.length} helpers <small>${T.status === "live" ? "working" : "done"}</small><button class="btn" ${da("open", { turn: T.n, tab: "agents" })}>Open</button></div>
    ${T.helpers.map(a => { const st = agStatus(T, a);
      const chip = st === "run" ? `<span class="chip run">${lv("agdur", T.n, a)}</span>` : st === "wait" ? `<span class="chip warn">needs your OK</span>` : st === "queued" ? `<span class="chip">queued</span>` : `<span class="chip ok">${ic("check")}done</span>`;
      return `<button class="crow" ${da("agent", { turn: T.n, id: a })} data-ref="agent:${T.n}:${a}">${av(a)}<span class="nm">${AG[a].name} <small>· ${AG[a].role}</small></span>${chip}</button>`; }).join("")}</div>`;
}
function fileCard(T) {
  const fs = filesIn(T).filter(f => fstate(f).s === "ready"); if (!fs.length) return "";
  const main = fs.find(f => f.type === "docx") ?? fs[0], more = fs.length - 1;
  return `<div class="ccard"><div class="ccard-h">${ic("file")}${fs.length} file${fs.length > 1 ? "s" : ""} <small>ready</small><button class="btn" ${da("open", { turn: T.n, tab: "files" })}>All files</button></div>
    <button class="crow" ${da("file", { id: main.id })} data-ref="file:${main.id}">${ftile(main, "sm")}<span class="nm">${esc(main.name)} <small>· ${main.size}${main.ver > 1 ? ` · v${main.ver}` : ""}</small></span><span class="chip ok">Open</span></button>
    ${more ? `<button class="crow" ${da("open", { turn: T.n, tab: "files" })}><span class="tk s"></span><span class="nm"><small>+${more} more · ${fs.filter(f => f !== main).map(f => f.name).join(", ")}</small></span>${ic("chevr")}</button>` : ""}</div>`;
}
function apprCard(n) {
  if (n === 5) return `<div class="appr done"><div class="h">${fav("connect.garmin.com")}Garmin Connect · create calendar events<span class="chip">${ic("check")}Allowed once</span></div></div>`;
  if (sim.approval === "none") return "";
  if (sim.approval !== "pending") return `<div class="appr done" id="ask6"><div class="h">${fav("strava.com")}Strava · read your last 8 long runs<span class="chip${sim.approval === "skipped" ? " skip" : ""}">${sim.approval === "allowed" ? `${ic("check")}Allowed once` : "Skipped"}</span></div></div>`;
  return `<div class="appr" id="ask6" role="alert"><div class="h">${ic("lock")}Hubble wants to use Strava<span class="chip">${fav("strava.com")}App · Strava</span></div>
    <p>To plan race-day fuel, Hubble wants to <b>read your last 8 long runs</b>. Read only: nothing in Strava gets changed.</p>
    <div class="r"><button class="btn solid" ${da("allow")}>${ic("check")}Allow once</button><button class="btn" ${da("skip")}>Skip</button><small>waiting ${lv("ask")}</small></div></div>`;
}
const receipt = T => `<button class="receipt" ${da("open", { turn: T.n })}>${T.status === "live" ? `${spin}${lv("dur", T.n)}` : T.status === "stopped" ? `${ic("stop")}stopped` : fmt(T.dur)}<span class="sep">·</span>≈ ${lv("cost", T.n)}<span class="sep">·</span><b>View activity</b></button>`;
function chatHTML() {
  return ALL.map(n => {
    const T = turn(n);
    let body = "";
    if (n === 5) body += apprCard(5);
    if (T.plan) body += todoCard(T);
    if (n === 6) body += apprCard(6);
    if (T.helpers.length && (n !== 6 || sim.planned)) body += helpersCard(T);
    if (T.status === "stopped") body += `<div class="errc"><div class="h">${ic("x")}Garmin Connect didn't respond</div><p>${esc(T.stop.why)}</p>
      <div class="r"><button class="btn solid" ${da("toast", { msg: "Retry would start again from step 2 · demo only" })}>${ic("retry")}Retry step 2</button><button class="btn" ${da("toast", { msg: "Would delete the empty calendar · demo only" })}>Remove empty calendar</button></div></div>`;
    if (T.status === "live") body += `<span class="typing" aria-label="Working"><i></i><i></i><i></i></span>`;
    else body += T.reply.map(p => p.startsWith("<table") ? p : `<p>${p}</p>`).join("") + fileCard(T);
    return `<div class="turn-mark" id="turn-${n}">Turn ${n} · ${T.at}</div><div class="msg-u">${esc(T.q)}</div>
      <div class="msg-a">${av("main", "lg")}<div class="body">${body}${receipt(T)}</div></div>`;
  }).join("");
}
T6BASE.reply = ["Done. I've added a <b>meal plan</b> for run, rest and long-run days, a <b>pacing chart</b> for a 4:15 finish, and updated your plan to <b>v2</b> with both."];
const composerHTML = () => `<span>Reply to the coach…</span>${live6() ? `<button class="btn stopb" ${da("toast", { msg: "Stop ends the turn and keeps finished work · demo only" })}>${ic("stop")}Stop</button>` : ""}<button class="btn solid" ${da("toast", { msg: "The composer is static in this demo" })}>${ic("send")}Send</button>`;

// ---------- render ----------
function bodyHTML() {
  const d = ui.detail, T = turn(ui.turn);
  if (d?.kind === "agent") return agentDetail(d);
  if (d?.kind === "file") return fileDetail(d);
  return { files: filesView, insights: insightsView, plan: planView, agents: agentsView }[ui.tab](T);
}
function footHTML() {
  const T = turn(ui.turn);
  if (ui.detail) return `<span>Esc to go back</span>`;
  const hint = { files: "click a file to preview it", insights: `turn ${T.n} only`, plan: "tap a step for detail", agents: "click an agent for detail" }[ui.tab];
  return `<span>${hint}</span><span class="ro" title="Approvals, retry and stop live in the chat">${ic("lock")}read-only</span>`;
}
let lastKey = "", lastSig = "";
const viewKey = () => JSON.stringify([ui.turn, ui.tab, ui.detail && [ui.detail.kind, ui.detail.id, ui.detail.turn, ui.detail.sub]]);
// Anything that changes markup (not just numbers) goes in the signature; a change re-renders.
const sig = () => [sim.fired, sim.approval, ...T6BASE.helpers.map(a => outK(turn(6), a)), ...["f3", "f4", "f5"].map(id => fstate(fileById(id)).s)].join("|");
function render() {
  const side = $("#side"), body = $("#pbody"), chat = $("#chatScroll");
  side.hidden = !ui.open; $("#reopen").hidden = ui.open;
  side.classList.toggle("wide", isWide());
  const key = viewKey(), keep = key === lastKey ? body.scrollTop : 0, chatKeep = chat.scrollTop;
  const atBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 60;
  $("#phead").innerHTML = headHTML();
  body.innerHTML = bodyHTML();
  $("#pfoot").innerHTML = footHTML();
  $("#chatCol").innerHTML = chatHTML();
  $("#composer").innerHTML = composerHTML();
  body.scrollTop = keep; lastKey = key;
  chat.scrollTop = atBottom ? chat.scrollHeight : chatKeep;
  lastSig = sig();
  live();
}
function live() {
  if (sig() !== lastSig) return render();
  for (const el of $$("[data-lv]")) { const v = LV[el.dataset.lv](...el.dataset.a.split("|")); if (el.textContent !== v) el.textContent = v; }
  for (const el of $$("[data-ls]")) { const [p, v] = LS[el.dataset.ls](...el.dataset.a.split("|")); if (p.startsWith("--")) el.style.setProperty(p, v); else el.style[p] = v; }
  layoutTL(); layoutSpark();
}

// ---------- events ----------
let toastTimer;
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("on"); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("on"), 2200); }
function openDetail(detail) { ui.detail = detail; ui.narrow = false; ui.picker = false; ui.open = true; }
function stepDetail(dir) {
  const d = ui.detail;
  if (d.kind === "agent") { const ids = agentsOf(turn(d.turn)); d.id = ids[clamp(ids.indexOf(d.id) + dir, 0, ids.length - 1)]; }
  else { const f = fileById(d.id), sibs = filesIn(turn(f.turn)); d.id = sibs[clamp(sibs.indexOf(f) + dir, 0, sibs.length - 1)].id; d.sheet = 0; d.sub = "preview"; }
}
function goChat() {
  const T = turn(ui.turn), el = T.n === 6 && $("#ask6") ? $("#ask6") : T.status === "stopped" ? $(`#turn-${T.n} ~ .msg-a .errc`) : $(`#turn-${T.n}`);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  if (el.classList.contains("appr") || el.classList.contains("errc")) { el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash"); }
}
const ACTIONS = {
  picker: () => { ui.picker = !ui.picker; },
  pick: el => goTurn(Number(el.dataset.n)),
  jump: () => goTurn(6),
  tab: el => { ui.tab = ui.userTab = el.dataset.v; ui.detail = null; ui.picker = false; },
  agent: el => { const n = Number(el.dataset.turn); if (n !== ui.turn) goTurn(n); ui.tab = "agents"; openDetail({ kind: "agent", turn: n, id: el.dataset.id, sub: "output" }); },
  file: el => { const f = fileById(el.dataset.id); if (f.turn !== ui.turn) goTurn(f.turn); ui.tab = "files"; openDetail({ kind: "file", id: f.id, sub: el.dataset.sub ?? "preview", sheet: 0 }); },
  open: el => { ui.open = true; goTurn(Number(el.dataset.turn)); if (el.dataset.tab) ui.tab = el.dataset.tab; },
  back: () => { ui.detail = null; },
  step: el => stepDetail(Number(el.dataset.d)),
  sub: el => { ui.detail.sub = el.dataset.v; },
  sheet: el => { ui.detail.sheet = Number(el.dataset.i); },
  stepx: el => { const i = Number(el.dataset.i); ui.openStep = ui.openStep === i ? null : i; },
  openstep: el => { ui.detail = null; ui.tab = "plan"; ui.openStep = Number(el.dataset.i); },
  filter: el => { ui.filter = el.dataset.v; },
  flag: el => { ui.tab = "plan"; ui.filter = el.dataset.k; ui.detail = null; },
  gochat: () => { goChat(); return false; },
  allow: () => { decide(true); toast("Allowed once · Hubble is reading your Strava runs"); },
  skip: () => { decide(false); toast("Skipped · Hubble will use standard guidance"); },
  wide: () => { if (ui.detail) ui.narrow = !ui.narrow; else ui.wide = !ui.wide; },
  close: () => { ui.open = false; ui.picker = false; },
  reopen: () => { ui.open = true; },
  speed: el => { sim.speed = Number(el.dataset.v); $$("#speedSeg button").forEach(b => b.classList.toggle("on", b === el)); return false; },
  replay: () => { const s = sim.speed; resetSim(0); sim.speed = s; goTurn(6); toast("Replaying turn 6 from the start"); },
  theme: () => {
    const r = document.documentElement;
    const next = r.dataset.effTheme === "dark" ? "light" : "dark";
    r.dataset.theme = next; r.dataset.effTheme = next;
    try { localStorage.setItem("tx-sys-theme", next); } catch (e) {}
    return false;
  },
  toast: el => { toast(el.dataset.msg); return false; },
};
document.addEventListener("click", e => {
  let el = e.target.closest("[data-act]");
  if (!el) { if (ui.picker && !e.target.closest(".picker")) { ui.picker = false; render(); } return; }
  if (el.dataset.act === "stepx" && e.target.closest("[data-noclose]")) return; // clicks inside an open step don't fold it
  if (el.disabled) return;
  const fn = ACTIONS[el.dataset.act];
  if (!fn) return;
  e.stopPropagation();
  if (fn(el) !== false) render();
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape") { if (ui.picker) ui.picker = false; else if (ui.detail) ui.detail = null; else return; render(); return; }
  if ((e.key === "Enter" || e.key === " ") && e.target.matches('[role="button"]')) { e.preventDefault(); e.target.click(); }
});
// Hovering an agent or a file lights it up everywhere it appears (chat and panel).
document.addEventListener("mouseover", e => {
  const el = e.target.closest("[data-ref]"), ref = el?.dataset.ref || "";
  if (ref === document.body.dataset.hl) return;
  $$(".hl").forEach(x => x.classList.remove("hl"));
  document.body.dataset.hl = ref;
  if (ref) $$(`[data-ref="${CSS.escape(ref)}"]`).forEach(x => x !== el && x.classList.add("hl"));
});

// ---------- boot ----------
// The foundation head bootstrap sets the theme. ?t=<seconds into turn 6>,
// ?turn=<n>&tab=<tab>, ?decide=allow|block, ?run=<seconds> are review shortcuts.
const QP = new URLSearchParams(location.search);
resetSim(Number(QP.get("t") ?? 20));   // opens mid-turn: helpers are researching and Hubble is asking for Strava
if (QP.get("decide")) decide(QP.get("decide") === "allow");
if (QP.get("run")) advance(sim.t + Number(QP.get("run")));
goTurn(Number(QP.get("turn") ?? 6));
if (QP.get("tab")) ui.tab = QP.get("tab");
render();
$("#chatScroll").scrollTop = $("#chatScroll").scrollHeight;
const TICK = 250;
setInterval(() => { if (live6()) advance(sim.t + TICK / 1000 * sim.speed); live(); }, TICK);

