/* plan — Plan mode: the agent's numbered plan, inline in the reply.
   Long tasks call update_plan, then ask plan_approval; the user doesn't
   toggle a mode. (The protocol also carries CollaborationMode.mode.)

   5.1 PlanStep
     step         string · "Pull Q3 pipeline from HubSpot"
     status       pending | inProgress | completed (in_progress also accepted)
   explanation?   on the plan update, shown as the plan intro
   progress       derived · {done, total, current, label: "{done} of {n} done"}

   5.2 PlanSteps · read-only, rebuilt whole from every plan.updated event
   and from snapshots, so the same plan always renders the same list.
     completed   check     Done
     inProgress  spinner   In progress   ← aria-current="step"
     pending     dot       Pending

   States: asking (answered in the PlanApprovalCard, approval.js) → running
   → done; or revise, stopped, or gone when the review closed unanswered. */
(function () {
  "use strict";

  var seq = 0;
  var NORM = { pending: "pending", inprogress: "inProgress", in_progress: "inProgress", "in-progress": "inProgress", completed: "completed" };
  var SAY = { pending: "Pending", inProgress: "In progress", completed: "Done" };
  // the card's line under the steps, by phase · [icon, text, muted]
  var NOTE = {
    asking: ["chev-down", "Waiting for your review. Answer in the card above the message box."],
    revise: ["pen", "Changes sent. The agent is revising the plan."],
    skipped: ["x", "Set aside for your new message. Nothing ran.", true],
    stopped: ["x", "Stopped before it started. Nothing ran.", true],
    halted: ["x", "Stopped by you. Steps marked done finished; the rest didn’t run.", true],
    gone: ["alert", "The review closed before an answer. Nothing ran here.", true],
    answered: ["check", "Answered in another window. This turn follows that answer.", true]
  };
  var TITLE = { done: "Plan complete", revise: "Plan · changes requested", skipped: "Plan · not started", stopped: "Plan · stopped", halted: "Plan · stopped", gone: "Plan · review closed", answered: "Plan · answered elsewhere" };

  function status(s) {
    var k = String(s == null ? "" : s).replace(/\s+/g, "").toLowerCase();
    return NORM[k] || "pending";
  }
  // drop empty steps; keep the order the agent gave
  function normalize(steps) {
    return (Array.isArray(steps) ? steps : []).filter(function (x) {
      return x && String(x.step == null ? "" : x.step).trim();
    }).map(function (x) { return { step: String(x.step).trim(), status: status(x.status) }; });
  }
  // current is the step in progress, else the next pending one; -1 when all done
  function progress(steps) {
    var total = steps.length;
    var done = steps.filter(function (x) { return x.status === "completed"; }).length;
    var current = -1;
    steps.some(function (x, i) { if (x.status === "inProgress") { current = i; return true; } return false; });
    if (current < 0) steps.some(function (x, i) { if (x.status === "pending") { current = i; return true; } return false; });
    return { done: done, total: total, current: current, label: done + " of " + total + " done" };
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function ic(id) { return '<svg class="tx-ic tx-ic-sm" aria-hidden="true"><use href="#i-' + id + '"/></svg>'; }

  // 5.2 · the list alone. Pure: no state, no handlers. The first step in
  // progress carries aria-current="step".
  var MARK = {
    completed: function () { return ic("check"); },
    inProgress: function () { return '<span class="tx-spin pl-spin"></span>'; },
    pending: function () { return '<span class="pl-dot"></span>'; }
  };
  function stepsHTML(raw) {
    var steps = normalize(raw);
    var cur = -1;
    steps.some(function (x, i) { if (x.status === "inProgress") { cur = i; return true; } return false; });
    return '<ol class="pl-steps" role="list">' + steps.map(function (x, i) {
      return '<li class="pl-step" data-status="' + x.status + '"' + (i === cur ? ' aria-current="step"' : "") + '>' +
        '<span class="pl-n num" aria-hidden="true">' + (i + 1) + '</span>' +
        '<span class="pl-mark" aria-hidden="true">' + MARK[x.status]() + '</span>' +
        '<span class="pl-text">' + esc(x.step) + '</span>' +
        '<span class="pl-label">' + SAY[x.status] + '</span>' +
      '</li>';
    }).join("") + '</ol>';
  }
  function steps(host, raw) {
    host.innerHTML = stepsHTML(raw);
    return host.firstChild;
  }

  // a plan.updated event or a snapshot: flat {explanation, plan[]} or nested
  // {plan: {explanation, plan[]}}; returns {explanation?, plan}
  function payload(it) {
    if (!it || typeof it !== "object") return { plan: [] };
    var src = Array.isArray(it.plan) ? it : it.plan && typeof it.plan === "object" ? it.plan : it;
    var out = { plan: Array.isArray(src.plan) ? src.plan : Array.isArray(src.steps) ? src.steps : [] };
    if ("explanation" in src) out.explanation = src.explanation;
    else if ("explanation" in it) out.explanation = it.explanation;
    return out;
  }

  /* render(host, { explanation, plan })
     → { el, update(props), ask(), start(), finish(), settle(kind), get() } */
  function render(host, props) {
    var id = "pl-" + (++seq);
    var el = document.createElement("section");
    el.className = "pl";
    el.setAttribute("aria-labelledby", id + "-title");
    host.textContent = "";
    host.appendChild(el);
    var st = { explanation: "", steps: [], phase: "draft" };

    function paint() {
      var p = progress(st.steps);
      var pct = p.total ? Math.round(p.done / p.total * 100) : 0;
      el.dataset.state = st.phase;
      var title = TITLE[st.phase] || "Plan";
      el.innerHTML =
        '<header class="pl-head">' +
          '<span class="pl-ic" aria-hidden="true">' + ic(st.phase === "done" ? "check" : "list") + '</span>' +
          '<b class="pl-title" id="' + id + '-title">' + title + '</b>' +
          '<span class="pl-prog num">' + (p.total ? p.label : "") + '</span>' +
        '</header>' +
        (p.total ? '<div class="tx-meter ' + (st.phase === "done" ? "tx-meter-ok" : "tx-meter-signal") + ' pl-meter" style="--tx-p:' + pct + '" role="meter" aria-valuemin="0" aria-valuemax="' + p.total + '" aria-valuenow="' + p.done + '" aria-valuetext="' + p.label + '" aria-label="Plan progress"><i></i></div>' : "") +
        (st.explanation ? '<p class="pl-intro">' + esc(st.explanation) + '</p>' : "") +
        stepsHTML(st.steps) +
        (NOTE[st.phase] ? '<p class="pl-note' + (NOTE[st.phase][2] ? " is-muted" : "") + '">' + ic(NOTE[st.phase][0]) + '<span>' + NOTE[st.phase][1] + '</span></p>' : "");
    }

    function update(next) {
      var d = payload(next || {});
      if ("explanation" in d) st.explanation = String(d.explanation || "").trim();
      if (next && ("plan" in next || "steps" in next)) st.steps = normalize(d.plan);
      paint();
    }
    update(props);

    return {
      el: el,
      update: update,
      ask: function () { st.phase = "asking"; paint(); },
      start: function () { st.phase = "running"; paint(); },
      finish: function () { st.phase = "done"; paint(); },
      // revise | skipped | stopped | halted | gone | answered
      settle: function (kind) { st.phase = NOTE[kind] && kind !== "asking" ? kind : "skipped"; paint(); },
      get: function () { return { explanation: st.explanation, plan: st.steps.slice(), phase: st.phase, progress: progress(st.steps) }; }
    };
  }

  window.TxPlan = { render: render, steps: steps, stepsHTML: stepsHTML, payload: payload, normalize: normalize, progress: progress, status: status };
})();
