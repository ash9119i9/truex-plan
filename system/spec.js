/* truex system · chapter 01 · spec behaviour */
(function () {
  "use strict";

  var root = document.documentElement;
  var THEMES = ["auto", "light", "dark"];
  var SIZES = ["100", "150", "200"];
  var darkMQ = matchMedia("(prefers-color-scheme: dark)");
  var contrastMQ = matchMedia("(prefers-contrast: more)");
  var motionMQ = matchMedia("(prefers-reduced-motion: reduce)");
  var theme = THEMES.indexOf(root.dataset.theme) > -1 ? root.dataset.theme : "auto";
  var size = SIZES.indexOf(root.dataset.textsize) > -1 ? root.dataset.textsize : "100";
  var contrastPref = ["system", "normal", "more"].indexOf(root.dataset.contrast) > -1 ? root.dataset.contrast : "system";
  var themeTool = document.getElementById("theme-tool");
  var themeLabel = document.getElementById("theme-label");
  var sizeTool = document.getElementById("size-tool");
  var sizeLabel = document.getElementById("size-label");

  function reduced() { return motionMQ.matches; }
  function listen(mq, fn) {
    if (mq.addEventListener) mq.addEventListener("change", fn);
    else if (mq.addListener) mq.addListener(fn);
  }

  function syncEnv() {
    root.dataset.effTheme = theme === "dark" || (theme === "auto" && darkMQ.matches) ? "dark" : "light";
    root.dataset.effContrast = contrastPref === "more" || (contrastPref === "system" && contrastMQ.matches) ? "more" : "normal";
    root.dataset.effMotion = motionMQ.matches ? "reduce" : "full";
  }

  function applyTheme(persist) {
    root.dataset.theme = theme;
    syncEnv();
    themeTool.dataset.pref = theme;
    themeLabel.textContent = theme.charAt(0).toUpperCase() + theme.slice(1);
    themeTool.setAttribute("aria-label", "Theme: " + theme + ". Activate to change.");
    if (persist !== false) {
      try { localStorage.setItem("tx-sys-theme", theme); } catch (e) {}
    }
  }

  themeTool.addEventListener("click", function () {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    applyTheme();
  });
  listen(darkMQ, function () { if (theme === "auto") applyTheme(false); });
  listen(contrastMQ, syncEnv);
  listen(motionMQ, syncEnv);

  function applySize(next, persist) {
    size = SIZES.indexOf(next) > -1 ? next : "100";
    if (size === "100") root.removeAttribute("data-textsize");
    else root.setAttribute("data-textsize", size);
    sizeLabel.textContent = size + "%";
    sizeTool.setAttribute("aria-label", "Text size: " + size + " percent. Activate to change.");
    Array.prototype.forEach.call(document.querySelectorAll("[data-setsize]"), function (b) {
      b.setAttribute("aria-pressed", String(b.dataset.setsize === size));
    });
    if (persist !== false) {
      try { localStorage.setItem("tx-sys-size", size); } catch (e) {}
    }
    requestAnimationFrame(updateChars);
  }

  sizeTool.addEventListener("click", function () {
    applySize(SIZES[(SIZES.indexOf(size) + 1) % SIZES.length]);
  });
  Array.prototype.forEach.call(document.querySelectorAll("[data-setsize]"), function (b) {
    b.addEventListener("click", function () { applySize(b.dataset.setsize); });
  });

  /* Bricolage cut playground ------------------------------------------------ */
  var axOpsz = document.getElementById("ax-opsz");
  var axWdth = document.getElementById("ax-wdth");
  var axWght = document.getElementById("ax-wght");
  var outOpsz = document.getElementById("out-opsz");
  var outWdth = document.getElementById("out-wdth");
  var outWght = document.getElementById("out-wght");
  var cutReadout = document.getElementById("cut-readout");
  var bricolageNodes = document.querySelectorAll("[data-bricolage]");
  var CUTS = {
    text: [14, 100, 400],
    heading: [48, 90, 700],
    display: [96, 82, 780],
    brand: [48, 85, 800]
  };
  var cutButtons = document.querySelectorAll("[data-cut]");

  function renderCut() {
    var o = axOpsz.value, w = axWdth.value, g = axWght.value;
    Array.prototype.forEach.call(bricolageNodes, function (el) {
      el.style.fontWeight = g;
      el.style.fontVariationSettings = '"opsz" ' + o + ', "wdth" ' + w;
      el.style.fontOpticalSizing = "none";
    });
    outOpsz.textContent = o;
    outWdth.textContent = w;
    outWght.textContent = g;
    cutReadout.textContent = "opsz " + o + " · wdth " + w + " · wght " + g;
    Array.prototype.forEach.call(cutButtons, function (b) {
      var p = CUTS[b.dataset.cut];
      b.setAttribute("aria-pressed", String(p && p[0] === +o && p[1] === +w && p[2] === +g));
    });
  }
  [axOpsz, axWdth, axWght].forEach(function (input) {
    input.addEventListener("input", renderCut);
  });
  Array.prototype.forEach.call(cutButtons, function (b) {
    b.addEventListener("click", function () {
      var p = CUTS[b.dataset.cut];
      if (!p) return;
      axOpsz.value = p[0];
      axWdth.value = p[1];
      axWght.value = p[2];
      renderCut();
    });
  });

  /* Geist weights ----------------------------------------------------------- */
  var geistButtons = document.querySelectorAll("[data-geist-weight]");
  function applyGeist(weight) {
    Array.prototype.forEach.call(document.querySelectorAll("[data-geist]"), function (el) {
      el.style.fontWeight = weight;
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-geist-sample]"), function (el) {
      el.style.fontWeight = weight;
    });
    Array.prototype.forEach.call(geistButtons, function (b) {
      b.setAttribute("aria-pressed", String(b.dataset.geistWeight === weight));
    });
  }
  Array.prototype.forEach.call(geistButtons, function (b) {
    b.addEventListener("click", function () { applyGeist(b.dataset.geistWeight); });
  });

  /* figures ----------------------------------------------------------------- */
  var fmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
  var numBig = document.getElementById("num-big");
  var numDelta = document.getElementById("num-delta");
  var numLive = document.getElementById("num-live");
  var numCells = document.querySelectorAll("[data-num]");
  var ROWS = [
    { id: "cloud", aug: 162300, spread: 18 },
    { id: "payroll", aug: 1262100, spread: 3 },
    { id: "services", aug: 70700, spread: 12 },
    { id: "fx", aug: -14900, spread: 22 }
  ];

  function pulse(el) {
    if (reduced() || !el || !el.animate) return;
    el.animate(
      [{ opacity: 0.35 }, { opacity: 1 }],
      { duration: 240, easing: "ease-out" }
    );
  }
  function signedMoney(n) {
    var sign = n < 0 ? "−" : "";
    return sign + fmt.format(Math.abs(n));
  }
  function deltaMarkup(pct) {
    var up = pct >= 0;
    return '<span class="' + (up ? "up" : "down") + '">' + (up ? "↑" : "↓") + " " + Math.abs(pct).toFixed(1) + "%</span>";
  }
  function random(min, max) { return min + Math.random() * (max - min); }

  function shuffleFigures() {
    if (!numBig) return;
    var revenue = random(4.02, 4.64);
    numBig.textContent = "$" + revenue.toFixed(2) + "M";
    var revDelta = random(1.2, 4.2);
    numDelta.textContent = "+" + revDelta.toFixed(1) + "%";
    pulse(numBig);

    numCells.forEach(function (cell) {
      var key = cell.dataset.num;
      if (key === "cash") cell.textContent = "$" + random(1.62, 2.18).toFixed(2) + "M";
      if (key === "dso") cell.textContent = random(34, 42).toFixed(1) + "d";
      if (key === "close") {
        var h = Math.floor(random(2, 5)), m = Math.floor(random(0, 60)), s = Math.floor(random(0, 60));
        cell.textContent = String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
      }
      if (key === "open") cell.textContent = String(Math.floor(random(0, 4))).padStart(2, "0");
      pulse(cell);
    });

    var totalSep = 0, totalAug = 0;
    ROWS.forEach(function (row) {
      var tr = document.querySelector('tr[data-row="' + row.id + '"]');
      if (!tr) return;
      var cells = tr.querySelectorAll("td");
      var pct = random(-row.spread, row.spread);
      if (row.id === "payroll") pct = random(-1.8, 2.4);
      var sep = Math.round(row.aug * (1 + pct / 100));
      var realPct = ((sep - row.aug) / Math.abs(row.aug)) * 100;
      cells[1].textContent = signedMoney(sep);
      cells[2].textContent = signedMoney(row.aug);
      cells[3].innerHTML = deltaMarkup(realPct);
      totalSep += sep;
      totalAug += row.aug;
      pulse(cells[1]);
      pulse(cells[3]);
    });

    var totalDelta = ((totalSep - totalAug) / Math.abs(totalAug)) * 100;
    var tSep = document.querySelector("[data-total-sep]");
    var tAug = document.querySelector("[data-total-aug]");
    var tD = document.querySelector("[data-total-delta]");
    if (tSep) { tSep.textContent = signedMoney(totalSep); pulse(tSep); }
    if (tAug) tAug.textContent = signedMoney(totalAug);
    if (tD) {
      var up = totalDelta >= 0;
      tD.className = up ? "up" : "down";
      tD.textContent = (up ? "↑ " : "↓ ") + Math.abs(totalDelta).toFixed(1) + "%";
    }
    if (numLive) numLive.textContent = "Figures updated. Net revenue " + revenue.toFixed(2) + " million.";
  }

  var shuffle = document.getElementById("shuffle");
  if (shuffle) shuffle.addEventListener("click", shuffleFigures);

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

  /* line boxes -------------------------------------------------------------- */
  var rhythmToggle = document.getElementById("rhythm-toggle");
  if (rhythmToggle) {
    rhythmToggle.addEventListener("click", function () {
      var demo = rhythmToggle.closest(".rhythm-demo");
      var on = demo.dataset.lines !== "on";
      demo.dataset.lines = on ? "on" : "off";
      rhythmToggle.setAttribute("aria-pressed", String(on));
      rhythmToggle.textContent = on ? "Hide line boxes" : "Show line boxes";
    });
  }

  /* measure readout --------------------------------------------------------- */
  var chQueued = false;
  function updateChars() {
    if (chQueued) return;
    chQueued = true;
    requestAnimationFrame(function () {
      chQueued = false;
      var wide = document.getElementById("measure-wide-text");
      var target = document.getElementById("measure-target-text");
      if (!wide || !target) return;
      var probe = document.createElement("span");
      probe.className = "t-body";
      probe.textContent = "0";
      probe.style.cssText = "position:absolute;left:-9999px;top:0;visibility:hidden;white-space:pre";
      document.body.appendChild(probe);
      var ch = probe.getBoundingClientRect().width;
      probe.remove();
      if (!ch) return;
      var refs = { wide: wide, target: target };
      Array.prototype.forEach.call(document.querySelectorAll("[data-ch]"), function (el) {
        var ref = refs[el.dataset.ch];
        if (!ref) return;
        el.textContent = "≈ " + Math.round(ref.clientWidth / ch) + " ch";
      });
    });
  }

  /* scroll ------------------------------------------------------------------ */
  var progress = document.getElementById("progress");
  var topbar = document.querySelector(".topbar");
  var ruler = document.querySelector(".ruler");
  var links = Array.prototype.slice.call(document.querySelectorAll(".ruler a"));
  var sections = links.map(function (a) { return document.getElementById(a.getAttribute("href").slice(1)); });
  var scrollQueued = false;

  function updateScroll() {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(function () {
      scrollQueued = false;
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
  window.addEventListener("resize", function () { updateChars(); updateScroll(); });
  listen(motionMQ, updateScroll);

  /* init -------------------------------------------------------------------- */
  applyTheme(false);
  renderCut();
  applyGeist("500");
  applySize(size, false);
  updateChars();
  updateScroll();
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () { updateChars(); updateScroll(); });
  }
})();
