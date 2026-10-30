/* error — the TurnError, inline in the reply that failed (today: a page banner).
     reason      rateLimited | quota | credentials | providerDown | contextWindow | other
     code        see 7.6
     message     user-safe copy (7.6); URLs and keys are already removed
     httpStatus? number
     willRetry   bool · shows "Retrying…" instead of failed
     turnId      for the ErrorRef chip
   Actions by reason: contextWindow → Compact conversation (then Try again);
   rateLimited / providerDown / other → Try again; quota / credentials → no
   retry, an admin tip instead. Titles, fallback copy and codes below are
   placeholders until 7.6 is wired. */
(function () {
  "use strict";

  var REASONS = {
    rateLimited: {
      title: "Too many requests right now",
      message: "The model is busier than usual. Give it a moment, then try again.",
      action: "retry", code: "rate_limited"
    },
    quota: {
      title: "Usage limit reached",
      message: "This workspace has used its model allowance for now.",
      action: "admin", code: "quota_exceeded",
      tip: "Ask your workspace admin to raise the limit, or try again after it resets."
    },
    credentials: {
      title: "The model connection needs attention",
      message: "The workspace's model credentials were not accepted.",
      action: "admin", code: "invalid_credentials",
      tip: "Ask your workspace admin to reconnect the model provider in Settings."
    },
    providerDown: {
      title: "The model service is unavailable",
      message: "The provider isn't responding. This is usually brief.",
      action: "retry", code: "provider_unavailable"
    },
    contextWindow: {
      title: "This conversation is too long",
      message: "There's no room left in the model's context for this request.",
      action: "compact", code: "context_length_exceeded"
    },
    other: {
      title: "Something went wrong",
      message: "The reply couldn't be finished.",
      action: "retry", code: "internal_error"
    }
  };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function ic(id) { return '<svg class="tx-ic tx-ic-sm" aria-hidden="true"><use href="#i-' + id + '"/></svg>'; }

  // the message should already be safe; mask URLs and key-like tokens anyway,
  // so the sentence still reads ("failed at ••• with •••")
  function scrub(s) {
    return String(s == null ? "" : s)
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s,;)]+/gi, "•••")
      .replace(/\b(?:sk|pk|rk|api|key|tok)[-_][A-Za-z0-9_-]{8,}\b/gi, "•••")
      .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "•••")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  function reasonOf(r) { return REASONS.hasOwnProperty(r) ? r : "other"; }

  /* render(host, props, { onRetry, onCompact }) → { el, update(props) }
     onCompact returns true once the conversation was compacted */
  function render(host, props, handlers) {
    handlers = handlers || {};
    var el = document.createElement("div");
    el.className = "te";
    host.textContent = "";
    host.appendChild(el);
    host.hidden = false;
    var state = { props: {}, compacted: false };

    el.addEventListener("click", function (e) {
      var b = e.target.closest("button");
      if (!b || !el.contains(b)) return;
      if (b.classList.contains("te-retry") && handlers.onRetry) handlers.onRetry();
      else if (b.classList.contains("te-compact") && handlers.onCompact) {
        if (handlers.onCompact() === true) {
          state.compacted = true;
          paint();
          var next = el.querySelector(".te-retry");
          if (next) next.focus();
        }
      } else if (b.classList.contains("te-ref")) copyRef(b);
    });

    function copyRef(b) {
      var p = state.props;
      var text = [p.turnId, p.code || REASONS[reasonOf(p.reason)].code, p.httpStatus].filter(Boolean).join(" · ");
      var label = b.querySelector(".te-ref-label");
      var done = function () {
        b.classList.add("is-copied");
        label.textContent = "Copied";
        clearTimeout(b._t);
        b._t = setTimeout(function () { b.classList.remove("is-copied"); label.textContent = "Ref " + p.turnId; }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, done);
      else done();
    }

    function paint() {
      var p = state.props;
      var r = reasonOf(p.reason);
      var R = REASONS[r];
      var retrying = !!p.willRetry;
      var msg = scrub(p.message) || R.message;
      var http = p.httpStatus ? String(p.httpStatus) : "";
      var action = state.compacted ? "retry" : R.action;

      el.dataset.reason = r;
      el.dataset.state = retrying ? "retrying" : "failed";
      el.setAttribute("role", retrying ? "status" : "alert");

      var buttons = "";
      if (!retrying) {
        if (action === "retry") buttons = '<button type="button" class="tx-btn tx-sm te-retry">' + ic("retry") + '<span>Try again</span></button>';
        else if (action === "compact") buttons = '<button type="button" class="tx-btn tx-sm te-compact">' + ic("compact") + '<span>Compact conversation</span></button>';
      }
      var ref = p.turnId
        ? '<button type="button" class="tx-chip tx-chip-ref te-ref" aria-label="Copy error reference ' + esc(p.turnId) + '"><span class="te-ref-label">Ref ' + esc(p.turnId) + '</span></button>'
        : "";

      el.innerHTML =
        '<div class="te-head">' +
          '<span class="te-ic" aria-hidden="true">' + (retrying ? '<span class="tx-spin te-spin"></span>' : ic("alert")) + '</span>' +
          '<b class="te-title">' + (retrying ? "Retrying…" : esc(R.title)) + '</b>' +
          (http ? '<span class="te-http num" title="HTTP status">' + esc(http) + '</span>' : "") +
        '</div>' +
        '<p class="te-msg">' + esc(msg) + '</p>' +
        (state.compacted ? '<p class="te-note">' + ic("check") + '<span>Earlier messages were summarised. Try again now.</span></p>' : "") +
        (!retrying && action === "admin" && R.tip ? '<p class="te-tip">' + ic("dock-user") + '<span>' + esc(R.tip) + '</span></p>' : "") +
        (buttons || ref ? '<div class="te-foot">' + buttons + ref + '</div>' : "");
    }

    function update(next) {
      // a fresh error clears the compacted note; a retry flag change keeps it
      if (next && next.reason && next.reason !== state.props.reason) state.compacted = false;
      state.props = next || {};
      paint();
    }
    update(props);
    return { el: el, update: update, get: function () { return state.props; } };
  }

  window.TxError = { render: render, reasons: Object.keys(REASONS), scrub: scrub };
})();
