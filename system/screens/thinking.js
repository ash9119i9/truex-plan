/* thinking — the ThinkingBlock: the agent's reasoning, shown before its answer.
   Props follow reasoning.delta (item/reasoning/textDelta or summaryTextDelta):
     text       string | {text}[]   summary parts join as paragraphs
     streaming  bool
   States: streaming → spinner + "Thinking…"; done → check + "Reasoning" +
   "{n} words" (or "Complete"); the chevron collapses and expands the body;
   empty and not streaming → hidden. Deferred on LIVE: the chat feeds it sample
   deltas until the reasoning stream is wired. */
(function () {
  "use strict";

  var seq = 0;

  function toText(text) {
    if (text == null) return "";
    if (Array.isArray(text)) {
      return text.map(function (part) {
        return part && typeof part === "object" ? part.text || "" : String(part);
      }).filter(function (s) { return s.trim(); }).join("\n\n");
    }
    return String(text);
  }

  function countWords(s) {
    var t = s.trim();
    return t ? t.split(/\s+/).length : 0;
  }

  function create(host) {
    var id = "tk-" + (++seq);
    var root = document.createElement("div");
    root.className = "tk";
    root.hidden = true;
    root.innerHTML =
      '<button type="button" class="tk-head" aria-expanded="false" aria-controls="' + id + '">' +
        '<span class="tk-ic" aria-hidden="true"><span class="tx-spin tk-spin"></span><svg class="tx-ic tx-ic-sm tk-check"><use href="#i-check"/></svg></span>' +
        '<span class="tk-label"></span>' +
        '<span class="tk-meta num"></span>' +
        '<svg class="tx-ic tx-ic-sm tk-chev" aria-hidden="true"><use href="#i-chev-down"/></svg>' +
      '</button>' +
      '<div class="tk-body" id="' + id + '"><div class="tk-clip"><div class="tk-text"></div></div></div>';
    host.appendChild(root);

    var head = root.querySelector(".tk-head");
    var label = root.querySelector(".tk-label");
    var meta = root.querySelector(".tk-meta");
    var clip = root.querySelector(".tk-clip");
    var textEl = root.querySelector(".tk-text");
    var state = { text: "", streaming: false, open: false, touched: false };

    function setOpen(open) {
      state.open = open;
      head.setAttribute("aria-expanded", String(open));
      root.classList.toggle("is-open", open);
    }

    // once the reader opens or closes it, the block stops folding itself
    head.addEventListener("click", function () {
      state.touched = true;
      setOpen(!state.open);
    });

    function update(props) {
      props = props || {};
      if ("text" in props) state.text = toText(props.text);
      if ("streaming" in props) state.streaming = !!props.streaming;

      var empty = !state.text.trim();
      var n = countWords(state.text);
      root.hidden = empty && !state.streaming;
      root.dataset.state = state.streaming ? "streaming" : "done";
      label.textContent = state.streaming ? "Thinking…" : "Reasoning";
      label.classList.toggle("tx-shimmer", state.streaming);
      meta.textContent = state.streaming ? "" : n ? n + (n === 1 ? " word" : " words") : "Complete";
      textEl.textContent = state.text;
      head.disabled = empty;

      // open while it streams so the reasoning reads live; fold away once done
      if (!state.touched) setOpen(state.streaming && !empty);

      // the live window follows the newest line and fades what scrolls past
      if (state.streaming) clip.scrollTop = clip.scrollHeight;
      root.classList.toggle("is-overflow", state.streaming && clip.scrollHeight > clip.clientHeight + 1);
    }

    return {
      el: root,
      update: update,
      setOpen: function (open) { state.touched = true; setOpen(!!open); },
      get: function () { return { text: state.text, streaming: state.streaming, open: state.open }; }
    };
  }

  window.TxThinking = { create: create, toText: toText, countWords: countWords };
})();
