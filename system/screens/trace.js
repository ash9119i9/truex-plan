/* trace — the observability part at the end of each agent turn.
   A receipt line (time, tokens, model, privacy) opens the trace card ported
   from charts/v2-premium/trace-card-v2.html: step waterfall, token receipt,
   context jar, timing and privacy, plus a Dev view of the model context. Figures are sample data until turns report real telemetry. */
(function () {
  "use strict";

  var WINDOW = 258000;
  var MODEL = "Sonnet 5.5";
  // tokens spent per second of step time, by step kind
  var RATE = { think: 494, file: 890, tool: 363, write: 350 };
  var KIND = { think: "Thinking", file: "Reading files", tool: "Tool calls", write: "Writing" };
  var ORDER = ["think", "file", "tool", "write"];
  var FILES = ["reports/q3-summary.md", "notes/meeting-notes.md", "handbook/week-one.md", "data/accounts.csv"];
  // the first turn mirrors the reference card exactly
  var FIRST = [
    ["Thinking", "think", 5],
    ["Search handbook", "tool", 9],
    ["Read week-one.md", "file", 15, "handbook/week-one.md"],
    ["Read access-requests.md", "file", 15, "handbook/access-requests.md", true],
    ["Google Calendar lookup", "tool", 18],
    ["Thinking", "think", 6],
    ["Write shadowing slots", "write", 16],
    ["Thinking", "think", 6],
    ["Writing answer", "write", 22]
  ];
  var reduce = matchMedia("(prefers-reduced-motion: reduce)");
  var state;

  // the context window carries across turns of one conversation
  function fresh() { state = { docs: 0, convo: 0, files: {}, seq: 0 }; }
  fresh();

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function k(n) { return n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") + "k" : String(Math.round(n)); }
  function dur(s) {
    if (s < 10) return s.toFixed(1) + "s";
    if (s < 60) return Math.round(s) + "s";
    return Math.floor(s / 60) + "m " + Math.round(s % 60) + "s";
  }
  function hash(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function rng(seed) {
    return function () {
      seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function ic(id, extra) { return '<svg class="tx-ic tx-ic-sm' + (extra || "") + '" aria-hidden="true"><use href="#i-' + id + '"/></svg>'; }

  /* ── sample telemetry for one turn ──────────────────────────────────────── */
  function build(info) {
    var r = rng(hash(info.prompt) + info.turn * 7919);
    var steps;
    if (info.turn === 0) {
      steps = FIRST.map(function (s) { return { label: s[0], kind: s[1], dur: s[2], file: s[3], flag: !!s[4] }; });
    } else {
      var file = FILES[Math.floor(r() * FILES.length)];
      steps = [
        { label: "Thinking", kind: "think", dur: Math.round((3 + r() * 3) * 10) / 10 },
        { label: "Search workspace", kind: "tool", dur: Math.round(5 + r() * 5) },
        { label: "Read " + file.split("/").pop(), kind: "file", dur: Math.round(8 + r() * 8), file: file }
      ];
      if (r() > 0.5) steps.push({ label: "Run query", kind: "tool", dur: Math.round(6 + r() * 6) });
      steps.push({ label: "Thinking", kind: "think", dur: Math.round((3 + r() * 3) * 10) / 10 });
      steps.push({ label: "Writing answer", kind: "write", dur: Math.round(10 + r() * 10) });
    }

    var wall = 0;
    steps.forEach(function (s) { s.start = wall; wall += s.dur; });

    var by = { think: 0, file: 0, tool: 0, write: 0 };
    steps.forEach(function (s) { by[s.kind] += s.dur * RATE[s.kind]; });
    var total = ORDER.reduce(function (a, kd) { return a + by[kd]; }, 0);

    // billed as · later turns hit the prompt cache harder
    var cache = total * (info.turn === 0 ? 0.192 : 0.41);
    var out = total * 0.105;
    var rsn = total * 0.043;
    var roles = { in: total - cache - out - rsn, cache: cache, out: out, rsn: rsn };

    // the context window after this turn
    steps.forEach(function (s) {
      if (s.file) state.files[s.file] = (state.files[s.file] || 0) + s.dur * RATE.file * 1.457;
    });
    state.docs += by.file * 1.457;
    state.convo += by.write * 1.3 + 600;
    var ctx = { sys: 1200, tools: 3400, docs: state.docs, convo: state.convo };
    var used = ctx.sys + ctx.tools + ctx.docs + ctx.convo;

    var stream = Math.max(wall - 4, 1);
    var data = {
      id: "ob-" + (++state.seq),
      n: info.turn + 1,
      time: info.time || "",
      prompt: info.prompt,
      steps: steps,
      wall: wall,
      by: by,
      total: total,
      roles: roles,
      ctx: ctx,
      used: used,
      files: Object.keys(state.files).map(function (f) { return [f, state.files[f]]; }),
      reading: by.file * 1.457,
      finding: steps.some(function (s) { return s.flag; }),
      timing: [
        ["Accept", Math.round(30 + r() * 30) + "ms"],
        ["First token", Math.round(400 + r() * 400) + "ms"],
        ["Stream", dur(stream)],
        ["Longest gap", Math.round(100 + r() * 120) + "ms"],
        ["Rate", Math.round(out / stream) + " tok/s"],
        ["Finalize", Math.round(40 + r() * 30) + "ms"]
      ]
    };
    return data;
  }

  /* ── receipt line ───────────────────────────────────────────────────────── */
  function receipt(d) {
    return '<div class="ob-receipt">' +
      '<span class="ob-rc">' + ic("clock") + '<span class="num">' + dur(d.wall) + '</span></span>' +
      '<span class="ob-rc">' + ic("sigma") + '<span class="num">' + k(d.total) + '</span> tokens</span>' +
      '<span class="ob-rc">' + ic("spark") + MODEL + '</span>' +
      (d.finding ? '<span class="tx-pill tx-pill-warn tx-pill-sm ob-privacy">' + ic("shield") + '1 privacy</span>' : "") +
      '<span class="ob-receipt-end">' +
        '<button class="tx-btn tx-ghost tx-xs cs-act-copy" type="button">' + ic("copy") + '<span class="cs-act-label">Copy</span></button>' +
        '<button class="ob-details" type="button" aria-expanded="false" aria-controls="' + d.id + '">Details' + ic("chev-down", " ob-chev") + '</button>' +
      '</span>' +
    '</div>';
  }

  /* ── trace card ─────────────────────────────────────────────────────────── */
  function waterfall(d) {
    function p(x) { return (x / d.wall * 100).toFixed(3); }
    var axis = [0, 0.25, 0.5, 0.75].map(function (q) {
      return '<span class="num" style="left:' + q * 100 + '%">' + (q ? dur(d.wall * q) : "0s") + '</span>';
    }).join("") + '<span class="num ob-end" style="left:100%">' + dur(d.wall) + '</span>';
    var rows = d.steps.map(function (s) {
      return '<div class="ob-row"><span class="ob-lab"><span>' + esc(s.label) + '</span>' +
        (s.flag ? '<svg class="tx-ic tx-ic-sm ob-mark" role="img" aria-label="privacy finding"><use href="#i-shield"/></svg>' : "") +
        '</span><span class="ob-trk"><i class="ob-bar ob-k-' + s.kind + '" style="left:' + p(s.start) + '%;width:' + p(s.dur) + '%"></i></span>' +
        '<span class="ob-dur num">' + dur(s.dur) + '</span></div>';
    }).join("");
    var table = d.steps.map(function (s) {
      return '<tr><td>' + esc(s.label) + '</td><td>' + KIND[s.kind].replace(/s$/, "") + '</td><td class="num">' + Math.round(s.start) + 's</td><td class="num">' + dur(s.dur) + '</td><td>Done' + (s.flag ? " · privacy" : "") + '</td></tr>';
    }).join("");
    var tools = d.steps.filter(function (s) { return s.kind === "tool"; }).length;
    var reads = d.steps.filter(function (s) { return s.kind === "file"; }).length;

    return '<div class="ob-sec">' +
      '<div class="ob-sh">' + ic("list") + 'Steps<span class="ob-r num">' + dur(d.wall) + ' wall time</span></div>' +
      '<p class="ob-summary">' + d.steps.length + ' steps over ' + dur(d.wall) + ', all in the main agent. It made ' + tools + ' tool call' + (tools === 1 ? "" : "s") + ', read ' + reads + ' file' + (reads === 1 ? "" : "s") + ' and wrote the answer. No helpers were spawned.' + (d.finding ? " One step read a file with a privacy finding." : "") + '</p>' +
      '<div class="ob-wf-scroll" tabindex="0" role="group" aria-label="Step waterfall, scrollable">' +
        '<div class="ob-wf">' +
          '<div class="ob-grid" aria-hidden="true"><i style="left:25%"></i><i style="left:50%"></i><i style="left:75%"></i></div>' +
          '<div class="ob-axis" aria-hidden="true">' + axis + '</div>' +
          '<div class="ob-row ob-grp"><span class="ob-lab"><i class="ob-id-dot ob-id-main" aria-hidden="true"></i><span>Main <small>solo</small></span></span><span class="ob-trk"><i class="ob-life ob-id-main" style="left:0;width:100%"></i></span><span class="ob-dur num">' + dur(d.wall) + '</span></div>' +
          rows +
        '</div>' +
      '</div>' +
      '<div class="ob-legend" aria-hidden="true">' +
        '<span><i class="ob-sw ob-k-think"></i>Thinking</span><span><i class="ob-sw ob-k-file"></i>Reading files</span>' +
        '<span><i class="ob-sw ob-k-tool"></i>Tool call</span><span><i class="ob-sw ob-k-write"></i>Writing</span>' +
        (d.finding ? '<span>' + ic("shield", " ob-mark") + 'Privacy</span>' : "") +
      '</div>' +
      '<details class="ob-table-alt"><summary>Waterfall as a table</summary>' +
        '<div class="ob-tbl-wrap"><table class="ob-tbl"><caption class="tx-sr">T' + d.n + ' steps</caption>' +
        '<thead><tr><th scope="col">Step</th><th scope="col">Kind</th><th scope="col">Start</th><th scope="col">Duration</th><th scope="col">Status</th></tr></thead>' +
        '<tbody>' + table + '</tbody></table></div>' +
      '</details>' +
    '</div>';
  }

  function slip(d) {
    var lines = ORDER.filter(function (kd) { return d.by[kd] > 0; })
      .sort(function (a, b) { return d.by[b] - d.by[a]; })
      .map(function (kd) {
        return '<li><i class="ob-k-' + kd + '"></i><span>' + KIND[kd] + '</span><span class="ob-slip-lead" aria-hidden="true"></span><b class="num">' + k(d.by[kd]) + '</b><em class="num">' + Math.round(d.by[kd] / d.total * 100) + '%</em></li>';
      }).join("");
    var R = d.roles;
    var code = "T" + d.n + " · " + k(d.total).toUpperCase() + " · " + d.steps.length + " STEPS";
    return '<div class="ob-sec">' +
      '<div class="ob-sh">' + ic("sigma") + 'Tokens<span class="ob-r num">' + k(d.total) + '</span></div>' +
      '<div class="ob-slip-wrap"><article class="ob-slip" aria-label="Token receipt for T' + d.n + ': ' + k(d.total) + ' tokens, all in the main agent.">' +
        '<header class="ob-slip-head"><span class="ob-slip-kicker">Token receipt</span><span class="ob-slip-meta num">T' + d.n + ' · ' + esc(d.time) + ' · main</span></header>' +
        '<div class="ob-slip-sub"><span>Where it went</span><em>by step kind</em></div>' +
        '<ul class="ob-slip-lines">' + lines + '</ul>' +
        '<div class="ob-slip-sub"><span>Billed as</span><em>by token role</em></div>' +
        '<div class="ob-slip-mix" role="img" aria-label="Token role mix: input ' + k(R.in) + ', cached input ' + k(R.cache) + ', output ' + k(R.out) + ', reasoning ' + k(R.rsn) + '.">' +
          '<i class="ob-t-in" style="flex-grow:' + Math.round(R.in / 100) + '"></i><i class="ob-t-cache" style="flex-grow:' + Math.round(R.cache / 100) + '"></i>' +
          '<i class="ob-t-out" style="flex-grow:' + Math.round(R.out / 100) + '"></i><i class="ob-t-rsn" style="flex-grow:' + Math.round(R.rsn / 100) + '"></i>' +
        '</div>' +
        '<div class="ob-slip-mixkey">' +
          '<span><i class="ob-t-in"></i>Input <b class="num">' + k(R.in) + '</b></span><span><i class="ob-t-cache"></i>Cached <b class="num">' + k(R.cache) + '</b></span>' +
          '<span><i class="ob-t-out"></i>Output <b class="num">' + k(R.out) + '</b></span><span><i class="ob-t-rsn"></i>Reasoning <b class="num">' + k(R.rsn) + '</b></span>' +
        '</div>' +
        '<div class="ob-slip-total"><span>Total <em>two cuts, one total</em></span><b class="num">' + k(d.total) + '</b></div>' +
        '<footer class="ob-slip-foot"><span class="ob-slip-stamp">No helpers</span><span class="ob-slip-code num">' + code + '</span></footer>' +
        '<div class="ob-slip-barcode" aria-hidden="true"></div>' +
        '<svg class="ob-slip-tear" viewBox="0 0 400 8" preserveAspectRatio="none" aria-hidden="true"><path d="' + tear() + '"/></svg>' +
      '</article></div>' +
    '</div>';
  }
  function tear() {
    var path = "M0 0 H400";
    for (var x = 400; x > 0; x -= 20) path += " L" + (x - 10) + " 8 L" + (x - 20) + " 0";
    return path + " Z";
  }

  function jar(d) {
    var C = d.ctx, BOTTOM = 198, H = 164, TOP = BOTTOM - H;
    var y = BOTTOM;
    var layers = ["sys", "tools", "docs", "convo"].map(function (key) {
      var h = C[key] / WINDOW * H;
      y -= h;
      return '<rect class="ob-jar-layer ob-c-' + key + '" x="20" y="' + y.toFixed(2) + '" width="110" height="' + h.toFixed(2) + '"/>';
    }).join("");
    var fill = Math.max(y, TOP);
    var pct = Math.round(d.used / WINDOW * 100);
    var free = WINDOW - d.used;
    var docShare = Math.round(C.docs / d.used * 100);
    var room = WINDOW * 0.75 - d.used;
    var tip = room > 0
      ? 'Docs are <b>' + docShare + '%</b> of the load. Room for about <b>' + Math.max(1, Math.floor(room / Math.max(d.reading, 8000))) + ' more turns’ worth of reading</b> before the 75% warn.'
      : 'Past the <b>75% warn</b>. Compact the conversation or start a new one.';
    var shape = "M54 18h42v16c18 3 34 16 34 36v110c0 12-10 22-22 22H42c-12 0-22-10-22-22V70c0-20 16-33 34-36Z";
    var id = d.id;
    var lids = [56, 62, 68, 74, 80, 86, 92].map(function (x) { return '<line x1="' + x + '" y1="10" x2="' + x + '" y2="20"/>'; }).join("");

    return '<div class="ob-sec">' +
      '<div class="ob-sh">' + ic("layers") + 'Context window<span class="ob-r num">warn 75 · full 90</span></div>' +
      '<div class="ob-jar-row">' +
        '<div class="ob-jar-wrap">' +
          '<div class="ob-jar-tag" aria-hidden="true"><span>CTX · 258K</span><b>T' + d.n + ' · sample</b></div>' +
          '<svg class="ob-jar" viewBox="0 0 150 210" role="img" aria-label="Context window: ' + k(d.used) + ' of 258k used, ' + pct + ' percent full. System ' + k(C.sys) + ', tools ' + k(C.tools) + ', workspace docs ' + k(C.docs) + ', conversation ' + k(C.convo) + ', free ' + k(free) + '.">' +
            '<defs>' +
              '<clipPath id="' + id + '-clip"><path d="' + shape + '"/></clipPath>' +
              '<pattern id="' + id + '-air" width="7" height="7" patternUnits="userSpaceOnUse"><circle cx="1.2" cy="1.2" r="0.9" class="ob-jar-dot"/></pattern>' +
              '<linearGradient id="' + id + '-gloss" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity=".24"/><stop offset=".16" stop-color="#fff" stop-opacity="0"/><stop offset=".8" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".06"/></linearGradient>' +
            '</defs>' +
            '<ellipse class="ob-jar-shadow" cx="75" cy="204" rx="46" ry="5"/>' +
            '<path class="ob-jar-glass" d="' + shape + '"/>' +
            '<g clip-path="url(#' + id + '-clip)">' +
              '<rect class="ob-jar-air" x="20" y="34" width="110" height="164"/>' +
              '<rect x="20" y="34" width="110" height="164" fill="url(#' + id + '-air)"/>' +
              layers +
              '<rect x="20" y="34" width="110" height="164" fill="url(#' + id + '-gloss)"/>' +
            '</g>' +
            '<path class="ob-jar-line" d="' + shape + '"/>' +
            '<path class="ob-jar-shine" d="M30 84q-3 42 0 92"/>' +
            '<g class="ob-jar-ticks"><line x1="20" y1="198" x2="26" y2="198"/><line x1="20" y1="157" x2="26" y2="157"/><line x1="20" y1="116" x2="26" y2="116"/><line x1="20" y1="75" x2="26" y2="75"/><line x1="20" y1="34" x2="26" y2="34"/></g>' +
            '<line class="ob-jar-warn" x1="20" y1="75" x2="130" y2="75"/><text class="ob-jar-thlab warn" x="126" y="72" text-anchor="end">75%</text>' +
            '<line class="ob-jar-full" x1="20" y1="50" x2="130" y2="50"/><text class="ob-jar-thlab bad" x="126" y="47" text-anchor="end">90%</text>' +
            '<text class="ob-jar-free" x="75" y="' + ((TOP + fill) / 2 + 3).toFixed(1) + '" text-anchor="middle">' + k(free) + ' free</text>' +
            '<line class="ob-jar-fill-line" x1="20" y1="' + fill.toFixed(1) + '" x2="130" y2="' + fill.toFixed(1) + '"/><text class="ob-jar-thlab signal" x="126" y="' + (fill - 3.6).toFixed(1) + '" text-anchor="end">' + k(d.used) + '</text>' +
            '<rect class="ob-jar-lid" x="50" y="8" width="50" height="14" rx="4"/>' +
            '<g class="ob-jar-lid-lines">' + lids + '</g>' +
            '<path class="ob-jar-neck" d="M54 18h42v7H54Z"/>' +
          '</svg>' +
        '</div>' +
        '<div class="ob-jar-copy">' +
          '<p class="ob-jar-kicker">Main agent · after this turn</p>' +
          '<p class="ob-jar-pct"><span class="ob-serif">' + pct + '%</span> full</p>' +
          '<p class="ob-jar-figure"><b class="num">' + k(d.used) + '</b> <span>of 258k</span></p>' +
          '<p class="ob-jar-tip">' + tip + '</p>' +
          '<button type="button" class="tx-btn tx-ghost tx-xs ob-compact">' + ic("compact") + '<span>Compact conversation</span></button>' +
        '</div>' +
      '</div>' +
      '<div class="ob-jar-legend">' +
        '<span><i class="ob-c-sys"></i>System <b class="num">' + k(C.sys) + '</b></span>' +
        '<span><i class="ob-c-tools"></i>Tools <b class="num">' + k(C.tools) + '</b></span>' +
        '<span><i class="ob-c-docs"></i>Docs <b class="num">' + k(C.docs) + '</b></span>' +
        '<span><i class="ob-c-convo"></i>Conversation <b class="num">' + k(C.convo) + '</b></span>' +
        '<span><i class="ob-jar-freekey"></i>Free <b class="num">' + k(free) + '</b></span>' +
      '</div>' +
      '<div class="ob-sh ob-sh2">' + ic("clock") + 'Timing</div>' +
      '<dl class="ob-spec">' + d.timing.map(function (t) { return '<div><dt>' + t[0] + '</dt><dd class="num">' + t[1] + '</dd></div>'; }).join("") + '</dl>' +
    '</div>';
  }

  function privacy(d) {
    var body = d.finding
      ? '<div class="ob-find"><span class="tx-tile tx-tile-warn" aria-hidden="true">' + ic("shield") + '</span>' +
          '<div class="ob-find-main"><span><b>Email</b><code>j•••@acme.com</code></span>' +
          '<span class="ob-dim">' + ic("file") + 'handbook/access-requests.md · read by Main</span></div>' +
          '<span class="ob-cnt num">×1</span></div>'
      : '<p class="ob-clean">' + ic("check") + 'Nothing personal was read on this turn.</p>';
    return '<div class="ob-sec">' +
      '<div class="ob-sh">' + ic("shield") + 'Privacy on this turn<span class="ob-r num">' + (d.finding ? "1 finding" : "clear") + '</span></div>' +
      body +
    '</div>';
  }

  function contextView(d) {
    var C = d.ctx;
    function share(v) { return (v / d.used * 100).toFixed(3); }
    function sec(key, label, v, body, open) {
      return '<details class="ob-ctxsec"' + (open ? " open" : "") + '><summary>' + ic("chev", " ob-dchev") + '<i class="ob-c-' + key + '"></i><span>' + label + '</span><span class="ob-share"><i class="ob-c-' + key + '" style="width:' + share(v) + '%"></i></span><b class="num">' + k(v) + '</b></summary><div class="ob-ctxbody">' + body + '</div></details>';
    }
    var files = d.files.map(function (f) { return '<li>' + ic("file") + '<span>' + esc(f[0]) + '</span><b class="num">' + k(f[1]) + '</b></li>'; }).join("");
    var docsPre = d.files.some(function (f) { return /access-requests/.test(f[0]); })
      ? "## Access requests\nSend the form to <mark>j•••@acme.com</mark> before day two.\nHub access is granted by the BI admin within…"
      : "## " + esc(d.files[0] ? d.files[0][0].split("/").pop() : "Sources") + "\nExcerpts the agent read on this turn, oldest first…";
    var ask = d.prompt.length > 96 ? d.prompt.slice(0, 96).trim() + "…" : d.prompt;
    return '<div class="ob-sec">' +
        '<div class="ob-sh">Context window<span class="ob-r num">' + k(d.used) + ' of 258k · ' + Math.round(d.used / WINDOW * 100) + '%</span></div>' +
        '<div class="ob-stack" role="img" aria-label="Window composition against the 258k window: system ' + k(C.sys) + ', tools ' + k(C.tools) + ', workspace docs ' + k(C.docs) + ', conversation ' + k(C.convo) + ', free ' + k(WINDOW - d.used) + '">' +
          ["sys", "tools", "docs", "convo"].map(function (key) { return '<i class="ob-c-' + key + '" style="flex-grow:' + Math.round(C[key] / 100) + '"></i>'; }).join("") +
          '<i class="ob-c-free" style="flex-grow:' + Math.round((WINDOW - d.used) / 100) + '"></i>' +
        '</div>' +
        '<p class="ob-summary">Four sections fill ' + k(d.used) + ' of the 258k window; workspace docs are ' + Math.round(C.docs / d.used * 100) + '% of what’s used.</p>' +
      '</div>' +
      '<div class="ob-sec ob-ctxlist">' +
        sec("sys", "System", C.sys, '<pre class="ob-pre">You are Qlik Analyst, a data assistant for <mark>•••••</mark>. Answer from workspace documents first…</pre>') +
        sec("tools", "Tools", C.tools, '<pre class="ob-pre">read_document, search_workspace, run_query, google_calendar.find, google_drive.list…</pre>') +
        sec("docs", "Workspace docs", C.docs, '<ul class="ob-files">' + files + '</ul><pre class="ob-pre ob-pre-docs">' + docsPre + '</pre>', true) +
        sec("convo", "Conversation", C.convo, '<pre class="ob-pre">' + d.n + ' user turn' + (d.n === 1 ? "" : "s") + ', no helper reports, oldest first…\n› ' + esc(ask) + '</pre>') +
      '</div>' +
      '<div class="ob-foot"><span class="ob-mask">' + ic("lock") + 'Masked on the server. Captured for live turns only.</span>' +
        '<span class="ob-right"><button type="button" class="tx-btn tx-ghost tx-sm ob-copy-masked">' + ic("copy") + '<span>Copy masked</span></button></span></div>';
  }

  function card(d) {
    var id = d.id;
    return '<div class="ob-trace" id="' + id + '" role="region" aria-labelledby="' + id + '-title" hidden>' +
      '<div class="ob-th">' +
        '<span class="tx-tile tx-tile-signal" aria-hidden="true"><svg class="tx-ic"><use href="#i-activity"/></svg></span>' +
        '<span class="ob-title"><b id="' + id + '-title">Turn trace</b><small class="num">T' + d.n + ' · ' + esc(d.time) + ' · ' + d.steps.length + ' steps · no helpers</small></span>' +
        '<span class="tx-pill tx-pill-ok tx-pill-sm">' + ic("check") + 'Completed</span>' +
        '<span class="ob-right">' +
          '<span class="tx-seg tx-seg-sm ob-switch" role="tablist" aria-label="Trace view">' +
            '<button type="button" role="tab" aria-selected="true" aria-controls="' + id + '-trace" id="' + id + '-tab-trace">Trace</button>' +
            '<button type="button" role="tab" aria-selected="false" aria-controls="' + id + '-ctx" id="' + id + '-tab-ctx" tabindex="-1">Model context<span class="ob-devtag">Dev</span></button>' +
          '</span>' +
          '<button type="button" class="tx-btn tx-ghost tx-icon tx-sm ob-close" aria-label="Close trace">' + ic("x") + '</button>' +
        '</span>' +
      '</div>' +
      '<div class="ob-view" id="' + id + '-trace" role="tabpanel" aria-labelledby="' + id + '-tab-trace">' +
        waterfall(d) +
        '<div class="ob-cols">' + slip(d) + jar(d) + '</div>' +
        privacy(d) +
      '</div>' +
      '<div class="ob-view" id="' + id + '-ctx" role="tabpanel" aria-labelledby="' + id + '-tab-ctx" hidden>' + contextView(d) + '</div>' +
    '</div>';
  }

  /* ── behaviour ──────────────────────────────────────────────────────────── */
  // scroll only the chat pane: scrollIntoView would also shift clipped
  // ancestors (the stage), hiding the top bar and leaving a band under the composer
  function reveal(el) {
    var pane = el.closest(".cs-scroll");
    if (!pane) return;
    var p = pane.getBoundingClientRect(), r = el.getBoundingClientRect();
    var delta = r.bottom > p.bottom ? Math.min(r.bottom - p.bottom + 16, r.top - p.top - 16) : r.top < p.top ? r.top - p.top - 16 : 0;
    if (delta) pane.scrollBy({ top: delta, behavior: reduce.matches ? "auto" : "smooth" });
  }

  function setOpen(trace, open, focus) {
    var btn = document.querySelector('.ob-details[aria-controls="' + trace.id + '"]');
    trace.hidden = !open;
    trace.classList.toggle("is-open", open);
    if (btn) btn.setAttribute("aria-expanded", String(open));
    if (open) reveal(trace);
    if (focus) (open ? trace.querySelector(".ob-close") : btn).focus();
  }

  function select(tab) {
    var tabs = Array.prototype.slice.call(tab.parentNode.querySelectorAll('[role="tab"]'));
    tabs.forEach(function (t) {
      var on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      var panel = document.getElementById(t.getAttribute("aria-controls"));
      if (panel) panel.hidden = !on;
    });
  }

  document.addEventListener("click", function (e) {
    var details = e.target.closest(".ob-details");
    if (details) {
      var trace = document.getElementById(details.getAttribute("aria-controls"));
      if (trace) setOpen(trace, trace.hidden, false);
      return;
    }
    var close = e.target.closest(".ob-close");
    if (close) { setOpen(close.closest(".ob-trace"), false, true); return; }
    var tab = e.target.closest('.ob-switch [role="tab"]');
    if (tab) { select(tab); return; }
    var compactBtn = e.target.closest(".ob-compact");
    if (compactBtn) {
      var ev = new CustomEvent("tx:compact", { detail: {} });
      document.dispatchEvent(ev);
      var lbl = compactBtn.querySelector("span");
      var r = ev.detail.result;
      lbl.textContent = r === true ? "Compacted" : r === "busy" ? "Wait for the reply" : r === "again" ? "Already compacted" : "Nothing to compact";
      clearTimeout(compactBtn._t);
      compactBtn._t = setTimeout(function () { lbl.textContent = "Compact conversation"; }, 1800);
      return;
    }
    var copy = e.target.closest(".ob-copy-masked");
    if (copy) {
      var pre = copy.closest(".ob-view").querySelector(".ob-pre-docs");
      var label = copy.querySelector("span");
      var done = function () {
        label.textContent = "Copied masked";
        clearTimeout(copy._t);
        copy._t = setTimeout(function () { label.textContent = "Copy masked"; }, 1600);
      };
      if (navigator.clipboard && pre) navigator.clipboard.writeText(pre.textContent).then(done, done);
      else done();
    }
  });

  document.addEventListener("keydown", function (e) {
    var tab = e.target.closest && e.target.closest('.ob-switch [role="tab"]');
    if (tab && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
      var tabs = Array.prototype.slice.call(tab.parentNode.querySelectorAll('[role="tab"]'));
      var next = tabs[(tabs.indexOf(tab) + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
      e.preventDefault();
      select(next);
      next.focus();
      return;
    }
    if (e.key !== "Escape") return;
    var trace = e.target.closest && e.target.closest(".ob-trace");
    if (trace && !trace.hidden) { e.preventDefault(); setOpen(trace, false, true); }
  });

  window.TxTrace = {
    // stamp the receipt and its trace card at the end of a settled agent turn
    attach: function (node, info) {
      var slot = node.querySelector(".cs-msg-obs");
      if (!slot) return;
      var d = build(info);
      slot.innerHTML = receipt(d) + card(d);
      slot.hidden = false;
    },
    reset: fresh,
    // earlier messages were summarised: the next turns start from a lighter window
    compact: function () {
      state.convo = Math.min(state.convo, 1800);
      state.docs *= 0.2;
      Object.keys(state.files).forEach(function (f) { state.files[f] *= 0.2; });
    }
  };
})();
