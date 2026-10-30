/* approval — 5.3 PlanApprovalCard, pinned above the composer when a request
   has a single question with id plan_approval, and the ApprovalRecord it
   leaves in the stream once answered.

     requestId          string
     questions[0].id    "plan_approval"
     options            Approve, Revise
     expiresAt          ISO · drives the countdown (LiveDuration, trend -1)
     plan?              steps to show; else "drafted steps are in the message above"
   answer: approve      {answers: {plan_approval: {answers: ["Approve"]}}}
   answer: revise       {answers: {plan_approval: {answers: ["Revise", "user_note: <feedback>"]}}}

   States: pending → revising → submitting → answered (card closes, record in
   the stream); expired (auto-Approve); stopped; error (409 already answered,
   404/410 gone or expired, anything else can be retried).
   Keys: ⌘/Ctrl+Enter sends feedback, Esc cancels revise.

   6.1 PendingRequest · only item/tool/requestUserInput reaches the browser;
   everything else is answered on the server (6.6).
     requestId, method, expiresAt (requestTimeoutMs), responseSchema (null)
     detail.questions[] · InputQuestion, shown one at a time ("{n} of {m}")
       id         plan_approval → PlanApprovalCard;
                  prefix mcp_tool_call_approval → tool approval
       kind?      toolApproval | absent (clarification)
       header?, question, action? (what will run)
       options    {label, description}[] | null
       isOther?   "Something else…" with free text
       isSecret?  password field; the answer is hidden in the record

   6.3 ToolApprovalCard · a single question with kind toolApproval (or an id
   prefixed mcp_tool_call_approval). MCP approvals arrive as requestUserInput.
     shield + "Permission needed" + countdown → connector logo, tool title and
     read-only / write badge (v2) → "Action" + action text → arguments (v2) →
     Allow once · Allow for this chat · Always allow · Don't allow.
     expired: declined, never auto-allowed. Auto by mode: no card, a record. */
