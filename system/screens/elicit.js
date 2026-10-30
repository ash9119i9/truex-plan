/* elicit — 6.4 McpElicitationCard. An MCP server asks the user for structured
   input (mcpServer/elicitation/request). Pinned above the composer like the
   other requests, in the shared .ap shell (approval.css).

     serverName, threadId, turnId
     mode         form | url | openai/userVerification | openai/form
     form         {message, requestedSchema: {type: "object", properties, required?}}
                  string (format email | uri | date | date-time, min/maxLength),
                  number / integer (minimum / maximum), boolean,
                  enum (single select) or array of enum (multi select)
     url          {elicitationId, message, url} · open-link flow
     userVerification {challenge, description, title}
   response       {action: "accept", content?} | {action: "decline"} | {action: "cancel"}
   Buttons: Submit · Decline · Cancel; URL mode: Open link · Done · Cancel. */
(function () {
  "use strict";

  var METHOD = "mcpServer/elicitation/request";
  var MODES = { form: "form", "openai/form": "form", url: "url", "openai/userVerification": "verify" };
  var GONE = {
    409: "This request was already answered.",
    404: "This request is gone. It may have expired.",
    410: "This request expired before your answer arrived."
  };
  var seq = 0;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function ic(id) { return '<svg class="tx-ic tx-ic-sm" aria-hidden="true"><use href="#i-' + id + '"/></svg>'; }
  function safeId(s) { return String(s).replace(/[^\w-]/g, "_"); }
  function words(k) {
    var w = String(k).replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim().toLowerCase();
    return w.charAt(0).toUpperCase() + w.slice(1);
  }
  function left(ms) {
    var s = Math.max(0, Math.ceil(ms / 1000));
    if (s >= 3600) return Math.floor(s / 3600) + "h " + String(Math.floor(s % 3600 / 60)).padStart(2, "0") + "m";
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }
  function spoken(ms) {
    var s = Math.max(0, Math.ceil(ms / 1000));
    if (s < 60) return s + (s === 1 ? " second" : " seconds");
    var m = Math.ceil(s / 60);
    return m + (m === 1 ? " minute" : " minutes");
  }
  // only http(s) links can be opened
  function httpUrl(u) {
    try {
      var x = new URL(String(u));
      return x.protocol === "https:" || x.protocol === "http:" ? x : null;
    } catch (e) { return null; }
  }

  function isElicitation(raw) {
    return !!(raw && typeof raw === "object" && (raw.method === METHOD || raw.type === "elicitation"));
  }

  // the wire shape {method, requestId|id, params}, or flat
  function normalize(raw) {
    var p = raw.params && typeof raw.params === "object" ? raw.params
      : raw.detail && typeof raw.detail === "object" ? raw.detail : raw;
    var mode = String(p.mode || (p.userVerification ? "openai/userVerification" : p.url && typeof p.url === "object" ? "url" : "form"));
    var kind = MODES[mode] || "unknown";
    var form = p.form && typeof p.form === "object" ? p.form : p;
    var u = p.url && typeof p.url === "object" ? p.url
      : { url: typeof p.url === "string" ? p.url : "", message: p.message, elicitationId: p.elicitationId };
    var v = p.userVerification && typeof p.userVerification === "object" ? p.userVerification : {};
    return {
      requestId: String(raw.requestId != null ? raw.requestId : raw.id != null ? raw.id : ""),
      serverName: String(p.serverName || raw.serverName || "An MCP server"),
      threadId: p.threadId || "",
      turnId: p.turnId || "",
      mode: mode,
      kind: kind,
      message: String((kind === "url" ? u.message : kind === "form" ? form.message : "") || p.message || ""),
      schema: kind === "form" ? form.requestedSchema || p.requestedSchema || null : null,
      link: { url: String(u.url || ""), elicitationId: u.elicitationId || "" },
      verify: { challenge: String(v.challenge || ""), title: String(v.title || ""), description: String(v.description || "") },
      expiresAt: raw.expiresAt || p.expiresAt || ""
    };
  }

  /* ── requestedSchema → fields ─────────────────────────────────────────── */
  function enumOpts(s) {
    if (!s) return null;
    if (Array.isArray(s.enum) && s.enum.length) {
      return s.enum.map(function (v, i) { return { value: v, label: String((s.enumNames && s.enumNames[i]) || v) }; });
    }
    var alt = s.oneOf || s.anyOf;
    if (Array.isArray(alt) && alt.length && alt.every(function (x) { return x && "const" in x; })) {
      return alt.map(function (x) { return { value: x["const"], label: String(x.title || x["const"]) }; });
    }
    return null;
  }

  function fields(schema) {
    var props = schema && schema.properties && typeof schema.properties === "object" ? schema.properties : {};
    var req = schema && Array.isArray(schema.required) ? schema.required : [];
    return Object.keys(props).map(function (k) {
      var s = props[k] || {};
      var f = { key: k, title: String(s.title || words(k)), desc: s.description ? String(s.description) : "", required: req.indexOf(k) > -1, def: s["default"] };
      var opts = enumOpts(s);
      if (s.type === "array" && enumOpts(s.items)) {
        f.kind = "multi"; f.options = enumOpts(s.items); f.min = s.minItems; f.max = s.maxItems;
      } else if (opts) {
        f.kind = "single"; f.options = opts;
      } else if (s.type === "boolean") {
        f.kind = "bool";
      } else if (s.type === "number" || s.type === "integer") {
        f.kind = "number"; f.int = s.type === "integer"; f.min = s.minimum; f.max = s.maximum;
      } else {
        // strings, and anything the form can't draw, fall back to text
        f.kind = "string"; f.format = s.format || ""; f.minLen = s.minLength; f.maxLen = s.maxLength;
      }
      return f;
    });
  }

  var INPUT = { email: "email", uri: "url", date: "date", "date-time": "datetime-local" };

  function fieldHTML(f, fid) {
    var hintId = f.desc ? fid + "-hint" : "";
    var hint = f.desc ? '<small class="el-hint" id="' + hintId + '">' + esc(f.desc) + '</small>' : "";
    var err = '<p class="el-err" id="' + fid + '-err" hidden>' + ic("alert") + '<span></span></p>';
    var optional = f.required ? "" : '<span class="el-opt">Optional</span>';
    var req = f.required ? ' aria-required="true"' : "";
    var by = hintId ? ' aria-describedby="' + hintId + '"' : "";
    var head = '<div class="el-field" data-key="' + esc(f.key) + '" data-kind="' + f.kind + '">';

    if (f.kind === "bool") {
      return head + '<label class="el-check" for="' + fid + '">' +
        '<input type="checkbox" id="' + fid + '"' + (f.def === true ? " checked" : "") + by + '>' +
        '<span class="el-check-text"><b>' + esc(f.title) + '</b>' + hint + '</span></label>' + err + '</div>';
    }
    if (f.kind === "single" || f.kind === "multi") {
      var multi = f.kind === "multi";
      var dflt = multi ? (Array.isArray(f.def) ? f.def : []) : f.def;
      return head + '<span class="el-label" id="' + fid + '-l"><b>' + esc(f.title) + '</b>' + optional +
        (multi ? '<span class="el-opt">Choose ' + (f.max === 1 ? "one" : "any") + '</span>' : "") + '</span>' + hint +
        '<div class="aq-opts el-group" id="' + fid + '" role="group" aria-labelledby="' + fid + '-l"' + req + by + '>' +
          f.options.map(function (o, i) {
            var on = multi ? dflt.indexOf(o.value) > -1 : dflt === o.value;
            return '<button type="button" class="aq-opt' + (multi ? " is-multi" : "") + '" data-i="' + i + '" aria-pressed="' + on + '">' +
              '<span class="aq-tick" aria-hidden="true">' + ic("check") + '</span>' +
              '<span class="aq-opt-text"><b>' + esc(o.label) + '</b></span></button>';
          }).join("") +
        '</div>' + err + '</div>';
    }
    var type = f.kind === "number" ? "number" : INPUT[f.format] || "text";
    var attrs = f.kind === "number"
      ? ' inputmode="' + (f.int ? "numeric" : "decimal") + '" step="' + (f.int ? "1" : "any") + '"' +
        (f.min != null ? ' min="' + esc(f.min) + '"' : "") + (f.max != null ? ' max="' + esc(f.max) + '"' : "")
      : (f.maxLen != null ? ' maxlength="' + esc(f.maxLen) + '"' : "") + (f.format === "email" ? ' autocomplete="email"' : ' autocomplete="off"');
    var value = f.def != null && typeof f.def !== "object" ? ' value="' + esc(f.def) + '"' : "";
    return head + '<label class="el-label" for="' + fid + '"><b>' + esc(f.title) + '</b>' + optional + '</label>' + hint +
      '<input class="aq-text el-in" id="' + fid + '" type="' + type + '"' + attrs + value + req + by + ' spellcheck="false">' + err + '</div>';
  }

  // one message per field, or ""
  function check(f, st) {
    if (f.kind === "bool") return "";
    if (f.kind === "single") return f.required && st.single[f.key] === undefined ? "Choose one." : "";
    if (f.kind === "multi") {
      var n = (st.multi[f.key] || []).length;
      if (f.required && !n) return "Choose at least one.";
      if (n && f.min != null && n < f.min) return "Choose at least " + f.min + ".";
      if (f.max != null && n > f.max) return "Choose up to " + f.max + ".";
      return "";
    }
    var input = f._el;
    if (input.validity && input.validity.badInput) return f.kind === "number" ? "Enter a number." : "Check this value.";
    var v = input.value.trim();
    if (!v) return f.required ? "Required." : "";
    if (f.kind === "number") {
      var x = Number(v);
      if (!isFinite(x)) return "Enter a number.";
      if (f.int && !Number.isInteger(x)) return "Enter a whole number.";
      if (f.min != null && x < f.min) return "Enter " + f.min + " or more.";
      if (f.max != null && x > f.max) return "Enter " + f.max + " or less.";
      return "";
    }
    var len = Array.from(v).length;
    if (f.minLen != null && len < f.minLen) return "Use at least " + f.minLen + " characters.";
    if (f.maxLen != null && len > f.maxLen) return "Use " + f.maxLen + " characters or fewer.";
    if (f.format === "email" && !/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(v)) return "Enter an email address, like name@company.com.";
    if (f.format === "uri") { try { new URL(v); } catch (e) { return "Enter a full link, starting with https://."; } }
    if (f.format === "date" && (!/^\d{4}-\d{2}-\d{2}$/.test(v) || isNaN(Date.parse(v)))) return "Enter a date.";
    if (f.format === "date-time" && isNaN(Date.parse(v))) return "Enter a date and time.";
    return "";
  }

  // typed values; empty optional fields are left out
  function valueOf(f, st) {
    if (f.kind === "bool") return f._el.checked;
    if (f.kind === "single") return st.single[f.key];
    if (f.kind === "multi") { var a = st.multi[f.key] || []; return a.length ? a.slice() : undefined; }
    var v = f._el.value.trim();
    if (!v) return undefined;
    if (f.kind === "number") return Number(v);
    if (f.format === "date-time") return new Date(v).toISOString();
    return v;
  }

  /* card(host, request, { submit(requestId, payload) → Promise,
     onClose(kind, info) }) → { el, requestId, stop(), destroy(), phase() }
     kind: accept (info = {fields: [titles]}) | decline | cancel | expired |
     stopped | gone (info = status) */
  function card(host, req, h) {
    h = h || {};
    var id = "el-" + (++seq);
    var kind = req.kind;
    var expires = Date.parse(req.expiresAt || "");
    var flds = kind === "form" ? fields(req.schema) : [];
    var link = kind === "url" ? httpUrl(req.link.url) : null;
    var st = { phase: "pending", single: {}, multi: {}, errs: {}, opened: false, err: null, closed: false, payload: null, act: "" };
    flds.forEach(function (f) {
      if (f.kind === "single" && f.def !== undefined) st.single[f.key] = f.def;
      if (f.kind === "multi" && Array.isArray(f.def)) st.multi[f.key] = f.def.slice();
    });

    var title = kind === "form" ? req.serverName + " needs a few details"
      : kind === "url" ? req.serverName + " wants you to open a link"
      : kind === "verify" ? req.verify.title || "Confirm it’s you"
      : req.serverName + " sent a request";
    var icon = kind === "url" ? "globe" : kind === "verify" ? "lock" : "plug";

    var main = "";
    if (kind === "form") {
      main = '<form class="el-form" id="' + id + '-form" novalidate>' +
        '<p class="el-summary" id="' + id + '-sum" role="alert" hidden></p>' +
        '<fieldset class="el-set">' + flds.map(function (f, i) { return fieldHTML(f, id + "-f" + i); }).join("") + '</fieldset>' +
        '<p class="aq-note">' + ic("lock") + '<span>Only share what you’re comfortable sending to ' + esc(req.serverName) + '.</span></p>' +
      '</form>';
    } else if (kind === "url") {
      main = '<div class="el-link">' +
          '<span class="at-logo" aria-hidden="true">' + ic("globe") + '</span>' +
          '<span class="el-link-text"><b>' + esc(link ? link.hostname : "Link unavailable") + '</b>' +
          '<code>' + esc(req.link.url || "No link was sent.") + '</code></span>' +
        '</div>' +
        (!link ? '<p class="el-warn">' + ic("alert") + '<span>This link can’t be opened here. Cancel, or ask the agent for another way.</span></p>'
          : link.protocol === "http:" ? '<p class="el-warn">' + ic("alert") + '<span>This link isn’t encrypted (http). Only continue if you trust ' + esc(link.hostname) + '.</span></p>'
          : '<p class="aq-note">' + ic("lock") + '<span>Opens in a new tab. Come back and choose Done when you’ve finished.</span></p>');
    } else if (kind === "verify") {
      main = (req.verify.description ? '<p class="ap-q">' + esc(req.verify.description) + '</p>' : "") +
        (req.verify.challenge ? '<div class="el-code-row"><output class="el-code num" aria-label="Verification code ' + esc(req.verify.challenge) + '">' + esc(req.verify.challenge) + '</output>' +
          '<button type="button" class="tx-btn tx-ghost tx-sm el-copy">' + ic("copy") + '<span>Copy</span></button></div>' : "");
    } else {
      main = '<p class="el-warn">' + ic("alert") + '<span>This request type (' + esc(req.mode) + ') can’t be shown here. Decline it, or cancel and ask the agent another way.</span></p>';
    }

    var el = document.createElement("section");
    el.className = "ap el";
    el.dataset.mode = kind;
    el.setAttribute("aria-labelledby", id + "-title");
    el.innerHTML =
      '<header class="ap-head">' +
        '<span class="ap-ic" aria-hidden="true">' + ic(icon) + '</span>' +
        '<b class="ap-title" id="' + id + '-title">' + esc(title) + '</b>' +
        (isNaN(expires) ? "" : '<span class="ap-time" role="timer">' + ic("clock") + '<span class="ap-left num"></span></span>') +
      '</header>' +
      '<p class="el-sub">Requested by <b>' + esc(req.serverName) + '</b> · MCP server</p>' +
      (req.message ? '<p class="ap-q">' + esc(req.message) + '</p>' : "") +
      main +
      '<div class="el-foot"></div>';
    host.textContent = "";
    host.appendChild(el);
    host.hidden = false;
    var foot = el.querySelector(".el-foot");
    var form = el.querySelector(".el-form");
    var set = el.querySelector(".el-set");
    var sum = el.querySelector(".el-summary");
    flds.forEach(function (f, i) {
      f._id = id + "-f" + i;
      f._el = el.querySelector("#" + f._id);
      f._wrap = f._el.closest(".el-field");
    });
    var timer = null;

    function btn(style, act, label, off) {
      var sending = st.phase === "submitting";
      var spin = '<span class="tx-spin ap-spin" aria-hidden="true"></span><span>Sending…</span>';
      return '<button type="' + (act === "submit" ? "submit" : "button") + '" class="tx-btn tx-sm ' + style + ' el-act" data-act="' + act + '"' +
        (act === "submit" ? ' form="' + id + '-form"' : "") + (sending || off ? " disabled" : "") + '>' +
        (sending && st.act === act ? spin : label) + '</button>';
    }

    function paintFoot() {
      var ph = st.phase;
      el.dataset.state = ph;
      if (set) set.disabled = ph === "submitting";
      var html = "";
      if (ph === "pending" || ph === "submitting") {
        if (kind === "form") html = btn("tx-primary", "submit", "<span>Submit</span>") + btn("ap-soft", "decline", "Decline") + btn("tx-ghost", "cancel", "Cancel");
        else if (kind === "url") html = btn(st.opened ? "ap-soft" : "tx-primary", "open", ic("globe") + "<span>" + (st.opened ? "Open again" : "Open link") + "</span>", !link) +
          btn(st.opened ? "tx-primary" : "ap-soft", "done", "<span>Done</span>") + btn("tx-ghost", "cancel", "Cancel");
        else if (kind === "verify") html = btn("tx-primary", "accept", ic("check") + "<span>Confirm</span>") + btn("ap-soft", "decline", "Decline") + btn("tx-ghost", "cancel", "Cancel");
        else html = btn("ap-soft", "decline", "Decline") + btn("tx-ghost", "cancel", "Cancel");
        html = '<div class="ap-btns">' + html + '</div>';
      } else if (ph === "expired") {
        html = '<p class="ap-msg" role="status">' + ic("clock") + '<span>No reply in time. ' + esc(req.serverName) + ' will treat it as cancelled.</span></p>';
      } else if (ph === "error") {
        var gone = GONE[st.err.status];
        html = '<div class="ap-error" role="alert">' +
          '<p class="ap-err">' + ic("alert") + '<span>' + esc(gone || st.err.message || "Couldn’t send your answer. Check your connection and try again.") + '</span></p>' +
          '<div class="ap-btns">' +
            (gone ? '<button type="button" class="tx-btn tx-sm el-dismiss">Dismiss</button>'
              : '<button type="button" class="tx-btn tx-primary tx-sm el-retry">' + ic("retry") + '<span>Try again</span></button>' +
                '<button type="button" class="tx-btn tx-ghost tx-sm el-back">Back</button>') +
            '<span class="tx-chip tx-chip-ref ap-ref">Ref ' + esc(req.requestId || "–") + (st.err.status ? " · " + esc(st.err.status) : "") + '</span>' +
          '</div></div>';
      }
      foot.innerHTML = html;
      tick();
    }

    /* ── form validation · inline, with a summary that takes focus to the first problem */
    function showErr(f, msg) {
      st.errs[f.key] = msg;
      var e = f._wrap.querySelector(".el-err");
      e.querySelector("span").textContent = msg;
      e.hidden = !msg;
      var ids = [f.desc ? f._id + "-hint" : "", msg ? f._id + "-err" : ""].filter(Boolean).join(" ");
      if (ids) f._el.setAttribute("aria-describedby", ids); else f._el.removeAttribute("aria-describedby");
      if (msg) f._el.setAttribute("aria-invalid", "true"); else f._el.removeAttribute("aria-invalid");
      f._wrap.classList.toggle("is-bad", !!msg);
    }
    function summary() {
      var n = flds.filter(function (f) { return st.errs[f.key]; }).length;
      if (!sum) return n;
      sum.hidden = !n;
      sum.innerHTML = n ? ic("alert") + "<span>Fix " + n + (n === 1 ? " field" : " fields") + " to submit.</span>" : "";
      return n;
    }
    function focusField(f) {
      var t = f.kind === "single" || f.kind === "multi" ? f._el.querySelector('.aq-opt[aria-pressed="true"]') || f._el.querySelector(".aq-opt") : f._el;
      if (t) t.focus();
    }
    // once a field has an error, it re-checks as the reader fixes it
    function recheck(f) {
      if (!st.errs[f.key]) return;
      showErr(f, check(f, st));
      summary();
    }

    if (form) {
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        if (st.phase !== "pending") return;
        var bad = null;
        flds.forEach(function (f) { var m = check(f, st); showErr(f, m); if (m && !bad) bad = f; });
        summary();
        if (bad) { focusField(bad); return; }
        var content = {}, sent = [];
        flds.forEach(function (f) {
          var v = valueOf(f, st);
          if (v !== undefined) { content[f.key] = v; if (f.kind !== "bool" || v) sent.push(f.title); }
        });
        send("submit", { action: "accept", content: content }, { fields: sent });
      });
      form.addEventListener("input", function (e) {
        var f = flds.filter(function (x) { return x._el === e.target; })[0];
        if (f) recheck(f);
      });
      form.addEventListener("change", function (e) {
        var f = flds.filter(function (x) { return x._el === e.target; })[0];
        if (f) recheck(f);
      });
      // option toggles · single picks one (again to clear); multi adds and removes
      form.addEventListener("click", function (e) {
        var b = e.target.closest(".aq-opt");
        if (!b || st.phase !== "pending") return;
        var f = flds.filter(function (x) { return x._el === b.parentNode; })[0];
        if (!f) return;
        var v = f.options[Number(b.dataset.i)].value;
        if (f.kind === "single") {
          st.single[f.key] = st.single[f.key] === v ? undefined : v;
          Array.prototype.forEach.call(f._el.querySelectorAll(".aq-opt"), function (o) {
            o.setAttribute("aria-pressed", String(st.single[f.key] !== undefined && f.options[Number(o.dataset.i)].value === st.single[f.key]));
          });
        } else {
          var a = st.multi[f.key] || (st.multi[f.key] = []);
          var at = a.indexOf(v);
          if (at > -1) a.splice(at, 1); else a.push(v);
          b.setAttribute("aria-pressed", String(at < 0));
        }
        recheck(f);
      });
    }

    function tick() {
      if (st.closed || isNaN(expires)) return;
      var ms = expires - Date.now();
      var t = el.querySelector(".ap-time");
      if (t) {
        t.querySelector(".ap-left").textContent = left(ms);
        t.classList.toggle("is-warn", ms <= 60000);
        var say = ms > 0 ? "Expires in " + spoken(ms) : "Expired";
        if (t.getAttribute("aria-label") !== say) t.setAttribute("aria-label", say);
      }
      if (ms <= 0 && (st.phase === "pending" || st.phase === "error")) {
        st.phase = "expired";
        clearInterval(timer);
        paintFoot();
        setTimeout(function () { close("expired"); }, 2200);
      }
    }

    function close(k, info) {
      if (st.closed) return;
      st.closed = true;
      clearInterval(timer);
      st.payload = null;
      host.textContent = "";
      host.hidden = true;
      if (h.onClose) h.onClose(k, info);
    }

    function send(act, payload, info) {
      st.act = act;
      st.payload = payload;
      st.info = info || {};
      st.phase = "submitting";
      paintFoot();
      var p;
      try { p = Promise.resolve(h.submit ? h.submit(req.requestId, payload) : null); }
      catch (err) { p = Promise.reject(err); }
      p.then(function () {
        if (!st.closed) close(payload.action, st.info);
      }, function (err) {
        if (st.closed) return;
        st.err = { status: err && err.status, message: err && err.message };
        st.phase = "error";
        paintFoot();
        var f = foot.querySelector(".ap-error button");
        if (f) f.focus();
      });
    }

    el.addEventListener("click", function (e) {
      var b = e.target.closest("button");
      if (!b || b.disabled || st.closed || !el.contains(b)) return;
      var act = b.dataset.act;
      if (act === "decline" && st.phase === "pending") send("decline", { action: "decline" });
      else if (act === "cancel" && st.phase === "pending") send("cancel", { action: "cancel" });
      else if ((act === "accept" || act === "done") && st.phase === "pending") send(act, { action: "accept" });
      else if (act === "open" && link && st.phase === "pending") {
        window.open(link.href, "_blank", "noopener,noreferrer");
        st.opened = true;
        paintFoot();
        var d = foot.querySelector('[data-act="done"]');
        if (d) d.focus();
      }
      else if (b.classList.contains("el-retry")) send(st.act, st.payload, st.info);
      else if (b.classList.contains("el-back")) { st.phase = "pending"; paintFoot(); }
      else if (b.classList.contains("el-dismiss")) close("gone", st.err.status);
      else if (b.classList.contains("el-copy")) {
        var lbl = b.querySelector("span");
        var done = function () { lbl.textContent = "Copied"; clearTimeout(b._t); b._t = setTimeout(function () { lbl.textContent = "Copy"; }, 1600); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(req.verify.challenge).then(done, done);
        else done();
      }
    });

    timer = setInterval(tick, 500);
    paintFoot();

    return {
      el: el,
      requestId: req.requestId,
      phase: function () { return st.phase; },
      stop: function () { close("stopped"); },
      destroy: function () {
        st.closed = true;
        clearInterval(timer);
        if (el.parentNode === host) { host.textContent = ""; host.hidden = true; }
      }
    };
  }

  // the record left in the reply · field names only, never the values
  function record(hostEl, o) {
    var req = o.req, k = o.kind, srv = req.serverName;
    var question = req.kind === "form" ? srv + " asked for a few details"
      : req.kind === "url" ? srv + " asked you to open a link"
      : req.kind === "verify" ? srv + " asked you to confirm it’s you"
      : srv + " sent a request";
    var fieldsSent = o.info && o.info.fields && o.info.fields.length ? ": " + o.info.fields.join(", ") : "";
    var answer = k === "accept" ? (req.kind === "form" ? "Sent" + fieldsSent : req.kind === "url" ? "Done" : "Confirmed")
      : k === "decline" ? "Declined" : k === "cancel" ? "Cancelled" : "";
    var outcome = answer ? "answered" : k === "stopped" ? "interrupted" : "expired";
    if (!window.TxApproval) return null;
    return window.TxApproval.record(hostEl, { requestId: req.requestId, turnId: req.turnId, at: new Date(), outcome: outcome,
      items: [{ kind: "question", question: question, answer: answer }] });
  }

  window.TxElicit = { METHOD: METHOD, isElicitation: isElicitation, normalize: normalize, fields: fields, card: card, record: record };
})();
