/* truex system · chapter 02 · colour & themes behaviour */
(function () {
  "use strict";

  var root = document.documentElement;
  var THEMES = ["auto", "light", "dark"];
  var CONTRASTS = ["system", "normal", "more"];
  var darkMQ = matchMedia("(prefers-color-scheme: dark)");
  var contrastMQ = matchMedia("(prefers-contrast: more)");
  var motionMQ = matchMedia("(prefers-reduced-motion: reduce)");
  var theme = THEMES.indexOf(root.dataset.theme) > -1 ? root.dataset.theme : "auto";
  var contrast = CONTRASTS.indexOf(root.dataset.contrast) > -1 ? root.dataset.contrast : "system";
  var themeTool = document.getElementById("theme-tool");
  var themeLabel = document.getElementById("theme-label");
  var contrastTool = document.getElementById("contrast-tool");
  var contrastLabel = document.getElementById("contrast-label");

  function listen(mq, fn) {
    if (mq.addEventListener) mq.addEventListener("change", fn);
    else if (mq.addListener) mq.addListener(fn);
  }
  function titleCase(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function themeName(pref) { return pref === "auto" ? "Auto" : pref === "light" ? "Light" : "Dark"; }
  function contrastName(pref) { return pref === "system" ? "System" : pref === "normal" ? "Standard" : "More"; }
  function effectiveContrast() {
    return contrast === "more" || (contrast === "system" && contrastMQ.matches) ? "more" : "normal";
  }
  function effectiveTheme() {
    return theme === "dark" || (theme === "auto" && darkMQ.matches) ? "dark" : "light";
  }
  function setText(sel, value) {
    Array.prototype.forEach.call(document.querySelectorAll(sel), function (el) { el.textContent = value; });
  }

  function rgbFrom(value) {
    var v = (value || "").trim();
    var h = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (h) {
      var x = h[1];
      if (x.length === 3) x = x.split("").map(function (c) { return c + c; }).join("");
      return [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16)];
    }
    var m = v.match(/rgba?\(([^)]+)\)/i);
    if (m) {
      var p = m[1].split(/[,\s\/]+/).map(Number).filter(function (n) { return !isNaN(n); });
      if (p.length >= 3) return p.slice(0, 3);
    }
    return null;
  }
  function luminance(rgb) {
    var c = rgbFrom(rgb);
    if (!c) return null;
    c = c.map(function (v) {
      v = v / 255;
      return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function contrastRatio(a, b) {
    var la = luminance(a), lb = luminance(b);
    if (la == null || lb == null) return null;
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }
  function renderMeasure() {
    var cs = getComputedStyle(root);
    var surface = cs.getPropertyValue("--surface");
    var ctx = document.getElementById("ink-context");
    if (ctx) {
      var more = effectiveContrast() === "more";
      ctx.textContent = titleCase(effectiveTheme()) + (more ? " · increased" : " · standard");
    }
    ["ink", "ink-2", "ink-3", "signal-ink"].forEach(function (k) {
      var el = document.querySelector('[data-contrast="' + k + '"]');
      if (!el) return;
      var ratio = contrastRatio(cs.getPropertyValue("--" + k), surface);
      if (ratio == null) return;
      el.textContent = ratio.toFixed(2) + ":1";
      var pass = el.parentElement.querySelector(".pass");
      if (pass) pass.textContent = ratio >= 4.5 ? "✓ AA" : "✕ AA";
    });
  }

  function renderState() {
    var dark = effectiveTheme();
    var more = effectiveContrast() === "more";
    setText('[data-bind="theme-choice"]', themeName(theme));
    setText('[data-bind="theme-os"]', darkMQ.matches ? "Dark" : "Light");
    setText('[data-bind="theme-eff"]', titleCase(dark));
    setText('[data-bind="contrast-choice"]', contrastName(contrast));
    setText('[data-bind="contrast-os"]', contrastMQ.matches ? "More" : "Standard");
    setText('[data-bind="contrast-eff"]', more ? "More" : "Standard");
    setText('[data-bind="scheme"]', dark);
    setText('[data-bind="context"]', titleCase(dark) + " / " + (more ? "Increased" : "Standard"));
    var current = document.getElementById("current-ctx");
    if (current) current.textContent = titleCase(dark) + " / " + (more ? "Increased" : "Standard");
    Array.prototype.forEach.call(document.querySelectorAll(".ctx-card"), function (card) {
      card.classList.toggle("is-current", card.getAttribute("data-ctx") === dark + (more ? "+" : ""));
    });
  }

  function applyEnv(persist) {
    root.dataset.theme = theme;
    root.dataset.contrast = contrast;
    root.dataset.effTheme = effectiveTheme();
    root.dataset.effContrast = effectiveContrast();
    root.dataset.effMotion = motionMQ.matches ? "reduce" : "full";
    themeTool.dataset.pref = theme;
    themeLabel.textContent = themeName(theme);
    themeTool.setAttribute("aria-label", "Theme: " + theme + ". Activate to change.");
    contrastTool.dataset.mode = contrast;
    contrastLabel.textContent = contrastName(contrast);
    contrastTool.setAttribute("aria-label", "Contrast: " + contrast + ". Activate to change.");
    Array.prototype.forEach.call(document.querySelectorAll("[data-set-theme]"), function (b) {
      b.setAttribute("aria-pressed", String(b.dataset.setTheme === theme));
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-set-contrast]"), function (b) {
      b.setAttribute("aria-pressed", String(b.dataset.setContrast === contrast));
    });
    if (persist) {
      try {
        localStorage.setItem("tx-sys-theme", theme);
        localStorage.setItem("tx-sys-contrast", contrast);
      } catch (e) {}
    }
    renderState();
    renderMeasure();
  }

  themeTool.addEventListener("click", function () {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    applyEnv(true);
  });
  contrastTool.addEventListener("click", function () {
    contrast = CONTRASTS[(CONTRASTS.indexOf(contrast) + 1) % CONTRASTS.length];
    applyEnv(true);
  });
  Array.prototype.forEach.call(document.querySelectorAll("[data-set-theme]"), function (b) {
    b.addEventListener("click", function () {
      theme = b.dataset.setTheme;
      applyEnv(true);
    });
  });
  Array.prototype.forEach.call(document.querySelectorAll("[data-set-contrast]"), function (b) {
    b.addEventListener("click", function () {
      contrast = b.dataset.setContrast;
      applyEnv(true);
    });
  });
  listen(darkMQ, function () { if (theme === "auto") applyEnv(false); else renderState(); });
  listen(contrastMQ, function () { if (contrast === "system") applyEnv(false); else renderState(); });
  listen(motionMQ, function () { applyEnv(false); });

  /* greyscale proof --------------------------------------------------------- */
  var greyToggle = document.querySelector("[data-grey-toggle]");
  if (greyToggle) {
    greyToggle.addEventListener("click", function () {
      var proof = document.getElementById(greyToggle.getAttribute("data-grey-toggle"));
      if (!proof) return;
      var on = !proof.classList.contains("is-grey");
      proof.classList.toggle("is-grey", on);
      greyToggle.setAttribute("aria-pressed", String(on));
      greyToggle.textContent = on ? "Restore colour" : "Check in greyscale";
    });
  }

  /* copy -------------------------------------------------------------------- */
  function legacyCopy(text) {
    return new Promise(function (resolve, reject) {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        document.body.removeChild(ta);
        resolve();
      } catch (e) {
        document.body.removeChild(ta);
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
  Array.prototype.forEach.call(document.querySelectorAll("[data-copy]"), function (btn) {
    btn.addEventListener("click", function () {
      var target = document.querySelector(btn.getAttribute("data-copy"));
      if (!target) return;
      copyText(target.textContent).then(function () {
        var old = btn.textContent;
        btn.textContent = "Copied";
        setTimeout(function () { btn.textContent = old; }, 1300);
      }).catch(function () {});
    });
  });

  /* scroll ------------------------------------------------------------------ */
  var progress = document.getElementById("progress");
  var topbar = document.querySelector(".topbar");
  var ruler = document.querySelector(".ruler");
  var links = Array.prototype.slice.call(document.querySelectorAll(".ruler a"));
  var sections = links.map(function (a) { return document.getElementById(a.getAttribute("href").slice(1)); });
  var queued = false;

  function updateScroll() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () {
      queued = false;
      var top = window.scrollY || window.pageYOffset;
      var max = document.documentElement.scrollHeight - window.innerHeight;
      if (progress) progress.style.width = (max > 0 ? Math.min(100, (top / max) * 100) : 0) + "%";
      var offset = (topbar ? topbar.offsetHeight : 0) + (ruler ? ruler.offsetHeight : 0) + 28;
      var current = sections[0];
      sections.forEach(function (s) {
        if (s && s.getBoundingClientRect().top <= offset) current = s;
      });
      if (top + window.innerHeight >= document.documentElement.scrollHeight - 4 && sections.length) {
        current = sections[sections.length - 1];
      }
      links.forEach(function (a) {
        var on = current && a.getAttribute("href") === "#" + current.id;
        a.classList.toggle("active", on);
        if (on) a.setAttribute("aria-current", "true");
        else a.removeAttribute("aria-current");
      });
    });
  }
  window.addEventListener("scroll", updateScroll, { passive: true });
  window.addEventListener("resize", updateScroll);

  applyEnv(false);
  updateScroll();
})();