(function () {
  "use strict";

  var seq = 0;
  var MAC = /Mac|iPhone|iPad/.test(navigator.platform || "");
  var GONE = {
    409: "This plan was already answered.",
    404: "This review is gone. It may have expired.",
    410: "This review expired before your answer arrived."
  };

  var LOGOS = {"google":{"vb":"0 0 24 24","parts":[["#4285F4","M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"],["#34A853","M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"],["#FBBC05","M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"],["#EA4335","M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"]]},"slack":{"vb":"0 0 54 54","parts":[["#36C5F0","M19.712.133a5.381 5.381 0 0 0-5.376 5.387 5.381 5.381 0 0 0 5.376 5.386h5.376V5.52A5.381 5.381 0 0 0 19.712.133m0 14.365H5.376A5.381 5.381 0 0 0 0 19.884a5.381 5.381 0 0 0 5.376 5.387h14.336a5.381 5.381 0 0 0 5.376-5.387 5.381 5.381 0 0 0-5.376-5.386"],["#2EB67D","M53.76 19.884a5.381 5.381 0 0 0-5.376-5.386 5.381 5.381 0 0 0-5.376 5.386v5.387h5.376a5.381 5.381 0 0 0 5.376-5.387m-14.336 0V5.52A5.381 5.381 0 0 0 34.048.133a5.381 5.381 0 0 0-5.376 5.387v14.364a5.381 5.381 0 0 0 5.376 5.387 5.381 5.381 0 0 0 5.376-5.387"],["#ECB22E","M34.048 54a5.381 5.381 0 0 0 5.376-5.387 5.381 5.381 0 0 0-5.376-5.386h-5.376v5.386A5.381 5.381 0 0 0 34.048 54m0-14.365h14.336a5.381 5.381 0 0 0 5.376-5.386 5.381 5.381 0 0 0-5.376-5.387H34.048a5.381 5.381 0 0 0-5.376 5.387 5.381 5.381 0 0 0 5.376 5.386"],["#E01E5A","M0 34.249a5.381 5.381 0 0 0 5.376 5.386 5.381 5.381 0 0 0 5.376-5.386v-5.387H5.376A5.381 5.381 0 0 0 0 34.25m14.336-.001v14.364A5.381 5.381 0 0 0 19.712 54a5.381 5.381 0 0 0 5.376-5.387V34.25a5.381 5.381 0 0 0-5.376-5.387 5.381 5.381 0 0 0-5.376 5.387"]]},"figma":{"vb":"-9.5 0 57 57","parts":[["#1ABCFE","M19 28.5a9.5 9.5 0 1 1 19 0 9.5 9.5 0 0 1-19 0z"],["#0ACF83","M0 47.5A9.5 9.5 0 0 1 9.5 38H19v9.5a9.5 9.5 0 1 1-19 0z"],["#FF7262","M19 0v19h9.5a9.5 9.5 0 1 0 0-19H19z"],["#F24E1E","M0 9.5A9.5 9.5 0 0 0 9.5 19H19V0H9.5A9.5 9.5 0 0 0 0 9.5z"],["#A259FF","M0 28.5A9.5 9.5 0 0 0 9.5 38H19V19H9.5A9.5 9.5 0 0 0 0 28.5z"]]},"notion":{"vb":"0 0 24 24","parts":[[null,"M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z"]]},"github":{"vb":"0 0 24 24","parts":[[null,"M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"]]},"hubspot":{"vb":"0 0 24 24","parts":[["#FF7A59","M18.164 7.93V5.084a2.198 2.198 0 001.267-1.978v-.067A2.2 2.2 0 0017.238.845h-.067a2.2 2.2 0 00-2.193 2.193v.067a2.196 2.196 0 001.252 1.973l.013.006v2.852a6.22 6.22 0 00-2.969 1.31l.012-.01-7.828-6.095A2.497 2.497 0 104.3 4.656l-.012.006 7.697 5.991a6.176 6.176 0 00-1.038 3.446c0 1.343.425 2.588 1.147 3.607l-.013-.02-2.342 2.343a1.968 1.968 0 00-.58-.095h-.002a2.033 2.033 0 102.033 2.033 1.978 1.978 0 00-.1-.595l.005.014 2.317-2.317a6.247 6.247 0 104.782-11.134l-.036-.005zm-.964 9.378a3.206 3.206 0 113.215-3.207v.002a3.206 3.206 0 01-3.207 3.207z"]]},"stripe":{"vb":"0 0 24 24","parts":[["#FFFFFF","M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.594-7.305h.003z","translate(5.4 5.4) scale(.55)"]],"bg":"#635BFF"}};
  var LOGO_ALIAS = { google_drive: "google", google_calendar: "google", gmail: "google", gdrive: "google" };
  function logoKey(s) {
    var k = String(s || "").toLowerCase().replace(/[\s-]+/g, "_");
    if (LOGOS[k]) return k;
    if (LOGO_ALIAS[k]) return LOGO_ALIAS[k];
    var base = k.split("_")[0];
    return LOGOS[base] ? base : "";
  }
  function logoSVG(key) {
    var L = LOGOS[key];
    if (!L) return "";
    return '<svg viewBox="' + L.vb + '" aria-hidden="true">' + (L.bg ? '<rect width="24" height="24" rx="5" fill="' + L.bg + '"/>' : "") +
      L.parts.map(function (pt) {
        return '<path d="' + pt[1] + '" fill="' + (pt[0] || "currentColor") + '"' + (pt[2] ? ' transform="' + pt[2] + '"' : "") + '/>';
      }).join("") + '</svg>';
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function ic(id) { return '<svg class="tx-ic tx-ic-sm" aria-hidden="true"><use href="#i-' + id + '"/></svg>'; }
  function safeId(s) { return String(s).replace(/[^\w-]/g, "_"); }
  function clip(s, n) { s = String(s || "").trim(); return s.length > n ? s.slice(0, n).replace(/\s+\S*$/, "") + "…" : s; }

  /* ── 6.1 PendingRequest ─────────────────────────────────────────────── */
  var METHOD = "item/tool/requestUserInput";

  // flat {questions} or the wire shape {detail: {questions}}; drops questions
  // without an id and options without a label
  function normalize(raw) {
    if (!raw || typeof raw !== "object") return null;
    var d = raw.detail && typeof raw.detail === "object" ? raw.detail : {};
    var list = Array.isArray(d.questions) ? d.questions : Array.isArray(raw.questions) ? raw.questions : [];
    var questions = list.filter(function (q) { return q && q.id != null && String(q.id).trim(); }).map(function (q) {
      var opts = Array.isArray(q.options) ? q.options.filter(function (o) {
        return o && String(o.label == null ? "" : o.label).trim();
      }).map(function (o) {
        return { label: String(o.label).trim(), description: o.description ? String(o.description) : "" };
      }) : null;
      return {
        id: String(q.id).trim(),
        kind: q.kind === "toolApproval" ? "toolApproval" : undefined,
        header: q.header ? String(q.header) : "",
        question: q.question == null ? "" : String(q.question),
        action: q.action ? String(q.action) : "",
        options: opts && opts.length ? opts : null,
        isOther: !!q.isOther,
        isSecret: !!q.isSecret,
        // v2 tool approval fields, when the runtime sends them
        server: q.server ? String(q.server) : "",
        tool: q.tool ? String(q.tool) : "",
        toolTitle: q.toolTitle ? String(q.toolTitle) : "",
        connectorName: q.connectorName ? String(q.connectorName) : "",
        readOnlyHint: typeof q.readOnlyHint === "boolean" ? q.readOnlyHint : null,
        arguments: q.arguments
      };
    });
    return {
      requestId: raw.requestId == null ? "" : String(raw.requestId),
      method: raw.method || METHOD,
      expiresAt: raw.expiresAt || d.expiresAt || "",
      questions: questions,
      plan: raw.plan || d.plan || null
    };
  }
  function forBrowser(r) { return !!(r && r.method === METHOD && r.requestId && r.questions.length); }
  function cardKind(q) {
    if (q.id === "plan_approval") return "plan";
    if (q.kind === "toolApproval" || q.id.indexOf("mcp_tool_call_approval") === 0) return "tool";
    return "clarify";
  }
  function isPlanApproval(req) {
    var r = req && req.questions && req.requestId !== undefined ? req : normalize(req);
    return !!(r && r.questions.length === 1 && r.questions[0].id === "plan_approval");
  }
  function isTool(req) {
    var r = req && req.questions ? req : normalize(req);
    return !!(r && r.questions.some(function (q) { return cardKind(q) === "tool"; }));
  }
  // a copy safe to keep or log: secret answers become a mask
  function redact(req, payload) {
    var out = JSON.parse(JSON.stringify(payload || {}));
    (req.questions || []).forEach(function (q) {
      if (q.isSecret && out.answers && out.answers[q.id]) out.answers[q.id] = { answers: ["••••••"] };
    });
    return out;
  }
  function approvePayload() { return { answers: { plan_approval: { answers: ["Approve"] } } }; }
  function revisePayload(note) { return { answers: { plan_approval: { answers: ["Revise", "user_note: " + note] } } }; }

  // countdown text: "4:59", "1h 05m"; spoken: "4 minutes", "12 seconds"
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

  /* planCard(host, request, { submit(requestId, payload) → Promise,
     onClose(kind, extra) }) → { el, requestId, stop(), destroy(), phase() }
     kind: approve | revise (extra = note) | expired | stopped | gone (extra = status) */
  function planCard(host, req, h) {
    h = h || {};
    var q = req.questions[0] || {};
    var id = "ap-" + (++seq);
    var expires = Date.parse(req.expiresAt || "");
    var st = { phase: "pending", from: "pending", note: "", kind: "", payload: null, err: null, closed: false };
    var el = document.createElement("section");
    el.className = "ap";
    el.setAttribute("aria-labelledby", id + "-title");
    host.textContent = "";
    host.appendChild(el);
    host.hidden = false;
    var timer = null;

    function paint() {
      var ph = st.phase, sending = ph === "submitting", from = sending ? st.from : ph;
      var dis = sending ? " disabled" : "";
      var spin = '<span class="tx-spin ap-spin" aria-hidden="true"></span><span>Sending…</span>';
      el.dataset.state = ph;

      var steps = Array.isArray(req.plan) && req.plan.length && window.TxPlan
        ? '<div class="ap-steps">' + window.TxPlan.stepsHTML(req.plan) + '</div>'
        : '<p class="ap-above">The drafted steps are in the message above.</p>';

      var body = "";
      if (from === "pending") {
        body = '<div class="ap-btns">' +
          '<button type="button" class="tx-btn tx-primary tx-sm ap-approve"' + dis + '>' +
            (sending && st.kind === "approve" ? spin : ic("check") + '<span>Approve plan</span>') + '</button>' +
          '<button type="button" class="tx-btn tx-sm ap-soft ap-revise"' + dis + '>' + ic("pen") + '<span>Revise</span></button>' +
        '</div>';
      } else if (from === "revising") {
        body = '<div class="ap-box">' +
          '<label class="ap-label" for="' + id + '-note">What should change?</label>' +
          '<textarea class="ap-note" id="' + id + '-note" rows="3"' + (sending ? " readonly" : "") + '>' + esc(st.note) + '</textarea>' +
          '<div class="ap-btns">' +
            '<button type="button" class="tx-btn tx-primary tx-sm ap-send"' + (sending || !st.note.trim() ? " disabled" : "") + '>' +
              (sending ? spin : '<span>Send feedback</span>') + '</button>' +
            '<button type="button" class="tx-btn tx-ghost tx-sm ap-cancel"' + dis + '>Cancel</button>' +
            '<span class="ap-hint" aria-hidden="true"><span class="tx-kbd">' + (MAC ? "⌘" : "Ctrl") + '↵</span> send · <span class="tx-kbd">Esc</span> cancel</span>' +
          '</div></div>';
      } else if (ph === "expired") {
        body = '<p class="ap-msg" role="status">' + ic("clock") + '<span>No reply in time. Continuing with the recommended option.</span></p>';
      } else if (ph === "error") {
        var gone = GONE[st.err.status];
        var text = gone || st.err.message || "Couldn’t send your answer. Check your connection and try again.";
        body = '<div class="ap-error" role="alert">' +
          '<p class="ap-err">' + ic("alert") + '<span>' + esc(text) + '</span></p>' +
          '<div class="ap-btns">' +
            (gone ? '<button type="button" class="tx-btn tx-sm ap-dismiss">Dismiss</button>'
              : '<button type="button" class="tx-btn tx-primary tx-sm ap-retry">' + ic("retry") + '<span>Try again</span></button>' +
                '<button type="button" class="tx-btn tx-ghost tx-sm ap-back">Back</button>') +
            '<span class="tx-chip tx-chip-ref ap-ref">Ref ' + esc(req.requestId || "–") + (st.err.status ? " · " + esc(st.err.status) : "") + '</span>' +
          '</div></div>';
      }

      el.innerHTML =
        '<header class="ap-head">' +
          '<span class="ap-ic" aria-hidden="true">' + ic("check") + '</span>' +
          '<b class="ap-title" id="' + id + '-title">' + esc((q.header || "Plan") + " ready for review") + '</b>' +
          (isNaN(expires) ? "" : '<span class="ap-time" role="timer">' + ic("clock") + '<span class="ap-left num"></span></span>') +
        '</header>' +
        (q.question ? '<p class="ap-q">' + esc(q.question) + '</p>' : "") +
        steps + body;
      tick();
    }

    // LiveDuration, trend -1: counts down to expiresAt, warns in the last minute
    function tick() {
      if (st.closed || isNaN(expires)) return;
      var ms = expires - Date.now();
      var t = el.querySelector(".ap-time");
      if (t) {
        t.querySelector(".ap-left").textContent = left(ms);
        t.classList.toggle("is-warn", ms <= 60000);
        var say = ms > 0 ? "Expires in " + spoken(ms) : "Expired";
        if (t.getAttribute("aria-label") !== say) t.setAttribute("aria-label", say);
        t.title = "Expires at " + new Date(expires).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      }
      if (ms <= 0 && (st.phase === "pending" || st.phase === "revising" || st.phase === "error")) expire();
    }

    // the recommended option is Approve; the runtime continues on its own
    function expire() {
      st.phase = "expired";
      clearInterval(timer);
      paint();
      setTimeout(function () { close("expired"); }, 2200);
    }

    function close(kind, extra) {
      if (st.closed) return;
      st.closed = true;
      clearInterval(timer);
      host.textContent = "";
      host.hidden = true;
      if (h.onClose) h.onClose(kind, extra);
    }

    function send(kind, payload) {
      if (st.phase !== "error") st.from = st.phase;
      st.kind = kind;
      st.payload = payload;
      st.phase = "submitting";
      paint();
      var p;
      try { p = Promise.resolve(h.submit ? h.submit(req.requestId, payload) : null); }
      catch (err) { p = Promise.reject(err); }
      p.then(function () {
        if (!st.closed) close(kind, kind === "revise" ? st.note.trim() : "");
      }, function (err) {
        if (st.closed) return;
        st.err = { status: err && err.status, message: err && err.message };
        st.phase = "error";
        paint();
        var f = el.querySelector(".ap-error button");
        if (f) f.focus();
      });
    }

    function sendNote() {
      var n = st.note.trim();
      if (n && st.phase === "revising") send("revise", revisePayload(n));
    }
    function cancel() {
      st.phase = "pending";
      paint();
      var r = el.querySelector(".ap-revise");
      if (r) r.focus();
    }
    function focusNote() {
      var t = el.querySelector(".ap-note");
      if (!t) return;
      t.focus();
      t.setSelectionRange(t.value.length, t.value.length);
    }

    el.addEventListener("click", function (e) {
      var b = e.target.closest("button");
      if (!b || b.disabled || st.closed) return;
      if (b.classList.contains("ap-approve")) send("approve", approvePayload());
      else if (b.classList.contains("ap-revise")) { st.phase = "revising"; paint(); focusNote(); }
      else if (b.classList.contains("ap-send")) sendNote();
      else if (b.classList.contains("ap-cancel")) cancel();
      else if (b.classList.contains("ap-retry")) send(st.kind, st.payload);
      else if (b.classList.contains("ap-back")) { st.phase = st.from; paint(); if (st.phase === "revising") focusNote(); else { var a = el.querySelector(".ap-approve"); if (a) a.focus(); } }
      else if (b.classList.contains("ap-dismiss")) close("gone", st.err.status);
    });
    el.addEventListener("input", function (e) {
      if (!e.target.classList.contains("ap-note")) return;
      st.note = e.target.value;
      var s = el.querySelector(".ap-send");
      if (s) s.disabled = !st.note.trim();
    });
    el.addEventListener("keydown", function (e) {
      if (st.phase !== "revising" || !e.target.classList || !e.target.classList.contains("ap-note")) return;
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendNote(); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancel(); }
    });

    timer = setInterval(tick, 500);
    paint();

    return {
      el: el,
      requestId: req.requestId,
      phase: function () { return st.phase; },
      // the user pressed Stop
      stop: function () { close("stopped"); },
      // gone without a record (a new conversation)
      destroy: function () {
        st.closed = true;
        clearInterval(timer);
        if (el.parentNode === host) { host.textContent = ""; host.hidden = true; }
      }
    };
  }

  /* 6.2 QuestionCard · requestCard(host, request, { submit(requestId,
     payload) → Promise, onClose(kind, info) }) → { el, requestId, stop(),
     destroy(), phase() }. Also hosts tool approvals until 6.3.
     Anatomy: icon + title (header || "Your input is needed") + "{n} of {m}" +
     countdown → question → option toggles → "Something else…" / "Type your
     own answer" (password if isSecret) → Back · Next / Send answer.
     one-click: a single clarification with options sends on click.
     missing answer: an alert, focus on the first unanswered question.
     kind: answer (info = summary, secrets masked) | expired (info.secret) |
     stopped | gone (info = status).
     Payload: {answers: {<questionId>: {answers: ["<text>"]}}} */
  function requestCard(host, req, h) {
    h = h || {};
    var qs = req.questions, m = qs.length;
    var id = "aq-" + (++seq);
    var expires = Date.parse(req.expiresAt || "");
    var tool = isTool(req);
    var secret = !tool && qs.some(function (q) { return q.isSecret; });
    var oneClick = !tool && m === 1 && !!qs[0].options;
    var st = { i: 0, phase: "pending", vals: {}, miss: -1, err: null, closed: false, payload: null };
    var el = document.createElement("section");
    el.className = "ap aq" + (tool ? " is-tool" : "") + (oneClick ? " is-one" : "");
    el.setAttribute("aria-labelledby", id + "-title");
    host.textContent = "";
    host.appendChild(el);
    host.hidden = false;
    var timer = null;
    var spin = '<span class="tx-spin ap-spin" aria-hidden="true"></span><span>Sending…</span>';

    function val(q) { return st.vals[q.id] || (st.vals[q.id] = { pick: "", text: "" }); }
    // pick is an option index, or "other"
    function answerOf(q) {
      var v = val(q);
      if (q.options && v.pick !== "other") return v.pick !== "" ? q.options[Number(v.pick)].label : "";
      return v.text.trim();
    }
    function ready(q) { return !!answerOf(q); }
    function firstMissing() { for (var k = 0; k < m; k++) if (!ready(qs[k])) return k; return -1; }
    function missText(q) {
      return q.options ? (q.isOther ? "Choose an option or type your own answer." : "Choose an option to continue.") : "Type your answer to continue.";
    }

    function toggle(q, key, label, desc, on, dis) {
      var other = key === "other";
      // one-click options are actions; everything else is a pressed/unpressed toggle
      if (oneClick && !other) {
        return '<button type="button" class="aq-opt is-go" data-key="' + key + '"' + dis + '>' +
          '<span class="aq-opt-text"><b>' + esc(label) + '</b>' + (desc ? '<small>' + esc(desc) + '</small>' : "") + '</span>' +
          '<span class="aq-go" aria-hidden="true">' + ic("chev") + '</span></button>';
      }
      return '<button type="button" class="aq-opt' + (other ? " is-other" : "") + '" data-key="' + key + '" aria-pressed="' + on + '"' + dis + '>' +
        '<span class="aq-tick" aria-hidden="true">' + ic("check") + '</span>' +
        '<span class="aq-opt-text"><b>' + esc(label) + '</b>' + (desc ? '<small>' + esc(desc) + '</small>' : "") + '</span></button>';
    }

    function field(q, sending) {
      var v = val(q), dis = sending ? " disabled" : "", ro = sending ? " readonly" : "";
      var miss = st.miss === st.i, errId = id + "-miss";
      var invalid = miss ? ' aria-invalid="true" aria-describedby="' + errId + '"' : "";
      var input = function (label) {
        return '<input class="aq-text" id="' + id + '-in" type="' + (q.isSecret ? "password" : "text") + '" autocomplete="off" spellcheck="false"' +
          (label ? ' aria-label="' + label + '"' : ' aria-labelledby="' + id + '-q"') +
          ' placeholder="Type your own answer" value="' + esc(v.text) + '"' + ro + invalid + '>';
      };
      var out = "";
      if (q.action) out += '<div class="aq-action"><span class="aq-k">Will run</span><code>' + esc(q.action) + '</code></div>';
      if (q.options) {
        out += '<div class="aq-opts' + (miss && v.pick !== "other" ? " is-miss" : "") + '" role="group" aria-labelledby="' + id + '-q"' + (miss && v.pick !== "other" ? ' aria-describedby="' + errId + '"' : "") + '>' +
          q.options.map(function (o, oi) { return toggle(q, String(oi), o.label, o.description, v.pick === String(oi), dis); }).join("") +
          (q.isOther ? toggle(q, "other", "Something else…", "", v.pick === "other", dis) : "") +
        '</div>';
        if (q.isOther && v.pick === "other") out += input("Something else: your own answer");
      } else {
        out += input("");
      }
      if (q.isSecret) out += '<p class="aq-note">' + ic("lock") + '<span>Sent to the agent only. It won’t appear in the conversation.</span></p>';
      if (miss) out += '<p class="aq-miss" id="' + errId + '" role="alert">' + ic("alert") + '<span>' + missText(q) + '</span></p>';
      return out;
    }

    function paint(focus) {
      var q = qs[st.i], ph = st.phase, sending = ph === "submitting";
      var lastQ = st.i === m - 1, v = val(q);
      el.dataset.state = ph;
      var body = "";
      if (ph === "pending" || sending) {
        var showSend = !oneClick || v.pick === "other";
        var foot = (st.i > 0 ? '<button type="button" class="tx-btn tx-ghost tx-sm aq-back"' + (sending ? " disabled" : "") + '>Back</button>' : "") +
          (showSend ? '<button type="button" class="tx-btn tx-primary tx-sm aq-next"' + (sending ? " disabled" : "") + '>' +
            (sending ? spin : '<span>' + (lastQ ? "Send answer" : "Next") + '</span>') + '</button>'
            : sending ? '<span class="aq-sending" role="status">' + spin + '</span>' : "");
        body = field(q, sending) + (foot ? '<div class="ap-btns">' + foot + '</div>' : "");
      } else if (ph === "expired") {
        body = '<p class="ap-msg" role="status">' + ic("clock") + '<span>' +
          (tool ? "No reply in time. The tool won’t run."
            : secret ? "This question has expired. Send a message to continue."
            : "Continuing with the recommended option.") + '</span></p>' +
          (secret ? '<div class="ap-btns"><button type="button" class="tx-btn tx-sm aq-dismiss">Dismiss</button></div>' : "");
      } else if (ph === "error") {
        var gone = GONE[st.err.status];
        body = '<div class="ap-error" role="alert">' +
          '<p class="ap-err">' + ic("alert") + '<span>' + esc(gone ? gone.replace("This plan was", "This was") : st.err.message || "Couldn’t send your answer. Check your connection and try again.") + '</span></p>' +
          '<div class="ap-btns">' +
            (gone ? '<button type="button" class="tx-btn tx-sm ap-dismiss">Dismiss</button>'
              : '<button type="button" class="tx-btn tx-primary tx-sm ap-retry">' + ic("retry") + '<span>Try again</span></button>' +
                '<button type="button" class="tx-btn tx-ghost tx-sm ap-back">Back</button>') +
            '<span class="tx-chip tx-chip-ref ap-ref">Ref ' + esc(req.requestId || "–") + (st.err.status ? " · " + esc(st.err.status) : "") + '</span>' +
          '</div></div>';
      }
      el.innerHTML =
        '<header class="ap-head">' +
          '<span class="ap-ic" aria-hidden="true">' + ic(tool ? "shield" : "help") + '</span>' +
          '<b class="ap-title" id="' + id + '-title">' + esc(q.header || (tool ? "Allow this tool?" : "Your input is needed")) + '</b>' +
          (m > 1 ? '<span class="aq-step num">' + (st.i + 1) + " of " + m + '</span>' : "") +
          (isNaN(expires) ? "" : '<span class="ap-time" role="timer">' + ic("clock") + '<span class="ap-left num"></span></span>') +
        '</header>' +
        '<p class="ap-q" id="' + id + '-q">' + (m > 1 ? '<span class="tx-sr">Question ' + (st.i + 1) + " of " + m + ': </span>' : "") + esc(q.question) + '</p>' +
        body;
      tick();
      if (focus) focusField(focus);
    }

    // a selector, or true for the question's first control
    function focusField(which) {
      var t = typeof which === "string" ? el.querySelector(which) : null;
      if (!t) {
        var v = val(qs[st.i]);
        t = v.pick === "other" ? el.querySelector(".aq-text")
          : el.querySelector('.aq-opt[aria-pressed="true"]') || el.querySelector(".aq-opt, .aq-text");
      }
      if (!t) return;
      t.focus();
      if (t.classList.contains("aq-text") && t.type !== "password") t.setSelectionRange(t.value.length, t.value.length);
    }

    // an answer arrived for the flagged question: take the alert down in place
    function clearMiss() {
      if (st.miss !== st.i || !ready(qs[st.i])) return;
      st.miss = -1;
      var n = el.querySelector(".aq-miss");
      if (n) n.remove();
      Array.prototype.forEach.call(el.querySelectorAll("[aria-invalid], .aq-opts[aria-describedby]"), function (x) {
        x.removeAttribute("aria-invalid");
        x.removeAttribute("aria-describedby");
        x.classList.remove("is-miss");
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
      if (ms <= 0 && (st.phase === "pending" || st.phase === "error")) expire();
    }

    // a secret can't take the recommended option: it waits for a new message
    function expire() {
      st.phase = "expired";
      st.vals = {};
      clearInterval(timer);
      paint();
      if (secret) { var d = el.querySelector(".aq-dismiss"); if (d && el.contains(document.activeElement)) d.focus(); return; }
      setTimeout(function () { close("expired", { secret: false }); }, 2200);
    }

    // one line per question; secrets never leave as text
    function summary() {
      return qs.map(function (q) {
        var a = q.isSecret ? "••••••" : answerOf(q);
        return (m > 1 && q.header ? q.header + ": " : "") + a;
      }).join(" · ");
    }

    function close(kind, info) {
      if (st.closed) return;
      st.closed = true;
      clearInterval(timer);
      st.vals = {};
      st.payload = null;
      host.textContent = "";
      host.hidden = true;
      if (h.onClose) h.onClose(kind, info);
    }

    function send() {
      st.phase = "submitting";
      paint();
      var p;
      try { p = Promise.resolve(h.submit ? h.submit(req.requestId, st.payload) : null); }
      catch (err) { p = Promise.reject(err); }
      p.then(function () {
        if (!st.closed) close("answer", {
          summary: summary(),
          items: qs.map(function (q) { return { answer: q.isSecret ? (answerOf(q) ? "hidden" : "") : answerOf(q) }; })
        });
      }, function (err) {
        if (st.closed) return;
        st.err = { status: err && err.status, message: err && err.message };
        st.phase = "error";
        paint();
        var f = el.querySelector(".ap-error button");
        if (f) f.focus();
      });
    }

    function flag(at) {
      st.i = at;
      st.miss = at;
      paint(true);
    }

    function advance() {
      if (st.phase !== "pending") return;
      if (!ready(qs[st.i])) { flag(st.i); return; }
      st.miss = -1;
      if (st.i < m - 1) { st.i++; paint(true); return; }
      var k = firstMissing();
      if (k > -1) { flag(k); return; }
      var answers = {};
      qs.forEach(function (q) { answers[q.id] = { answers: [answerOf(q)] }; });
      st.payload = { answers: answers };
      send();
    }

    el.addEventListener("click", function (e) {
      var b = e.target.closest("button");
      if (!b || b.disabled || st.closed) return;
      if (b.classList.contains("aq-opt")) {
        if (st.phase !== "pending") return;
        var q = qs[st.i], v = val(q), key = b.dataset.key;
        if (oneClick && key !== "other") { v.pick = key; advance(); return; }
        v.pick = v.pick === key ? "" : key;
        clearMiss();
        paint(v.pick === "other" ? ".aq-text" : '.aq-opt[data-key="' + key + '"]');
      }
      else if (b.classList.contains("aq-next")) advance();
      else if (b.classList.contains("aq-back")) { st.miss = -1; st.i--; paint(true); }
      else if (b.classList.contains("ap-retry")) send();
      else if (b.classList.contains("ap-back")) { st.phase = "pending"; paint(true); }
      else if (b.classList.contains("ap-dismiss")) close("gone", st.err.status);
      else if (b.classList.contains("aq-dismiss")) close("expired", { secret: true });
    });
    el.addEventListener("input", function (e) {
      if (!e.target.classList.contains("aq-text")) return;
      val(qs[st.i]).text = e.target.value;
      clearMiss();
    });
    el.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && st.phase === "pending" && e.target.classList && e.target.classList.contains("aq-text")) {
        e.preventDefault();
        advance();
      }
    });

    timer = setInterval(tick, 500);
    paint();

    return {
      el: el,
      requestId: req.requestId,
      phase: function () { return st.phase; },
      // Stop, or a new message: an expired secret closes as expired
      stop: function () { if (st.phase === "expired") close("expired", { secret: secret }); else close("stopped"); },
      destroy: function () {
        st.closed = true;
        st.vals = {};
        clearInterval(timer);
        if (el.parentNode === host) { host.textContent = ""; host.hidden = true; }
      }
    };
  }

  /* ── 6.3 ToolApprovalCard ───────────────────────────────────────────── */
  // runtime option → button; the runtime's own label is what goes back
  var DECIDE = [
    { re: /^allow(?: once)?$/i, label: "Allow once", style: "tx-primary", decision: "allowedOnce" },
    { re: /^allow (?:for|in) this (?:session|chat)/i, label: "Allow for this chat", style: "ap-soft", decision: "allowedChat" },
    { re: /^(?:allow and don.?t ask|always allow)/i, label: "Always allow", style: "ap-soft", decision: "allowedAlways" },
    { re: /^(?:cancel|decline|deny|don.?t allow)$/i, label: "Don’t allow", style: "tx-ghost", decision: "declined" }
  ];
  var RUNTIME_OPTIONS = ["Allow", "Allow for this session", "Allow and don't ask me again", "Cancel"];
  function decisions(q) {
    var labels = q.options && q.options.length ? q.options.map(function (o) { return o.label; }) : RUNTIME_OPTIONS;
    return labels.map(function (lab) {
      var d = DECIDE.filter(function (x) { return x.re.test(lab.trim()); })[0];
      if (!d) return { value: lab, label: lab, style: "ap-soft", decision: "toolAnswered" };
      // a session-scoped runtime records session; a chat-scoped one, chat
      var dec = d.decision === "allowedChat" && /session/i.test(lab) ? "allowedSession" : d.decision;
      return { value: lab, label: d.label, style: d.style, decision: dec };
    });
  }

  // connector, tool title and logo · from the v2 fields, else from the action
  // text (Allow hubspot to run tool "update_deal")
  function toolMeta(q) {
    var m = String(q.action || "").match(/allow\s+(\S+)\s+to\s+run\s+tool\s+["“']([^"”']+)["”']/i);
    var server = q.server || (m ? m[1] : ""), tool = q.tool || (m ? m[2] : "");
    var A = window.TxActivity;
    var full = A && A.name
      ? A.name({ type: server ? "mcpToolCall" : "dynamicToolCall", server: server, tool: tool || "tool", toolTitle: q.toolTitle, connectorName: q.connectorName })
      : q.toolTitle || tool || "Tool";
    var cut = full.indexOf(" · ");
    var connector = cut > -1 ? full.slice(0, cut) : (q.connectorName || "");
    var title = cut > -1 ? full.slice(cut + 3) : full;
    return { server: server, tool: tool, connector: connector, title: title, name: connector ? connector + " · " + title : title, logo: logoKey(server || connector) };
  }
  function toolName(q) { return toolMeta(q).name; }

  // arguments pass through the activity masks: paths, URLs, emails
  function maskArgs(v) {
    var mk = window.TxActivity && window.TxActivity.mask;
    if (!mk) return v;
    if (typeof v === "string") return mk(v);
    if (Array.isArray(v)) return v.map(maskArgs);
    if (v && typeof v === "object") { var o = {}; Object.keys(v).forEach(function (k) { o[k] = maskArgs(v[k]); }); return o; }
    return v;
  }

  /* toolCard(host, request, { submit(requestId, payload) → Promise,
     onClose(kind, info) }) → { el, requestId, stop(), destroy(), phase() }
     kind: answer (info = {decision, label, value}) | expired (declined) |
     stopped | gone (info = status).
     Payload: {answers: {<questionId>: {answers: ["<runtime option>"]}}} */
  function toolCard(host, req, h) {
    h = h || {};
    var q = req.questions[0];
    var id = "at-" + (++seq);
    var expires = Date.parse(req.expiresAt || "");
    var meta = toolMeta(q);
    var opts = decisions(q);
    var st = { phase: "pending", pick: -1, err: null, closed: false };
    var args = q.arguments != null && !(typeof q.arguments === "object" && !Object.keys(q.arguments).length)
      ? JSON.stringify(maskArgs(q.arguments), null, 2) : "";
    var badge = q.readOnlyHint === true ? '<span class="at-badge is-read">Read-only</span>'
      : q.readOnlyHint === false ? '<span class="at-badge is-write">Write</span>' : "";
    var logo = meta.logo
      ? '<span class="at-logo" aria-hidden="true">' + logoSVG(meta.logo) + '</span>'
      : '<span class="at-logo is-letter" aria-hidden="true">' + esc((meta.connector || meta.title || "?").charAt(0).toUpperCase()) + '</span>';
    var spin = '<span class="tx-spin ap-spin" aria-hidden="true"></span><span>Sending…</span>';

    var el = document.createElement("section");
    el.className = "ap at";
    el.setAttribute("aria-labelledby", id + "-title");
    // the head, tool and arguments render once, so an open disclosure stays open
    el.innerHTML =
      '<header class="ap-head">' +
        '<span class="ap-ic" aria-hidden="true">' + ic("shield") + '</span>' +
        '<b class="ap-title" id="' + id + '-title">Permission needed</b>' +
        (isNaN(expires) ? "" : '<span class="ap-time" role="timer">' + ic("clock") + '<span class="ap-left num"></span></span>') +
      '</header>' +
      '<div class="at-tool">' + logo +
        '<span class="at-id"><b>' + esc(meta.title) + '</b>' + (meta.connector ? '<small>' + esc(meta.connector) + '</small>' : "") + '</span>' + badge +
      '</div>' +
      (q.action ? '<div class="aq-action"><span class="aq-k">Action</span><code>' + esc(q.action) + '</code></div>' : "") +
      (q.question && q.question !== q.action ? '<p class="ap-q">' + esc(q.question) + '</p>' : "") +
      (args ? '<details class="at-args"><summary>' + ic("chev") + '<span>Arguments</span></summary><pre class="at-pre">' + esc(args) + '</pre></details>' : "") +
      '<div class="at-body"></div>';
    host.textContent = "";
    host.appendChild(el);
    host.hidden = false;
    var bodyEl = el.querySelector(".at-body");
    var timer = null;

    function paint() {
      var ph = st.phase, sending = ph === "submitting";
      el.dataset.state = ph;
      var body = "";
      if (ph === "pending" || sending) {
        body = '<div class="ap-btns at-btns" role="group" aria-label="Your decision">' + opts.map(function (o, i) {
          return '<button type="button" class="tx-btn tx-sm ' + o.style + ' at-opt" data-i="' + i + '"' + (sending ? " disabled" : "") + '>' +
            (sending && st.pick === i ? spin : '<span>' + esc(o.label) + '</span>') + '</button>';
        }).join("") + '</div>';
      } else if (ph === "expired") {
        body = '<p class="ap-msg" role="status">' + ic("clock") + '<span>This question has expired. Send a message to continue.</span></p>' +
          '<div class="ap-btns"><button type="button" class="tx-btn tx-sm at-dismiss">Dismiss</button></div>';
      } else if (ph === "error") {
        var gone = GONE[st.err.status];
        body = '<div class="ap-error" role="alert">' +
          '<p class="ap-err">' + ic("alert") + '<span>' + esc(gone ? gone.replace("This plan was", "This was") : st.err.message || "Couldn’t send your answer. Check your connection and try again.") + '</span></p>' +
          '<div class="ap-btns">' +
            (gone ? '<button type="button" class="tx-btn tx-sm ap-dismiss">Dismiss</button>'
              : '<button type="button" class="tx-btn tx-primary tx-sm ap-retry">' + ic("retry") + '<span>Try again</span></button>' +
                '<button type="button" class="tx-btn tx-ghost tx-sm ap-back">Back</button>') +
            '<span class="tx-chip tx-chip-ref ap-ref">Ref ' + esc(req.requestId || "–") + (st.err.status ? " · " + esc(st.err.status) : "") + '</span>' +
          '</div></div>';
      }
      bodyEl.innerHTML = body;
      tick();
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
      if (ms <= 0 && (st.phase === "pending" || st.phase === "error")) expire();
    }

    // never auto-allowed: the tool is declined and the card waits
    function expire() {
      var had = el.contains(document.activeElement);
      st.phase = "expired";
      clearInterval(timer);
      paint();
      var d = el.querySelector(".at-dismiss");
      if (d && had) d.focus();
    }

    function close(kind, info) {
      if (st.closed) return;
      st.closed = true;
      clearInterval(timer);
      host.textContent = "";
      host.hidden = true;
      if (h.onClose) h.onClose(kind, info);
    }

    function send(i) {
      var o = opts[i];
      if (!o) return;
      st.pick = i;
      st.phase = "submitting";
      paint();
      var payload = { answers: {} };
      payload.answers[q.id] = { answers: [o.value] };
      var p;
      try { p = Promise.resolve(h.submit ? h.submit(req.requestId, payload) : null); }
      catch (err) { p = Promise.reject(err); }
      p.then(function () {
        if (!st.closed) close("answer", { decision: o.decision, label: o.label, value: o.value });
      }, function (err) {
        if (st.closed) return;
        st.err = { status: err && err.status, message: err && err.message };
        st.phase = "error";
        paint();
        var f = el.querySelector(".ap-error button");
        if (f) f.focus();
      });
    }

    el.addEventListener("click", function (e) {
      var b = e.target.closest("button");
      if (!b || b.disabled || st.closed) return;
      if (b.classList.contains("at-opt") && st.phase === "pending") send(Number(b.dataset.i));
      else if (b.classList.contains("ap-retry")) send(st.pick);
      else if (b.classList.contains("ap-back")) { st.phase = "pending"; paint(); var f = el.querySelector(".at-opt"); if (f) f.focus(); }
      else if (b.classList.contains("ap-dismiss")) close("gone", st.err.status);
      else if (b.classList.contains("at-dismiss")) close("expired", { declined: true });
    });

    timer = setInterval(tick, 500);
    paint();

    return {
      el: el,
      requestId: req.requestId,
      phase: function () { return st.phase; },
      // Stop, or a new message: an expired card closes as expired (declined)
      stop: function () { if (st.phase === "expired") close("expired", { declined: true }); else close("stopped"); },
      destroy: function () {
        st.closed = true;
        clearInterval(timer);
        if (el.parentNode === host) { host.textContent = ""; host.hidden = true; }
      }
    };
  }

  // ApprovalRecord · what was answered, left in the stream
  /* 6.5 ApprovalRecord · the audit line left in the chat.
     record(host, { requestId, at, turnId, outcome, autoMode?, items[] })
       outcome   answered "You answered" | auto | expired / interrupted "Closed"
       autoMode  readOnly "Auto-allowed (read-only)" | auto "Auto-accepted
                 (Autopilot)" | grant "Allowed for this chat"
       items[]   {kind: "toolApproval", title, decision}
                 {kind: "question", question, answer?, secret?, by?: autopilot | timeout}
     Group "Your decision": a toned dot + title + badge, or question + answer,
     then "{summary} at {h:mm}". A secret answer never reaches the record. */
  var OUTCOMES = { answered: 1, auto: 1, expired: 1, interrupted: 1 };
  var AUTO_MODE = { readOnly: "Auto-allowed (read-only)", auto: "Auto-accepted (Autopilot)", grant: "Allowed for this chat" };
  var DECISION = {
    allowedOnce: ["Allowed once", "allowed"],
    allowedSession: ["Allowed for this chat", "allowed"],
    allowedChat: ["Allowed for this chat", "allowed"],
    allowedAlways: ["Always allowed", "allowed"],
    declined: ["Not allowed", "declined"],
    expired: ["No answer — timed out", "muted"],
    interrupted: ["No answer — stopped", "muted"]
  };
  function atOf(at) {
    var d = at instanceof Date ? at : new Date(at || Date.now());
    return isNaN(d) ? new Date() : d;
  }
  // h:mm in the reader's own clock (11:32 PM, or 23:32)
  function atText(d) {
    try { return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }
    catch (e) { return d.getHours() + ":" + String(d.getMinutes()).padStart(2, "0"); }
  }
  function answerText(it) {
    if (!it.answer) return it.by === "timeout" ? "Chosen automatically, no reply in time" : "No answer";
    if (it.secret) return "Answer hidden";
    return it.answer + (it.by === "autopilot" ? " (chosen by Autopilot)" : it.by === "timeout" ? " (chosen automatically, no reply in time)" : "");
  }

  function record(host, r) {
    r = r || {};
    var outcome = OUTCOMES[r.outcome] ? r.outcome : "answered";
    var summary = outcome === "auto" ? AUTO_MODE[r.autoMode] || AUTO_MODE.readOnly
      : outcome === "answered" ? "You answered" : "Closed";
    var d = atOf(r.at), at = atText(d);
    var tone = "", say = [];
    var rows = (r.items || []).filter(Boolean).map(function (it) {
      if (it.kind === "toolApproval") {
        // an option the card doesn't know keeps its own label, muted
        var key = DECISION[it.decision] ? it.decision
          : outcome === "answered" && it.label ? "other"
          : outcome === "interrupted" ? "interrupted" : "expired";
        var D = key === "other" ? [it.label, "muted"] : DECISION[key];
        // the record takes its tone from the first decision that isn't muted
        if (!tone || tone === "muted") tone = D[1];
        say.push((it.title || "Tool") + ", " + D[0]);
        return '<li class="ar-item ar-tool" data-tone="' + D[1] + '" data-decision="' + key + '">' +
          '<span class="ar-dot" aria-hidden="true"></span>' +
          '<span class="ar-title">' + esc(it.title || "Tool") + '</span>' +
          '<span class="ar-badge">' + esc(D[0]) + '</span></li>';
      }
      var ans = answerText(it), dim = !it.answer || !!it.secret;
      // "Who is this for? Board" · "Paste a token: Answer hidden"
      var qt = String(it.question || "").trim();
      say.push((qt ? (/\?$/.test(qt) ? qt + " " : qt.replace(/[.:]+$/, "") + ": ") : "") + ans);
      return '<li class="ar-item ar-qa">' +
        '<span class="ar-q">' + esc(clip(it.question || "Question", 140)) + '</span>' +
        '<span class="ar-a' + (dim ? " is-dim" : "") + '">' + esc(clip(ans, 180)) + '</span></li>';
    }).join("");

    var el = document.createElement("div");
    el.className = "ar";
    el.dataset.outcome = outcome;
    el.dataset.tone = tone || "muted";
    if (r.autoMode) el.dataset.auto = r.autoMode;
    if (r.turnId != null) el.dataset.turn = r.turnId;
    el.setAttribute("role", "group");
    el.setAttribute("aria-label", "Your decision");
    if (r.requestId) el.id = "approval-" + safeId(r.requestId);
    el.innerHTML =
      '<span class="ar-k" aria-hidden="true">Your decision</span>' +
      '<ul class="ar-items" role="list">' + rows + '</ul>' +
      '<p class="ar-foot">' + esc(summary) + ' at <time datetime="' + d.toISOString() + '">' + esc(at) + '</time></p>';
    // one sentence for the live region
    el.dataset.say = "Your decision. " + say.join(". ") + (say.length ? ". " : "") + summary + " at " + at + ".";
    host.appendChild(el);
    return el;
  }

  window.TxApproval = {
    METHOD: METHOD, normalize: normalize, forBrowser: forBrowser, cardKind: cardKind,
    isPlanApproval: isPlanApproval, isTool: isTool, redact: redact,
    planCard: planCard, requestCard: requestCard, toolCard: toolCard, record: record,
    decisions: decisions, toolMeta: toolMeta, toolName: toolName, logoKey: logoKey,
    approvePayload: approvePayload, revisePayload: revisePayload
  };
})();
