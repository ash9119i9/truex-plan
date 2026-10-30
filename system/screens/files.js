/* files — the DocumentCard: a generated or uploaded file, shown inline in the
   reply that created it.
     id, name, size (bytes), createdAt, mediaType
     sourceId?   set on a revision → "Revised version"
     url?        a link to the file; content? builds one in the browser
   Row: kind icon + name + "{type} · {KB} KB [· Revised version]" + Discuss +
   Download. Discuss raises tx:discuss with the file; the chat decides what
   that means. */
(function () {
  "use strict";

  // [type label, kind, extensions, media types] · extension wins, since some
  // systems report .ts as video/mp2t and code as text/plain
  var TYPES = [
    ["PDF", "document", ["pdf"], ["application/pdf"]],
    ["Word", "document", ["docx", "doc", "docm", "rtf"], ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/msword", "application/rtf"]],
    ["Excel", "sheet", ["xlsx", "xls", "xlsm"], ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.ms-excel"]],
    ["PowerPoint", "slides", ["pptx", "ppt", "pptm"], ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "application/vnd.ms-powerpoint"]],
    ["CSV", "sheet", ["csv"], ["text/csv"]],
    ["TSV", "sheet", ["tsv"], ["text/tab-separated-values"]],
    ["Markdown", "text", ["md", "markdown"], ["text/markdown", "text/x-markdown"]],
    ["Text", "text", ["txt", "log"], ["text/plain"]],
    ["ABAP", "code", ["abap"], []],
    ["CDS", "code", ["cds"], []],
    ["JavaScript", "code", ["js", "mjs", "cjs", "jsx"], ["text/javascript", "application/javascript"]],
    ["TypeScript", "code", ["ts", "tsx", "mts", "cts"], ["application/typescript", "text/typescript"]],
    ["JSON", "code", ["json"], ["application/json"]],
    ["XML", "code", ["xml"], ["application/xml", "text/xml"]],
    ["YAML", "code", ["yaml", "yml"], ["application/yaml", "application/x-yaml", "text/yaml"]],
    ["SQL", "code", ["sql"], ["application/sql"]],
    ["HTML", "code", ["html", "htm"], ["text/html"]],
    ["Properties", "code", ["properties"], []],
    ["Java", "code", ["java"], ["text/x-java-source", "text/x-java"]],
    ["Python", "code", ["py"], ["text/x-python", "application/x-python-code"]],
    ["Shell", "code", ["sh", "bash", "zsh"], ["application/x-sh", "text/x-shellscript"]]
  ];
  var GLYPH = { document: "file", sheet: "sheet", slides: "slides", code: "code", text: "text" };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function ic(id, cls) { return '<svg class="tx-ic' + (cls ? " " + cls : "") + '" aria-hidden="true"><use href="#i-' + id + '"/></svg>'; }
  function safeId(id) { return "file-" + String(id).replace(/[^\w-]/g, "_"); }

  function extOf(name) {
    var m = String(name || "").match(/\.([A-Za-z0-9]{1,10})$/);
    return m ? m[1].toLowerCase() : "";
  }

  function typeOf(file) {
    var ext = extOf(file.name);
    var media = String(file.mediaType || "").split(";")[0].trim().toLowerCase();
    var hit = TYPES.filter(function (t) { return ext && t[2].indexOf(ext) > -1; })[0] ||
      TYPES.filter(function (t) { return media && t[3].indexOf(media) > -1; })[0];
    if (hit) return { label: hit[0], kind: hit[1] };
    return { label: ext && ext.length <= 5 ? ext.toUpperCase() : "File", kind: "document" };
  }

  // KB per the spec; files past 1 MB read in MB rather than "12,288 KB"
  function sizeOf(bytes) {
    var b = Number(bytes);
    if (bytes == null || !isFinite(b) || b < 0) return "";
    var kb = b / 1024;
    if (kb >= 1024) return (kb / 1024).toFixed(1).replace(/\.0$/, "") + " MB";
    if (b === 0) return "0 KB";
    if (kb < 10) return Math.max(0.1, Math.round(kb * 10) / 10).toString() + " KB";
    return Math.round(kb).toLocaleString("en-US") + " KB";
  }

  function createdOf(at) {
    var d = at ? new Date(at) : null;
    if (!d || isNaN(d)) return "";
    try {
      return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(d);
    } catch (e) { return d.toISOString().slice(0, 16).replace("T", " "); }
  }

  // only links a browser can fetch safely; anything else needs content
  function safeUrl(u) {
    try {
      var x = new URL(String(u), location.href);
      return /^(https?|blob):$/.test(x.protocol) ? x.href : "";
    } catch (e) { return ""; }
  }

  // split the name so a long base truncates and the extension stays visible
  function nameParts(name) {
    var n = String(name || "Untitled");
    var dot = n.lastIndexOf(".");
    return dot > 0 && n.length - dot <= 11 ? [n.slice(0, dot), n.slice(dot)] : [n, ""];
  }

  function card(file) {
    var t = typeOf(file);
    var id = safeId(file.id);
    var parts = nameParts(file.name);
    var size = sizeOf(file.size);
    var created = createdOf(file.createdAt);
    var source = file.sourceId ? safeId(file.sourceId) : "";
    var canGet = !!(safeUrl(file.url) || file.content != null);
    var name = esc(file.name || "Untitled");

    var el = document.createElement("article");
    el.className = "dc";
    el.id = id;
    el.dataset.kind = t.kind;
    el.setAttribute("aria-labelledby", id + "-name");
    el.innerHTML =
      '<span class="dc-ic" aria-hidden="true">' + ic(GLYPH[t.kind]) + '</span>' +
      '<div class="dc-main">' +
        '<span class="dc-name" id="' + id + '-name" title="' + name + '"><span class="dc-base">' + esc(parts[0]) + '</span><span class="dc-ext">' + esc(parts[1]) + '</span></span>' +
        '<span class="dc-meta">' +
          '<span>' + esc(t.label) + '</span>' +
          (size ? '<span class="dc-dot" aria-hidden="true">·</span><span class="num">' + esc(size) + '</span>' : "") +
          (source ? '<span class="dc-dot" aria-hidden="true">·</span>' + (document.getElementById(source)
            ? '<a class="dc-rev" href="#' + source + '">Revised version</a>'
            : '<span class="dc-rev-plain">Revised version</span>') : "") +
          (created ? '<span class="tx-sr">, created ' + esc(created) + '</span>' : "") +
        '</span>' +
      '</div>' +
      '<div class="dc-actions">' +
        '<button type="button" class="tx-btn tx-ghost tx-sm dc-discuss" aria-label="Discuss ' + name + '">' + ic("discuss", "tx-ic-sm") + '<span>Discuss</span></button>' +
        '<button type="button" class="tx-btn tx-ghost tx-sm tx-icon dc-dl" aria-label="Download ' + name + '"' +
          (canGet ? "" : ' disabled title="Not available to download yet"') + '>' + ic("download", "tx-ic-sm") + '</button>' +
      '</div>';
    if (created) el.title = "Created " + created;
    el._file = file;
    return el;
  }

  // render a reply's files into its slot; returns how many were shown
  function list(host, files) {
    host.textContent = "";
    (files || []).filter(Boolean).forEach(function (f) { host.appendChild(card(f)); });
    host.hidden = !host.children.length;
    return host.children.length;
  }

  function download(file) {
    var href = safeUrl(file.url);
    var temp = "";
    if (!href && file.content != null) {
      temp = URL.createObjectURL(new Blob([file.content], { type: file.mediaType || "application/octet-stream" }));
      href = temp;
    }
    if (!href) return false;
    var a = document.createElement("a");
    a.href = href;
    a.download = file.name || "download";
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    if (temp) setTimeout(function () { URL.revokeObjectURL(temp); }, 4000);
    return true;
  }

  function reveal(target) {
    var pane = target.closest(".cs-scroll");
    if (pane) {
      var p = pane.getBoundingClientRect(), r = target.getBoundingClientRect();
      pane.scrollBy({ top: r.top - p.top - p.height / 3, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    }
    target.classList.remove("is-flash");
    void target.offsetWidth;
    target.classList.add("is-flash");
    target.setAttribute("tabindex", "-1");
    target.focus({ preventScroll: true });
  }

  document.addEventListener("click", function (e) {
    var t = e.target;
    if (!t.closest) return;
    var discuss = t.closest(".dc-discuss");
    var dl = t.closest(".dc-dl");
    var rev = t.closest(".dc-rev");
    if (discuss) {
      document.dispatchEvent(new CustomEvent("tx:discuss", { detail: { file: discuss.closest(".dc")._file } }));
    } else if (dl && !dl.disabled) {
      download(dl.closest(".dc")._file);
    } else if (rev) {
      var target = document.getElementById(rev.getAttribute("href").slice(1));
      if (target) { e.preventDefault(); reveal(target); }
    }
  });

  window.TxFiles = { card: card, list: list, typeOf: typeOf, size: sizeOf, download: download };
})();
