/* truex screen 01 · chat
   Theme and text-size only. The layout itself is CSS; none of the regions
   needs JavaScript to exist. */
(function () {
  "use strict";

  var root = document.documentElement;
  var THEMES = ["auto", "light", "dark"];
  var SIZES = ["100", "150", "200"];
  var darkMQ = matchMedia("(prefers-color-scheme: dark)");
  var theme = THEMES.indexOf(root.dataset.theme) > -1 ? root.dataset.theme : "auto";
  var size = SIZES.indexOf(root.dataset.textsize) > -1 ? root.dataset.textsize : "100";
  var themeBtn = document.getElementById("screen-theme");
  var themeVal = document.getElementById("screen-theme-value");
  var typeBtn = document.getElementById("screen-type");
  var typeVal = document.getElementById("screen-type-value");

  function store(key, value) {
    try { localStorage.setItem(key, value); } catch (e) {}
  }

  function applyTheme(persist) {
    root.dataset.theme = theme;
    var eff = theme === "dark" || (theme === "auto" && darkMQ.matches) ? "dark" : "light";
    root.dataset.effTheme = eff;
    if (themeVal) themeVal.textContent = theme.charAt(0).toUpperCase() + theme.slice(1);
    if (themeBtn) themeBtn.setAttribute("aria-label", "Switch to " + (eff === "dark" ? "light" : "dark") + " theme");
    if (persist) store("tx-sys-theme", theme);
  }

  function applySize(persist) {
    size = SIZES.indexOf(size) > -1 ? size : "100";
    if (size === "100") root.removeAttribute("data-textsize");
    else root.setAttribute("data-textsize", size);
    if (typeVal) typeVal.textContent = size + "%";
    if (typeBtn) typeBtn.setAttribute("aria-label", "Text size: " + size + " percent. Activate to change.");
    if (persist) store("tx-sys-size", size);
  }

  if (themeBtn) {
    // one tap flips what you see; the choice then sticks instead of following the system
    themeBtn.addEventListener("click", function () {
      theme = root.dataset.effTheme === "dark" ? "light" : "dark";
      applyTheme(true);
    });
  }
  if (typeBtn) {
    typeBtn.addEventListener("click", function () {
      size = SIZES[(SIZES.indexOf(size) + 1) % SIZES.length];
      applySize(true);
    });
  }
  if (darkMQ.addEventListener) darkMQ.addEventListener("change", function () { if (theme === "auto") applyTheme(false); });
  else if (darkMQ.addListener) darkMQ.addListener(function () { if (theme === "auto") applyTheme(false); });

  applyTheme(false);
  applySize(false);
})();

/* conversation state — a new, empty conversation until the first send.
   Each send stamps a user message, then an agent message that reasons in a
   ThinkingBlock (thinking.js), calls its tools (activity.js), streams
   its reply word by word and settles with its observability receipt
   (trace.js) and a few follow-up questions. Composer growth and
   the slim state follow the reference: the textarea grows to a 224px content
   cap, and the follow-up composer stays compact. */
