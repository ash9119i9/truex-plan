/* truex system · chapter 03 · space & form behaviour */
(function () {
  "use strict";

  var root = document.documentElement;
  var THEMES = ["auto", "light", "dark"];
  var CONTRASTS = ["system", "normal", "more"];
  var SIZES = ["100", "150", "200"];
  var darkMQ = matchMedia("(prefers-color-scheme: dark)");
  var contrastMQ = matchMedia("(prefers-contrast: more)");
  var motionMQ = matchMedia("(prefers-reduced-motion: reduce)");
  var theme = THEMES.indexOf(root.dataset.theme) > -1 ? root.dataset.theme : "auto";
  var contrast = CONTRASTS.indexOf(root.dataset.contrast) > -1 ? root.dataset.contrast : "system";
  var size = SIZES.indexOf(root.dataset.textsize) > -1 ? root.dataset.textsize : "100";
  var themeTool = document.getElementById("theme-tool");
  var themeLabel = document.getElementById("theme-label");
  var contrastTool = document.getElementById("contrast-tool");
  var contrastLabel = document.getElementById("contrast-label");
  var sizeTool = document.getElementById("size-tool");
  var sizeLabel = document.getElementById("size-label");

  function listen(mq, fn) {
    if (mq.addEventListener) mq.addEventListener("change", fn);
    else if (mq.addListener) mq.addListener(fn);
  }
  function titleCase(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function themeName(pref) { return pref === "auto" ? "Auto" : pref === "light" ? "Light" : "Dark"; }
  function contrastName(pref) { return pref === "system" ? "System" : pref === "normal" ? "Standard" : "More"; }
  function effectiveTheme() {
    return theme === "dark" || (theme === "auto" && darkMQ.matches) ? "dark" : "light";
  }
  function effectiveContrast() {
    return contrast === "more" || (contrast === "system" && contrastMQ.matches) ? "more" : "normal";
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
    if (persist) {
      try {
        localStorage.setItem("tx-sys-theme", theme);
        localStorage.setItem("tx-sys-contrast", contrast);
      } catch (e) {}
    }
  }

  themeTool.addEventListener("click", function () {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    applyEnv(true);
  });
  contrastTool.addEventListener("click", function () {
    contrast = CONTRASTS[(CONTRASTS.indexOf(contrast) + 1) % CONTRASTS.length];
    applyEnv(true);
  });
  listen(darkMQ, function () { if (theme === "auto") applyEnv(false); });
  listen(contrastMQ, function () { if (contrast === "system") applyEnv(false); });
  listen(motionMQ, function () { applyEnv(false); });

  function applySize(next, persist) {
    size = SIZES.indexOf(next) > -1 ? next : "100";
    if (size === "100") root.removeAttribute("data-textsize");
    else root.setAttribute("data-textsize", size);
    sizeLabel.textContent = size + "%";
    sizeTool.setAttribute("aria-label", "Text size: " + size + " percent. Activate to change.");
    if (persist) {
      try { localStorage.setItem("tx-sys-size", size); } catch (e) {}
    }
  }
  sizeTool.addEventListener("click", function () {
    applySize(SIZES[(SIZES.indexOf(size) + 1) % SIZES.length], true);
  });

  /* density specimen -------------------------------------------------------- */
  var densityDemo = document.getElementById("density-demo");
  var densityButtons = document.querySelectorAll("[data-density-set]");
  var DENSITY = {
    instrument: { pad: "12", row: "8", block: "16" },
    reading: { pad: "24", row: "12", block: "24" }
  };
  function applyDensity(name) {
    if (!densityDemo || !DENSITY[name]) return;
    densityDemo.dataset.density = name;
    Array.prototype.forEach.call(densityButtons, function (b) {
      b.setAttribute("aria-pressed", String(b.dataset.densitySet === name));
    });
    var values = DENSITY[name];
    ["pad", "row", "block"].forEach(function (key) {
      var el = document.querySelector('[data-bind="' + key + '"]');
      if (el) el.textContent = values[key];
    });
  }
  Array.prototype.forEach.call(densityButtons, function (b) {
    b.addEventListener("click", function () { applyDensity(b.dataset.densitySet); });
  });

  /* grid specimen ----------------------------------------------------------- */
  var gridDemo = document.getElementById("grid-demo");
  var gridButtons = document.querySelectorAll("[data-grid-set]");
  var GRIDS = {
    wide: { cols: "12", gap: "24", main: "8 col · main", rail: "4 col · rail" },
    medium: { cols: "8", gap: "16", main: "5 col · main", rail: "3 col · rail" },
    compact: { cols: "4", gap: "12", main: "4 col · main", rail: "4 col · rail" }
  };
  function applyGrid(name) {
    if (!gridDemo || !GRIDS[name]) return;
    gridDemo.dataset.gridState = name;
    Array.prototype.forEach.call(gridButtons, function (b) {
      b.setAttribute("aria-pressed", String(b.dataset.gridSet === name));
    });
    var values = GRIDS[name];
    ["cols", "gap"].forEach(function (key) {
      var el = document.querySelector('[data-bind="' + key + '"]');
      if (el) el.textContent = values[key];
    });
    var main = document.querySelector('[data-bind="main-label"]');
    var rail = document.querySelector('[data-bind="rail-label"]');
    if (main) main.textContent = values.main;
    if (rail) rail.textContent = values.rail;
  }
  Array.prototype.forEach.call(gridButtons, function (b) {
    b.addEventListener("click", function () { applyGrid(b.dataset.gridSet); });
  });

  /* corner character ------------------------------------------------------- */
  var cornerDemo = document.getElementById("corner-demo");
  var cornerButtons = document.querySelectorAll("[data-corner-set]");
  var cornerSupport = document.getElementById("corner-support");
  var supportsSquircle = !!(window.CSS && CSS.supports && CSS.supports("corner-shape", "squircle"));

  function applyCorner(name) {
    if (!cornerDemo) return;
    cornerDemo.dataset.corner = name;
    Array.prototype.forEach.call(cornerButtons, function (b) {
      b.setAttribute("aria-pressed", String(b.dataset.cornerSet === name));
    });
  }

  if (cornerSupport) {
    if (supportsSquircle) {
      cornerSupport.innerHTML = "<b>Native</b> squircle · Chromium 139+";
    } else {
      cornerSupport.classList.add("is-fallback");
      cornerSupport.innerHTML = "<b>Fallback</b> round · this browser ignores corner-shape";
      var squircleBtn = document.querySelector('[data-corner-set="squircle"]');
      if (squircleBtn) squircleBtn.disabled = true;
      var sqTile = document.querySelector(".cv-squircle");
      if (sqTile) sqTile.classList.add("is-fallback");
      var sqLabel = document.getElementById("cv-squircle-label");
      var sqTag = document.getElementById("cv-squircle-tag");
      var sqTitle = document.getElementById("cv-squircle-title");
      var sqCode = document.getElementById("cv-squircle-code");
      var sqCopy = document.getElementById("cv-squircle-copy");
      if (sqLabel) sqLabel.textContent = "Fallback";
      if (sqTag) sqTag.textContent = "Round";
      if (sqTitle) sqTitle.textContent = "Round fallback";
      if (sqCode) sqCode.textContent = "corner-shape: unsupported";
      if (sqCopy) sqCopy.textContent = "The ladder falls back to a circular radius. Layout and light are unchanged.";
    }
  }
  Array.prototype.forEach.call(cornerButtons, function (b) {
    b.addEventListener("click", function () { applyCorner(b.dataset.cornerSet); });
  });
  applyCorner(supportsSquircle ? "squircle" : "round");

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
      if (max > 0 && top + window.innerHeight >= document.documentElement.scrollHeight - 4 && sections.length) {
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
  applySize(size, false);
  applyDensity("instrument");
  applyGrid("wide");
  updateScroll();
})();
