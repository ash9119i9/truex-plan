/* truex system · chapter 05 · primitives behaviour
   All control states live in CSS. This file only moves data, focus and the
   one page clock. No dependency, no framework, one interval. */
(function () {
  "use strict";

  var root = document.documentElement;

  /* ── the bench: Fitts with your own pointer ────────────────────────────────
     W comes from the range, D from the pointer's distance to the cap centre.
     With no hovering pointer (touch, keyboard, pointer elsewhere) D rests at
     360 px. One rAF per move; the curve is redrawn for the current D. */
  var benchRange = document.getElementById("bench-range");
  var benchPlate = document.getElementById("bench-plate");
  var benchBody = document.getElementById("bench-body");
  var benchWrap = document.getElementById("bench-target-wrap");
  var benchMeasure = document.getElementById("bench-measure");
  var wBig = document.getElementById("bench-w-big");
  var wLabel = document.getElementById("bench-w-label");
  var wMeta = document.getElementById("bench-w-meta");
  var dBig = document.getElementById("bench-d-big");
  var dSub = document.getElementById("bench-d-sub");
  var idBig = document.getElementById("bench-id-big");
  var idMeta = document.getElementById("bench-id-meta");
  var mtBig = document.getElementById("bench-mt-big");
  var fittsPath = document.getElementById("bench-fitts-path");
  var fittsDot = document.getElementById("bench-fitts-dot");
  var fittsDrop = document.getElementById("bench-fitts-drop");
  var vLine = document.getElementById("bench-vector-line");
  var vDot = document.getElementById("bench-vector-dot");
  var vLabel = document.getElementById("bench-vector-label");
  var REST = 360;
  var distance = REST;
  var tracking = false;

  function fittsId(d, w) { return Math.log2(Math.max((2 * d) / w, 1)); }
  function plotX(w) { return 10 + ((w - 16) / 48) * 220; }
  function plotY(id) { return 84 - (Math.min(id, 7.4) / 7) * 76; }

  function updateBench() {
    if (!benchRange || !benchPlate) return;
    var w = parseInt(benchRange.value, 10);
    var d = Math.round(distance);
    var id = fittsId(d, w);
    var mt = 0.204 + 0.147 * id;
    benchPlate.style.setProperty("--bench-h", w + "px");
    if (benchWrap) benchWrap.setAttribute("data-w", String(w));
    if (wBig) wBig.textContent = String(w);
    if (wLabel) wLabel.textContent = String(w);
    if (wMeta) wMeta.textContent = String(w);
    if (dBig) dBig.textContent = String(d);
    if (dSub) dSub.textContent = tracking ? "live · your pointer" : "resting · move your pointer";
    if (idBig) idBig.textContent = id.toFixed(2);
    if (idMeta) idMeta.textContent = "ID " + id.toFixed(2);
    if (mtBig) mtBig.textContent = mt.toFixed(2);
    if (fittsPath) {
      var path = "";
      for (var x = 16; x <= 64; x += 2) path += (x === 16 ? "M" : " L") + plotX(x).toFixed(1) + " " + plotY(fittsId(d, x)).toFixed(1);
      fittsPath.setAttribute("d", path);
    }
    var px = plotX(w).toFixed(1), py = plotY(id).toFixed(1);
    if (fittsDot) { fittsDot.setAttribute("cx", px); fittsDot.setAttribute("cy", py); }
    if (fittsDrop) { fittsDrop.setAttribute("x1", px); fittsDrop.setAttribute("x2", px); fittsDrop.setAttribute("y1", py); }
    benchRange.setAttribute("aria-valuetext", w + " pixels; Fitts index " + id.toFixed(2) + " bits at " + d + " pixels");
  }

  var pending = null;
  function track(e) {
    if (e.pointerType === "touch") return;
    pending = { x: e.clientX, y: e.clientY };
    if (track.queued) return;
    track.queued = true;
    requestAnimationFrame(function () {
      track.queued = false;
      if (!pending || !benchWrap || !benchBody) return;
      var box = benchBody.getBoundingClientRect();
      var cap = benchWrap.getBoundingClientRect();
      var cx = cap.left + cap.width / 2, cy = cap.top + cap.height / 2;
      distance = Math.max(Math.hypot(pending.x - cx, pending.y - cy), cap.height / 2);
      tracking = true;
      benchBody.classList.add("is-tracking");
      var near = Math.max(0, Math.min(1, 1 - (distance - cap.height / 2) / 420));
      benchWrap.style.setProperty("--near", near.toFixed(3));
      var ax = pending.x - box.left, ay = pending.y - box.top, bx = cx - box.left, by = cy - box.top;
      if (vLine) { vLine.setAttribute("x1", ax); vLine.setAttribute("y1", ay); vLine.setAttribute("x2", bx); vLine.setAttribute("y2", by); }
      if (vDot) { vDot.setAttribute("cx", ax); vDot.setAttribute("cy", ay); }
      if (vLabel) {
        vLabel.setAttribute("x", ((ax + bx) / 2 + 8).toFixed(1));
        vLabel.setAttribute("y", ((ay + by) / 2 - 8).toFixed(1));
        vLabel.textContent = "D " + Math.round(distance);
      }
      updateBench();
    });
  }
  function rest() {
    pending = null;
    tracking = false;
    distance = REST;
    if (benchBody) benchBody.classList.remove("is-tracking");
    if (benchWrap) benchWrap.style.setProperty("--near", "0");
    updateBench();
  }
  if (benchBody) {
    benchBody.addEventListener("pointermove", track);
    benchBody.addEventListener("pointerleave", rest);
  }
  if (benchRange) {
    benchRange.addEventListener("input", updateBench);
    updateBench();
  }
  if (benchMeasure && benchPlate) {
    benchMeasure.addEventListener("change", function () {
      benchPlate.classList.toggle("is-measuring", benchMeasure.checked);
    });
  }
  var benchTarget = document.getElementById("bench-target");
  if (benchTarget) {
    benchTarget.addEventListener("click", function () {
      toast("ok", "Run approved", "The agent resumed at the write step. 412 lines reconciled.");
    });
  }

  /* ── one clock: mm:ss + a 60 second countdown ring ─────────────────────── */
  var clockEl = document.getElementById("bench-clock");
  var ring = document.getElementById("pv-live-ring");
  var ringSeconds = document.getElementById("pv-ring-seconds");
  var ringLabel = document.getElementById("pv-ring-label");
  var startedAt = performance.now();
  var lastSecond = -1;
  var lastRingSecond = -1;
  var LOOP = 60;

  function tick() {
    var elapsed = (performance.now() - startedAt) / 1000;
    var seconds = Math.floor(elapsed);
    if (clockEl && seconds !== lastSecond) {
      lastSecond = seconds;
      var m = Math.floor(seconds / 60);
      var s = seconds % 60;
      clockEl.textContent = (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
    }
    if (ring) {
      var left = LOOP - (elapsed % LOOP);
      ring.style.setProperty("--tx-p", ((left / LOOP) * 100).toFixed(2));
      var whole = Math.ceil(left);
      if (whole !== lastRingSecond) {
        lastRingSecond = whole;
        if (ringSeconds) ringSeconds.textContent = String(whole);
        if (ringLabel) ringLabel.textContent = whole + " seconds remaining";
      }
    }
  }
  tick();
  setInterval(tick, 250);

  /* ── chips: pick independently ─────────────────────────────────────────── */
  Array.prototype.forEach.call(document.querySelectorAll(".tx-chip[aria-pressed]"), function (chip) {
    chip.addEventListener("click", function () {
      chip.setAttribute("aria-pressed", chip.getAttribute("aria-pressed") === "true" ? "false" : "true");
    });
  });

  /* ── segmented controls: one of n, arrows move the choice ──────────────── */
  Array.prototype.forEach.call(document.querySelectorAll("[data-seg]"), function (seg) {
    var buttons = Array.prototype.slice.call(seg.querySelectorAll("button"));
    function select(button, focus) {
      buttons.forEach(function (b) { b.setAttribute("aria-pressed", String(b === button)); });
      if (focus) button.focus();
      seg.dispatchEvent(new CustomEvent("pv-select", { detail: { button: button, count: buttons.length } }));
    }
    buttons.forEach(function (button, i) {
      button.addEventListener("click", function () { select(button, false); });
      button.addEventListener("keydown", function (e) {
        var next = -1;
        if (e.key === "ArrowRight" || e.key === "ArrowDown") next = i + 1;
        else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = i - 1;
        else if (e.key === "Home") next = 0;
        else if (e.key === "End") next = buttons.length - 1;
        if (next < 0) return;
        e.preventDefault();
        select(buttons[(next + buttons.length) % buttons.length], true);
      });
    });
  });

  /* ── Hick marker: follows whichever picker segment was used last ───────── */
  var hickDot = document.getElementById("pv-hick-dot");
  var hickDrop = document.getElementById("pv-hick-drop");
  var hickNote = document.getElementById("pv-hick-note");
  Array.prototype.forEach.call(document.querySelectorAll("#pickers [data-seg]"), function (seg) {
    seg.addEventListener("pv-select", function (e) {
      var n = e.detail.count;
      var bits = Math.log2(n + 1);
      var x = 24 + ((n - 1) / 7) * 280, y = 140 - (bits / 3.5) * 128;
      if (hickDot) { hickDot.style.cx = x + "px"; hickDot.style.cy = y + "px"; }
      if (hickDrop) {
        hickDrop.setAttribute("x1", x); hickDrop.setAttribute("x2", x); hickDrop.setAttribute("y1", y.toFixed(1));
      }
      if (hickNote) {
        hickNote.innerHTML = "<b>" + seg.getAttribute("aria-label") + " · " + n + " options = " + bits.toFixed(2) + " bits.</b> " +
          (n <= 2 ? "Two visible options are the cheapest choice a surface can ask for." : "Each option past two adds less than the last, but never nothing.");
      }
    });
  });

  /* ── tabs: roving tabindex, panes, arrows / home / end ─────────────────── */
  var tablist = document.getElementById("pv-tabs");
  if (tablist) {
    var tabs = Array.prototype.slice.call(tablist.querySelectorAll("[role='tab']"));
    function activateTab(tab) {
      tabs.forEach(function (t) {
        var on = t === tab;
        t.setAttribute("aria-selected", String(on));
        t.tabIndex = on ? 0 : -1;
        var panel = document.getElementById(t.getAttribute("aria-controls"));
        if (panel) panel.hidden = !on;
      });
      tab.focus();
    }
    tabs.forEach(function (tab, i) {
      tab.addEventListener("click", function () { activateTab(tab); });
      tab.addEventListener("keydown", function (e) {
        var next = -1;
        if (e.key === "ArrowRight") next = i + 1;
        else if (e.key === "ArrowLeft") next = i - 1;
        else if (e.key === "Home") next = 0;
        else if (e.key === "End") next = tabs.length - 1;
        if (next < 0) return;
        e.preventDefault();
        activateTab(tabs[(next + tabs.length) % tabs.length]);
      });
    });
  }

  /* ── loading keycap ────────────────────────────────────────────────────── */
  var loadBtn = document.getElementById("pv-load-btn");
  if (loadBtn) {
    var idleMarkup = loadBtn.innerHTML;
    var busy = false;
    loadBtn.addEventListener("click", function () {
      if (busy) return;
      busy = true;
      loadBtn.setAttribute("aria-busy", "true");
      loadBtn.innerHTML = '<span class="tx-spin" aria-hidden="true"></span>Working…';
      setTimeout(function () {
        loadBtn.innerHTML = '<span aria-hidden="true">✓</span> Done';
        loadBtn.removeAttribute("aria-busy");
        setTimeout(function () {
          loadBtn.innerHTML = idleMarkup;
          busy = false;
        }, 900);
      }, 2000);
    });
  }

  /* ── secret reveal ─────────────────────────────────────────────────────── */
  var reveal = document.getElementById("pv-reveal");
  var secret = document.getElementById("pv-secret");
  if (reveal && secret) {
    reveal.addEventListener("click", function () {
      var shown = secret.type === "text";
      secret.type = shown ? "password" : "text";
      reveal.setAttribute("aria-pressed", String(!shown));
      reveal.setAttribute("aria-label", shown ? "Show token" : "Hide token");
      var label = reveal.querySelector(".pv-reveal-tx");
      if (label) label.textContent = shown ? "Show" : "Hide";
    });
  }

  /* ── field validation: the message becomes a receipt ───────────────────── */
  var keyInput = document.getElementById("pv-key");
  var keyMsg = document.getElementById("pv-key-msg");
  if (keyInput && keyMsg) {
    keyMsg.setAttribute("aria-live", "polite");
    var lastValid = false;
    keyInput.addEventListener("input", function () {
      var valid = /^[A-Z]{2,6}$/.test(keyInput.value.trim());
      if (valid === lastValid) return;
      lastValid = valid;
      keyInput.setAttribute("aria-invalid", String(!valid));
      keyMsg.classList.toggle("is-ok", valid);
      keyMsg.innerHTML = valid
        ? '<span aria-hidden="true">✓</span>Valid key · ready to save.'
        : '<span aria-hidden="true">!</span>Keys are 2–6 uppercase letters, e.g. <code>ONB</code>.';
    });
  }
  var form = document.getElementById("pv-form");
  if (form) form.addEventListener("submit", function (e) { e.preventDefault(); });

  /* ── menu: a toggle and a destructive confirmation ─────────────────────── */
  var reason = document.getElementById("pv-menu-reason");
  if (reason) {
    var check = reason.querySelector(".pv-menu-check");
    reason.addEventListener("click", function () {
      var on = reason.getAttribute("aria-pressed") !== "true";
      reason.setAttribute("aria-pressed", String(on));
      if (check) check.hidden = !on;
    });
  }
  var stop = document.getElementById("pv-stop-session");
  if (stop) {
    stop.addEventListener("click", function () {
      toast("warn", "Stop requested", "Turn 04 stops after the current write.");
    });
  }

  /* ── tooltips: Escape dismisses, pointer or focus returns them ─────────── */
  Array.prototype.forEach.call(document.querySelectorAll(".tx-tip"), function (tip) {
    tip.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        tip.setAttribute("data-hidden", "true");
        var trigger = tip.querySelector("button");
        if (trigger) trigger.blur();
      }
    });
    tip.addEventListener("mouseleave", function () { tip.removeAttribute("data-hidden"); });
    tip.addEventListener("focusout", function () { tip.removeAttribute("data-hidden"); });
  });

  /* ── toasts: one host, 4.5 seconds, three at most ──────────────────────── */
  function toast(tone, title, message) {
    var host = document.getElementById("page-toast-host");
    if (!host) return;
    var el = document.createElement("div");
    el.className = "tx-toast";

    var tile = document.createElement("span");
    tile.className = "tx-tile " + (tone === "bad" ? "tx-tile-bad" : tone === "warn" ? "tx-tile-warn" : "tx-tile-ok");
    var glyph = document.createElement("span");
    glyph.setAttribute("aria-hidden", "true");
    glyph.textContent = tone === "bad" ? "×" : tone === "warn" ? "!" : "✓";
    tile.appendChild(glyph);

    var body = document.createElement("div");
    var heading = document.createElement("h5");
    heading.textContent = title;
    var copy = document.createElement("p");
    copy.textContent = message;
    body.appendChild(heading);
    body.appendChild(copy);

    var close = document.createElement("button");
    close.type = "button";
    close.className = "tx-toast-x";
    close.setAttribute("aria-label", "Dismiss notification");
    var x = document.createElement("span");
    x.setAttribute("aria-hidden", "true");
    x.textContent = "×";
    close.appendChild(x);

    el.appendChild(tile);
    el.appendChild(body);
    el.appendChild(close);
    host.appendChild(el);

    var dead = false;
    function dismiss() {
      if (dead) return;
      dead = true;
      el.classList.add("tx-toast-out");
      setTimeout(function () { el.remove(); }, 260);
    }
    close.addEventListener("click", dismiss);
    setTimeout(dismiss, 4500);
    timeLife();
    while (host.children.length > 3) host.removeChild(host.firstElementChild);
  }

  /* the lifetime rail times the newest toast */
  var life = document.getElementById("pv-life");
  var lifeState = document.getElementById("pv-life-state");
  var lifeTimer = null;
  function timeLife() {
    if (!life) return;
    life.classList.remove("is-running");
    void life.offsetWidth;
    life.classList.add("is-running");
    if (lifeState) lifeState.textContent = "timing the newest toast";
    clearTimeout(lifeTimer);
    lifeTimer = setTimeout(function () {
      if (lifeState) lifeState.textContent = "left at 4.5 s · read in 3.6";
    }, 4500);
  }

  var toastOk = document.getElementById("pv-toast-ok");
  var toastBad = document.getElementById("pv-toast-bad");
  if (toastOk) toastOk.addEventListener("click", function () {
    toast("ok", "Checklist saved", "onboarding/checklist.csv · 18 of 30 rows.");
  });
  if (toastBad) toastBad.addEventListener("click", function () {
    toast("bad", "Drive search failed", "Token expired · ref err_7f3a21.");
  });

  /* ── copy a reference ──────────────────────────────────────────────────── */
  function legacyCopy(text) {
    return new Promise(function (resolve, reject) {
      var area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.cssText = "position:fixed;top:0;left:0;opacity:0";
      document.body.appendChild(area);
      area.select();
      try {
        document.execCommand("copy");
        document.body.removeChild(area);
        resolve();
      } catch (e) {
        document.body.removeChild(area);
        reject(e);
      }
    });
  }
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).catch(function () { return legacyCopy(text); });
    }
    return legacyCopy(text);
  }
  var refChip = document.getElementById("pv-chip-ref");
  if (refChip) {
    refChip.addEventListener("click", function () {
      var text = refChip.getAttribute("data-ref") || "err_7f3a21";
      copyText(text).then(function () {
        refChip.classList.add("is-copied");
        toast("ok", "Copied", text + " is on your clipboard.");
        setTimeout(function () { refChip.classList.remove("is-copied"); }, 1400);
      }).catch(function () {});
    });
  }

  /* ── springs: replay the three step responses ──────────────────────────── */
  var springs = document.querySelector(".pv-springs");
  var springPlay = document.getElementById("pv-spring-play");
  var springSpeed = document.getElementById("pv-spring-speed");
  if (springs && springPlay) {
    springPlay.addEventListener("click", function () {
      springs.classList.remove("is-moving", "is-end");
      void springs.offsetWidth;
      springs.classList.add("is-moving", "is-end");
    });
  }
  if (springs && springSpeed) {
    springSpeed.addEventListener("pv-select", function (e) {
      springs.setAttribute("data-speed", e.detail.button.getAttribute("data-speed"));
    });
  }

  /* ── states: anatomy pins on or off ────────────────────────────────────── */
  var anno = document.getElementById("pv-anno");
  var stateGrid = document.getElementById("pv-states");
  if (anno && stateGrid) {
    anno.addEventListener("change", function () { stateGrid.classList.toggle("is-annotated", anno.checked); });
  }

  /* ── reduced motion preview ────────────────────────────────────────────── */
  var reduceSwitch = document.getElementById("pv-reduce");
  var motionState = document.getElementById("pv-motion-state");
  function syncMotion() {
    var on = root.dataset.effMotion === "reduce";
    if (reduceSwitch) reduceSwitch.checked = on;
    if (motionState) motionState.textContent = on ? "on" : "off";
  }
  if (reduceSwitch) {
    reduceSwitch.addEventListener("change", function () {
      root.dataset.effMotion = reduceSwitch.checked ? "reduce" : "full";
      syncMotion();
    });
  }
  if (window.MutationObserver) {
    new MutationObserver(syncMotion).observe(root, { attributes: true, attributeFilter: ["data-eff-motion"] });
  }
  syncMotion();
})();
