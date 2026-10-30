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
  // DESIGN-SPEC 12.6: one lane per helper, state as a glyph and a word.
  assert.match(html, /<section class="hg is-live" aria-label="Helpers">/);
  assert.match(html, /class="hg-title" role="status">Running 3 helpers</);
  assert.match(html, /class="hg-flag">1 failed</);
  const lanes = html.match(/<li class="hg-lane[^"]*"/g) ?? [];
  assert.deepEqual(lanes, [
    '<li class="hg-lane is-running"',
    '<li class="hg-lane is-done"',
    '<li class="hg-lane is-failed"',
  ]);
  // identity colours by first appearance
  assert.match(
    html,
    /class="hg-tile" style="--hg-soft:var\(--id-1-soft\);--hg-ink:var\(--id-1-ink\)"/,
  );
  assert.match(html, /--id-3-soft/);
  assert.match(html, /class="hg-name">Crm deals</);
  assert.match(
    html,
    /class="hg-badge is-running"><span class="tx-spin"[^>]*><\/span>Running</,
  );
  assert.match(html, /class="hg-preview">Reading deals</);
  assert.match(
    html,
    /<details class="hg-result"><summary>Result<\/summary><p>Two threads\.<\/p>/,
  );
  assert.match(html, /class="hg-badge is-failed">.*#i-x.*Failed/);
  assert.match(html, /The helper stopped before finishing\./);
  // a sentence per lane for assistive technology
  assert.match(html, /class="tx-sr">Email: done\.</);
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
      // The helpers choice lives on the desk's Access step (spec 15.3).
      initialStep: "access",
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
