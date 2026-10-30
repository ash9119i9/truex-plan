import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { turnErrorOf } from "../lib/turn.ts";
import { component } from "./next-details-runtime.ts";

const { TurnError } = component("tenant/chat-transcript.tsx");

test("a run error maps to the spec's reason, title and action", () => {
  assert.deepEqual(
    turnErrorOf({ code: "RATE_LIMITED", message: "m", retryable: true }),
    {
      title: "Too many requests right now",
      code: "rate_limited",
      action: "retry",
    },
  );
  assert.deepEqual(
    turnErrorOf({ code: "MODEL_TIMEOUT", message: "m", retryable: true }),
    {
      title: "The model service is unavailable",
      code: "provider_unavailable",
      action: "retry",
    },
  );
  assert.deepEqual(
    turnErrorOf({ code: "CONTEXT_FULL", message: "m", retryable: false }),
    {
      title: "This conversation is too long",
      code: "context_length_exceeded",
      action: "new",
    },
  );
  assert.deepEqual(
    turnErrorOf({ code: "THREAD_LOST", message: "m", retryable: false }),
    {
      title: "Something went wrong",
      code: "internal_error",
      action: "new",
    },
  );
  assert.equal(turnErrorOf(null).action, "retry");
});

const render = (props: Record<string, unknown>) =>
  renderToStaticMarkup(
    createElement(TurnError, { runId: "run_7f3a21", ...props }),
  );

test("TurnError says what failed, whether to retry, and shows only masked text", () => {
  const html = render({
    error: {
      code: "PROVIDER_ERROR",
      message: "Upstream https://api.example/v1 said sk-AbCdEf1234567890",
      retryable: true,
    },
    onRetry() {},
  });
  assert.match(html, /<div class="te" role="alert">/);
  assert.match(
    html,
    /#i-alert[\s\S]*class="te-title">The model service is unavailable</,
  );
  assert.match(html, /class="te-body">Upstream ••• said •••</);
  assert.doesNotMatch(html, /api\.example|sk-AbCd/);
  assert.match(
    html,
    /<button type="button" class="tx-btn tx-sm"[^>]*>.*Try again/,
  );
  assert.match(
    html,
    /aria-label="Copy reference run_7f3a21 · provider_unavailable · failed"/,
  );
});

test("a TurnError that can't be retried offers a new chat instead, or nothing", () => {
  const html = render({
    error: { code: "CONTEXT_FULL", message: "Too long.", retryable: false },
    onNewChat() {},
  });
  assert.doesNotMatch(html, /Try again/);
  assert.match(html, />Start a new chat</);
  const quiet = render({ error: { code: "X", message: "m", retryable: true } });
  assert.doesNotMatch(quiet, /Try again|Start a new chat/);
});
