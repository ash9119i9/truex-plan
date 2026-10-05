// node --experimental-strip-types docs/performance/t3-chat/next-details-ssr.mjs
import { createRequire } from "node:module";
import { component } from "../../../frontend/test/next-details-runtime.ts";
const require = createRequire(
  new URL("../../../frontend/package.json", import.meta.url),
);
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { ThinkingBlock } = component("thinking-block.tsx");
const { SessionActivity } = component("session-activity.tsx");
const render = (Component, props) =>
  renderToStaticMarkup(createElement(Component, props));
const reasoning = "fixture reasoning ".repeat(50000);
const html = render(ThinkingBlock, { text: reasoning });
const event = (status) => ({
  type: "turn.completed",
  seq: 2,
  cursor: "2",
  at: "2026-10-05T00:00:00Z",
  threadId: "fixture",
  turnId: "t",
  data: { turn: { status } },
});
const activityProps = { plan: [], timings: [], goal: null, goalReview: null };
const activity = (status) =>
  render(SessionActivity, { ...activityProps, events: [event(status)] });
const closed = render(SessionActivity, {
  ...activityProps,
  events: [event("failed")],
  open: false,
});
console.log(
  JSON.stringify(
    {
      reasoningChars: reasoning.length,
      closedReasoningMarkupBytes: html.length,
      closedReasoningTextMounted: html.includes(reasoning.trim()),
      failed100Percent: activity("failed").includes("100%"),
      interrupted100Percent: activity("interrupted").includes("100%"),
      closedActivityBodyMounted: closed.includes("Last run:"),
    },
    null,
    2,
  ),
);
