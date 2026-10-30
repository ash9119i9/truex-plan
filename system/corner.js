/* truex system · chapter 04 · corner geometry behaviour */
(function () {
  "use strict";

  var supportsSquircle = !!(window.CSS && CSS.supports && CSS.supports("corner-shape", "squircle"));
  var nativeSupport = document.getElementById("native-support");
  if (nativeSupport && !supportsSquircle) {
    nativeSupport.classList.add("is-fallback");
    nativeSupport.innerHTML = '<i aria-hidden="true"></i> Fallback · round';
  }
  var clamp = function (v, lo, hi) { return Math.min(hi, Math.max(lo, v)); };

  /* gamma (Lanczos) for the superellipse corner area ----------------------- */
  function gamma(z) {
    var g = 7;
    var c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
      771.32342877765313, -176.61502916214059, 12.507343278686905,
      -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
    if (z < 0.5) return Math.PI / (Math.sin(Math.PI * z) * gamma(1 - z));
    z -= 1;
    var x = c[0];
    for (var i = 1; i < g + 2; i++) x += c[i] / (z + i);
    var t = z + g + 0.5;
    return Math.sqrt(2 * Math.PI) * Math.pow(t, z + 0.5) * Math.exp(-t) * x;
  }
  function cornerMetrics(radius, k) {
    var n = 2 * k;
    var inset = radius * (1 - Math.pow(2, -1 / n));
    var area = 1 - Math.pow(gamma(1 + 1 / n), 2) / gamma(1 + 2 / n);
    return { n: n, inset: inset, area: area };
  }

  /* hero instrument -------------------------------------------------------- */
  var hero = document.getElementById("hero-demo");
  if (hero) {
    var heroPlate = document.getElementById("hero-plate");
    var heroRadius = document.getElementById("hero-radius");
    var heroRadiusLabel = document.getElementById("hero-radius-label");
    var heroRLabel = document.getElementById("hero-r-label");
    var heroRBig = document.getElementById("hero-r-big");
    var heroInset = document.getElementById("hero-inset");
    var heroCode = document.getElementById("hero-code");
    var heroShapeLabel = document.getElementById("hero-shape-label");
    var heroKappa = document.getElementById("hero-kappa");
    var heroContinuity = document.getElementById("hero-continuity");
    var heroDetailLabel = document.getElementById("hero-detail-label");
    var heroButtons = Array.prototype.slice.call(hero.querySelectorAll("[data-hero-corner]"));
    var heroShape = "squircle";

    function renderHero() {
      var r = +heroRadius.value;
      var m = cornerMetrics(r, heroShape === "round" ? 1 : 2);
      hero.style.setProperty("--hr", r + "px");
      hero.style.setProperty("--hero-shape", heroShape === "round" ? "round" : "squircle");
      heroRadiusLabel.textContent = r;
      heroRLabel.textContent = r;
      heroRBig.textContent = r;
      heroInset.textContent = m.inset.toFixed(1);
      heroCode.textContent = heroShape;
      heroShapeLabel.textContent = heroShape === "round" ? "round" : "superellipse(2)";
      heroKappa.textContent = heroShape === "round" ? "step" : "0";
      heroContinuity.textContent = heroShape === "round" ? "G1 · 1/r step" : "G2 · no step";
      heroDetailLabel.textContent = "r " + r;
      heroButtons.forEach(function (b) {
        b.setAttribute("aria-pressed", String(b.getAttribute("data-hero-corner") === heroShape));
      });
    }
    heroRadius.addEventListener("input", renderHero);
    heroButtons.forEach(function (b) {
      b.addEventListener("click", function () {
        heroShape = b.getAttribute("data-hero-corner");
        renderHero();
      });
    });
    if (!supportsSquircle) {
      heroButtons.forEach(function (b) {
        if (b.getAttribute("data-hero-corner") === "squircle") {
          b.setAttribute("aria-pressed", "false");
          b.setAttribute("title", "This browser renders the round fallback");
        }
      });
    }
    renderHero();
  }

  /* kink graph ------------------------------------------------------------- */
  var graph = document.getElementById("kink-graph");
  if (graph) {
    var W = 440, H = 232;
    var M = { l: 38, r: 14, t: 16, b: 30 };
    var PW = W - M.l - M.r, PH = H - M.t - M.b;
    var X = function (s) { return M.l + s * PW; };
    var Y = function (y) { return M.t + PH - (y / 2.8) * PH; };
    var svgNS = "http://www.w3.org/2000/svg";
    function el(name, attrs) {
      var node = document.createElementNS(svgNS, name);
      for (var key in attrs) node.setAttribute(key, attrs[key]);
      return node;
    }
    function pathFrom(points) {
      return points.map(function (p, i) { return (i ? "L" : "M") + p[0].toFixed(2) + " " + p[1].toFixed(2); }).join(" ");
    }

    graph.innerHTML = "";
    var grid = el("g", {});
    [0, 0.5, 1, 1.5, 2, 2.5].forEach(function (y) {
      grid.appendChild(el("line", {
        x1: X(0), x2: X(1), y1: Y(y), y2: Y(y),
        class: y === 0 ? "g-axis" : "g-grid", "vector-effect": "non-scaling-stroke"
      }));
      grid.appendChild(el("text", { x: M.l - 7, y: Y(y) + 3, "text-anchor": "end", class: "g-tick" })).textContent =
        y === 0 ? "0" : y === 1 ? "1" : y.toFixed(1);
    });
    [0, 0.25, 0.5, 0.75, 1].forEach(function (x) {
      grid.appendChild(el("line", {
        x1: X(x), x2: X(x), y1: Y(0), y2: Y(2.8),
        class: x === 0 || x === 1 ? "g-axis" : "g-grid", "vector-effect": "non-scaling-stroke"
      }));
    });
    graph.appendChild(grid);

    graph.appendChild(el("text", { x: 2, y: 11, class: "g-label" })).textContent = "κ / (1/r)";
    graph.appendChild(el("text", { x: W - M.r, y: H - 8, "text-anchor": "end", class: "g-label" })).textContent = "arc length";

    /* round: constant 1, step at both tangents */
    var roundPts = [];
    for (var rs = 0; rs <= 1.0001; rs += 0.02) roundPts.push([X(rs), Y(1)]);
    var roundPath = el("path", {
      d: pathFrom(roundPts), class: "g-round", "vector-effect": "non-scaling-stroke"
    });
    graph.appendChild(roundPath);
    [0, 1].forEach(function (x) {
      graph.appendChild(el("line", {
        x1: X(x), x2: X(x), y1: Y(0), y2: Y(1),
        class: "g-jump", "vector-effect": "non-scaling-stroke"
      }));
    });
    graph.appendChild(el("text", { x: X(0.035), y: Y(1) - 8, class: "g-note-muted" })).textContent = "step";
    graph.appendChild(el("text", { x: X(0.965), y: Y(0.38), "text-anchor": "end", class: "g-note-muted" })).textContent = "step";

    /* squircle: sample the superellipse, curvature normalised by 1/a */
    var n = 4, N = 480, pts = [];
    var t0 = 1e-4, t1 = Math.PI / 2 - 1e-4;
    for (var i = 0; i <= N; i++) {
      var t = t0 + (t1 - t0) * (i / N);
      var ct = Math.cos(t), st = Math.sin(t);
      var a = 2 / n;
      var x = Math.pow(ct, a), y = Math.pow(st, a);
      var dx = -a * Math.pow(ct, a - 1) * st;
      var dy = a * Math.pow(st, a - 1) * ct;
      var ddx = a * ((a - 1) * Math.pow(ct, a - 2) * st * st - Math.pow(ct, a));
      var ddy = a * ((a - 1) * Math.pow(st, a - 2) * ct * ct - Math.pow(st, a));
      var denom = Math.pow(dx * dx + dy * dy, 1.5);
      var kappa = denom > 1e-9 ? Math.abs(dx * ddy - dy * ddx) / denom : 0;
      var segment = Math.sqrt(dx * dx + dy * dy) * ((t1 - t0) / N);
      pts.push({ t: t, kappa: kappa, dx: dx, dy: dy, ds: segment });
    }
    var total = 0;
    pts.forEach(function (p) { total += p.ds; p.s = total; });
    pts.forEach(function (p) { p.s = p.s / total; });
    var contPts = pts.map(function (p) { return [X(p.s), Y(clamp(p.kappa, 0, 2.8))]; });
    var areaPath = pathFrom(contPts) + " L " + X(1).toFixed(2) + " " + Y(0).toFixed(2) + " L " + X(0).toFixed(2) + " " + Y(0).toFixed(2) + " Z";
    graph.appendChild(el("path", { d: areaPath, class: "g-area" }));
    graph.appendChild(el("path", {
      d: pathFrom(contPts), class: "g-cont", "vector-effect": "non-scaling-stroke"
    }));
    var peak = pts.reduce(function (best, p) { return p.kappa > best.kappa ? p : best; }, pts[0]);
    graph.appendChild(el("circle", {
      cx: X(peak.s), cy: Y(clamp(peak.kappa, 0, 2.8)), r: 2.6, fill: "var(--signal)"
    }));
    graph.appendChild(el("text", {
      x: X(peak.s) + 7, y: Y(clamp(peak.kappa, 0, 2.8)) - 7, class: "g-note"
    })).textContent = "45° · κ peak ×" + (peak.kappa).toFixed(2);
  }


  /* curve lab -------------------------------------------------------------- */
  function sampleCorner(n, count) {
    var N = count || 480, pts = [];
    var t0 = 1e-4, t1 = Math.PI / 2 - 1e-4;
    for (var i = 0; i <= N; i++) {
      var t = t0 + (t1 - t0) * (i / N);
      var ct = Math.cos(t), st = Math.sin(t);
      var a = 2 / n;
      var x = Math.pow(ct, a), y = Math.pow(st, a);
      var dx = -a * Math.pow(ct, a - 1) * st;
      var dy = a * Math.pow(st, a - 1) * ct;
      var ddx = a * ((a - 1) * Math.pow(ct, a - 2) * st * st - Math.pow(ct, a));
      var ddy = a * ((a - 1) * Math.pow(st, a - 2) * ct * ct - Math.pow(st, a));
      var denom = Math.pow(dx * dx + dy * dy, 1.5);
      var kappa = denom > 1e-9 ? Math.abs(dx * ddy - dy * ddx) / denom : 0;
      pts.push({ t: t, kappa: kappa, ds: Math.sqrt(dx * dx + dy * dy) * ((t1 - t0) / N) });
    }
    var total = 0;
    pts.forEach(function (p) { total += p.ds; p.s = total; });
    pts.forEach(function (p) { p.s = p.s / total; });
    var peak = pts.reduce(function (best, p) { return p.kappa > best.kappa ? p : best; }, pts[0]);
    return { pts: pts, peak: peak };
  }

  var curveLab = document.getElementById("curve-lab");
  if (curveLab) {
    var plate = document.getElementById("curve-plate");
    var range = document.getElementById("curve-range");
    var kEl = document.getElementById("curve-k");
    var kNameEl = document.getElementById("curve-k-name");
    var classEl = document.getElementById("curve-class");
    var eqEl = document.getElementById("curve-eq");
    var nEl = document.getElementById("curve-n");
    var insetEl = document.getElementById("curve-inset");
    var areaEl = document.getElementById("curve-area");
    var kappaEl = document.getElementById("curve-kappa");
    var kappaNote = document.getElementById("curve-kappa-note");
    var specWord = document.getElementById("curve-spec-word");
    var codeEl = document.getElementById("curve-code");
    var rLabel = document.getElementById("curve-r-label");
    var spark = document.getElementById("curve-spark");
    var familyButtons = Array.prototype.slice.call(curveLab.querySelectorAll("[data-k]"));
    var svgNS = "http://www.w3.org/2000/svg";
    var k = 2;

    function fmtK(v) { return (Math.round(v * 10) / 10).toFixed(1); }
    function codeK(v) { return String(Math.round(v * 10) / 10); }
    function nameFor(v) {
      if (v <= 1.001) return "round";
      if (Math.abs(v - 1.5) < 0.01) return "soft";
      if (Math.abs(v - 2) < 0.01) return "squircle";
      if (Math.abs(v - 3) < 0.01) return "tight";
      if (v >= 3.99) return "near-square";
      return v < 2 ? "continuous" : "tight";
    }
    function currentRadius() {
      return plate.getBoundingClientRect().width * 0.48;
    }
    function svgEl(name, attrs) {
      var node = document.createElementNS(svgNS, name);
      for (var key in attrs) node.setAttribute(key, attrs[key]);
      return node;
    }
    function drawSpark(n) {
      var data = sampleCorner(n, 260);
      var peak = data.peak;
      var ymax = Math.max(1.5, Math.ceil(peak.kappa * 1.1 * 2) / 2);
      var W = 260, H = 76, L = 20, R = 6, T = 8, B = 12;
      var PW = W - L - R, PH = H - T - B;
      var X = function (s) { return L + s * PW; };
      var Y = function (v) { return T + PH - (Math.min(v, ymax) / ymax) * PH; };
      spark.innerHTML = "";
      for (var g = 0; g <= 3; g++) {
        var yv = ymax * g / 3;
        spark.appendChild(svgEl("line", {
          x1: L, x2: W - R, y1: Y(yv), y2: Y(yv),
          class: g === 0 ? "k-axis" : "k-grid", "vector-effect": "non-scaling-stroke"
        }));
        var label = svgEl("text", { x: L - 4, y: Y(yv) + 2.5, "text-anchor": "end", class: "k-tick" });
        label.textContent = yv === 0 ? "0" : yv.toFixed(1);
        spark.appendChild(label);
      }
      if (n !== 2) {
        spark.appendChild(svgEl("line", {
          x1: L, x2: W - R, y1: Y(1), y2: Y(1),
          stroke: "var(--line-strong)", "stroke-width": 1, "stroke-dasharray": "2 4",
          "vector-effect": "non-scaling-stroke"
        }));
      }
      var points = data.pts.map(function (p) { return [X(p.s), Y(p.kappa)]; });
      var line = points.map(function (p, i) { return (i ? "L" : "M") + p[0].toFixed(2) + " " + p[1].toFixed(2); }).join(" ");
      if (n === 2) {
        spark.appendChild(svgEl("line", {
          x1: L, x2: W - R, y1: Y(1), y2: Y(1),
          class: "k-line", "vector-effect": "non-scaling-stroke"
        }));
        [L, W - R].forEach(function (x) {
          spark.appendChild(svgEl("line", {
            x1: x, x2: x, y1: Y(0), y2: Y(1), class: "k-line",
            "stroke-dasharray": "3 3", "vector-effect": "non-scaling-stroke"
          }));
        });
      } else {
        spark.appendChild(svgEl("path", {
          d: line + " L " + X(1).toFixed(2) + " " + Y(0).toFixed(2) + " L " + X(0).toFixed(2) + " " + Y(0).toFixed(2) + " Z",
          class: "k-fill"
        }));
        spark.appendChild(svgEl("path", {
          d: line, class: "k-line", "vector-effect": "non-scaling-stroke"
        }));
        spark.appendChild(svgEl("circle", {
          cx: X(peak.s), cy: Y(peak.kappa), r: 2.1, class: "k-peak"
        }));
      }
      spark.setAttribute("aria-label",
        n === 2
          ? "Curvature is constant at one over r and steps at both tangents."
          : "Curvature starts at zero, peaks at " + peak.kappa.toFixed(2) + " times the circular value at 45 degrees, and returns to zero.");
      return peak.kappa;
    }

    function renderCurve() {
      var n = 2 * k;
      var r = currentRadius();
      var m = cornerMetrics(r, k);
      var peak = drawSpark(n);
      plate.style.setProperty("--k", k);
      kEl.textContent = fmtK(k);
      kNameEl.textContent = nameFor(k);
      classEl.textContent = k <= 1.001 ? "G1" : "G2";
      classEl.classList.toggle("is-g1", k <= 1.001);
      nEl.textContent = n.toFixed(2);
      insetEl.textContent = m.inset.toFixed(1);
      areaEl.textContent = (m.area * 100).toFixed(1);
      kappaEl.textContent = k <= 1.001 ? "step" : "0";
      specWord.textContent = "K " + fmtK(k);
      eqEl.innerHTML = "|x|<sup>" + n.toFixed(2) + "</sup> + |y|<sup>" + n.toFixed(2) + "</sup> = 1";
      codeEl.textContent = "corner-shape: superellipse(" + codeK(k) + ")";
      rLabel.textContent = "r " + Math.round(r) + "px";
      kappaNote.textContent = k <= 1.001
        ? "1/r step at both tangents · no continuous derivative"
        : "0 at both tangents · peak " + peak.toFixed(2) + "× at 45°";
      familyButtons.forEach(function (b) {
        b.setAttribute("aria-pressed", String(Math.abs(+b.getAttribute("data-k") - k) < 0.01));
      });
      requestAnimationFrame(centerFamily);
    }

    var familyStrip = curveLab.querySelector(".cn-family-strip");
    function centerFamily() {
      if (!familyStrip || familyStrip.scrollWidth <= familyStrip.clientWidth + 2) return;
      var active = familyStrip.querySelector('[aria-pressed="true"]');
      if (!active) return;
      if (active.offsetLeft < familyStrip.scrollLeft ||
          active.offsetLeft + active.offsetWidth > familyStrip.scrollLeft + familyStrip.clientWidth) {
        var left = active.offsetLeft - (familyStrip.clientWidth - active.offsetWidth) / 2;
        familyStrip.scrollTo({ left: Math.max(0, left), behavior: "smooth" });
      }
    }

    range.addEventListener("input", function () {
      k = Math.min(4, Math.max(1, +range.value));
      renderCurve();
    });
    familyButtons.forEach(function (b) {
      b.addEventListener("click", function () {
        k = Math.min(4, Math.max(1, +b.getAttribute("data-k")));
        range.value = k;
        renderCurve();
      });
    });
    var q = false;
    window.addEventListener("resize", function () {
      if (q) return;
      q = true;
      requestAnimationFrame(function () { q = false; renderCurve(); });
    });
    renderCurve();
  }


  /* ladder ----------------------------------------------------------------- */
  var ladder = document.getElementById("ladder-demo");
  if (ladder) {
    var ladderButtons = Array.prototype.slice.call(ladder.querySelectorAll("[data-ladder-shape]"));
    var ladderMode = "squircle";
    function applyLadder(mode) {
      ladderMode = mode;
      ladder.style.setProperty("--corner-mode", mode === "round" ? "round" : "squircle");
      ladderButtons.forEach(function (b) {
        b.setAttribute("aria-pressed", String(b.getAttribute("data-ladder-shape") === mode));
      });
      Array.prototype.forEach.call(ladder.querySelectorAll(".cn-inset-pair[data-mode]"), function (pair) {
        pair.classList.toggle("is-active", pair.getAttribute("data-mode") === mode);
      });
    }
    ladderButtons.forEach(function (b) {
      b.addEventListener("click", function () { applyLadder(b.getAttribute("data-ladder-shape")); });
    });
    applyLadder("squircle");
  }


  /* nesting ---------------------------------------------------------------- */
  var nest = document.getElementById("nest-demo");
  if (nest) {
    var nestPad = document.getElementById("nest-pad");
    var nestOuter = document.getElementById("nest-outer");
    var nestPadLabel = document.getElementById("nest-pad-label");
    var nestPadReadout = document.getElementById("nest-pad-readout");
    var nestInnerLabel = document.getElementById("nest-inner-label");
    var nestOuterLabel = document.getElementById("nest-outer-label");
    var nestVerdict = document.getElementById("nest-verdict");
    var nestVerdictTitle = document.getElementById("nest-verdict-title");
    var nestVerdictNote = document.getElementById("nest-verdict-note");
    var formulaP = document.getElementById("formula-p");
    var nestButtons = Array.prototype.slice.call(nest.querySelectorAll("[data-nest-mode]"));
    var nestValues = Array.prototype.slice.call(nest.querySelectorAll(".cn-nest-values [data-pad]"));
    var nestMode = "concentric";
    var OUTER = 30;

    function renderNest() {
      var pad = +nestPad.value;
      var inner = nestMode === "same" ? OUTER : Math.max(0, OUTER - pad);
      nestOuter.style.setProperty("--nr", OUTER + "px");
      nestOuter.style.setProperty("--pad", pad + "px");
      nestPadLabel.textContent = pad;
      nestPadReadout.textContent = pad;
      nestOuterLabel.textContent = OUTER;
      nestInnerLabel.textContent = inner;
      formulaP.textContent = pad;
      nest.dataset.mode = nestMode;
      var warn = nestMode === "same";
      nestVerdict.classList.toggle("is-warn", warn);
      nestVerdictTitle.textContent = warn ? "Offset" : "Concentric";
      nestVerdictNote.textContent = warn ? "centers offset · gap opens" : "shared center · aligned tangent";
      nestButtons.forEach(function (b) {
        b.setAttribute("aria-pressed", String(b.getAttribute("data-nest-mode") === nestMode));
      });
      nestValues.forEach(function (v) {
        v.classList.toggle("is-on", +v.getAttribute("data-pad") === pad);
      });
    }
    nestPad.addEventListener("input", renderNest);
    nestButtons.forEach(function (b) {
      b.addEventListener("click", function () {
        nestMode = b.getAttribute("data-nest-mode");
        renderNest();
      });
    });
    renderNest();
  }


  /* product surface -------------------------------------------------------- */
  var surface = document.getElementById("surface-demo");
  if (surface) {
    var surfaceButtons = Array.prototype.slice.call(surface.querySelectorAll("[data-surface-shape]"));
    function applySurface(mode) {
      surface.style.setProperty("--corner-mode", mode === "round" ? "round" : "squircle");
      surfaceButtons.forEach(function (b) {
        b.setAttribute("aria-pressed", String(b.getAttribute("data-surface-shape") === mode));
      });
    }
    surfaceButtons.forEach(function (b) {
      b.addEventListener("click", function () { applySurface(b.getAttribute("data-surface-shape")); });
    });
    applySurface("squircle");
  }


  /* keep the active ruler item in view on narrow screens ------------------- */
  (function () {
    var rulerIn = document.querySelector(".ruler-in");
    if (!rulerIn) return;
    var last = null;
    function centerActive() {
      var active = document.querySelector(".ruler a.active");
      if (!active || active === last) return;
      last = active;
      var left = active.offsetLeft - (rulerIn.clientWidth - active.offsetWidth) / 2;
      if (rulerIn.scrollWidth > rulerIn.clientWidth + 2) {
        rulerIn.scrollTo({ left: Math.max(0, left), behavior: "smooth" });
      }
    }
    var queued = false;
    window.addEventListener("scroll", function () {
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () { queued = false; centerActive(); });
    }, { passive: true });
    window.addEventListener("resize", centerActive);
    centerActive();
  })();

  /* expose for the rest of the chapter */
  window.txCorner = {
    supportsSquircle: supportsSquircle,
    gamma: gamma,
    cornerMetrics: cornerMetrics,
    clamp: clamp
  };
})();