(function () {
  "use strict";

  var shell = document.querySelector(".cs-shell");
  if (!shell) return;
  var topbar = document.getElementById("cs-topbar");
  var title = document.getElementById("cs-title");
  var status = document.getElementById("cs-status");
  var statusState = document.getElementById("cs-status-state");
  var heroInput = document.getElementById("cs-hero-input");
  var heroSend = document.getElementById("cs-hero-send");
  var bottomInput = document.getElementById("cs-input");
  var bottomSend = document.getElementById("cs-send");
  var bottomComposer = document.getElementById("cs-composer");
  var thread = document.getElementById("cs-thread");
  var announce = document.getElementById("cs-announce");
  var tplUser = document.getElementById("cs-tpl-user");
  var tplAgent = document.getElementById("cs-tpl-agent");
  var scroll = document.querySelector(".cs-scroll");
  var newChat = document.getElementById("cs-new-chat");
  var dockNew = document.querySelector('.cs-dock-btn[aria-label="New chat"]');
  var greet = document.getElementById("cs-greet-text");
  var greetIc = document.getElementById("cs-greet-ic");
  var reduce = matchMedia("(prefers-reduced-motion: reduce)");
  var MAX = 224;
  var busy = false;
  var run = 0;     // bumps on reset so a pending reply never lands in a new conversation
  var turn = 0;
  var active = null;   // the agent message of the turn in flight
  var compacted = {};  // contextCompaction ids already marked
  var pending = null;     // { node, card } · a request card waiting on an answer
  var heroAttach = null, bottomAttach = null;   // attach.js controllers, one per composer
  // 6.6 · steer while a request waits (if enabled); MCP elicitation: ask | decline
  var policy = { steer: true, elicitation: "ask" };
  var steerFn = function () { return Promise.resolve(); };
  var PLACEHOLDER = bottomInput ? bottomInput.placeholder : "";

  // the greeting and its glyph follow the hour: sunrise, sun, sunset, moon
  function setGreeting() {
    if (!greet) return;
    var hour = new Date().getHours();
    var part = hour < 5 ? ["Working late", "moon"] :
      hour < 12 ? ["Good morning", "sunrise"] :
      hour < 18 ? ["Good afternoon", "sun"] :
      hour < 22 ? ["Good evening", "sunset"] : ["Working late", "moon"];
    greet.textContent = part[0] + ", A. Shah";
    if (greetIc) greetIc.setAttribute("href", "#i-" + part[1]);
  }
  setGreeting();

  function grow(el) {
    if (!el) return;
    if (!el.value) { el.style.height = ""; return; }
    var cs = getComputedStyle(el);
    var pt = parseFloat(cs.paddingTop) || 0;
    var pb = parseFloat(cs.paddingBottom) || 0;
    el.style.height = "auto";
    var content = Math.max(el.scrollHeight - pt - pb, 0);
    el.style.height = Math.min(content, MAX) + pt + pb + "px";
  }

  function attachOf(el) { return el === heroInput ? heroAttach : el === bottomInput ? bottomAttach : null; }
  function syncSend(el, btn) {
    if (!btn) return;
    // text or an uploaded file can send; an upload in progress or failed holds it
    var a = attachOf(el), s = a ? a.state() : { ready: 0, uploading: 0, failed: 0 };
    // while a turn is in flight, Send becomes Steer: it takes a note, not files,
    // and stays off when steer is off
    var steer = btn === bottomSend && live();
    var has = !!el.value.trim() || (!steer && s.ready > 0);
    btn.disabled = (busy && !steer) || !has || s.uploading > 0 || s.failed > 0 || (steer && !policy.steer);
  }
  function syncAll() {
    syncSend(heroInput, heroSend);
    refreshComposer();
  }

  // the follow-up composer rests compact; it opens to full height while you're
  // in it, while it holds text, or while it holds attachments
  function syncSlim() {
    if (!bottomComposer || !bottomInput) return;
    var open = bottomComposer.matches(":focus-within") || !!bottomInput.value ||
      bottomComposer.classList.contains("has-files");
    bottomComposer.classList.toggle("is-slim", !shell.classList.contains("is-new") && !open);
  }
  if (bottomComposer) {
    bottomComposer.addEventListener("focusin", syncSlim);
    // focus may be moving to another control inside the composer: check after it lands
    bottomComposer.addEventListener("focusout", function () { setTimeout(syncSlim, 0); });
  }

  function setStatus(label) {
    if (statusState) statusState.textContent = label;
    if (status) status.dataset.state = label.toLowerCase();
  }

  function clock() {
    var d = new Date();
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }

  function agent() {
    var name = document.getElementById("cs-pick-name");
    var av = document.getElementById("cs-pick-av");
    return { name: name ? name.textContent : "Agent", initials: av ? av.textContent : "AI" };
  }

  // follow the newest message only while the reader is already at the bottom
  function nearBottom() {
    return !scroll || scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 96;
  }
  function toBottom() {
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  }

  // placeholder replies until the agent is wired to a backend
  function replyFor(text, n) {
    // the quote carries its own end; drop the prompt's trailing punctuation
    var topic = text.length > 72 ? text.slice(0, 72).trim() + "…" : text.replace(/[.!?;:,\s]+$/, "");
    var replies = [
      "Here is a first pass on “" + topic + "”.\n\nI would start with the goal and the people it is for, then work back to the two or three steps that matter most. Anything that does not change the outcome can wait for a second round.\n\nWant me to turn this into a checklist, or go deeper on one part?",
      "Good question. The short answer: start small and make the first step easy to check.\n\nOnce that holds, add the next piece and keep each change reviewable on its own. Tell me which part you want to see first and I will draft it.",
      "Got it. I have noted “" + topic + "” as the focus for this conversation.\n\nI will keep answers short and point to sources where they exist. Ask for detail whenever you need it."
    ];
    return replies[(n == null ? turn : n) % replies.length];
  }

  // placeholder follow-ups until the agent suggests its own
  function followupsFor(text, n) {
    var sets = [
      ["Turn this into a checklist", "Add a day-one agenda", "Who should sign off on it?"],
      ["Show me the first step in detail", "What could go wrong?", "Make it shorter"],
      ["Summarise what we have so far", "Which sources did you use?", "Draft an intro note"]
    ];
    return sets[n % sets.length];
  }

  // only the latest turn offers follow-ups; older ones drop theirs
  function clearFollowups() {
    Array.prototype.forEach.call(thread.querySelectorAll(".cs-next"), function (el) {
      el.hidden = true;
      el.textContent = "";
    });
  }

  function showFollowups(node) {
    var box = node.querySelector(".cs-next");
    if (!box) return 0;
    var list = followupsFor(node.dataset.prompt || "", Number(node.dataset.turn) || 0);
    box.innerHTML = '<ul class="cs-next-list" role="list"></ul>';
    var ul = box.firstChild;
    list.forEach(function (q, i) {
      var li = document.createElement("li");
      li.style.setProperty("--i", i);
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cs-next-row";
      btn.dataset.ask = q;
      btn.innerHTML = '<span class="cs-next-mark" aria-hidden="true">↳</span><span class="cs-next-q"></span>';
      btn.querySelector(".cs-next-q").textContent = q;
      li.appendChild(btn);
      ul.appendChild(li);
    });
    box.hidden = false;
    return list.length;
  }

  function userMsg(text, files, meta) {
    var node = tplUser.content.firstElementChild.cloneNode(true);
    var bubble = node.querySelector(".cs-msg-text");
    bubble.textContent = text;
    bubble.hidden = !text;
    if (files && files.length && window.TxFiles) window.TxFiles.list(node.querySelector(".cs-user-files"), files);
    node.querySelector(".cs-msg-time").textContent = "You · " + clock() + (meta ? " · " + meta : "");
    return node;
  }
  function addUser(text, files) {
    return thread.appendChild(userMsg(text, files));
  }

  function addAgent() {
    var who = agent();
    var node = tplAgent.content.firstElementChild.cloneNode(true);
    node.querySelector(".cs-msg-av").textContent = who.initials;
    node.querySelector(".cs-msg-name").textContent = who.name;
    node.querySelector(".cs-msg-time").textContent = clock();
    thread.appendChild(node);
    return node;
  }

  // placeholder reasoning until reasoning.delta is wired; the third turn
  // arrives as summary parts ({text}[]) to exercise that shape
  function reasoningFor(prompt, n) {
    // cut long prompts at a word boundary, not mid-word
    var ask = prompt.length > 60 ? prompt.slice(0, 60).replace(/\s+\S*$/, "") + "…" : prompt.replace(/[.!?;:,\s]+$/, "");
    var sets = [
      ["The ask is \u201C" + ask + "\u201D. Start from who it is for and what done looks like.",
       "The handbook covers access, the dashboard walkthrough and shadowing. Access has the longest lead time, so it should land before day one.",
       "Keep the answer short: the shape first, then offer to expand any part."],
      ["They want a tighter version. Keep the first step concrete and checkable, and drop anything that does not change the outcome.",
       "Offer to draft the part they pick next rather than writing everything now."],
      [{ text: "Restate the focus so the rest of the conversation stays anchored." },
       { text: "Point to sources where they exist and keep each answer brief." }]
    ];
    return sets[n % sets.length];
  }

  // stream reasoning into the block a few words at a time, then hand off
  function think(node, prompt, n, id, done) {
    var host = node.querySelector(".cs-msg-think");
    var block = window.TxThinking ? window.TxThinking.create(host) : null;
    node._think = block;
    node.classList.add("is-thinking");
    node.setAttribute("aria-busy", "true");
    if (!block) { setTimeout(function () { if (id === run) done(); }, 900); return; }

    var parts = reasoningFor(prompt, n);
    var summary = typeof parts[0] === "object";
    var full = window.TxThinking.toText(parts);
    block.update({ text: "", streaming: true });

    if (reduce.matches) {
      setTimeout(function () {
        if (id !== run || node._failed) return;
        block.update({ text: parts, streaming: false });
        done();
      }, 250);
      return;
    }

    var tokens = full.split(/(\s+)/), ti = 0, acc = "";
    setTimeout(function tick() {
      if (id !== run || node._failed) return;
      var follow = nearBottom();
      acc += tokens.slice(ti, ti + 3).join("");
      ti += 3;
      // summary deltas land as parts; text deltas as one growing string
      block.update({ text: summary ? acc.split(/\n{2,}/).map(function (t) { return { text: t }; }) : acc });
      if (follow) toBottom();
      if (ti < tokens.length) { setTimeout(tick, 45); return; }
      setTimeout(function () {
        if (id !== run || node._failed) return;
        block.update({ text: parts, streaming: false });
        done();
      }, 260);
    }, 420);
  }

  // placeholder tool calls until the runtime's mcpToolCall / dynamicToolCall
  // and webSearch items pass through. [item, activity label, result patch];
  // the three turns cover web + tools, web only, and failed + declined
  function toolsFor(n) {
    var sets = [
      [
        [{ type: "webSearch", query: "analyst onboarding best practices",
           action: { type: "search", query: "analyst onboarding best practices",
             queries: ["analyst onboarding best practices", "BI analyst 30-day plan", "data team shadowing program"] } },
         "Searching the web",
         { status: "completed", durationMs: 1840, sources: [
           { url: "https://www.atlassian.com/team-playbook/plays/onboarding", title: "Onboarding play" },
           { url: "https://hbr.org/2023/05/onboarding-new-employees", title: "Onboarding new employees" },
           { url: "https://www.getdbt.com/blog/onboarding-analytics-engineers", title: "Onboarding analytics engineers" },
           { url: "https://en.wikipedia.org/wiki/Onboarding", title: "Onboarding" },
           { url: "https://www.gartner.com/en/articles/onboarding", title: "Onboarding that works" },
           { url: "https://www.shrm.org/topics-tools/onboarding", title: "Onboarding guide" },
           { url: "https://www.mckinsey.com/capabilities/people/onboarding", title: "The onboarding imperative" }
         ] }],
        [{ type: "mcpToolCall", server: "google_drive", tool: "search_files", readOnlyHint: true,
           arguments: { query: "analyst onboarding", folder: "/Shared/handbook" } },
         "Searching Google Drive",
         { status: "completed", durationMs: 1240, result: { content: [{ type: "text", text: "Found 3 files: week-one.md, access-requests.md and shadowing.md in /Shared/handbook." }] } }],
        [{ type: "mcpToolCall", server: "google_drive", tool: "read_file", toolTitle: "Read the handbook", readOnlyHint: true,
           arguments: { path: "/Shared/handbook/week-one.md" } },
         "Reading the handbook",
         { status: "completed", durationMs: 2180, result: { content: [{ type: "text", text: "Week one covers access, the sales dashboard walkthrough and a first practice app. Contact jane.doe@acme.com for hub access." }, { type: "resource" }] } }],
        [{ type: "dynamicToolCall", tool: "findFreeSlots", toolTitle: "Find shadowing slots",
           arguments: { attendees: 4, days: 10 } },
         "Checking calendars",
         { status: "completed", durationMs: 1630, result: { content: [{ type: "text", text: "12 open slots across the first two weeks." }] } }],
        [{ type: "mcpToolCall", server: "hubspot", tool: "search_contacts", readOnlyHint: true,
           arguments: { team: "analytics", role: "manager" } },
         "Looking up managers",
         { status: "completed", durationMs: 1250, result: { content: [{ type: "text", text: "Found 2 managers on the analytics team." }] } }]
      ],
      [
        [{ type: "webSearch", action: { type: "openPage", url: "https://www.atlassian.com/team-playbook/plays/onboarding" } },
         "Opening atlassian.com",
         { status: "completed", durationMs: 820, sources: [{ url: "https://www.atlassian.com/team-playbook/plays/onboarding", title: "Onboarding play" }] }],
        [{ type: "webSearch", action: { type: "findInPage", url: "https://www.atlassian.com/team-playbook/plays/onboarding", pattern: "first week" } },
         "Reading the page",
         { status: "completed", durationMs: 410 }],
        [{ type: "webSearch", action: { type: "other" } },
         "Checking the web",
         { status: "completed", durationMs: 560 }]
      ],
      [
        [{ type: "mcpToolCall", server: "salesforce", tool: "query_accounts",
           arguments: { segment: "EMEA", limit: 50 } },
         "Querying Salesforce",
         { status: "failed", durationMs: 3020, error: { message: "Salesforce timed out after 3s. Try again or narrow the query." } }],
        [{ type: "mcpToolCall", server: "slack", tool: "post_message", toolTitle: "Post a summary",
           arguments: { channel: "#analytics", text: "Onboarding plan ready" } },
         "Asking to post in Slack",
         { status: "declined", approvalId: "ap-1" }]
      ]
    ];
    return sets[n % sets.length];
  }

  // placeholder helpers until the runtime reports spawned agents.
  // [helper, run ms]; turn 1 has a handoff and an ask, turn 3 a failure
  function helpersFor(n) {
    var sets = [
      [
        [{ id: "atlas", name: "Atlas", role: "Docs", model: "Sonnet 5.5", icon: "search", label: "Read the handbook", tools: ["Drive"] }, 2200],
        [{ id: "birch", name: "Birch", role: "Access", model: "Haiku 5.5", icon: "ops", label: "Request hub access", tools: ["HubSpot"],
           ask: "Allow Birch to request hub access for 4 new analysts?" }, 1200],
        [{ id: "cedar", name: "Cedar", role: "Shadowing", model: "Sonnet 5.5", icon: "write", label: "Plan shadowing slots", tools: ["Calendar"], from: "atlas" }, 1800]
      ],
      [],
      [
        [{ id: "atlas", name: "Atlas", role: "Docs", model: "Sonnet 5.5", icon: "search", label: "Summarise the plan", tools: ["Drive"] }, 1400],
        [{ id: "dune", name: "Dune", role: "Certification", model: "GPT-6 Sol", icon: "review", label: "Check certification dates", tools: ["Qlik"],
           error: "The certification calendar didn't respond. Main went on without it." }, 1600]
      ]
    ];
    return sets[n % sets.length];
  }

  // helpers run side by side; a "from" helper starts when its source finishes,
  // an ask waits for the reader. Then the turn moves on.
  function runHelpers(node, n, id, done) {
    var plan = helpersFor(n);
    if (!plan.length || !window.TxHelpers) { done(); return; }
    var work = node._work;
    var pending = plan.length, finished = {};
    var g = node._helpers = window.TxHelpers.group(node.querySelector(".cs-msg-helpers"), {
      onAnswer: function (h, allow) {
        if (id !== run || node._failed) return;
        g.upsert(allow ? { id: h.id, state: "running" } : { id: h.id, state: "failed", error: "Not allowed. Main went on without it." });
        if (allow) setTimeout(function () { finish(h.id, { state: "done" }); }, reduce.matches ? 120 : 900);
        else settleOne(h.id);
      }
    });
    function label() {
      var open = g.items().filter(function (x) { return x.state === "running" || x.state === "needs"; }).length;
      var asks = g.items().filter(function (x) { return x.state === "needs"; }).length;
      if (work) work.show(asks ? "Waiting for you" : "Waiting on " + open + " helper" + (open === 1 ? "" : "s"));
    }
    function settleOne(hid) {
      if (finished[hid]) return;
      finished[hid] = true;
      pending--;
      plan.forEach(function (p) { if (p[0].from === hid) start(p); });
      if (pending <= 0) { done(); return; }
      label();
    }
    function finish(hid, patch) {
      if (id !== run || node._failed) return;
      patch.id = hid;
      g.upsert(patch);
      settleOne(hid);
    }
    function start(p) {
      var spec = p[0], item = {};
      Object.keys(spec).forEach(function (k) { if (k !== "ask" && k !== "error") item[k] = spec[k]; });
      item.state = "running";
      item.startedAt = Date.now();
      var follow = nearBottom();
      g.upsert(item);
      label();
      if (follow) toBottom();
      setTimeout(function () {
        if (id !== run || node._failed) return;
        if (spec.ask) { g.upsert({ id: spec.id, state: "needs", ask: spec.ask }); label(); if (nearBottom()) toBottom(); }
        else if (spec.error) finish(spec.id, { state: "failed", error: spec.error });
        else finish(spec.id, { state: "done" });
      }, reduce.matches ? 150 : p[1]);
    }
    plan.forEach(function (p) { if (!p[0].from) start(p); });
  }

  /* 5 · Plan mode. Long tasks call update_plan, then ask plan_approval: the
     plan card reads in the reply, the PlanApprovalCard pins above the
     composer. The answer goes back to the same turn: Approve (or expiry) runs
     the steps, Revise re-plans in place, Stop or a new message ends it.
     Placeholder steps until update_plan is wired. */
  function planFor() {
    return {
      explanation: "This pulls from three systems and writes a deck, so here is the plan before I start.",
      plan: [
        { step: "Pull Q3 pipeline from HubSpot", status: "pending" },
        { step: "Reconcile closed-won against finance actuals", status: "pending" },
        { step: "Flag deals that slipped from Q3 to Q4", status: "pending" },
        { step: "Draft the pipeline section of the board deck", status: "pending" },
        { step: "Summarise risks and next steps", status: "pending" }
      ]
    };
  }

  // 5.3 · answers go through submitAnswer; TxChat.setSubmit wires the real one.
  // The demo resolves after a beat, or fails once with demo.failNext.
  var pinned = document.getElementById("cs-pinned");
  var stopBtn = document.getElementById("cs-stop");
  var demo = { failNext: 0, expiresIn: 5 * 60000 };
  var lastAnswer = null;
  var submitAnswer = function () {
    var fail = demo.failNext;
    demo.failNext = 0;
    return new Promise(function (ok, no) {
      setTimeout(function () {
        if (fail) no({ status: fail, message: fail >= 500 ? "The server didn’t accept your answer. Try again." : "" });
        else ok();
      }, reduce.matches ? 150 : 700);
    });
  };

  /* 6.6 · while a turn is in flight, working or paused on a request, Stop
     ends it and a note steers it, if steer is on; anything else waits.
     An expired card no longer waits: a new message closes it and goes on. */
  function waiting() {
    return !!(pending && pending.card && pending.card.phase && pending.card.phase() !== "expired");
  }
  function live() { return !!active || waiting(); }
  function refreshComposer() {
    if (!bottomInput) return;
    var w = waiting(), l = live(), steer = l && policy.steer;
    bottomInput.placeholder = !l ? PLACEHOLDER
      : w ? (steer ? "Add a note to this turn, or answer above" : "Answer the request above, or press Stop")
      : steer ? "Steer this turn: add a note, or press Stop" : "Wait for this reply, or press Stop";
    if (stopBtn) stopBtn.hidden = !l;
    if (bottomSend) bottomSend.title = steer ? "Send. It joins the turn in progress" : "";
    syncSend(bottomInput, bottomSend);
  }
  // a card that changes state (pending → expired, say) updates the composer
  if (pinned && window.MutationObserver) {
    new MutationObserver(refreshComposer).observe(pinned, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-state"] });
  }
  // a send the paused turn can't take: point at the card instead
  function nudge() {
    if (announce) announce.textContent = waiting() ? "Answer the request above, or press Stop." : "This turn is still running. Wait for it, or press Stop.";
    var c = pinned && pinned.querySelector(".ap");
    if (!c) return;
    c.classList.remove("is-nudge");
    void c.offsetWidth;
    c.classList.add("is-nudge");
    var f = c.querySelector("button:not(:disabled), .aq-text, input:not([type=hidden]), textarea");
    if (f) f.focus();
  }
  // steer · the note is sent as a normal message, placed in the reply where
  // it lands, so what the agent does next reads below it; the card stays open
  function steerTurn(node, text) {
    var el = userMsg(text, null, "added to this turn");
    el.classList.add("is-steer");
    node.querySelector(".cs-msg-asks").appendChild(el);
    if (nearBottom()) toBottom();
    var paused = waiting();
    Promise.resolve().then(function () { return steerFn(text, node.dataset.turn); }).then(function () {
      if (announce) announce.textContent = paused ? "Added to this turn. Answer the request above to continue." : "Added to this turn. The agent reads it at its next step.";
    }, function () {
      el.remove();
      if (bottomInput && !bottomInput.value) { bottomInput.value = text; grow(bottomInput); syncSend(bottomInput, bottomSend); }
      if (announce) announce.textContent = "Couldn’t add that to the turn. Your text is back in the message box.";
    });
  }
  // Stop · a paused turn closes through its card; a working one ends where it
  // is: what ran stays, and nothing after it runs
  function stopTurn(node) {
    run++;   // every timer of this turn checks run and falls silent
    node.classList.remove("is-thinking", "is-streaming");
    node.removeAttribute("aria-busy");
    if (node._think && node._think.get().streaming) node._think.update({ streaming: false });
    if (node._work) node._work.hide();
    if (node._helpers) node._helpers.items().forEach(function (h) {
      if (h.state === "running" || h.state === "needs") node._helpers.upsert({ id: h.id, state: "stopped" });
    });
    [node._tools, node._askTools].forEach(function (g) {
      if (g) g.items().forEach(function (t) {
        if (t.status === "inProgress") g.upsert({ id: t.id, status: "stopped", durationMs: Date.now() - (t.startedAt || Date.now()) });
      });
    });
    if (node._planView && node._planView.get().phase === "running") node._planView.settle("halted");
    var body = node.querySelector(".cs-msg-body");
    var said = body.textContent.trim();
    node.dataset.text = said;
    var el = document.createElement("p");
    el.className = "cs-stopped";
    el.innerHTML = '<svg class="tx-ic tx-ic-sm" aria-hidden="true"><use href="#i-stop"/></svg><span></span>';
    el.lastChild.textContent = (said ? "Stopped by you mid-reply" : "Stopped by you before it replied") + " · nothing after this ran · " + clock();
    node.querySelector(".cs-msg-asks").appendChild(el);
    busy = false;
    active = null;
    setStatus("Ready");
    syncAll();
    if (announce) announce.textContent = "Stopped. Nothing else runs in this turn.";
    if (nearBottom()) toBottom();
  }
  if (stopBtn) stopBtn.addEventListener("click", function () {
    if (waiting()) pending.card.stop();
    else if (active) stopTurn(active);
  });

  // pin the card; on close, leave an ApprovalRecord under the plan it answered
  function pinApproval(node, req, after) {
    if (!window.TxApproval || !pinned || !window.TxApproval.isPlanApproval(req)) return false;
    if (pending) pending.card.destroy();
    var card = window.TxApproval.planCard(pinned, req, {
      submit: function (rid, payload) {
        lastAnswer = { requestId: rid, payload: window.TxApproval.redact(req, payload) };
        return submitAnswer(rid, payload);
      },
      onClose: function (kind, extra) {
        if (pending && pending.card === card) pending = null;
        refreshComposer();
        var follow = nearBottom();
        var pq = req.questions[0] || {};
        var rec = window.TxApproval.record(node.querySelector(".cs-msg-plan"), {
          requestId: req.requestId, turnId: node.dataset.turn, at: new Date(),
          outcome: kind === "approve" || kind === "revise" ? "answered" : kind === "stopped" ? "interrupted" : "expired",
          items: [{
            kind: "question",
            question: pq.question || (pq.header || "Plan") + " ready for review",
            answer: kind === "approve" ? "Approve plan" : kind === "revise" ? "Revise: " + extra
              : kind === "expired" ? "Approve plan" : kind === "gone" && extra === 409 ? "Answered elsewhere" : "",
            by: kind === "expired" ? "timeout" : ""
          }]
        });
        if (announce && rec) announce.textContent = rec.dataset.say || rec.textContent;
        after(kind, extra);
        if (follow) toBottom();
      }
    });
    pending = { node: node, card: card };
    refreshComposer();
    if (announce) announce.textContent = ((req.questions[0].header || "Plan") + " ready for review. Approve plan or Revise, just above the message box.");
    return true;
  }

  /* 6.1 · route a PendingRequest to its card. Only item/tool/requestUserInput
     reaches the browser; plan_approval pins the PlanApprovalCard, anything
     else the request card (clarification or tool approval). after(kind, info)
     runs once it closes. */
  function pinRequest(node, raw, after) {
    var A = window.TxApproval;
    if (!A || !pinned) return false;
    var req = A.normalize(raw);
    if (!A.forBrowser(req)) return false;
    if (A.isPlanApproval(req)) return pinApproval(node, req, after);
    if (pending) pending.card.destroy();
    var tool = A.isTool(req);
    // 6.3 · a single tool approval gets the decision buttons
    var single = tool && req.questions.length === 1;
    var name = single ? A.toolName(req.questions[0]) : "";
    var card = (single ? A.toolCard : A.requestCard)(pinned, req, {
      submit: function (rid, payload) {
        lastAnswer = { requestId: rid, payload: A.redact(req, payload) };
        return submitAnswer(rid, payload);
      },
      onClose: function (kind, info) {
        if (pending && pending.card === card) pending = null;
        refreshComposer();
        var follow = nearBottom();
        var outcome = kind === "answer" ? "answered" : kind === "stopped" ? "interrupted" : "expired";
        var items = single
          ? [{ kind: "toolApproval", title: name, decision: kind === "answer" ? info.decision : outcome, label: kind === "answer" ? info.label : "" }]
          : req.questions.map(function (q, i) {
              var a = kind === "answer" && info && info.items ? info.items[i] : null;
              // an expired secret waits for a message; the rest took the recommended option
              var timedOut = kind === "expired" && !(info && info.secret);
              return { kind: "question", question: q.question || q.header, answer: a ? a.answer : "", secret: q.isSecret, by: timedOut ? "timeout" : "" };
            });
        var rec = A.record(node.querySelector(".cs-msg-asks"), { requestId: req.requestId, turnId: node.dataset.turn, at: new Date(), outcome: outcome, items: items });
        if (announce && rec) announce.textContent = rec.dataset.say || rec.textContent;
        after(kind, info, req);
        if (follow) toBottom();
      }
    });
    pending = { node: node, card: card };
    refreshComposer();
    var q = req.questions[0];
    if (announce) announce.textContent = single ? "Permission needed: " + name + ". Answer just above the message box."
      : (q.header || (tool ? "Allow this tool?" : "Your input is needed")) +
        (req.questions.length > 1 ? ", " + req.questions.length + " questions" : "") + ". Answer just above the message box.";
    return true;
  }

  // the tool behind an approval, for its row in the activity list
  function toolInfo(req) {
    var A = window.TxApproval, q = req.questions[0], m = A.toolMeta(q);
    return { requestId: req.requestId, server: m.server, tool: m.tool, toolTitle: q.toolTitle || m.title,
      connectorName: q.connectorName, readOnlyHint: q.readOnlyHint, arguments: q.arguments };
  }
  function toolRow(node, info, patch) {
    if (!window.TxActivity) return;
    var g = node._askTools || (node._askTools = window.TxActivity.group(node.querySelector(".cs-msg-tools")));
    var item = { id: "approved-" + info.requestId, type: info.server ? "mcpToolCall" : "dynamicToolCall", server: info.server,
      tool: info.tool || "tool", toolTitle: info.toolTitle, connectorName: info.connectorName, readOnlyHint: info.readOnlyHint === true };
    Object.keys(patch).forEach(function (k) { item[k] = patch[k]; });
    g.upsert(item);
  }
  function runTool(node, id, info, resume) {
    if (node._work) node._work.show("Running " + (info.toolTitle || "the tool").toLowerCase());
    toolRow(node, info, { status: "inProgress", startedAt: Date.now(), arguments: info.arguments });
    setTimeout(function () {
      if (id !== run || node._failed) return;
      toolRow(node, info, { status: "completed", durationMs: 1300, result: { content: [{ type: "text", text: info.resultText || "Done." }] } });
      resume();
    }, reduce.matches ? 120 : 1300);
  }
  // auto by mode · no card, only the record
  function autoRecord(node, it) {
    var A = window.TxApproval;
    var q = A.normalize({ requestId: it.requestId || "auto", detail: { questions: [{ id: "mcp_tool_call_approval_auto", kind: "toolApproval",
      action: it.action || "", server: it.server, tool: it.tool, toolTitle: it.toolTitle, connectorName: it.connectorName }] } }).questions[0];
    var mode = /pilot|^auto$/i.test(it.mode || "") ? "auto" : /grant|chat|session/i.test(it.mode || "") ? "grant" : "readOnly";
    // Autopilot can answer a question too: the answer reads "(chosen by Autopilot)"
    var items = it.question
      ? [{ kind: "question", question: it.question, answer: it.answer || "", by: mode === "auto" ? "autopilot" : "" }]
      : [{ kind: "toolApproval", title: A.toolName(q), decision: mode === "grant" ? "allowedChat" : "allowedOnce" }];
    var rec = A.record(node.querySelector(".cs-msg-asks"), {
      requestId: it.requestId, turnId: node.dataset.turn, at: it.at || new Date(), outcome: "auto", autoMode: mode, items: items
    });
    if (nearBottom()) toBottom();
    return rec;
  }

  // placeholder requests for the /ask demos until the runtime sends them.
  // o: { tool, one, expire }
  function sampleRequest(o) {
    o = o || {};
    var at = new Date(Date.now() + (o.expire ? 12000 : 3 * 60000)).toISOString();
    var rid = "req_" + Math.random().toString(36).slice(2, 8);
    var wrap = function (questions) { return { requestId: rid, method: "item/tool/requestUserInput", expiresAt: at, responseSchema: null, detail: { questions: questions } }; };
    // auto by mode: no card, a record, and the tool runs
    if (o.auto) return { auto: o.auto === "pilot"
      ? { mode: "autopilot", requestId: rid, server: "hubspot", tool: "update_deal", toolTitle: "Update deal", readOnlyHint: false, resultText: "Updated 12 deals." }
      : { mode: "readOnly", requestId: rid, server: "hubspot", tool: "search_deals", toolTitle: "Search deals", readOnlyHint: true, resultText: "Found 12 deals that slipped." } };
    if (o.tool) {
      var tq = {
        id: "mcp_tool_call_approval_hubspot_update_deal", kind: "toolApproval",
        question: "The agent wants to move 12 deals that slipped from Q3 into Q4.",
        action: "Allow hubspot to run tool “update_deal”",
        options: [{ label: "Allow" }, { label: "Allow for this session" }, { label: "Allow and don't ask me again" }, { label: "Cancel" }]
      };
      // v2 fields, unless the demo asks for the plain runtime shape
      if (!o.plain) {
        tq.server = "hubspot"; tq.tool = "update_deal"; tq.toolTitle = "Update deal"; tq.readOnlyHint = false;
        tq.arguments = { deal_ids: ["1041", "1057", "1063"], properties: { closedate: "2026-12-31", dealstage: "Q4 commit" }, notify: "jane.doe@acme.com" };
      }
      return wrap([tq]);
    }
    // one question with options: sends on click (no header, so the title falls back)
    if (o.one) return wrap([{ id: "region", question: "Which region should the review start with?", isOther: true, options: [
      { label: "EMEA", description: "Largest slip this quarter" },
      { label: "North America", description: "Most deals by count" },
      { label: "APAC", description: "" }] }]);
    return wrap([
      { id: "audience", header: "Audience", question: "Who is this review for?", isOther: true, options: [
        { label: "Board", description: "Five slides, headline numbers only" },
        { label: "Sales leadership", description: "Deal-level detail by region" }] },
      { id: "period", header: "Period", question: "Compare Q3 against which period?", options: [
        { label: "Q2 2026", description: "" }, { label: "Q3 2025", description: "Same quarter last year" }] },
      { id: "notes", header: "Anything else", question: "Anything the agent should keep in mind?", options: null },
      { id: "hubspot_token", header: "HubSpot access", question: "Paste a HubSpot private app token so the agent can read the pipeline.", isSecret: true, options: null }
    ]);
  }

  /* 6.4 · an MCP server asks for structured input (mcpServer/elicitation/
     request). Pinned like the other requests; the record keeps field names
     only, never the values. after(kind) runs once it closes. */
  function pinElicit(node, raw, after) {
    var E = window.TxElicit;
    if (!E || !pinned) return false;
    var req = E.normalize(raw);
    if (!req.requestId) return false;
    if (pending) pending.card.destroy();
    var card = E.card(pinned, req, {
      submit: function (rid, payload) {
        // what the page keeps names the fields, not what was typed
        lastAnswer = { requestId: rid, payload: payload.content
          ? { action: payload.action, content: Object.keys(payload.content).reduce(function (o, k) { o[k] = "•••"; return o; }, {}) }
          : payload, sent: payload };
        return submitAnswer(rid, payload);
      },
      onClose: function (kind, info) {
        if (pending && pending.card === card) pending = null;
        refreshComposer();
        var follow = nearBottom();
        var rec = E.record(node.querySelector(".cs-msg-asks"), { req: req, kind: kind, info: info });
        if (announce && rec) announce.textContent = rec.dataset.say || rec.textContent;
        after(kind, info, req);
        if (follow) toBottom();
      }
    });
    pending = { node: node, card: card };
    refreshComposer();
    if (announce) announce.textContent = card.el.querySelector(".ap-title").textContent + ". Answer just above the message box.";
    return true;
  }

  // placeholder elicitations for the /elicit demos
  function sampleElicit(o) {
    var rid = "eli_" + Math.random().toString(36).slice(2, 8);
    var at = new Date(Date.now() + (o.expire ? 12000 : 4 * 60000)).toISOString();
    var base = { method: "mcpServer/elicitation/request", requestId: rid, expiresAt: at };
    var p = { serverName: "Acme CRM", threadId: "thr_demo", turnId: "turn_demo" };
    if (o.mode === "url") {
      p.serverName = "DocuSign"; p.mode = "url";
      p.url = { elicitationId: "elc_" + rid, message: "Sign in to DocuSign so the agent can send the renewal contract.", url: "https://account.docusign.com/oauth/auth?client=acme&state=" + rid };
    } else if (o.mode === "verify") {
      p.serverName = "Okta"; p.mode = "openai/userVerification";
      p.userVerification = { title: "Confirm it’s you", description: "Check that this code matches the one on your phone, then confirm.", challenge: "482 913" };
    } else if (o.mode === "unknown") {
      p.mode = "acme/voiceprint";
    } else {
      p.mode = "form";
      p.form = { message: "To create the trial workspace, Acme CRM needs a few details.", requestedSchema: { type: "object", required: ["email", "company", "seats", "plan"], properties: {
        email: { type: "string", format: "email", title: "Work email", description: "Where the trial invite goes." },
        company: { type: "string", title: "Company name", minLength: 2, maxLength: 60 },
        seats: { type: "integer", title: "Seats", minimum: 1, maximum: 50, "default": 5 },
        start: { type: "string", format: "date", title: "Start date" },
        plan: { type: "string", title: "Plan", "enum": ["starter", "growth", "enterprise"], enumNames: ["Starter", "Growth", "Enterprise"] },
        regions: { type: "array", title: "Data regions", items: { type: "string", "enum": ["EU", "US", "APAC"] }, maxItems: 2 },
        website: { type: "string", format: "uri", title: "Company website" },
        updates: { type: "boolean", title: "Send product updates", description: "One email a month. Unsubscribe any time." }
      } } };
    }
    base.params = p;
    return base;
  }

  // pause the turn on a request; answering resumes it
  function askUser(node, id, raw, resume) {
    // auto by mode: no card, the record, and the tool runs
    if (raw && raw.auto && window.TxApproval) {
      autoRecord(node, raw.auto);
      runTool(node, id, raw.auto, resume);
      return;
    }
    // 6.6 · elicitation declined automatically: no card, no record
    if (policy.elicitation === "decline" && window.TxElicit && window.TxElicit.isElicitation(raw)) { resume(); return; }
    if (node._work) node._work.hide();
    node.classList.remove("is-thinking");
    node.removeAttribute("aria-busy");
    busy = false;
    active = null;
    setStatus("Waiting");
    syncAll();
    // 6.4 · an elicitation: any answer (accept, decline, cancel, expiry) goes
    // back to the server, which carries on; Stop or a closed request ends the turn
    if (window.TxElicit && window.TxElicit.isElicitation(raw)) {
      var eok = pinElicit(node, raw, function (kind) {
        if (id !== run || node._failed) return;
        if (kind === "stopped" || kind === "gone") { setStatus("Ready"); return; }
        busy = true;
        active = node;
        node.setAttribute("aria-busy", "true");
        setStatus("Working");
        syncAll();
        resume();
      });
      if (!eok) { busy = true; active = node; resume(); return; }
      if (nearBottom()) toBottom();
      return;
    }
    var ok = pinRequest(node, raw, function (kind, info, req) {
      if (id !== run || node._failed) return;
      var tool = window.TxApproval.isTool(req);
      // an expired tool approval is declined, never auto-allowed; a new message continues
      if (tool && kind === "expired") { toolRow(node, toolInfo(req), { status: "declined", approvalId: req.requestId }); setStatus("Ready"); return; }
      // an expired secret can't continue on its own: the next message picks up
      if (kind === "stopped" || kind === "gone" || (kind === "expired" && info && info.secret)) { setStatus("Ready"); return; }
      busy = true;
      active = node;
      node.setAttribute("aria-busy", "true");
      setStatus("Working");
      syncAll();
      if (tool) {
        var said = info && typeof info === "object" ? info.summary || "" : info || "";
        var allowed = kind === "answer" && (info && info.decision ? /^allowed/.test(info.decision) : !/^don/i.test(said));
        var ti = toolInfo(req);
        if (!allowed) {
          toolRow(node, ti, { status: "declined", approvalId: req.requestId });
          setTimeout(function () { if (id === run && !node._failed) resume(); }, 300);
          return;
        }
        ti.resultText = "Updated 12 deals.";
        runTool(node, id, ti, resume);
        return;
      }
      resume();
    });
    if (!ok) { busy = true; active = node; resume(); return; }
    if (nearBottom()) toBottom();
  }

  function askPlan(node, id, resume, note) {
    if (!window.TxPlan) { resume(); return; }
    var spec = planFor();
    if (note) spec.explanation = "Updated after your feedback: “" + (note.length > 90 ? note.slice(0, 90).replace(/\s+\S*$/, "") + "…" : note) + "”";
    var view = node._planView;
    if (view) view.update(spec);
    else { view = window.TxPlan.render(node.querySelector(".cs-msg-plan"), spec); node._planView = view; }
    view.ask();
    if (node._work) node._work.hide();
    node.classList.remove("is-thinking");
    node.removeAttribute("aria-busy");
    // the turn waits on the reader; the composer stays open
    busy = false;
    active = null;
    setStatus("Waiting");
    syncAll();
    var req = {
      requestId: "req_" + Math.random().toString(36).slice(2, 8),
      questions: [{ id: "plan_approval", question: "Approve to start the " + spec.plan.length + " steps, or tell me what to change.", options: [{ label: "Approve" }, { label: "Revise" }] }],
      expiresAt: new Date(Date.now() + demo.expiresIn).toISOString()
    };
    demo.expiresIn = 5 * 60000;
    var working = function (label) {
      busy = true;
      active = node;
      node.setAttribute("aria-busy", "true");
      setStatus("Working");
      syncAll();
      if (label && node._work) node._work.show(label);
    };
    pinApproval(node, req, function (kind, extra) {
      if (id !== run || node._failed) return;
      if (kind === "approve" || kind === "expired") {
        working();
        view.start();
        runPlan(node, view, null, id, function () { view.finish(); resume(); });
      } else if (kind === "revise") {
        view.settle("revise");
        working("Revising the plan");
        setTimeout(function () { if (id === run && !node._failed) askPlan(node, id, resume, extra); }, reduce.matches ? 150 : 1100);
      } else {
        // 409: someone answered it elsewhere; 404/410: it's gone
        view.settle(kind === "stopped" ? "stopped" : extra === 409 ? "answered" : "gone");
        setStatus("Ready");
      }
    });
    if (nearBottom()) toBottom();
  }

  // each step goes in progress, then done; the Working line names it
  function runPlan(node, view, steps, id, done) {
    var i = 0;
    (function next() {
      if (id !== run || node._failed) return;
      // read the live plan each step, so an update_plan in between is kept
      var plan = view.get().plan;
      if (i > 0 && plan[i - 1]) plan[i - 1].status = "completed";
      if (i >= plan.length) {
        view.update({ plan: plan });
        if (node._work) node._work.hide();
        done();
        return;
      }
      plan[i].status = "in_progress";   // the protocol's spelling is accepted too
      view.update({ plan: plan });
      // the Working line names the step in progress
      if (node._work) node._work.show(view.get().plan[i].step);
      if (nearBottom()) toBottom();
      i++;
      setTimeout(next, reduce.matches ? 120 : 900);
    })();
  }

  // run each call in order, then hold "Working" until the answer starts
  function runTools(node, n, id, done) {
    var calls = toolsFor(n);
    var work = node._work;
    var g = node._tools = window.TxActivity ? window.TxActivity.group(node.querySelector(".cs-msg-tools")) : null;
    if (!g) { done(); return; }
    var i = 0;
    (function next() {
      if (id !== run || node._failed) return;
      if (i >= calls.length) {
        if (work) work.show("Working");
        setTimeout(function () { if (id === run) done(); }, reduce.matches ? 150 : 650);
        return;
      }
      var c = calls[i], callId = "call-" + n + "-" + (++i);
      var item = { id: callId, status: "inProgress" };
      Object.keys(c[0]).forEach(function (k) { item[k] = c[0][k]; });
      var follow = nearBottom();
      g.upsert(item);
      if (work) work.show(c[1]);
      if (follow) toBottom();
      // sample durations play back shorter than they report
      var wait = reduce.matches ? 120 : Math.min(c[2].durationMs || 700, 1400);
      setTimeout(function () {
        if (id !== run || node._failed) return;
        var patch = { id: callId };
        Object.keys(c[2]).forEach(function (k) { patch[k] = c[2][k]; });
        g.upsert(patch);
        next();
      }, wait);
    })();
  }

  // placeholder files until the runtime reports what a reply created.
  // Ids are unique per conversation so a revision can point at its source.
  function filesFor(n) {
    var key = "f" + run + "-";
    var now = new Date().toISOString();
    var sets = [
      [
        { id: key + n + "-0", name: "Analyst onboarding plan.docx", size: 48230, createdAt: now,
          mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
        { id: key + n + "-1", name: "onboarding-checklist.csv", size: 2150, createdAt: now, mediaType: "text/csv",
          content: "day,task,owner\n1,Request hub access,Manager\n1,Sales dashboard walkthrough,Buddy\n2,First practice app,Analyst\n" }
      ],
      [
        // the previous turn's plan, revised
        { id: key + n + "-0", name: "Analyst onboarding plan.docx", size: 31744, createdAt: now, sourceId: key + (n - 1) + "-0",
          mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }
      ],
      [
        { id: key + n + "-0", name: "load_onboarding_metrics.py", size: 3890, createdAt: now, mediaType: "text/plain",
          content: "import csv\n\nwith open('onboarding-checklist.csv') as f:\n    rows = list(csv.DictReader(f))\nprint(len(rows), 'tasks')\n" },
        { id: key + n + "-1", name: "Week one kickoff.pptx", size: 2411724, createdAt: now,
          mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }
      ]
    ];
    return sets[n % sets.length];
  }

  function settle(node, text) {
    node.classList.remove("is-thinking", "is-streaming");
    node.removeAttribute("aria-busy");
    node.dataset.text = text;
    // the receipt adds height; keep following if the reader was at the bottom
    var follow = nearBottom();
    var files = window.TxFiles ? window.TxFiles.list(node.querySelector(".cs-msg-files"), filesFor(Number(node.dataset.turn) || 0)) : 0;
    if (window.TxTrace) window.TxTrace.attach(node, {
      prompt: node.dataset.prompt || "",
      turn: Number(node.dataset.turn) || 0,
      time: node.querySelector(".cs-msg-time").textContent
    });
    var count = showFollowups(node);
    if (follow) toBottom();
    busy = false;
    active = null;
    setStatus("Ready");
    syncAll();
    if (announce) announce.textContent = node.querySelector(".cs-msg-name").textContent + ": " + text.replace(/\n+/g, " ") +
      (files ? " " + files + (files === 1 ? " file" : " files") + " attached." : "") +
      (count ? " " + count + " follow-up suggestions below." : "");
  }

  // stream paragraph by paragraph, a few words per frame
  function stream(node, text, id) {
    var body = node.querySelector(".cs-msg-body");
    var paras = text.split(/\n{2,}/);
    node.classList.remove("is-thinking");
    // the first words replace the Working indicator
    if (node._work) node._work.hide();
    body.textContent = "";
    if (reduce.matches) {
      paras.forEach(function (para) {
        var p = document.createElement("p");
        p.className = "pt-answer-body";
        p.textContent = para;
        body.appendChild(p);
      });
      settle(node, text);
      toBottom();
      return;
    }
    node.classList.add("is-streaming");
    var pi = 0, words = [], wi = 0, p = null;
    (function tick() {
      if (id !== run || node._failed) return;
      var follow = nearBottom();
      if (!p || wi >= words.length) {
        if (pi >= paras.length) { settle(node, text); return; }
        p = document.createElement("p");
        p.className = "pt-answer-body";
        body.appendChild(p);
        words = paras[pi++].split(/(\s+)/);
        wi = 0;
      }
      p.textContent += words.slice(wi, wi + 4).join("");
      wi += 4;
      if (follow) toBottom();
      setTimeout(tick, 32);
    })();
  }

  // again: Try again on a failed reply, which keeps its turn number
  function respond(node, prompt, again) {
    var id = run;
    busy = true;
    active = node;
    setStatus("Working");
    syncAll();
    var n = again ? Number(node.dataset.turn) || 0 : turn;
    if (!again) { node.dataset.turn = n; turn++; }
    var text = replyFor(prompt, n);
    node._failed = false;
    node.querySelector(".cs-msg-think").textContent = "";
    var eh = node.querySelector(".cs-msg-error");
    eh.textContent = "";
    eh.hidden = true;
    node.querySelector(".cs-msg-body").textContent = "";
    node.querySelector(".cs-msg-tools").textContent = "";
    node.querySelector(".cs-msg-helpers").textContent = "";
    node.querySelector(".cs-msg-plan").textContent = "";
    node.querySelector(".cs-msg-asks").textContent = "";
    node._askTools = node._tools = node._helpers = null;
    node._planView = null;
    var wk = node.querySelector(".cs-msg-working");
    wk.textContent = "";
    node._work = window.TxActivity ? window.TxActivity.working(wk) : null;
    var go = function () {
      runHelpers(node, n, id, function () {
        runTools(node, n, id, function () { stream(node, text, id); });
      });
    };
    think(node, prompt, n, id, function () {
      // a planned failure (demo) surfaces once thinking is done
      if (node._fail) { var f = node._fail; node._fail = null; fail(node, f, id, go); return; }
      // a long task plans first and waits for approval
      if (node._planned) { node._planned = false; askPlan(node, id, function () { stream(node, text, id); }); return; }
      // a request pauses the turn before the answer
      if (node._ask) { var rq = node._ask; node._ask = null; askUser(node, id, rq, function () { stream(node, text, id); }); return; }
      go();
    });
  }

  function send(text, failWith, planned, ask, files) {
    var value = text.trim();
    files = files || [];
    if ((!value && !files.length) || busy || !thread) return false;
    // a message of files alone is about those files
    var about = value || (files.length === 1 ? files[0].name : files.length + " files");
    // an expired card closes with the next message; a waiting one blocks it
    if (pending && !waiting()) pending.card.stop();
    if (waiting()) return false;
    if (shell.classList.contains("is-new")) {
      shell.classList.remove("is-new");
      if (topbar) topbar.classList.add("is-slim");
      if (title) title.textContent = about.length > 64 ? about.slice(0, 64).trim() + "…" : about;
    }
    clearFollowups();
    var user = addUser(value, files);
    var reply = addAgent();
    reply.dataset.prompt = about;
    if (failWith) reply._fail = failWith;
    if (planned) reply._planned = true;
    if (ask) reply._ask = ask;
    respond(reply, about);
    syncSlim();
    toBottom();
    return true;
  }

  /* 4.7 ContextCompactionMarker · {type: "contextCompaction", id}
     A divider where earlier messages were summarised. Comes from the runtime,
     from /compact, or from the "Compact conversation" action. Returns true when
     a marker was placed, otherwise why not: "busy", "empty" or "again". */
  var COMPACT_TEXT = "Earlier messages were summarised to free up context.";
  function compact(item, at) {
    var fromRuntime = !!(item && item.id);
    if (!thread) return "empty";
    if (fromRuntime && compacted[item.id]) return "again";
    if (!thread.querySelector(".cs-msg")) return "empty";
    // a reader can't compact mid-reply; the runtime can, before the turn's ask
    if (busy && !fromRuntime) return "busy";
    var last = thread.lastElementChild;
    if (!fromRuntime && last && last.classList.contains("cs-compact")) return "again";

    var id = fromRuntime ? item.id : "compact-" + Date.now();
    compacted[id] = true;
    var follow = nearBottom();
    var el = document.createElement("div");
    el.className = "cs-compact";
    el.dataset.id = id;
    el.setAttribute("role", "note");
    el.innerHTML =
      '<span class="cs-compact-rule" aria-hidden="true"></span>' +
      '<span class="cs-compact-text"><svg class="tx-ic tx-ic-sm" aria-hidden="true"><use href="#i-compact"/></svg><span></span></span>' +
      '<span class="cs-compact-rule" aria-hidden="true"></span>';
    el.querySelector(".cs-compact-text > span").textContent = COMPACT_TEXT;

    // mid-turn, everything before this turn's ask was summarised
    var turnNode = at || (busy ? active : null);
    var ask = turnNode && turnNode.previousElementSibling;
    var before = ask && ask.classList.contains("cs-msg-user") ? ask : null;
    // two compactions with nothing between them read as one divider
    var prev = before ? before.previousElementSibling : thread.lastElementChild;
    if (prev && prev.classList.contains("cs-compact")) {
      prev.dataset.id += " " + id;
      return true;
    }
    if (before) thread.insertBefore(el, before);
    else thread.appendChild(el);

    if (window.TxTrace && window.TxTrace.compact) window.TxTrace.compact();
    if (follow) toBottom();
    if (announce) announce.textContent = COMPACT_TEXT;
    return true;
  }

  function compactNote(result) {
    if (!announce || result === true) return;
    announce.textContent = result === "busy" ? "Wait for the reply to finish, then compact."
      : result === "again" ? "Already compacted. Nothing new to summarise."
      : "Nothing to compact yet.";
  }

  /* 4.12 TurnError · inline in the reply that failed. With willRetry the
     turn stays active and reads "Retrying…"; otherwise it ends here. */
  function fail(node, err, id, resume) {
    if (!window.TxError) return;
    node._failed = true;
    node.classList.remove("is-thinking", "is-streaming");
    if (node._think && node._think.get().streaming) node._think.update({ streaming: false });
    if (node._work) node._work.hide();
    var follow = nearBottom();
    var view = window.TxError.render(node.querySelector(".cs-msg-error"), err, {
      onRetry: function () {
        if (busy) return;
        node._fail = null;
        respond(node, node.dataset.prompt || "", true);
      },
      onCompact: function () {
        var r = compact(null, node);
        compactNote(r);
        return r === true || r === "again";
      }
    });
    node._error = view;
    if (follow) toBottom();
    if (err.willRetry) {
      setStatus("Working");
      // the sample retry succeeds; a runtime retry reports through TxChat.item
      if (resume) setTimeout(function () {
        if (id !== run || node._error !== view) return;
        node._failed = false;
        node._error = null;
        var host = node.querySelector(".cs-msg-error");
        host.textContent = "";
        host.hidden = true;
        resume();
      }, reduce.matches ? 300 : 1800);
      return;
    }
    node.removeAttribute("aria-busy");
    node.dataset.text = "";
    busy = false;
    active = null;
    setStatus("Ready");
    syncAll();
  }

  // placeholder failures for the /error demo command until 7.6 is wired
  var HTTP = { rateLimited: 429, quota: 429, credentials: 401, providerDown: 503, contextWindow: 400, other: 500 };
  function sampleError(reason, willRetry) {
    return { reason: reason, httpStatus: HTTP[reason], willRetry: willRetry,
      turnId: "turn_" + Math.random().toString(36).slice(2, 8) };
  }

  function clearInput(el, btn) {
    if (!el) return;
    el.value = "";
    el.style.height = "";
    if (btn) btn.disabled = true;
  }

  function submit(el) {
    // 6.6 policy demos · /steer on|off · /elicitation ask|decline
    var pol = el.value.trim().match(/^\/(steer)\s+(on|off)\s*$|^\/(elicitation)\s+(ask|decline)\s*$/i);
    if (pol) {
      if (pol[1]) policy.steer = pol[2].toLowerCase() === "on";
      else policy.elicitation = pol[4].toLowerCase();
      clearInput(el, el === heroInput ? heroSend : bottomSend);
      refreshComposer();
      if (announce) announce.textContent = pol[1] ? "Steer is " + (policy.steer ? "on" : "off") + "."
        : "MCP elicitation " + (policy.elicitation === "decline" ? "is declined automatically." : "asks you.");
      return;
    }
    // 6.6 · a turn in flight, working or paused on a request: a note steers it,
    // if steer is on; commands and anything else wait for the turn or Stop
    if (el === bottomInput && live()) {
      var note = el.value.trim();
      if (!note) return;
      if (!policy.steer || note.charAt(0) === "/") { nudge(); return; }
      steerTurn(waiting() ? pending.node : active, note);
      clearInput(el, el === heroInput ? heroSend : bottomSend);
      syncSlim();
      return;
    }
    // /elicit [url | verify | unknown] [expire] [fail <status>] · demo an MCP elicitation
    var em2 = el.value.trim().match(/^\/elicit((?:\s+(?:url|verify|unknown|expire|fail|\d{3}))*)\s*$/i);
    if (em2) {
      var ew = em2[1].toLowerCase().trim().split(/\s+/);
      var eh = function (w) { return ew.indexOf(w) > -1; };
      if (eh("fail")) demo.failNext = Number(ew.filter(function (w) { return /^\d{3}$/.test(w); })[0]) || 500;
      var esample = sampleElicit({ mode: eh("url") ? "url" : eh("verify") ? "verify" : eh("unknown") ? "unknown" : "form", expire: eh("expire") });
      var eprompt = eh("url") ? "Send the renewal contract to Globex for signature." : eh("verify") ? "Rotate the admin password for the Okta tenant."
        : "Set up a CRM trial workspace for the new team.";
      if (!send(eprompt, null, false, esample)) { demo.failNext = 0; return; }
      clearInput(heroInput, heroSend);
      clearInput(bottomInput, bottomSend);
      if (bottomInput) bottomInput.focus();
      return;
    }
    // /ask [one | tool [plain] | auto | autopilot] [expire] [fail <status>] · demo a request
    var am = el.value.trim().match(/^\/ask((?:\s+(?:one|tool|plain|auto|autopilot|expire|fail|\d{3}))*)\s*$/i);
    if (am) {
      var words = am[1].toLowerCase().trim().split(/\s+/);
      var has = function (w) { return words.indexOf(w) > -1; };
      if (has("fail")) demo.failNext = Number(words.filter(function (w) { return /^\d{3}$/.test(w); })[0]) || 500;
      var sample = sampleRequest({ tool: has("tool"), plain: has("plain"), one: has("one"), expire: has("expire"),
        auto: has("autopilot") ? "pilot" : has("auto") ? "read" : "" });
      var prompt = has("tool") || has("autopilot") ? "Move the deals that slipped out of Q3 into Q4 in HubSpot."
        : has("auto") ? "Which deals slipped out of Q3?" : "Build the Q3 pipeline review.";
      if (!send(prompt, null, false, sample)) { demo.failNext = 0; return; }
      clearInput(heroInput, heroSend);
      clearInput(bottomInput, bottomSend);
      if (bottomInput) bottomInput.focus();
      return;
    }
    // /plan [expire | fail <status>] · demo a long task that plans first
    var pm = el.value.trim().match(/^\/plan(?:\s+(expire|fail)(?:\s+(\d{3}))?)?\s*$/i);
    if (pm) {
      var mode = (pm[1] || "").toLowerCase();
      if (mode === "expire") demo.expiresIn = 12000;
      if (mode === "fail") demo.failNext = Number(pm[2]) || 500;
      if (!send("Build the Q3 pipeline review for Monday's board meeting.", null, true)) { demo.failNext = 0; demo.expiresIn = 5 * 60000; return; }
      clearInput(heroInput, heroSend);
      clearInput(bottomInput, bottomSend);
      if (bottomInput) bottomInput.focus();
      return;
    }
    // /error <reason> [retry] · demo a failed turn
    var em = el.value.trim().match(/^\/error(?:\s+([a-z]+))?(?:\s+(retry))?$/i);
    if (em && window.TxError) {
      var want = (em[1] || "other").toLowerCase();
      var reason = window.TxError.reasons.filter(function (r) { return r.toLowerCase() === want; })[0] || "other";
      if (!send("Pull the latest numbers for the Q3 board deck.", sampleError(reason, !!em[2]))) return;
      clearInput(heroInput, heroSend);
      clearInput(bottomInput, bottomSend);
      if (bottomInput) bottomInput.focus();
      return;
    }
    // /compact is a command, not a message
    if (/^\/compact\s*$/i.test(el.value.trim())) {
      var result = compact();
      compactNote(result);
      if (result !== "busy") {
        clearInput(el, el === heroInput ? heroSend : bottomSend);
        syncSlim();
      }
      return;
    }
    // attachments go with the message once they've uploaded
    var ac = attachOf(el), as = ac ? ac.state() : null;
    if (as && (as.uploading || as.failed)) {
      if (announce) announce.textContent = as.uploading ? "Wait for the upload to finish, then send." : "An attachment didn\u2019t upload. Retry or remove it, then send.";
      return;
    }
    if (!send(el.value, null, false, null, ac ? ac.files() : [])) return;
    if (ac) ac.clear();
    clearInput(heroInput, heroSend);
    clearInput(bottomInput, bottomSend);
    if (bottomInput) bottomInput.focus();
  }

  function reset() {
    run++;
    busy = false;
    turn = 0;
    active = null;
    compacted = {};
    if (heroAttach) heroAttach.clear();
    if (bottomAttach) bottomAttach.clear();
    if (pending) { pending.card.destroy(); pending = null; }
    refreshComposer();
    if (window.TxTrace) window.TxTrace.reset();
    if (window.TxHelpers) window.TxHelpers.reset();
    shell.classList.add("is-new");
    setGreeting();
    if (thread) thread.textContent = "";
    if (announce) announce.textContent = "";
    if (topbar) topbar.classList.remove("is-slim");
    if (title) title.textContent = "New conversation";
    setStatus("Ready");
    clearInput(heroInput, heroSend);
    clearInput(bottomInput, bottomSend);
    if (bottomComposer) bottomComposer.classList.remove("is-slim");
    if (scroll) scroll.scrollTop = 0;
    if (heroInput) heroInput.focus();
  }

  // copy sits in each agent turn's receipt line; a follow-up sends itself
  if (thread) thread.addEventListener("click", function (e) {
    var next = e.target.closest(".cs-next-row");
    if (next) {
      if (send(next.dataset.ask)) {
        clearInput(bottomInput, bottomSend);
        if (bottomInput) bottomInput.focus();
      }
      return;
    }
    var copy = e.target.closest(".cs-act-copy");
    var msg = e.target.closest(".cs-msg-agent");
    if (!msg) return;
    if (copy) {
      var label = copy.querySelector(".cs-act-label");
      var done = function () {
        label.textContent = "Copied";
        clearTimeout(copy._t);
        copy._t = setTimeout(function () { label.textContent = "Copy"; }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(msg.dataset.text || "").then(done, done);
      else done();
    }
  });

  [heroInput, bottomInput].forEach(function (el) {
    if (!el) return;
    el.addEventListener("input", function () {
      syncSlim();
      grow(el);
      syncSend(el, el === heroInput ? heroSend : bottomSend);
    });
    el.addEventListener("keydown", function (e) {
      if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
      e.preventDefault();
      submit(el);
    });
  });

  if (bottomInput) {
    bottomInput.addEventListener("focus", function () { grow(bottomInput); });
  }
  if (heroSend) heroSend.addEventListener("click", function () { submit(heroInput); });
  if (bottomSend) bottomSend.addEventListener("click", function () { submit(bottomInput); });
  if (newChat) newChat.addEventListener("click", reset);
  if (dockNew) dockNew.addEventListener("click", reset);
  document.addEventListener("keydown", function (e) {
    if (!(e.metaKey || e.ctrlKey) || e.repeat) return;
    if (e.key.toLowerCase() === "j") { e.preventDefault(); reset(); }
  });

  // Discuss on a DocumentCard starts a follow-up about that file
  document.addEventListener("tx:discuss", function (e) {
    var file = e.detail && e.detail.file;
    if (!file || !bottomInput || shell.classList.contains("is-new")) return;
    bottomInput.value = "About \u201C" + (file.name || "this file") + "\u201D: ";
    syncSlim();
    grow(bottomInput);
    syncSend(bottomInput, bottomSend);
    bottomInput.focus();
    bottomInput.setSelectionRange(bottomInput.value.length, bottomInput.value.length);
  });

  // the "Compact conversation" action raises tx:compact and reads the result
  document.addEventListener("tx:compact", function (e) {
    var result = compact();
    compactNote(result);
    if (e.detail) e.detail.result = result;
  });

  // attachments · a paperclip in each composer, paste, and drop anywhere
  if (window.TxAttach) {
    var say = function (t) { if (announce) announce.textContent = t; };
    var heroCard = heroInput && heroInput.closest(".cs-composer");
    if (heroCard) heroAttach = window.TxAttach.attach(heroCard, { announce: say, onChange: function () { syncSend(heroInput, heroSend); } });
    if (bottomComposer) bottomAttach = window.TxAttach.attach(bottomComposer, { announce: say, onChange: function () { syncSend(bottomInput, bottomSend); syncSlim(); } });
    // the composer in view takes the drop
    window.TxAttach.dropzone(function () { return shell.classList.contains("is-new") ? heroAttach : bottomAttach; });
  }

  // runtime items that live at the thread level, not inside a message
  window.TxChat = {
    // wire the real answer call: fn(requestId, payload) → Promise; reject with {status}
    setSubmit: function (fn) { if (typeof fn === "function") submitAnswer = fn; },
    // steer a paused turn: fn(text, turnId) → Promise
    setSteer: function (fn) { if (typeof fn === "function") steerFn = fn; },
    // {steer: bool, elicitation: "ask" | "decline"}; returns the current policy
    policy: function (p) {
      if (p && typeof p.steer === "boolean") policy.steer = p.steer;
      if (p && (p.elicitation === "ask" || p.elicitation === "decline")) policy.elicitation = p.elicitation;
      refreshComposer();
      return { steer: policy.steer, elicitation: policy.elicitation };
    },
    lastAnswer: function () { return lastAnswer; },
    item: function (it) {
      // 6.4 · an MCP elicitation from the runtime pins its card
      if (it && window.TxElicit && window.TxElicit.isElicitation(it)) {
        if (policy.elicitation === "decline") return false;
        var ea = thread ? thread.querySelectorAll(".cs-msg-agent") : [];
        var en = active || (pending && pending.node) || ea[ea.length - 1];
        if (!en) return false;
        return pinElicit(en, it, function () {});
      }
      // 6.1 · a PendingRequest from the runtime pins its card; the runtime
      // resumes the turn itself once answered
      if (it && (it.type === "request" || it.method === "item/tool/requestUserInput") && window.TxApproval) {
        var ra = thread ? thread.querySelectorAll(".cs-msg-agent") : [];
        var rn = active || (pending && pending.node) || ra[ra.length - 1];
        if (!rn) return false;
        return pinRequest(rn, it, function (kind, extra) {
          var v = rn._planView;
          if (!v || !window.TxApproval.isPlanApproval(window.TxApproval.normalize(it))) return;
          if (kind === "approve" || kind === "expired") v.start();
          else if (kind === "revise") v.settle("revise");
          else v.settle(kind === "stopped" ? "stopped" : extra === 409 ? "answered" : "gone");
        });
      }
      // 6.3 · a tool approval the mode answered on its own: a record, no card
      if (it && it.type === "toolApproval.auto" && window.TxApproval) {
        var aa = thread ? thread.querySelectorAll(".cs-msg-agent") : [];
        var an = active || aa[aa.length - 1];
        if (!an) return false;
        autoRecord(an, it);
        return true;
      }
      if (it && it.type === "contextCompaction") return compact(it);
      // plan.updated (or a snapshot) · the plan card on the turn in flight
      // is rebuilt from it
      if (it && (it.type === "plan.updated" || it.type === "plan") && window.TxPlan) {
        var pa = thread ? thread.querySelectorAll(".cs-msg-agent") : [];
        var pn = active || (pending && pending.node) || pa[pa.length - 1];
        if (!pn) return false;
        if (pn._planView) pn._planView.update(it);
        else pn._planView = window.TxPlan.render(pn.querySelector(".cs-msg-plan"), it);
        return true;
      }
      // a turn error lands on the turn in flight, or the latest reply
      if (it && it.type === "turnError") {
        var agents = thread ? thread.querySelectorAll(".cs-msg-agent") : [];
        var node = active || agents[agents.length - 1];
        if (!node) return false;
        if (node._error && node._failed) { node._error.update(it); if (!it.willRetry) { node.removeAttribute("aria-busy"); busy = false; active = null; setStatus("Ready"); syncAll(); } return true; }
        fail(node, it, run);
        return true;
      }
      return false;
    }
  };

  syncAll();
  syncSlim();
})();

/* dock magnification — two critically damped springs, never a raw pointer:
   one carries the pointer's position, one its presence over the bar. Each key's
   size is a pure function of the two, so the swell glides in from nothing,
   follows without lag spikes, and deflates in place when the pointer leaves.
   Key centres come from the resting layout, not live rects, so a growing key
   never pushes the curve that sizes it (no feedback shimmer, no layout reads
   per frame). */
(function () {
  "use strict";

  var dock = document.querySelector(".cs-dock");
  if (!dock) return;
  var btns = Array.prototype.slice.call(dock.querySelectorAll(".cs-dock-btn"));
  var reduced = matchMedia("(prefers-reduced-motion: reduce)");
  var fine = matchMedia("(hover: hover) and (pointer: fine)");
  var BASE = 40, PEAK = 52, REACH = 140;
  // spring stiffness in rad/s: settle time is roughly 5 / ω seconds
  var W_POINTER = 11, W_PRESENCE = 7;
  var px = { x: 0, v: 0, t: 0 };   // pointer offset from the dock's centre
  var on = { x: 0, v: 0, t: 0 };   // presence, 0 → 1
  var rest = [];                   // resting key centres, same frame of reference
  var centre = 0, raf = 0, last = 0;

  function measure() {
    var r = dock.getBoundingClientRect();
    var gap = parseFloat(getComputedStyle(dock).columnGap) || 0;
    // keys the layout has hidden take no slot
    var slot = 0, n = btns.filter(function (b) { return b.getClientRects().length; }).length;
    centre = r.left + r.width / 2;
    rest = btns.map(function (b) {
      return b.getClientRects().length ? (slot++ - (n - 1) / 2) * (BASE + gap) : Infinity;
    });
  }

  function step(s, w, dt) {
    s.v += (-w * w * (s.x - s.t) - 2 * w * s.v) * dt;
    s.x += s.v * dt;
  }

  function settled(s, eps) {
    return Math.abs(s.x - s.t) < eps && Math.abs(s.v) < eps * 10;
  }

  // cosine falloff: a soft shoulder at the edge of reach instead of a hard ramp
  function size(i) {
    var d = Math.min(Math.abs(px.x - rest[i]), REACH);
    return BASE + (PEAK - BASE) * on.x * (0.5 + 0.5 * Math.cos(Math.PI * d / REACH));
  }

  function paint() {
    btns.forEach(function (btn, i) {
      var s = size(i);
      btn.style.width = s + "px";
      btn.style.height = s + "px";
      var ic = btn.querySelector(".cs-dock-ic");
      if (ic) ic.style.transform = "scale(" + (1 + (s / BASE - 1) * 0.6) + ")";
    });
  }

  function clear() {
    btns.forEach(function (btn) {
      btn.style.width = "";
      btn.style.height = "";
      var ic = btn.querySelector(".cs-dock-ic");
      if (ic) ic.style.transform = "";
    });
  }

  function tick(now) {
    var dt = last ? Math.min((now - last) / 1000, 0.064) : 1 / 60;
    last = now;
    // fixed sub-steps keep the integration stable through a dropped frame
    for (var n = Math.ceil(dt / 0.008), h = dt / n; n > 0; n--) {
      step(px, W_POINTER, h);
      step(on, W_PRESENCE, h);
    }
    if (settled(px, 0.05) && settled(on, 0.001)) {
      px.x = px.t; px.v = 0;
      on.x = on.t; on.v = 0;
    }
    if (on.x === 0 && on.t === 0) {
      clear();
      raf = 0; last = 0;
      return;
    }
    paint();
    var still = px.v === 0 && on.v === 0;
    raf = still ? 0 : requestAnimationFrame(tick);
    if (!raf) last = 0;
  }

  function wake() {
    if (!raf) raf = requestAnimationFrame(tick);
  }

  function stop() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    last = 0;
    px.x = px.v = px.t = 0;
    on.x = on.v = on.t = 0;
    clear();
  }

  dock.addEventListener("mouseenter", function (e) {
    if (reduced.matches || !fine.matches) return;
    measure();
    // arriving from nothing: start the swell where the pointer is, not where it left
    if (on.x < 0.02) { px.x = px.t = e.clientX - centre; px.v = 0; }
    on.t = 1;
    wake();
  });
  dock.addEventListener("mousemove", function (e) {
    if (reduced.matches || !fine.matches) return;
    if (on.t !== 1) { measure(); on.t = 1; }
    px.t = e.clientX - centre;
    wake();
  });
  // the pointer's last position is kept, so the swell sinks where it stood
  dock.addEventListener("mouseleave", function () {
    on.t = 0;
    wake();
  });
  window.addEventListener("resize", stop);
  if (reduced.addEventListener) reduced.addEventListener("change", stop);
  if (fine.addEventListener) fine.addEventListener("change", stop);
})();

/* dock stow — it rests below the edge until the pointer reaches the bottom;
   the composer reserves the dock's height while it is up */
(function () {
  "use strict";

  var dock = document.querySelector(".cs-dock");
  if (!dock) return;
  var bottom = dock.closest(".cs-bottom");
  var fine = matchMedia("(hover: hover) and (pointer: fine)");
  var open = false;
  var fromBottom = Infinity;
  var SLACK = 24; // px above the dock's top edge before it stows

  // distance from the viewport bottom to the dock's resting top edge, plus
  // slack; the rise transform is backed out so the line doesn't drift mid-rise
  function reach() {
    var t = getComputedStyle(dock).transform;
    var shift = t === "none" ? 0 : new DOMMatrix(t).m42;
    return window.innerHeight - (dock.getBoundingClientRect().top - shift) + SLACK;
  }

  function setDock(next) {
    if (!fine.matches || open === next) return;
    open = next;
    dock.classList.toggle("is-stowed", !next);
    if (bottom) bottom.classList.toggle("is-dock-up", next);
  }

  window.addEventListener("mousemove", function (e) {
    if (!fine.matches) return;
    fromBottom = window.innerHeight - e.clientY;
    if (!open) {
      if (fromBottom <= 10) setDock(true);
    } else if (fromBottom >= reach() && !dock.contains(document.activeElement)) {
      setDock(false);
    }
  }, { passive: true });

  document.documentElement.addEventListener("mouseleave", function () {
    if (!fine.matches) return;
    if (!dock.contains(document.activeElement)) setDock(false);
  });

  dock.addEventListener("focusin", function () { setDock(true); });
  dock.addEventListener("focusout", function (e) {
    if (dock.contains(e.relatedTarget)) return;
    if (fine.matches && fromBottom >= reach()) setDock(false);
  });

  if (fine.addEventListener) {
    fine.addEventListener("change", function () {
      if (!fine.matches) {
        open = false;
        dock.classList.add("is-stowed");
        if (bottom) bottom.classList.remove("is-dock-up");
      }
    });
  }
})();

/* dock navigation — the two panel keys toggle their region */
(function () {
  "use strict";

  var shell = document.querySelector(".cs-shell");
  var dock = document.querySelector(".cs-dock");
  if (!shell || !dock) return;
  var activityBtn = dock.querySelector('[data-cs-panel="activity"]');
  var close = document.getElementById("cs-activity-close");

  function setPanel(name, on) {
    shell.classList.toggle(name === "rail" ? "is-rail-off" : "is-act-off", !on);
    var btn = dock.querySelector('[data-cs-panel="' + name + '"]');
    if (btn) btn.setAttribute("aria-pressed", String(on));
  }

  Array.prototype.forEach.call(dock.querySelectorAll("[data-cs-panel]"), function (btn) {
    btn.addEventListener("click", function () {
      setPanel(btn.getAttribute("data-cs-panel"), btn.getAttribute("aria-pressed") !== "true");
    });
  });

  if (close) {
    close.addEventListener("click", function () {
      setPanel("activity", false);
      if (activityBtn) activityBtn.focus();
    });
  }

  document.addEventListener("keydown", function (e) {
    if (!(e.metaKey || e.ctrlKey) || e.repeat) return;
    var name = null;
    if (e.key.toLowerCase() === "b") name = "rail";
    else if (e.key === ".") name = "activity";
    if (!name) return;
    e.preventDefault();
    var btn = dock.querySelector('[data-cs-panel="' + name + '"]');
    if (btn) setPanel(name, btn.getAttribute("aria-pressed") !== "true");
  });
})();

/* activity tabs — the tx-tabs contract: roving tabindex, arrows / home / end */
(function () {
  "use strict";

  var tablist = document.querySelector(".cs-activity-tabs");
  if (!tablist) return;
  var tabs = Array.prototype.slice.call(tablist.querySelectorAll("[role='tab']"));

  function activate(tab, focus) {
    tabs.forEach(function (t) {
      var on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
    });
    if (focus) tab.focus();
  }

  tabs.forEach(function (tab, i) {
    tab.addEventListener("click", function () { activate(tab, false); });
    tab.addEventListener("keydown", function (e) {
      var next = -1;
      if (e.key === "ArrowRight") next = i + 1;
      else if (e.key === "ArrowLeft") next = i - 1;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = tabs.length - 1;
      if (next < 0) return;
      e.preventDefault();
      activate(tabs[(next + tabs.length) % tabs.length], true);
    });
  });
})();

/* view all — older conversations open in place under Previous */
(function () {
  "use strict";

  var btn = document.getElementById("cs-view-all");
  var older = document.getElementById("cs-older");
  if (!btn || !older) return;

  btn.addEventListener("click", function () {
    var open = btn.getAttribute("aria-expanded") !== "true";
    older.hidden = !open;
    older.classList.toggle("is-in", open);
    btn.setAttribute("aria-expanded", String(open));
    btn.textContent = open ? "Show less" : "View all conversations";
    // opening: show the first older label and its first chat; closing: keep the toggle in sight
    (open ? older.querySelector(".cs-session") : btn).scrollIntoView({ block: "nearest" });
  });
})();

/* account menu — opens upward from the footer; arrows move, Escape returns */
(function () {
  "use strict";

  var btn = document.getElementById("cs-account");
  var menu = document.getElementById("cs-account-menu");
  if (!btn || !menu) return;
  var items = Array.prototype.slice.call(menu.querySelectorAll("[role='menuitem']"));

  function setOpen(open, focusItem) {
    menu.hidden = !open;
    menu.classList.toggle("is-in", open);
    btn.setAttribute("aria-expanded", String(open));
    if (open && focusItem != null) items[focusItem].focus();
  }

  btn.addEventListener("click", function () {
    setOpen(menu.hidden, menu.hidden ? 0 : null);
  });
  btn.addEventListener("keydown", function (e) {
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true, e.key === "ArrowUp" ? items.length - 1 : 0);
    }
  });

  menu.addEventListener("keydown", function (e) {
    var i = items.indexOf(document.activeElement);
    var next = null;
    if (e.key === "ArrowDown") next = i + 1;
    else if (e.key === "ArrowUp") next = i - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else if (e.key === "Escape") { e.preventDefault(); setOpen(false); btn.focus(); return; }
    else if (e.key === "Tab") { setOpen(false); return; }
    if (next === null) return;
    e.preventDefault();
    items[(next + items.length) % items.length].focus();
  });

  // picking an item closes the menu (actions are placeholders in this study)
  items.forEach(function (item) {
    item.addEventListener("click", function () { setOpen(false); btn.focus(); });
  });

  document.addEventListener("pointerdown", function (e) {
    if (!menu.hidden && !menu.contains(e.target) && !btn.contains(e.target)) setOpen(false);
  });
})();

/* agent picker — chosen in the new-conversation composer, then fixed for the
   conversation; the top bar only names the agent that answered */
(function () {
  "use strict";

  var btn = document.getElementById("cs-agent-pick");
  var menu = document.getElementById("cs-agent-menu");
  if (!btn || !menu) return;
  var items = Array.prototype.slice.call(menu.querySelectorAll("[role^='menuitem']"));

  function setText(ids, value) {
    ids.forEach(function (id) { var el = document.getElementById(id); if (el) el.textContent = value; });
  }

  function setOpen(open, focusIndex) {
    menu.hidden = !open;
    if (open) {
      // open upward when the window has no room below the chip
      var r = btn.getBoundingClientRect();
      var below = window.innerHeight - r.bottom;
      menu.classList.toggle("is-up", below < menu.offsetHeight + 16 && r.top > below);
    }
    menu.classList.toggle("is-in", open);
    btn.setAttribute("aria-expanded", String(open));
    if (open && focusIndex != null) items[focusIndex].focus();
  }

  function pick(item) {
    var name = item.getAttribute("data-agent");
    items.forEach(function (it) {
      if (it.hasAttribute("data-agent")) it.setAttribute("aria-checked", String(it === item));
    });
    setText(["cs-pick-name", "cs-agent-name"], name);
    setText(["cs-pick-av", "cs-agent-av"], item.getAttribute("data-initials"));
    btn.setAttribute("aria-label", "Agent: " + name + ". Change agent");
    Array.prototype.forEach.call(document.querySelectorAll(".cs-composer .tx-sr"), function (label) { label.textContent = "Message " + name; });
  }

  btn.addEventListener("click", function () { setOpen(menu.hidden, menu.hidden ? 0 : null); });
  btn.addEventListener("keydown", function (e) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true, e.key === "ArrowUp" ? items.length - 1 : 0);
    }
  });

  menu.addEventListener("keydown", function (e) {
    var i = items.indexOf(document.activeElement);
    var next = null;
    if (e.key === "ArrowDown") next = i + 1;
    else if (e.key === "ArrowUp") next = i - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else if (e.key === "Escape") { e.preventDefault(); setOpen(false); btn.focus(); return; }
    else if (e.key === "Tab") { setOpen(false); return; }
    if (next === null) return;
    e.preventDefault();
    items[(next + items.length) % items.length].focus();
  });

  items.forEach(function (item) {
    item.addEventListener("click", function () {
      if (item.hasAttribute("data-agent")) pick(item);
      setOpen(false);
      btn.focus();
    });
  });

  document.addEventListener("pointerdown", function (e) {
    if (!menu.hidden && !menu.contains(e.target) && !btn.contains(e.target)) setOpen(false);
  });
})();

/* share — copies the conversation link and says so for a moment */
(function () {
  "use strict";

  var btn = document.getElementById("cs-share");
  var label = document.getElementById("cs-share-label");
  if (!btn || !label) return;
  var timer = null;

  btn.addEventListener("click", function () {
    var done = function () {
      label.textContent = "Link copied";
      btn.setAttribute("aria-label", "Link copied");
      clearTimeout(timer);
      timer = setTimeout(function () { label.textContent = "Share"; btn.removeAttribute("aria-label"); }, 1800);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(location.href).then(done, done);
    else done();
  });
})();
