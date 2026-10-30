/* truex system · chapter 06 · patterns behaviour
   Composition is CSS. This file only moves state: the docked request, the
   inspector drawer, the command palette, the live turn and the fold readout.
   One request clock is paused while the room is offscreen. */
(function () {
  "use strict";

  var root = document.documentElement;
  function q(sel, scope) { return (scope || document).querySelector(sel); }
  function qa(sel, scope) { return Array.prototype.slice.call((scope || document).querySelectorAll(sel)); }
  function rootRem() { return parseFloat(getComputedStyle(root).fontSize) || 16; }
  function raf(fn) { return window.requestAnimationFrame ? requestAnimationFrame(fn) : setTimeout(fn, 16); }

  /* ── toasts ───────────────────────────────────────────────────────────── */
  function toast(tone, title, message) {
    var host = q("#page-toast-host");
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
    while (host.children.length > 3) host.removeChild(host.firstElementChild);
  }

  function toastFor(text) {
    return /declin|reject|skip|fail|lost|expire/i.test(text) ? "warn" : "ok";
  }

  /* ── focus trap ───────────────────────────────────────────────────────── */
  function focusables(container) {
    return qa('a[href], button:not([disabled]):not([tabindex="-1"]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])', container)
      .filter(function (el) { return el.offsetParent !== null || el === document.activeElement; });
  }
  function trapFocus(container, e) {
    var items = focusables(container);
    if (!items.length) return;
    var first = items[0], last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || !container.contains(document.activeElement))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (document.activeElement === last || !container.contains(document.activeElement))) {
      e.preventDefault();
      first.focus();
    }
  }

  /* ── the hero request ─────────────────────────────────────────────────── */
  function initHeroRequest() {
    var request = q("#hero-request");
    if (!request) return;
    var shell = q("#hero-shell");
    var status = q("#hero-status");
    var statusText = q("#hero-status-text");
    var statusPulse = q("#hero-pulse");
    var clock = q("#hero-time");
    var clockNum = q("#hero-time-num");
    var composer = q("#hero-composer");
    var composerInput = q("#hero-composer-input");
    var send = q("#hero-send");
    var allowOnce = q("#hero-allow-once");
    var allowSession = q("#hero-allow-session");
    var decline = q("#hero-decline");
    var workSq = q("#hero-work-sq");
    var workTitle = q("#hero-work-title");
    var workSub = q("#hero-work-sub");
    var approvalNode = q("#hero-approval-node");
    var approvalTitle = q("#hero-approval-title");
    var approvalSub = q("#hero-approval-sub");
    var approvalTime = q("#hero-approval-time");

    var remaining = 42, timer = null, resolved = false, inView = true;

    function format(seconds) {
      var m = Math.floor(seconds / 60), s = seconds % 60;
      return m + ":" + (s < 10 ? "0" : "") + s;
    }
    function paint() {
      if (!clock) return;
      if (clockNum) clockNum.textContent = format(remaining);
      clock.setAttribute("aria-label", "Approval expires in " + remaining + " seconds");
    }
    function setStatus(kind) {
      if (!status) return;
      status.className = "tx-pill pt-status " + (kind === "wait" ? "tx-pill-warn" : kind === "work" ? "tx-pill-live" : "tx-pill-line");
      if (statusText) statusText.textContent = kind === "wait" ? "Waiting on you" : kind === "work" ? "Working" : "Idle";
      if (statusPulse) {
        statusPulse.hidden = kind === "idle";
        statusPulse.style.setProperty("--tx-c", kind === "wait" ? "var(--warn)" : "var(--signal)");
      }
    }
    function setWork(kind) {
      if (!workSq) return;
      workSq.className = "pt-work-sq " + (kind === "running" ? "is-run" : kind === "done" ? "is-ok" : "is-warn");
      if (kind === "running") {
        workSq.innerHTML = '<span class="tx-spin" aria-hidden="true"></span>';
        workTitle.textContent = "Working · 8 steps";
        workSub.textContent = "Posting the two accruals";
        approvalNode.className = "pt-step-node is-ok";
        approvalNode.textContent = "✓";
        approvalTitle.textContent = "Approval resolved";
        approvalSub.textContent = "Allowed once · by you";
        approvalTime.textContent = "now";
      } else if (kind === "declined") {
        workSq.textContent = "!";
        workTitle.textContent = "Paused · approval declined";
        workSub.textContent = "The ledger was not posted";
        approvalNode.className = "pt-step-node is-bad";
        approvalNode.textContent = "×";
        approvalTitle.textContent = "Approval declined";
        approvalSub.textContent = "by you";
        approvalTime.textContent = "now";
      } else {
        workSq.textContent = "!";
        workTitle.textContent = "Worked · 7 steps";
        workSub.textContent = "Paused before the ledger write";
        approvalNode.className = "pt-step-node is-warn";
        approvalNode.textContent = "!";
        approvalTitle.textContent = "Waiting for approval to post";
        approvalSub.textContent = "Two accruals · $182,400";
        approvalTime.textContent = "now";
      }
    }
    function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }
    function startTimer() {
      stopTimer();
      remaining = 42;
      paint();
      timer = setInterval(function () {
        if (resolved || !inView) return;
        remaining -= 1;
        if (remaining <= 0) {
          remaining = 0;
          paint();
          resolve("expired");
        } else {
          paint();
        }
      }, 1000);
    }
    function resolve(kind) {
      if (resolved) return;
      resolved = true;
      stopTimer();
      request.hidden = true;
      composer.classList.remove("is-held");
      composerInput.disabled = false;
      composerInput.value = "";
      composerInput.placeholder = "Steer Qlik Analyst or queue a follow-up";
      if (kind === "once" || kind === "session") {
        setStatus("work");
        setWork("running");
        toast("ok", "Request allowed", kind === "session" ? "The ledger post is allowed for this session." : "The ledger will post once, then return to the turn.");
      } else if (kind === "declined") {
        setStatus("idle");
        setWork("declined");
        toast("warn", "Request declined", "The ledger was not written. The turn is idle.");
      } else {
        setStatus("idle");
        setWork("declined");
        toast("warn", "Request expired", "No answer arrived; the ledger was not written.");
      }
      composerInput.focus();
    }
    function reset(focus) {
      resolved = false;
      stopTimer();
      request.hidden = false;
      setStatus("wait");
      setWork("pending");
      composer.classList.add("is-held");
      composerInput.disabled = true;
      composerInput.value = "";
      composerInput.placeholder = "Answer the request above to keep going";
      startTimer();
      if (focus) allowOnce.focus();
    }

    allowOnce.addEventListener("click", function () { resolve("once"); });
    allowSession.addEventListener("click", function () { resolve("session"); });
    decline.addEventListener("click", function () { resolve("declined"); });
    qa("#hero-replay-2").forEach(function (button) {
      button.addEventListener("click", function () { reset(true); });
    });
    qa("#hero-composer [data-fill]").forEach(function (chip) {
      chip.addEventListener("click", function () {
        if (composer.classList.contains("is-held")) {
          toast("warn", "Request waiting", "Answer the request above before queueing a follow-up.");
          return;
        }
        composerInput.value = chip.getAttribute("data-fill") || "";
        composerInput.focus();
      });
    });
    send.addEventListener("click", function () {
      if (composerInput.disabled) return;
      var value = composerInput.value.trim();
      if (!value) { composerInput.focus(); return; }
      toast("ok", "Follow-up queued", value.length > 88 ? value.slice(0, 85) + "…" : value);
      composerInput.value = "";
      composerInput.focus();
    });
    composerInput.addEventListener("input", function () {
      composerInput.style.height = "auto";
      composerInput.style.height = Math.min(composerInput.scrollHeight, 120) + "px";
    });

    document.addEventListener("keydown", function (e) {
      if (resolved || e.metaKey || e.ctrlKey || e.altKey) return;
      var t = e.target;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      var paletteOpen = q("#hero-palette") && !q("#hero-palette").hidden;
      var inspectorOpen = shell && shell.classList.contains("is-inspecting");
      if (paletteOpen || inspectorOpen) return;
      if (e.key === "1") { e.preventDefault(); allowOnce.click(); }
      else if (e.key === "2") { e.preventDefault(); allowSession.click(); }
      else if (e.key === "Escape") { e.preventDefault(); decline.click(); }
    });

    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (entries) {
        inView = entries[0].isIntersecting;
      }, { threshold: 0.15 }).observe(request);
    }
    reset(false);
  }

  /* ── inspector drawer ─────────────────────────────────────────────────── */
  var inspectorTrigger = null;
  var inspectorIsOpen = false;
  function inspectorOpenState() { return inspectorIsOpen; }

  function openInspector(cardId, trigger) {
    var shell = q("#hero-shell"), inspector = q("#hero-inspector");
    if (!shell || !inspector) return;
    if (q("#hero-palette") && !q("#hero-palette").hidden) closeHeroPalette(false);
    inspectorIsOpen = true;
    inspectorTrigger = trigger || document.activeElement;
    shell.classList.add("is-inspecting");
    inspector.setAttribute("aria-hidden", "false");
    if (cardId) {
      var card = document.getElementById(cardId);
      var scroller = q(".pt-inspector-scroll", inspector);
      if (card && scroller) {
        raf(function () {
          var top = card.offsetTop - scroller.offsetTop;
          scroller.scrollTop = Math.max(0, top - 12);
        });
      }
    }
    var close = q("#hero-inspector-close");
    if (close) close.focus();
  }

  function closeInspector(returnFocus) {
    var shell = q("#hero-shell"), inspector = q("#hero-inspector");
    if (!shell || !inspector) return;
    inspectorIsOpen = false;
    shell.classList.remove("is-inspecting");
    inspector.setAttribute("aria-hidden", "true");
    if (returnFocus !== false && inspectorTrigger && document.contains(inspectorTrigger)) inspectorTrigger.focus();
  }

  function initInspector() {
    var shell = q("#hero-shell"), inspector = q("#hero-inspector");
    if (!shell || !inspector) return;
    var close = q("#hero-inspector-close");
    var scrim = q("#hero-inspector-scrim");
    var closeLink = q('#hero-inspector a[href="#worklog"]');

    qa("[data-inspector]").forEach(function (button) {
      button.addEventListener("click", function () {
        openInspector(button.getAttribute("data-inspector"), button);
      });
    });
    qa("#hero-inspector-open, #hero-inspector-open-2").forEach(function (button) {
      button.addEventListener("click", function () { openInspector("insp-receipt", button); });
    });
    var receipt = q("#hero-receipt-link");
    if (receipt) receipt.addEventListener("click", function () { openInspector("insp-receipt", receipt); });
    if (close) close.addEventListener("click", function () { closeInspector(true); });
    if (scrim) scrim.addEventListener("click", function () { closeInspector(true); });
    if (closeLink) closeLink.addEventListener("click", function () { closeInspector(false); });
    inspector.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { e.preventDefault(); closeInspector(true); }
      else if (e.key === "Tab") trapFocus(inspector, e);
    });
    // clicking the rail button a second time returns to the trigger
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && inspectorIsOpen && (!q("#hero-palette") || q("#hero-palette").hidden)) {
        // the drawer's own handler covers focus inside; this covers the shell
        if (!inspector.contains(document.activeElement)) closeInspector(true);
      }
    });
  }

  /* ── palette (overlay and inline share this) ──────────────────────────── */
  function wirePalette(palette, opts) {
    if (!palette) return null;
    var input = q(".pt-palette-input", palette);
    var list = q(".pt-palette-list", palette);
    var groups = qa(".pt-palette-group-wrap", palette);
    var options = qa('[role="option"]', palette);
    var empty = q(".pt-palette-empty", palette);
    var active = options.filter(function (o) { return o.getAttribute("aria-selected") === "true"; })[0] || options[0] || null;

    function visible() { return options.filter(function (o) { return !o.hidden; }); }
    function setActive(option, scroll) {
      if (!option) return;
      active = option;
      options.forEach(function (o) { o.setAttribute("aria-selected", String(o === option)); });
      if (input) input.setAttribute("aria-activedescendant", option.id);
      if (scroll && option.scrollIntoView) option.scrollIntoView({ block: "nearest" });
    }
    function filter() {
      var query = input.value.trim().toLowerCase();
      options.forEach(function (o) {
        var haystack = ((o.textContent || "") + " " + (o.getAttribute("data-keywords") || "")).toLowerCase();
        o.hidden = query !== "" && haystack.indexOf(query) === -1;
      });
      groups.forEach(function (group) {
        group.hidden = !group.querySelector('[role="option"]:not([hidden])');
      });
      var shown = visible();
      if (empty) empty.hidden = shown.length !== 0;
      if (!shown.length) {
        active = null;
        options.forEach(function (o) { o.setAttribute("aria-selected", "false"); });
        if (input) input.removeAttribute("aria-activedescendant");
      } else if (shown.indexOf(active) === -1) {
        setActive(shown[0], false);
      } else {
        setActive(active, false);
      }
    }
    function run(option) {
      if (!option || option.hidden) return;
      var action = option.getAttribute("data-action");
      if (opts.onAction) opts.onAction(action, option);
    }

    input.addEventListener("input", filter);
    input.addEventListener("keydown", function (e) {
      var shown;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        shown = visible();
        if (!shown.length) return;
        var i = shown.indexOf(active);
        i = e.key === "ArrowDown" ? (i + 1) % shown.length : (i - 1 + shown.length) % shown.length;
        setActive(shown[i], true);
      } else if (e.key === "Enter") {
        e.preventDefault();
        run(active);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (opts.onEscape) opts.onEscape();
        else { input.value = ""; filter(); }
      }
    });
    options.forEach(function (option) {
      option.addEventListener("mousedown", function (e) { e.preventDefault(); });
      option.addEventListener("mouseenter", function () { setActive(option, false); });
      option.addEventListener("click", function () { run(option); });
    });

    filter();
    return {
      filter: filter,
      focus: function () { input.focus(); },
      reset: function () { input.value = ""; filter(); setActive(visible()[0], false); },
      input: input,
      getActive: function () { return active; }
    };
  }

  var heroPaletteTrigger = null;
  var heroPaletteApi = null;
  var heroPalette = q("#hero-palette");

  function closeHeroPalette(returnFocus) {
    if (!heroPalette || heroPalette.hidden) return;
    heroPalette.hidden = true;
    if (returnFocus !== false && heroPaletteTrigger && document.contains(heroPaletteTrigger)) heroPaletteTrigger.focus();
  }

  function heroPaletteAction(action) {
    closeHeroPalette(false);
    if (action === "receipt") {
      openInspector("insp-receipt", heroPaletteTrigger);
      return;
    }
    if (action === "reasoning") {
      var work = q("#hero-work");
      if (work) {
        work.open = true;
        work.scrollIntoView({ block: "nearest", behavior: "auto" });
      }
      toast("ok", "Work log open", "The fold sits under the answer.");
      if (heroPaletteTrigger) heroPaletteTrigger.focus();
      return;
    }
    if (action === "session") toast("ok", "Session opened", "September close is already the current session.");
    else if (action === "new") toast("ok", "New session", "A clean thread is ready.");
    else if (action === "agent") toast("ok", "Agent selected", "Qlik Analyst stays on this turn.");
    if (heroPaletteTrigger) heroPaletteTrigger.focus();
  }

  function openHeroPalette(trigger) {
    if (!heroPalette) return;
    if (inspectorIsOpen) closeInspector(false);
    heroPaletteTrigger = trigger || document.activeElement;
    heroPalette.hidden = false;
    if (heroPaletteApi) { heroPaletteApi.reset(); heroPaletteApi.focus(); }
  }

  function initHeroPalette() {
    if (!heroPalette) return;
    heroPaletteApi = wirePalette(q(".pt-palette", heroPalette), {
      onAction: function (action) { heroPaletteAction(action); },
      onEscape: function () { closeHeroPalette(true); },
      overlay: true
    });
    qa("#hero-palette-open, #hero-palette-open-2").forEach(function (button) {
      button.addEventListener("click", function () { openHeroPalette(button); });
    });
    var close = q("#hero-palette-close");
    if (close) close.addEventListener("click", function () { closeHeroPalette(true); });
    heroPalette.addEventListener("click", function (e) { if (e.target === heroPalette) closeHeroPalette(true); });
    heroPalette.addEventListener("keydown", function (e) { if (e.key === "Tab") trapFocus(heroPalette, e); });
    document.addEventListener("keydown", function (e) {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        if (heroPalette.hidden) openHeroPalette(q("#hero-palette-open-2") || document.activeElement);
        else closeHeroPalette(true);
      }
    });
  }

  function initInlinePalette() {
    var palette = q("#inline-palette");
    if (!palette) return;
    wirePalette(palette, {
      onAction: function (action) {
        var labels = { session: "Session", receipt: "Receipt", reasoning: "Work log", new: "New session", agent: "Agent" };
        toast("ok", (labels[action] || "Command") + " selected", "The live version is in the room at the top of the chapter.");
      }
    });
  }

  /* ── live turn specimen ───────────────────────────────────────────────── */
  function initTurn() {
    var demo = q("#turn-demo");
    var seg = q("[data-turn-state]");
    if (!demo || !seg) return;
    var status = q("#turn-status");
    var elapsed = q("#turn-elapsed");
    var workSq = q("#turn-work-sq");
    var workTitle = q("#turn-work-title");
    var workSub = q("#turn-work-sub");
    var buttons = qa("button", seg);

    function apply(mode) {
      var done = mode === "done";
      demo.classList.toggle("is-done", done);
      demo.classList.toggle("is-live", !done);
      buttons.forEach(function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-state") === mode)); });
      if (status) {
        status.className = "tx-pill " + (done ? "tx-pill-ok" : "tx-pill-live");
        status.innerHTML = done ? '<span aria-hidden="true">✓</span> Complete' : '<span class="tx-pulse" aria-hidden="true"></span>Working';
      }
      if (workSq) {
        workSq.className = "pt-work-sq " + (done ? "is-ok" : "is-run");
        workSq.innerHTML = done ? "✓" : '<span class="tx-spin" aria-hidden="true"></span>';
      }
      if (workTitle) workTitle.textContent = done ? "Worked · 7 steps" : "Working · 6 done, 1 running";
      if (workSub) workSub.textContent = done ? "Finished in 1m 22s" : "Vera checking the FX close · 3 helpers";
      if (elapsed) elapsed.textContent = done ? "1:22" : "0:42";
    }
    buttons.forEach(function (button, i) {
      button.addEventListener("click", function () { apply(button.getAttribute("data-state")); });
      button.addEventListener("keydown", function (e) {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        e.preventDefault();
        var next = e.key === "ArrowRight" ? (i + 1) % buttons.length : (i - 1 + buttons.length) % buttons.length;
        buttons[next].focus();
        apply(buttons[next].getAttribute("data-state"));
      });
    });
    apply("live");
  }

  /* ── secret + question choices ────────────────────────────────────────── */
  function initRequestMethods() {
    var reveal = q("#req-reveal"), secret = q("#req-secret"), label = q("#req-reveal-label");
    if (reveal && secret) {
      reveal.addEventListener("click", function () {
        var shown = secret.type === "text";
        secret.type = shown ? "password" : "text";
        reveal.setAttribute("aria-pressed", String(!shown));
        reveal.setAttribute("aria-label", shown ? "Show signing key" : "Hide signing key");
        if (label) label.textContent = shown ? "Show" : "Hide";
      });
    }
    qa(".pg-choice .tx-chip").forEach(function (chip) {
      chip.addEventListener("click", function () {
        qa(".pg-choice .tx-chip").forEach(function (other) {
          other.setAttribute("aria-pressed", String(other === chip));
        });
      });
    });
  }

  /* ── fold bench + hero measurements ───────────────────────────────────── */
  function stateFor(width) {
    var rem = rootRem();
    if (width > 68 * rem) return "full";
    if (width > 52 * rem) return "docked";
    if (width > 40 * rem) return "compact";
    return "focus";
  }
  function stateLabel(state) {
    return { full: "Full", docked: "Docked", compact: "Compact", focus: "Focus" }[state] || "Full";
  }
  function rectWidth(el) { return el ? Math.round(el.getBoundingClientRect().width) : 0; }

  function initMeasurements() {
    var heroShell = q("#hero-shell");
    var heroRail = q(".pt-rail", heroShell);
    var heroIrail = q(".pt-irail", heroShell);
    var heroThread = q(".pt-thread-in", heroShell);
    var heroShellW = q("#hero-shell-w");
    var heroRailW = q("#hero-rail-w");
    var heroThreadW = q("#hero-thread-w");
    var heroIrailW = q("#hero-irail-w");
    var heroFold = q("#hero-fold-state");
    var foldWrap = q("#fold-shell-wrap");
    var foldShell = q("#fold-shell");
    var foldRange = q("#fold-range");
    var foldStage = q(".pg-fold-stage");
    var foldStateEl = q("#fold-state");
    var foldRailW = q("#fold-rail-w");
    var foldThreadW = q("#fold-thread-w");
    var foldIrailW = q("#fold-irail-w");
    var foldShellW = q("#fold-shell-w");
    var foldLabel = q("#fold-w-label");
    var foldMapItems = qa(".pg-fold-map-item");

    function measureHero() {
      if (!heroShell) return;
      var w = rectWidth(heroShell);
      var state = stateFor(w);
      if (heroShellW) heroShellW.textContent = String(w);
      if (heroRailW) heroRailW.textContent = String(rectWidth(heroRail));
      if (heroThreadW) heroThreadW.textContent = String(rectWidth(heroThread));
      if (heroIrailW) heroIrailW.textContent = String(rectWidth(heroIrail));
      if (heroFold) heroFold.textContent = stateLabel(state);
    }
    function measureFold() {
      if (!foldShell) return;
      var w = rectWidth(foldShell);
      var state = stateFor(w);
      if (foldShellW) foldShellW.textContent = String(w);
      if (foldRailW) foldRailW.textContent = String(rectWidth(q(".pt-rail", foldShell)));
      if (foldThreadW) foldThreadW.textContent = String(rectWidth(q(".pt-thread-in", foldShell)));
      if (foldIrailW) foldIrailW.textContent = String(rectWidth(q(".pt-irail", foldShell)));
      if (foldStateEl) foldStateEl.textContent = stateLabel(state);
      foldMapItems.forEach(function (item) { item.classList.toggle("is-on", item.getAttribute("data-fold") === state); });
    }
    function applyFold() {
      if (!foldWrap || !foldRange) return;
      foldWrap.style.setProperty("--pg-fold-w", foldRange.value + "px");
      if (foldLabel) foldLabel.textContent = foldRange.value;
      raf(measureFold);
    }
    function sizeFold() {
      if (!foldRange || !foldStage || !foldWrap) return;
      var cs = getComputedStyle(foldStage);
      var available = foldStage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      var max = Math.min(1184, Math.floor(available));
      if (max < 360) max = 360;
      foldRange.max = String(max);
      if (+foldRange.value > max) foldRange.value = String(max);
      var labels = qa(".pg-range-scale i");
      var values = [360, 640, 832, 1088, 1184];
      labels.forEach(function (el, i) {
        var v = values[i];
        if (v > max) { el.hidden = true; return; }
        el.hidden = false;
        el.style.left = ((v - 360) / (max - 360) * 100).toFixed(2) + "%";
      });
      applyFold();
    }

    var pending = false;
    function scheduleHero() {
      if (pending) return;
      pending = true;
      raf(function () { pending = false; measureHero(); });
    }
    if (heroShell && window.ResizeObserver) new ResizeObserver(scheduleHero).observe(heroShell);
    if (foldShell && window.ResizeObserver) new ResizeObserver(function () { raf(measureFold); }).observe(foldShell);
    if (foldRange) foldRange.addEventListener("input", applyFold);
    window.addEventListener("resize", function () { sizeFold(); measureHero(); });
    if (window.MutationObserver) {
      new MutationObserver(function () { raf(function () { measureHero(); sizeFold(); }); })
        .observe(root, { attributes: true, attributeFilter: ["data-textsize", "data-eff-theme"] });
    }
    sizeFold();
    measureHero();
    measureFold();
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () { sizeFold(); measureHero(); measureFold(); });
    }
  }

  /* ── generic toast buttons ─────────────────────────────────────────────── */
  function initToastButtons() {
    qa("[data-toast]").forEach(function (button) {
      button.addEventListener("click", function () {
        var raw = button.getAttribute("data-toast") || "";
        var parts = raw.split("|");
        toast(toastFor(parts[0] || ""), parts[0] || "Done", parts[1] || "");
      });
    });
  }

  /* ── init ──────────────────────────────────────────────────────────────── */
  function init() {
    initHeroRequest();
    initInspector();
    initHeroPalette();
    initInlinePalette();
    initTurn();
    initRequestMethods();
    initMeasurements();
    initToastButtons();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
