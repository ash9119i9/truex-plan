import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { component } from "./next-details-runtime.ts";

const { HelperGroup } = component("tenant/chat-transcript.tsx");
const { TenantAgentDialog } = component("tenant/tenant-agent-dialog.tsx");

const group = (helpers: unknown[], live = false) =>
  renderToStaticMarkup(createElement(HelperGroup, { helpers, live }));

test("helper cards show status, a live preview and an expandable result", () => {
  const html = group(
    [
      {
        key: "1",
        path: "/root/crm_deals",
        status: "running",
        preview: "Reading deals",
      },
      {
        key: "2",
        path: "/root/email",
        status: "completed",
        result: "Two threads.",
      },
      { key: "3", path: "/root/jira", status: "failed" },
    ],
    true,
  );
  assert.match(html, /Checking with 3 helpers · 2 done/);
  assert.match(html, /role="status"/);
  assert.match(html, />crm deals</);
  assert.match(html, />Reading deals</);
  assert.match(html, /<details class="helper-card">/);
  assert.match(html, />Two threads\.</);
  assert.match(html, /tool-card is-failed/);
  assert.match(html, /· Failed/);
});

test("helper results are plain text and nothing renders without helpers", () => {
  const html = group([
    {
      key: "1",
      path: "/x",
      status: "completed",
      result: "<img src=x onerror=1>",
    },
  ]);
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /role="status"/);
  assert.equal(group([]), "");
});

const dialog = (props: Record<string, unknown>) =>
  renderToStaticMarkup(
    createElement(TenantAgentDialog, {
      open: true,
      editing: null,
      models: [],
      onClose: () => {},
      onSaved: () => {},
      ...props,
    }),
  );

const editing = (helpers: boolean) => ({
  id: "64b7f0c2a1b2c3d4e5f60aa1",
  source: "personal",
  name: "Scout",
  description: "Finds sources.",
  look: 2,
  tint: "ice",
  model: null,
  available: true,
  connectors: [],
  skills: [],
  helpers,
  revision: 1,
  createdByMe: true,
  status: "active",
  canEdit: true,
  canArchive: true,
  canPromote: false,
});

test("the helpers setting shows only where the server allows it", () => {
  assert.doesNotMatch(dialog({}), /Use helper agents/);
  const html = dialog({ helpersAllowed: true });
  assert.match(html, /Use helper agents/);
  assert.doesNotMatch(html, /off in this workspace/);
  // An agent already opted in can still turn it off, with a note.
  const kept = dialog({ editing: editing(true) });
  assert.match(kept, /Use helper agents/);
  assert.match(kept, /off in this workspace/);
});
