/* activity — what the agent does between its reasoning and its answer.

   4.4 Working indicator · spinner + "Working" (role=status). Shown while the
   turn is active, no answer text has arrived and thinking is done. v2 passes
   the latest activity.updated.label instead ("Searching the web").

   4.5 ToolActivityRow · one MCP (mcpToolCall) or dynamic (dynamicToolCall)
   call, shown business-safe: a friendly connector and tool name, never the raw
   command, and paths are masked anywhere text is shown. Arguments sit behind a
   Details disclosure only. Several calls in one turn group under
   "Used 4 tools · 6.3s ▸".

   4.6 WebSearchRow · type webSearch: globe + "Searched “{query}”" /
   "Opened {host}" / "Looked for “{pattern}” in {host}". Only the host of a
   URL is shown; sources are favicon chips that open in a new tab.

   Item keys: id, type, server, tool, toolTitle?, connectorName?, status
   (inProgress | completed | failed | declined), arguments, result?, error?,
   readOnlyHint?, durationMs?, startedAt?, approvalId? (declined only). */
(function () {
  "use strict";

  var seq = 0;
  var CONNECTORS = {
    hubspot: "HubSpot", salesforce: "Salesforce", google_drive: "Google Drive",
    google_calendar: "Google Calendar", gmail: "Gmail", slack: "Slack",
    github: "GitHub", notion: "Notion", jira: "Jira", web: "Web"
  };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function ic(id) { return '<svg class="tx-ic tx-ic-sm" aria-hidden="true"><use href="#i-' + id + '"/></svg>'; }

  /* ── business-safe text ─────────────────────────────────────────────────── */
  // URLs and file paths become "•••"; emails keep their first letter and domain.
  // Only rooted paths, or relative ones ending in a file extension, count as
  // paths, so dates like 10/12/2026 and words like and/or stay readable.
  function mask(s) {
    return String(s)
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "•••")
      .replace(/(^|[\s("'=:,\[])(?:[A-Za-z]:\\|~?\/)[^\s"'),\]]+/g, "$1•••")
      .replace(/\b[\w.-]+(?:[\\/][\w.-]+)+\.[A-Za-z0-9]{1,5}\b/g, "•••")
      .replace(/\b([A-Za-z0-9])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, "$1•••@$2");
  }
  function maskDeep(v) {
    if (typeof v === "string") return mask(v);
    if (Array.isArray(v)) return v.map(maskDeep);
    if (v && typeof v === "object") {
      var o = {};
      Object.keys(v).forEach(function (k) { o[k] = maskDeep(v[k]); });
      return o;
    }
    return v;
  }
  function words(s) {
    return String(s).replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim().toLowerCase();
  }
  function connectorOf(it) {
    if (it.connectorName) return it.connectorName;
    if (it.type !== "mcpToolCall" || !it.server) return "";
    var key = String(it.server).toLowerCase();
    return CONNECTORS[key] || words(key).replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }
  function toolOf(it) {
    if (it.toolTitle) return it.toolTitle;
    var w = words(it.tool || "tool");
    return w.charAt(0).toUpperCase() + w.slice(1);
  }
  function nameOf(it) {
    var c = connectorOf(it);
    return (c ? c + " · " : "") + toolOf(it);
  }

  function dur(ms) {
    if (ms == null || isNaN(ms)) return "";
    var s = ms / 1000;
    if (s < 10) return s.toFixed(1) + "s";
    if (s < 60) return Math.round(s) + "s";
    return Math.floor(s / 60) + "m " + Math.round(s % 60) + "s";
  }

  // summarise McpToolCallResult content blocks into one short line
  function summarise(result) {
    if (!result) return "";
    var blocks = Array.isArray(result.content) ? result.content : [];
    var text = blocks.filter(function (b) { return b && b.type === "text" && b.text; })
      .map(function (b) { return b.text.trim(); }).join(" ");
    var extra = {};
    blocks.forEach(function (b) { if (b && b.type && b.type !== "text") extra[b.type] = (extra[b.type] || 0) + 1; });
    var parts = Object.keys(extra).map(function (k) {
      var label = k === "resource" || k === "resource_link" ? "resource" : k;
      return extra[k] + " " + label + (extra[k] === 1 ? "" : "s");
    });
    text = mask(text);
    if (text.length > 160) text = text.slice(0, 160).replace(/\s+\S*$/, "") + "…";
    if (!text && !parts.length) return result.structuredContent ? "Returned structured data." : "Done, no output.";
    return [text, parts.length ? "Also returned " + parts.join(", ") + "." : ""].filter(Boolean).join(" ");
  }

  /* ── one shared clock for every live timer on the page ──────────────────── */
  var live = [];
  var clock = null;
  function tickAll() {
    var now = Date.now();
    live = live.filter(function (t) { return t.el.isConnected && !t.stopped; });
    live.forEach(function (t) {
      var ms = now - t.start;
      t.el.textContent = ms < 60000 ? (ms / 1000).toFixed(1) + "s" : dur(ms);
    });
    if (!live.length) { clearInterval(clock); clock = null; }
  }
  function track(el, start) {
    var t = { el: el, start: start, stopped: false };
    live.push(t);
    if (!clock) clock = setInterval(tickAll, 100);
    tickAll();
    return t;
  }

  /* ── 4.4 Working indicator ──────────────────────────────────────────────── */
  function working(host) {
    var el = document.createElement("div");
    el.className = "wk";
    el.setAttribute("role", "status");
    el.innerHTML = '<span class="tx-spin wk-spin" aria-hidden="true"></span><span class="wk-label tx-shimmer"></span>';
    host.appendChild(el);
    host.hidden = true;
    var label = el.querySelector(".wk-label");
    return {
      el: el,
      show: function (text) { host.hidden = false; label.textContent = text || "Working"; },
      hide: function () { host.hidden = true; label.textContent = ""; }
    };
  }

  /* ── 4.6 WebSearchRow ───────────────────────────────────────────────────── */
  // action: search (query, queries[]) | openPage (url) | findInPage (url, pattern) | other
  function hostOf(u) {
    var s = String(u || "");
    try { return new URL(s).hostname.replace(/^www\./, ""); }
    catch (e) {
      // bare "site.com/path" still reads as a host; free text does not
      var m = s.trim().match(/^(?:[a-z][a-z0-9+.-]*:\/\/)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?=[\/?#:]|$)/i);
      return m ? m[1].toLowerCase().replace(/^www\./, "") : "";
    }
  }
  // only http(s) links become anchors; anything else renders inert
  function safeHref(u) {
    try {
      var x = new URL(String(u));
      return x.protocol === "https:" || x.protocol === "http:" ? x.href : "";
    } catch (e) { return ""; }
  }
  function clip(v, n) {
    v = String(v || "").trim();
    return v.length > n ? v.slice(0, n).replace(/\s+\S*$/, "") + "…" : v;
  }
  function queriesOf(it) {
    var a = it.action || {};
    var qs = a.queries && a.queries.length ? a.queries : [a.query || it.query];
    return qs.filter(function (q) { return q && String(q).trim(); });
  }
  function quote(v) { return '<q class="ws-q">' + esc(clip(mask(v), 64)) + '</q>'; }
  function hostTag(u, fallback) { return '<b class="ws-host">' + esc(hostOf(u) || fallback) + '</b>'; }

  function webLabel(it, live) {
    var a = it.action || {};
    var type = a.type || "search";
    if (type === "search") {
      var qs = queriesOf(it);
      if (!qs.length) return live ? "Searching the web" : "Searched the web";
      return (live ? "Searching " : "Searched ") + quote(qs[0]) +
        (qs.length > 1 ? ' <span class="ws-more">+' + (qs.length - 1) + '</span>' : "");
    }
    if (type === "openPage") return (live ? "Opening " : "Opened ") + hostTag(a.url, "a page");
    if (type === "findInPage") {
      var p = a.pattern || it.query;
      return (live ? "Looking for " : "Looked for ") + (p ? quote(p) : "text") + " in " + hostTag(a.url, "the page");
    }
    return live ? "Using the web" : "Used the web";
  }

  // a favicon chip: the site's initial, with its icon over it when one is
  // supplied (no favicon service is called, so no host leaves the page)
  function sourceChip(src) {
    var host = hostOf(src.url) || "source";
    var href = safeHref(src.url);
    var fav = src.favicon && safeHref(src.favicon)
      ? '<img class="ws-fav" src="' + esc(safeHref(src.favicon)) + '" alt="" loading="lazy" referrerpolicy="no-referrer">' : "";
    var inner =
      '<span class="ws-fav-wrap" aria-hidden="true"><span class="ws-letter">' + esc(host.charAt(0).toUpperCase()) + '</span>' + fav + '</span>' +
      '<span class="ws-src-host">' + esc(host) + '</span>';
    var title = esc((src.title ? clip(src.title, 90) + " · " : "") + host);
    return '<li>' + (href
      ? '<a class="ws-src" href="' + esc(href) + '" target="_blank" rel="noopener noreferrer" title="' + title + '">' + inner + '<span class="tx-sr"> (opens in a new tab)</span></a>'
      : '<span class="ws-src" title="' + title + '">' + inner + '</span>') + '</li>';
  }

  var MAX_SOURCES = 6;
  function renderWeb(li, it) {
    var status = it.status === "completed" || it.status === "failed" || it.status === "stopped" ? it.status : "inProgress";
    var live = status === "inProgress";
    var qs = queriesOf(it);
    var bodyId = li.id + "-detail";
    var hasDetail = !live && qs.length > 1;
    var time = live ? "" : dur(it.durationMs);
    var srcs = (it.sources || []).filter(function (x) { return x && x.url; });
    var say = SAY[status];

    li.dataset.status = status;
    li.classList.add("ta-web");
    li.classList.toggle("is-bad", status === "failed");
    li.innerHTML =
      '<div class="ta-head">' +
        '<span class="ta-ic ws-ic" aria-hidden="true">' + (live ? '<span class="tx-spin ta-spin"></span>' : ic(status === "failed" ? "alert" : status === "stopped" ? "stop" : "globe")) + '</span>' +
        '<span class="ta-name ws-name">' + webLabel(it, live) + '</span>' +
        '<span class="tx-sr">' + say + (time ? " in " + time : "") + (srcs.length ? ", " + srcs.length + " source" + (srcs.length === 1 ? "" : "s") : "") + '</span>' +
        '<span class="ta-time num" aria-hidden="true">' + time + '</span>' +
        (hasDetail ? '<button type="button" class="ta-more" aria-expanded="' + !!it._open + '" aria-controls="' + bodyId + '">Details' + ic("chev-down") + '</button>' : "") +
      '</div>' +
      (status === "failed" ? '<p class="ta-err">' + esc(mask(it.error && it.error.message || "The web step failed.")) + '</p>' : "") +
      (status === "stopped" ? '<p class="ta-deny">Stopped by you before it finished</p>' : "") +
      (srcs.length ? '<ul class="ws-srcs" role="list" aria-label="Sources">' +
        srcs.slice(0, MAX_SOURCES).map(sourceChip).join("") +
        (srcs.length > MAX_SOURCES ? '<li><span class="ws-src ws-src-more" title="' + esc(srcs.slice(MAX_SOURCES).map(function (x) { return hostOf(x.url); }).join(", ")) + '">+' + (srcs.length - MAX_SOURCES) + '</span></li>' : "") +
      '</ul>' : "") +
      (hasDetail ? '<div class="ta-detail" id="' + bodyId + '"' + (it._open ? "" : " hidden") + '>' +
        '<div class="ta-k">Queries</div><ol class="ws-qs">' +
        qs.map(function (q) { return '<li>' + esc(clip(mask(q), 140)) + '</li>'; }).join("") +
      '</ol></div>' : "");

    // a favicon that fails to load falls back to the initial underneath
    Array.prototype.forEach.call(li.querySelectorAll(".ws-fav"), function (img) {
      img.addEventListener("error", function () { img.remove(); }, { once: true });
    });
    if (li._timer) li._timer.stopped = true;
    li._timer = live ? track(li.querySelector(".ta-time"), it.startedAt || Date.now()) : null;
  }

  /* ── 4.5 ToolActivityRow + group ────────────────────────────────────────── */
  var ICON = { inProgress: "", completed: "check", failed: "alert", declined: "ban", stopped: "stop" };
  var SAY = { inProgress: "Running", completed: "Done", failed: "Failed", declined: "Not allowed", stopped: "Stopped" };

  function renderRow(li, it) {
    if (it.type === "webSearch") { renderWeb(li, it); return; }
    var status = ICON.hasOwnProperty(it.status) ? it.status : "inProgress";
    var bodyId = li.id + "-detail";
    var summary = status === "completed" ? summarise(it.result) : "";
    var args = it.arguments != null && !(typeof it.arguments === "object" && !Object.keys(it.arguments).length)
      ? JSON.stringify(maskDeep(it.arguments), null, 2) : "";
    var hasDetail = !!(summary || args);
    var time = status === "completed" || status === "failed" || status === "stopped" ? dur(it.durationMs) : "";

    li.dataset.status = status;
    li.classList.toggle("is-bad", status === "failed");
    li.innerHTML =
      '<div class="ta-head">' +
        '<span class="ta-ic" aria-hidden="true">' + (status === "inProgress" ? '<span class="tx-spin ta-spin"></span>' : ic(ICON[status])) + '</span>' +
        '<span class="ta-name">' + esc(nameOf(it)) + '</span>' +
        (it.readOnlyHint ? '<span class="tx-pill tx-pill-line tx-pill-sm ta-ro">Read-only</span>' : "") +
        '<span class="tx-sr">' + SAY[status] + (time ? " in " + time : "") + '</span>' +
        '<span class="ta-time num" aria-hidden="true">' + time + '</span>' +
        (hasDetail ? '<button type="button" class="ta-more" aria-expanded="' + !!it._open + '" aria-controls="' + bodyId + '">Details' + ic("chev-down") + '</button>' : "") +
      '</div>' +
      (status === "failed" ? '<p class="ta-err">' + esc(mask(it.error && it.error.message || "The tool call failed.")) + '</p>' : "") +
      (status === "stopped" ? '<p class="ta-deny">Stopped by you before it finished</p>' : "") +
      (status === "declined" ? '<p class="ta-deny">Not allowed<span aria-hidden="true"> · </span><a href="#approval-' + esc(it.approvalId || it.id) + '">View approval</a></p>' : "") +
      (hasDetail ? '<div class="ta-detail" id="' + bodyId + '"' + (it._open ? "" : " hidden") + '>' +
        (summary ? '<p class="ta-sum">' + esc(summary) + '</p>' : "") +
        (args ? '<div class="ta-k">Arguments</div><pre class="ta-args">' + esc(args) + '</pre>' : "") +
      '</div>' : "");

    if (li._timer) li._timer.stopped = true;
    li._timer = status === "inProgress" ? track(li.querySelector(".ta-time"), it.startedAt || Date.now()) : null;
  }

  function group(host) {
    var gid = "tg-" + (++seq);
    var root = document.createElement("div");
    root.className = "tg is-solo";
    root.innerHTML =
      '<button type="button" class="tg-head" aria-expanded="true" aria-controls="' + gid + '">' +
        '<span class="tg-ic" aria-hidden="true"></span><span class="tg-label"></span>' +
        '<span class="tg-meta num"></span><span class="tg-flag"></span>' +
        '<svg class="tx-ic tx-ic-sm tg-chev" aria-hidden="true"><use href="#i-chev"/></svg>' +
      '</button>' +
      '<div class="tg-body" id="' + gid + '"><div class="tg-clip"><ul class="tg-list" role="list" aria-label="Tool calls"></ul></div></div>';
    host.appendChild(root);

    var head = root.querySelector(".tg-head");
    var icEl = root.querySelector(".tg-ic");
    var label = root.querySelector(".tg-label");
    var meta = root.querySelector(".tg-meta");
    var flag = root.querySelector(".tg-flag");
    var list = root.querySelector(".tg-list");
    var items = [];
    var open = true, touched = false, timer = null;

    function setOpen(v) {
      open = v;
      head.setAttribute("aria-expanded", String(v));
      root.classList.toggle("is-open", v);
    }
    setOpen(true);
    head.addEventListener("click", function () { touched = true; setOpen(!open); });

    // the row's own Details disclosure
    list.addEventListener("click", function (e) {
      var more = e.target.closest(".ta-more");
      if (!more) return;
      var li = more.closest(".ta");
      var it = items.filter(function (x) { return x._li === li; })[0];
      if (!it) return;
      it._open = !it._open;
      more.setAttribute("aria-expanded", String(it._open));
      document.getElementById(more.getAttribute("aria-controls")).hidden = !it._open;
    });

    function renderHead() {
      var running = items.filter(function (x) { return x.status === "inProgress"; }).length;
      var failed = items.filter(function (x) { return x.status === "failed"; }).length;
      var declined = items.filter(function (x) { return x.status === "declined"; }).length;
      var stopped = items.filter(function (x) { return x.status === "stopped"; }).length;
      var web = items.filter(function (x) { return x.type === "webSearch"; }).length;
      var tools = items.length - web;
      var toolsRunning = items.filter(function (x) { return x.status === "inProgress" && x.type !== "webSearch"; }).length;
      root.classList.toggle("is-solo", items.length < 2);
      root.dataset.state = running ? "running" : "done";
      if (timer) { timer.stopped = true; timer = null; }
      if (running) {
        icEl.innerHTML = '<span class="tx-spin ta-spin"></span>';
        label.textContent = toolsRunning ? "Using tools" : "Searching the web";
        var first = Math.min.apply(null, items.map(function (x) { return x.startedAt || Date.now(); }));
        timer = track(meta, first);
        flag.textContent = "";
      } else {
        icEl.innerHTML = ic(failed ? "alert" : stopped ? "stop" : "check");
        label.textContent = !web ? "Used " + tools + " tool" + (tools === 1 ? "" : "s")
          : !tools ? "Searched the web · " + web + " step" + (web === 1 ? "" : "s")
          : "Used " + tools + " tool" + (tools === 1 ? "" : "s") + " and the web";
        // total time across the calls; calls without a duration add nothing
        meta.textContent = dur(items.reduce(function (a, x) { return a + (x.durationMs || 0); }, 0));
        flag.textContent = [failed ? failed + " failed" : "", declined ? declined + " not allowed" : "", stopped ? stopped + " stopped" : ""].filter(Boolean).join(" · ");
      }
      root.classList.toggle("has-bad", !running && failed > 0);
      root.classList.toggle("has-stop", !running && !failed && stopped > 0);
      // open while calls run; fold once all settle, unless the reader chose.
      // A failed or declined call keeps the group open so its message shows.
      if (!touched) setOpen(!!running || items.length < 2 || failed > 0 || declined > 0);
    }

    return {
      el: root,
      // add a call, or merge an update into the call with the same id
      upsert: function (patch) {
        var it = items.filter(function (x) { return x.id === patch.id; })[0];
        if (!it) {
          it = { status: "inProgress" };
          items.push(it);
          it._li = document.createElement("li");
          it._li.className = "ta";
          it._li.id = gid + "-" + items.length;
          list.appendChild(it._li);
        }
        Object.keys(patch).forEach(function (k) { it[k] = patch[k]; });
        if (it.status === "inProgress" && !it.startedAt) it.startedAt = Date.now();
        renderRow(it._li, it);
        renderHead();
        return it;
      },
      items: function () { return items.slice(); }
    };
  }

  window.TxActivity = { working: working, group: group, mask: mask, summarise: summarise, name: nameOf, webLabel: webLabel, host: hostOf };
})();
