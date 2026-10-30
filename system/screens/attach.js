/* attach — file attachments in the composer.
   A paperclip in the composer bar opens the picker; files also come from
   paste and drag-and-drop. Each file is a chip above the message box with
   its upload progress; a failed upload offers Retry. Sending takes the
   uploaded files and they show on your message as DocumentCards (files.js).

   Limits: 10 files a message, 25 MB each, no empty files, no executables.
   TxAttach.setUpload(fn(file, onProgress(0..1)) → Promise<{id?, url?}>)
   wires the real upload; the demo simulates one, and a file with "fail" in
   its name fails on the first try. */
(function () {
  "use strict";

  var MAX_FILES = 10, MAX_BYTES = 25 * 1024 * 1024;
  var BLOCKED = ["exe", "dll", "msi", "dmg", "pkg", "app", "bat", "cmd", "com", "scr", "vbs", "ps1", "apk", "iso"];
  var IMAGES = ["png", "jpg", "jpeg", "gif", "webp"];
  var GLYPH = { document: "file", sheet: "sheet", slides: "slides", code: "code", text: "text" };
  var seq = 0;
  var all = [];
  var tries = {};

  var upload = function (file, progress) {
    return new Promise(function (ok, no) {
      var key = file.name + "|" + file.size;
      tries[key] = (tries[key] || 0) + 1;
      var total = Math.min(2000, 500 + file.size / 2048), t0 = Date.now();
      var failAt = /fail/i.test(file.name) && tries[key] === 1 ? 0.55 : 2;
      (function step() {
        var p = Math.min(1, (Date.now() - t0) / total);
        if (p >= failAt) { no({ message: "Upload failed. Check your connection." }); return; }
        progress(p);
        if (p >= 1) { ok({}); return; }
        setTimeout(step, 80);
      })();
    });
  };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function ic(id) { return '<svg class="tx-ic tx-ic-sm" aria-hidden="true"><use href="#i-' + id + '"/></svg>'; }
  function extOf(name) { var m = String(name || "").match(/\.([A-Za-z0-9]{1,10})$/); return m ? m[1].toLowerCase() : ""; }
  function clip(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
  // a long name truncates, its extension stays
  function nameParts(name) {
    var n = String(name || "Untitled"), dot = n.lastIndexOf(".");
    return dot > 0 && n.length - dot <= 11 ? [n.slice(0, dot), n.slice(dot)] : [n, ""];
  }
  function sizeText(b) {
    if (window.TxFiles) return window.TxFiles.size(b);
    var kb = b / 1024;
    return kb >= 1024 ? (kb / 1024).toFixed(1) + " MB" : Math.max(0.1, Math.round(kb * 10) / 10) + " KB";
  }

  /* attach(composer, { onChange(), announce(text) }) → controller
     { composer, add(files), files(), clear(), state(), focus() } */
  function attach(composer, opts) {
    opts = opts || {};
    var input = composer.querySelector("textarea");
    var bar = composer.querySelector(".pt-composer-bar");
    var id = "ac-" + (++seq);
    var items = [];
    var say = function (t) { if (opts.announce) opts.announce(t); };

    var tray = document.createElement("div");
    tray.className = "ac-tray";
    tray.id = id + "-tray";
    tray.setAttribute("role", "list");
    tray.setAttribute("aria-label", "Attached files");
    tray.hidden = true;
    var note = document.createElement("p");
    note.className = "ac-note";
    note.setAttribute("role", "alert");
    note.hidden = true;
    composer.insertBefore(tray, input);
    composer.insertBefore(note, input);

    var picker = document.createElement("input");
    picker.type = "file";
    picker.multiple = true;
    picker.hidden = true;
    picker.tabIndex = -1;
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tx-btn tx-ghost tx-sm tx-icon ac-btn";
    btn.setAttribute("aria-label", "Attach files");
    btn.setAttribute("aria-controls", tray.id);
    btn.title = "Attach files · up to " + MAX_FILES + ", 25 MB each";
    btn.innerHTML = '<svg class="tx-ic" aria-hidden="true"><use href="#i-paperclip"/></svg>';
    bar.insertBefore(picker, bar.firstChild);
    bar.insertBefore(btn, bar.firstChild);

    function sync() {
      composer.classList.toggle("has-files", items.length > 0);
      if (opts.onChange) opts.onChange();
    }

    function message(bad) {
      if (!bad.length) { note.hidden = true; note.textContent = ""; return; }
      var lim = bad.filter(function (b) { return b[1] === "limit"; }).length;
      var other = bad.filter(function (b) { return b[1] !== "limit"; });
      var text = "";
      if (other.length) {
        text = (other.length === 1 ? "Couldn’t attach " : other.length + " files weren’t attached: ") +
          other.slice(0, 2).map(function (b) { return "“" + clip(b[0], 40) + "” (" + b[1] + ")"; }).join(", ") +
          (other.length > 2 ? " and " + (other.length - 2) + " more" : "") + ".";
      }
      if (lim) text += (text ? " " : "") + "You can attach up to " + MAX_FILES + " files, so " + lim + (lim === 1 ? " wasn’t" : " weren’t") + " added.";
      note.innerHTML = ic("alert") + "<span></span>";
      note.querySelector("span").textContent = text;
      note.hidden = false;
    }

    function render(it) {
      var el = document.createElement("div");
      el.className = "ac-chip";
      el.setAttribute("role", "listitem");
      el.id = it.key;
      var t = window.TxFiles ? window.TxFiles.typeOf({ name: it.file.name, mediaType: it.file.type }) : { label: "File", kind: "document" };
      it.label = it.image ? (it.ext ? it.ext.toUpperCase().replace("JPG", "JPEG") : "Image") : t.label;
      var parts = nameParts(it.file.name);
      el.innerHTML =
        '<span class="ac-ic' + (it.image ? " is-img" : "") + '" aria-hidden="true">' +
          (it.image ? '<img alt="" src="' + esc(it.preview) + '">' : ic(GLYPH[t.kind] || "file")) + '</span>' +
        '<span class="ac-main"><span class="ac-name" title="' + esc(it.file.name) + '"><span class="ac-base">' + esc(parts[0]) + '</span>' +
          '<span class="ac-ext">' + esc(parts[1]) + '</span></span><span class="ac-meta num"></span></span>' +
        '<span class="ac-acts"></span>' +
        '<span class="ac-bar" aria-hidden="true"><i></i></span>';
      it.el = el;
      var img = el.querySelector(".ac-ic img");
      if (img) img.addEventListener("error", function () {
        var box = img.parentNode;
        box.classList.remove("is-img");
        box.innerHTML = ic("file");
      }, { once: true });
      tray.appendChild(el);
      tray.hidden = false;
      update(it);
    }

    function update(it) {
      var el = it.el, pct = Math.round(it.pct * 100);
      el.dataset.state = it.state;
      el.querySelector(".ac-meta").textContent = it.state === "uploading" ? "Uploading " + pct + "%"
        : it.state === "failed" ? "Upload failed" : it.label + " · " + sizeText(it.file.size);
      el.title = it.state === "failed" && it.err ? it.file.name + " · " + it.err : it.file.name;
      el.querySelector(".ac-bar i").style.width = (it.state === "uploading" ? pct : 0) + "%";
      el.setAttribute("aria-label", it.file.name + ", " + (it.state === "uploading" ? "uploading " + pct + "%" : it.state === "failed" ? (it.err || "upload failed") : "attached, " + sizeText(it.file.size)));
      var acts = el.querySelector(".ac-acts");
      // the buttons change only with the state, so focus survives progress
      if (acts.dataset.state !== it.state) {
        acts.dataset.state = it.state;
        acts.innerHTML = (it.state === "failed" ? '<button type="button" class="ac-retry" aria-label="Retry ' + esc(it.file.name) + '" title="Retry">' + ic("retry") + '</button>' : "") +
          '<button type="button" class="ac-x" aria-label="Remove ' + esc(it.file.name) + '" title="Remove">' + ic("x") + '</button>';
      }
    }

    function start(it) {
      it.state = "uploading";
      it.pct = 0;
      update(it);
      sync();
      var token = it.token = {};
      var live = function () { return it.token === token && !it.gone; };
      Promise.resolve().then(function () {
        return upload(it.file, function (p) { if (!live()) return; it.pct = Math.max(0, Math.min(1, Number(p) || 0)); update(it); });
      }).then(function (res) {
        if (!live()) return;
        it.state = "ready";
        it.res = res || {};
        update(it);
        sync();
        if (!items.some(function (x) { return x.state === "uploading"; })) say(items.length === 1 ? it.file.name + " is ready to send." : items.length + " files ready to send.");
      }, function (err) {
        if (!live()) return;
        it.state = "failed";
        it.err = (err && err.message) || "Upload failed";
        update(it);
        sync();
        say(it.file.name + " didn’t upload. Retry or remove it.");
      });
    }

    function add(list) {
      var files = Array.prototype.slice.call(list || []);
      if (!files.length) return 0;
      var bad = [], added = 0;
      files.forEach(function (f) {
        var ext = extOf(f.name);
        if (items.length >= MAX_FILES) { bad.push([f.name, "limit"]); return; }
        if (items.some(function (x) { return x.file.name === f.name && x.file.size === f.size && x.file.lastModified === f.lastModified; })) { bad.push([f.name, "already attached"]); return; }
        if (BLOCKED.indexOf(ext) > -1) { bad.push([f.name, "." + ext + " files aren’t allowed"]); return; }
        if (!f.size) { bad.push([f.name, "it’s empty"]); return; }
        if (f.size > MAX_BYTES) { bad.push([f.name, "over 25 MB"]); return; }
        var it = { key: id + "-" + (++seq), file: f, ext: ext, state: "uploading", pct: 0,
          image: IMAGES.indexOf(ext) > -1 || /^image\/(png|jpe?g|gif|webp)$/.test(f.type || "") };
        if (it.image) it.preview = URL.createObjectURL(f);
        items.push(it);
        render(it);
        start(it);
        added++;
      });
      message(bad);
      if (added) say((added === 1 ? files.filter(function (f) { return items.some(function (x) { return x.file === f; }); })[0].name : added + " files") + " added. Uploading.");
      sync();
      return added;
    }

    function remove(it) {
      var i = items.indexOf(it);
      if (i < 0) return;
      it.gone = true;
      items.splice(i, 1);
      if (it.preview) URL.revokeObjectURL(it.preview);
      it.el.remove();
      tray.hidden = !items.length;
      note.hidden = true;
      say("Removed " + it.file.name + ".");
      var next = items[i] || items[i - 1];
      (next ? next.el.querySelector(".ac-x") : input).focus();
      sync();
    }

    btn.addEventListener("click", function () { picker.click(); });
    picker.addEventListener("change", function () { add(picker.files); picker.value = ""; input.focus(); });
    tray.addEventListener("click", function (e) {
      var b = e.target.closest("button");
      if (!b) return;
      var it = items.filter(function (x) { return x.el.contains(b); })[0];
      if (!it) return;
      if (b.classList.contains("ac-x")) remove(it);
      else if (b.classList.contains("ac-retry")) { start(it); it.el.querySelector(".ac-x").focus(); }
    });
    // pasted files (a screenshot, say) attach; pasted text still pastes
    input.addEventListener("paste", function (e) {
      var cd = e.clipboardData;
      if (!cd || !cd.files || !cd.files.length) return;
      if (!cd.getData("text")) e.preventDefault();
      add(cd.files);
    });

    var ctl = {
      composer: composer,
      add: add,
      // uploaded files, shaped for TxFiles; the blob URL makes them downloadable
      files: function () {
        return items.filter(function (x) { return x.state === "ready"; }).map(function (x) {
          return { id: (x.res && x.res.id) || "up-" + x.key, name: x.file.name, size: x.file.size, mediaType: x.file.type,
            createdAt: new Date().toISOString(), url: (x.res && x.res.url) || URL.createObjectURL(x.file) };
        });
      },
      clear: function () {
        items.forEach(function (x) { x.gone = true; if (x.preview) URL.revokeObjectURL(x.preview); });
        items = [];
        tray.textContent = "";
        tray.hidden = true;
        note.hidden = true;
        sync();
      },
      state: function () {
        var n = function (s) { return items.filter(function (x) { return x.state === s; }).length; };
        return { count: items.length, ready: n("ready"), uploading: n("uploading"), failed: n("failed") };
      },
      focus: function () { input.focus(); }
    };
    all.push(ctl);
    return ctl;
  }

  // drag files anywhere on the page: the active composer shows a drop target
  function dropzone(target) {
    var depth = 0;
    function hasFiles(e) { var t = e.dataTransfer && e.dataTransfer.types; return !!t && Array.prototype.indexOf.call(t, "Files") > -1; }
    function show(on) {
      var t = target();
      all.forEach(function (c) { c.composer.classList.toggle("is-drop", !!on && c === t); });
    }
    window.addEventListener("dragenter", function (e) { if (!hasFiles(e)) return; depth++; show(true); });
    window.addEventListener("dragleave", function (e) { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) show(false); });
    window.addEventListener("dragover", function (e) { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = target() ? "copy" : "none"; });
    // a drop anywhere attaches, so a stray drop never navigates away
    window.addEventListener("drop", function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      show(false);
      var t = target();
      if (t) { t.add(e.dataTransfer.files); t.focus(); }
    });
  }

  window.TxAttach = {
    attach: attach, dropzone: dropzone, MAX_FILES: MAX_FILES, MAX_BYTES: MAX_BYTES,
    setUpload: function (fn) { if (typeof fn === "function") upload = fn; }
  };
})();
