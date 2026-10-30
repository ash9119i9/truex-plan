/* helpers — the HelperGroup: helper agents inline in the reply that spawned
   them. A compact Helper board (charts/index.html#c-board) on the turn's own
   clock: one lane per helper, its identity tile, name and model, and a bar for
   its task. Done is neutral, running is blue and edged in blue at its live end,
   needs-you is warn with the ask spelled out under the lane, failed is bad.
   A helper keeps one identity hue for the whole conversation: slots 1-5 in
   order of first appearance, then neutral.

   Helper keys: id, name, role?, model?, icon? (search | write | review | ops |
   data | code | mail | bot), letter?, label (the task), state (running | needs
   | done | failed | stopped), startedAt, endedAt?, tools?[], from? (id of the
   helper whose output this task picked up), ask? (needs), error? (failed).
   Stopped is the reader's Stop: neutral, never a failure. */
(function () {
  "use strict";

  var GLYPHS = {
    search: "M10.5 4.5a6 6 0 1 0 0 12 6 6 0 0 0 0-12zM15 15l4.5 4.5",
    write: "M4.5 19.5h4l10-10a2.83 2.83 0 0 0-4-4l-10 10zM13 7l4 4",
    review: "M12 3.5l7 2.75v5c0 4.25-2.9 7.75-7 9.25-4.1-1.5-7-5-7-9.25v-5zM8.75 12l2.25 2.25 4.25-4.5",
    ops: "M13 3.5L5.5 13.25h6L11 20.5l7.5-9.75h-6z",
    data: "M5 19.5V11M10 19.5V5M15 19.5v-6M20 19.5V8",
    code: "M8.5 7.5L4 12l4.5 4.5M15.5 7.5L20 12l-4.5 4.5M13.5 5l-3 14",
    mail: "M4 6.5h16v11H4zM4.5 7l7.5 6 7.5-6",
    bot: "M6 8.5h12a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 17v-7A1.5 1.5 0 0 1 6 8.5zM12 8.5V5M9.25 13v1M14.75 13v1"
  };
  var STATE = { running: "Running", needs: "Needs you", done: "Done", failed: "Failed", stopped: "Stopped" };

  var seq = 0;
  var slots = {}, nextSlot = 1;
  // identity by first appearance; a sixth helper shows neutral
  function slotOf(id) {
    if (!slots.hasOwnProperty(id)) slots[id] = nextSlot <= 5 ? String(nextSlot++) : "main";
    return slots[id];
  }
  function reset() { slots = {}; nextSlot = 1; }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function ic(id) { return '<svg class="tx-ic tx-ic-sm" aria-hidden="true"><use href="#i-' + id + '"/></svg>'; }
  function dur(ms) {
    var s = Math.max(0, ms) / 1000;
    if (s < 10) return s.toFixed(1) + "s";
    if (s < 60) return Math.round(s) + "s";
    return Math.floor(s / 60) + "m " + Math.round(s % 60) + "s";
  }

  function tile(h) {
    var slot = slotOf(h.id);
    var d = GLYPHS[h.icon];
    return '<span class="hg-tile" data-slot="' + slot + '" aria-hidden="true">' + (d
      ? '<svg viewBox="0 0 24 24"><path d="' + d + '"/></svg>'
      : '<span>' + esc(h.letter || (h.name || "?").charAt(0)) + '</span>') + '</span>';
  }

  /* group(host, { onAnswer(helper, allow) }) → { el, upsert(patch), items() } */
  function group(host, opts) {
    opts = opts || {};
    var gid = "hg-" + (++seq);
    var root = document.createElement("section");
    root.className = "hg";
    root.setAttribute("aria-label", "Helpers");
    root.innerHTML =
      '<button type="button" class="hg-head" aria-expanded="true" aria-controls="' + gid + '">' +
        '<span class="hg-ic" aria-hidden="true"></span><span class="hg-title"></span>' +
        '<span class="hg-meta num"></span><span class="hg-flag"></span>' +
        '<svg class="tx-ic tx-ic-sm hg-chev" aria-hidden="true"><use href="#i-chev"/></svg>' +
      '</button>' +
      '<div class="hg-body" id="' + gid + '"><div class="hg-clip"><div class="hg-board">' +
        '<div class="hg-axis" aria-hidden="true"><span></span><span class="hg-ax"><span class="num">0s</span><span class="hg-ax-end num"></span></span><span></span></div>' +
        '<ul class="hg-lanes" role="list"></ul>' +
      '</div></div></div>';
    host.textContent = "";
    host.appendChild(root);

    var head = root.querySelector(".hg-head");
    var icEl = root.querySelector(".hg-ic");
    var title = root.querySelector(".hg-title");
    var meta = root.querySelector(".hg-meta");
    var flag = root.querySelector(".hg-flag");
    var axEnd = root.querySelector(".hg-ax-end");
    var lanes = root.querySelector(".hg-lanes");
    var t0 = opts.startedAt || Date.now();
    var items = [], open = true, touched = false, timer = null;

    function setOpen(v) {
      open = v;
      head.setAttribute("aria-expanded", String(v));
      root.classList.toggle("is-open", v);
    }
    setOpen(true);
    head.addEventListener("click", function () { touched = true; setOpen(!open); });

    // a wider or narrower column re-decides where labels go
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(function () {
        if (!root.isConnected) { ro.disconnect(); return; }
        if (!items.length) return;
        items.forEach(function (h) { h._nat = h._bare = null; });
        paint();
      });
      ro.observe(root.querySelector(".hg-board"));
    }

    lanes.addEventListener("click", function (e) {
      var b = e.target.closest(".hg-answer");
      if (!b) return;
      var h = items.filter(function (x) { return x._li === b.closest(".hg-lane"); })[0];
      if (!h || h.state !== "needs") return;
      head.focus();
      if (opts.onAnswer) opts.onAnswer(h, b.dataset.allow === "1");
    });

    // a lane's structure changes only with its state; geometry and time tick
    function renderLane(h) {
      var li = h._li;
      h._nat = h._bare = null;
      var src = h.from && items.filter(function (x) { return x.id === h.from; })[0];
      var badge = h.state === "needs" ? '<span class="hg-badge is-warn"><span aria-hidden="true">!</span> Needs you</span>'
        : h.state === "failed" ? '<span class="hg-badge is-bad"><span aria-hidden="true">✕</span> Failed</span>'
        : h.state === "stopped" ? '<span class="hg-badge">Stopped</span>' : "";
      var sub = [h.role, h.model].filter(Boolean).join(" · ");
      var tools = (h.tools || []).slice(0, 2);
      li.dataset.state = h.state;
      li.innerHTML =
        '<div class="hg-who">' + tile(h) +
          '<span class="hg-id"><span class="hg-name-row"><b class="hg-name">' + esc(h.name) + '</b>' + badge + '</span>' +
          (sub ? '<small class="hg-model">' + esc(sub) + '</small>' : "") + '</span>' +
        '</div>' +
        '<div class="hg-track"><span class="hg-bar"></span><span class="hg-label">' +
          (src ? '<span class="hg-from" title="Picked up ' + esc(src.name) + '’s output">↳</span>' : "") +
          '<span class="hg-lt">' + esc(h.label || "Working") + '</span>' +
          (tools.length ? '<span class="hg-tools">' + tools.map(function (t) { return '<span class="hg-tool">' + esc(t) + '</span>'; }).join("") + '</span>' : "") +
        '</span></div>' +
        '<span class="hg-time num"></span>' +
        (h.state === "needs" ? '<div class="hg-ask" role="group" aria-label="' + esc(h.name) + ' needs you">' +
          '<span class="hg-ask-mark" aria-hidden="true">!</span>' +
          '<span class="hg-ask-text">' + esc(h.ask || "Needs your go-ahead to continue.") + '</span>' +
          '<span class="hg-ask-btns"><button type="button" class="tx-btn tx-primary tx-sm hg-answer" data-allow="1">Allow</button>' +
          '<button type="button" class="tx-btn tx-ghost tx-sm hg-answer" data-allow="0">Don’t allow</button></span></div>' : "") +
        (h.state === "failed" ? '<p class="hg-err">' + esc(h.error || "The helper stopped before finishing.") + '</p>' : "");
      var took = h.endedAt ? "took " + dur(h.endedAt - h.startedAt) : "running for " + dur(Date.now() - h.startedAt);
      li.setAttribute("aria-label", [h.name, sub, STATE[h.state], h.label, took,
        src ? "picked up " + src.name + "’s output" : "", tools.length ? "tools: " + tools.join(", ") : "",
        h.state === "needs" ? h.ask : "", h.state === "failed" ? h.error : ""].filter(Boolean).join(", "));
      li.title = (src ? "After " + src.name + " · " : "") + (h.label || "");
    }

    // natural label widths, with and without tool chips, measured once per state
    function measure(h, lab) {
      lab.style.left = "0";
      lab.style.maxWidth = "none";
      lab.style.width = "max-content";
      lab.classList.remove("is-bare");
      h._nat = lab.offsetWidth;
      lab.classList.add("is-bare");
      h._bare = lab.offsetWidth;
      lab.style.width = "";
    }

    // inside the bar when it fits, else just after it; a label never sits
    // before its bar. When neither fits whole, it truncates in whichever
    // side has more room. Tool chips go before the label does.
    function place(h, lab, sPct, wPct) {
      var tw = h._li.querySelector(".hg-track").clientWidth;
      if (!tw) return;
      if (h._nat == null) measure(h, lab);
      var bl = sPct / 100 * tw, bw = wPct / 100 * tw, end = bl + bw;
      var room = tw - end - 3;
      var x, out = false, bare = false, max = "";
      if (h._nat + 4 <= bw) x = bl + 2;
      else if (h._bare + 4 <= bw) { x = bl + 2; bare = true; }
      else if (h._nat <= room) { x = end + 3; out = true; }
      else if (h._bare <= room) { x = end + 3; out = true; bare = true; }
      else if (room > bw - 4 && room >= 56) { x = end + 3; out = true; bare = true; max = room + "px"; }
      else { x = bl + 2; bare = true; max = Math.max(0, bw - 4) + "px"; }
      lab.style.left = x + "px";
      lab.style.maxWidth = max || "none";
      lab.classList.toggle("is-out", out);
      lab.classList.toggle("is-bare", bare);
    }

    function paint() {
      if (!root.isConnected) { clearInterval(timer); timer = null; return; }
      var now = Date.now();
      var live = items.some(function (h) { return !h.endedAt; });
      var span = Math.max(1000, Math.max.apply(null, items.map(function (h) { return (h.endedAt || now) - t0; })));
      items.forEach(function (h) {
        var s = (h.startedAt - t0) / span * 100;
        var w = Math.max(1.5, ((h.endedAt || now) - h.startedAt) / span * 100);
        var bar = h._li.querySelector(".hg-bar");
        var lab = h._li.querySelector(".hg-label");
        bar.style.left = s + "%";
        bar.style.width = Math.min(w, 100 - s) + "%";
        place(h, lab, s, Math.min(w, 100 - s));
        h._li.querySelector(".hg-time").textContent = dur((h.endedAt || now) - h.startedAt);
      });
      axEnd.textContent = live ? "now" : dur(span);
      axEnd.classList.toggle("is-now", live);
      if (live) meta.textContent = dur(now - t0);
      if (!live && timer) { clearInterval(timer); timer = null; }
    }

    function renderHead() {
      var n = items.length;
      var running = items.filter(function (h) { return h.state === "running"; }).length;
      var needs = items.filter(function (h) { return h.state === "needs"; }).length;
      var failed = items.filter(function (h) { return h.state === "failed"; }).length;
      var stopped = items.filter(function (h) { return h.state === "stopped"; }).length;
      var live = running + needs > 0;
      var noun = n + " helper" + (n === 1 ? "" : "s");
      root.dataset.state = needs ? "needs" : live ? "running" : failed ? "failed" : stopped ? "stopped" : "done";
      icEl.innerHTML = needs ? '<span class="hg-mark is-warn">!</span>' : live ? '<span class="tx-spin hg-spin"></span>' : ic(failed ? "alert" : stopped ? "stop" : "check");
      title.textContent = live ? "Running " + noun : "Used " + noun;
      if (!live) meta.textContent = dur(Math.max.apply(null, items.map(function (h) { return (h.endedAt || Date.now()) - t0; })));
      flag.textContent = [needs ? needs + (needs === 1 ? " needs" : " need") + " you" : "", failed ? failed + " failed" : "",
        stopped ? stopped + " stopped" : ""].filter(Boolean).join(" · ");
      flag.classList.toggle("is-warn", needs > 0);
      flag.classList.toggle("is-mute", !needs && !failed && stopped > 0);
      // open while helpers work or need you; fold once all settle, unless the reader chose
      if (!touched) setOpen(live || failed > 0);
      if (live && !timer) timer = setInterval(paint, 250);
    }

    return {
      el: root,
      upsert: function (patch) {
        var h = items.filter(function (x) { return x.id === patch.id; })[0];
        if (!h) {
          h = { state: "running", startedAt: Date.now() };
          items.push(h);
          h._li = document.createElement("li");
          h._li.className = "hg-lane";
          lanes.appendChild(h._li);
        }
        Object.keys(patch).forEach(function (k) { h[k] = patch[k]; });
        if ((h.state === "done" || h.state === "failed" || h.state === "stopped") && !h.endedAt) h.endedAt = Date.now();
        if (h.state === "running" || h.state === "needs") h.endedAt = null;
        renderLane(h);
        renderHead();
        paint();
        return h;
      },
      items: function () { return items.slice(); }
    };
  }

  window.TxHelpers = { group: group, reset: reset, slotOf: slotOf };
})();
