import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AUTO_SIG,
  BLANK_GUIDE,
  clip,
  deskProblem,
  featuredModels,
  guideSummary,
  withIdea,
} from "../lib/agent-desk.ts";
import { component } from "./next-details-runtime.ts";

const { TenantAgentDialog } = component("tenant/tenant-agent-dialog.tsx");

const model = (id: string, displayName: string) => ({
  id,
  displayName,
  shortLabel: displayName,
  family: "claude",
});
const MODELS = [
  model("h", "Claude Haiku 5.5"),
  model("s", "Claude Sonnet 5.5"),
  model("o", "Claude Opus 5.5"),
  model("g", "Gemini 3"),
];
const desk = (props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(TenantAgentDialog, {
      open: true,
      editing: null,
      models: MODELS,
      onClose() {},
      onSaved() {},
      ...props,
    }),
  );

test("only a name and a purpose are required, in the spec's words", () => {
  assert.equal(deskProblem({ name: "", description: "x" }), "Give it a name");
  assert.equal(
    deskProblem({ name: "Scout", description: "  " }),
    "Say what it's for",
  );
  assert.equal(
    deskProblem({ name: "Scout", description: "Finds sources." }),
    null,
  );
});

test("three featured models show first; the selected one is never hidden", () => {
  assert.deepEqual(
    featuredModels(MODELS, "h").map((m) => m.id),
    ["h", "s", "o"],
  );
  assert.deepEqual(
    featuredModels(MODELS, "g").map((m) => m.id),
    ["h", "s", "g"],
  );
});

test("the desk is a labelled modal with four steps, Identity first", () => {
  const html = desk();
  assert.match(html, /role="dialog" aria-modal="true" aria-labelledby="[^"]+"/);
  const tabs = [...html.matchAll(/role="tab"[^>]*>([\s\S]*?)<\/button>/g)].map(
    (m) =>
      m[1]
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .trim(),
  );
  assert.deepEqual(tabs, ["1Identity", "2Access", "3Rules", "4Sign & issue"]);
  assert.match(
    html,
    /role="tab"[^>]*aria-selected="true"[^>]*>[\s\S]*?Identity/,
  );
  // the step's heading takes focus when the step opens
  assert.match(html, /<h3 class="idd-h" tabindex="-1"[^>]*>Identity<\/h3>/);
  assert.match(
    html,
    /Who it is and what it’s for\. This prints on the front of its ID\./,
  );
});

test("Identity: name with its handle, purpose with a count, photo and model cards", () => {
  const html = desk();
  assert.match(html, /placeholder="Research Scout"/);
  assert.match(html, /placeholder="What this specialist owns"/);
  assert.match(html, /role="radiogroup" aria-label="Model"/);
  const cards = html.match(/role="radio"[^>]*class="idd-model[^"]*"/g) ?? [];
  assert.equal(cards.length, 3);
  assert.match(html, />Haiku 5\.5</);
  assert.doesNotMatch(html, />Claude /);
  assert.match(html, />All models \(4\)</);
  // roving: one model card in the tab order
  assert.equal(
    (
      html.match(
        /class="idd-model[^"]*"[^>]*tabindex="0"|tabindex="0"[^>]*class="idd-model/g,
      ) ?? []
    ).length,
    1,
  );
});

test("the footer: Cancel and Continue on the first step, large and to the right", () => {
  const html = desk();
  const foot = html.slice(html.indexOf('class="idd-foot"'));
  // the study's actions: a default (outlined) Cancel, then the primary with a chevron
  assert.match(
    foot,
    /<button type="button" class="tx-btn tx-lg"[^>]*>Cancel<\/button>/,
  );
  assert.match(foot, /class="tx-btn tx-primary tx-lg"[^>]*>Continue<svg/);
  assert.ok(foot.indexOf("pt-spacer") < foot.indexOf(">Cancel<"));
});

test("Sign & issue: who can use it, and Issue ID blocked by an Identity problem", () => {
  const html = desk({ initialStep: "sign" });
  assert.match(
    html,
    /<h3 class="idd-h" tabindex="-1"[^>]*>Sign &amp; issue<\/h3>/,
  );
  assert.match(
    html,
    /<legend class="idd-label">Who can use it<\/legend><div class="idd-scope-row">/,
  );
  assert.match(
    html,
    /<label class="idd-scope-option is-on"><input type="radio"[^>]*checked=""[^>]*\/><span><b>Just me<\/b>/,
  );
  assert.match(html, /Everyone in this workspace/);
  assert.match(html, /Give it a name on the Identity step first/);
  assert.match(
    html,
    /<button type="submit" class="tx-btn tx-primary tx-lg"[^>]*disabled=""[^>]*>Issue ID</,
  );
  assert.match(html, />Back</);
});

test("editing saves changes rather than issuing a new ID", () => {
  const html = desk({
    initialStep: "sign",
    editing: {
      id: "a",
      source: "personal",
      name: "Scout",
      description: "Finds sources.",
      look: 1,
      tint: "ice",
      model: MODELS[0],
      available: true,
      connectors: [],
      skills: [],
      helpers: false,
      revision: 3,
      createdByMe: true,
      status: "active",
      canEdit: true,
      canArchive: true,
      canPromote: true,
    },
  });
  assert.match(html, />Save changes</);
  assert.doesNotMatch(html, /Issue ID/);
  assert.match(html, /Personal agent/);
});

const EDITED = {
  id: "a",
  source: "personal",
  name: "Incident Scout",
  description: "Watch our deploys and triage errors.",
  look: 4,
  tint: "peach",
  model: MODELS[1],
  available: true,
  connectors: [],
  skills: [],
  helpers: false,
  revision: 3,
  createdByMe: true,
  status: "active",
  canEdit: true,
  canArchive: true,
  canPromote: true,
};

test("the head carries the title and the step's subhead; Close sits on the stage", () => {
  const html = desk();
  const head = html.slice(
    html.indexOf('class="idd-head"'),
    html.indexOf('class="idd-steps"'),
  );
  assert.match(head, /<h2[^>]*>New agent<\/h2>/);
  assert.match(
    head,
    /Who it is and what it’s for\. This prints on the front of its ID\./,
  );
  assert.doesNotMatch(head, /aria-label="Close"/);
  const stage = html.slice(html.indexOf('class="idd-stage'));
  assert.match(stage, /aria-label="Close"/);
});

test("Name shows its handle and Purpose its count in the label row", () => {
  const html = desk({ editing: EDITED });
  assert.match(
    html,
    /class="idd-label-row"><label[^>]*>Name<\/label><span class="idd-hint mono"[^>]*>@incidentscout<\/span>/,
  );
  assert.match(
    html,
    /class="idd-label-row"><label[^>]*>Purpose<\/label><span class="idd-hint mono"[^>]*>36\/280<\/span>/,
  );
});

test("Photo: backdrop swatches and shuffle share the label row; the chosen look wears the backdrop", () => {
  const html = desk({ editing: EDITED });
  const row = html.slice(
    html.indexOf(">Photo<"),
    html.indexOf('aria-label="Look"'),
  );
  assert.match(row, /role="radiogroup" aria-label="Backdrop"/);
  assert.match(row, />shuffle</);
  const looks =
    html.match(/<button[^>]*class="idd-look(?: is-on)?"[^>]*>/g) ?? [];
  assert.equal(looks.length, 12);
  const chosen = looks.filter((l) => l.includes("is-on"));
  assert.equal(chosen.length, 1);
  assert.match(chosen[0], /aria-checked="true"/);
  assert.match(chosen[0], /background:#FBE9DD/i);
  assert.ok(
    looks
      .filter((l) => !l.includes("is-on"))
      .every((l) => !/background/.test(l)),
  );
});

test("model cards carry a radio dot", () => {
  const html = desk();
  assert.equal((html.match(/class="idd-model-dot"/g) ?? []).length, 3);
});

test("the ID card front: brand, photo, name, handle, purpose, model and scope", () => {
  const html = desk({ editing: EDITED });
  const front = html.slice(
    html.indexOf('class="idc-face front"'),
    html.indexOf('class="idc-face back"'),
  );
  assert.match(front, /truex<small>Agent ID<\/small>/);
  assert.match(front, /class="idc-name">Incident Scout</);
  assert.match(front, /class="idc-handle">@incidentscout</);
  assert.match(
    front,
    /class="idc-duty">Watch our deploys and triage errors\.</,
  );
  assert.match(front, /<dt>Model<\/dt><dd>Sonnet 5\.5<\/dd>/);
  assert.match(front, /<dt>Expires<\/dt><dd>No expiry<\/dd>/);
  assert.match(
    front,
    /<b>Personal agent<\/b><small>Only you can use it<\/small>/,
  );
  // no invented identifiers: there is no ID number on file yet (backlog 11)
  assert.doesNotMatch(html, /AG-\d{4}/);
});

test("the ID card back lists what it can open and its skills; Front / Back flips it", () => {
  const html = desk({
    editing: {
      ...EDITED,
      connectors: [
        { slug: "sentry", displayName: "Sentry", access: "read_write" },
      ],
      skills: [{ id: "triage", displayName: "Triage incidents" }],
    },
  });
  const back = html.slice(html.indexOf('class="idc-face back"'));
  assert.match(back, /class="acc-n">Sentry</);
  assert.match(back, /class="acc-w">R\/W</);
  assert.match(back, /class="sk">Triage incidents</);
  assert.match(html, /role="radiogroup" aria-label="Card side"/);
  assert.match(html, /Drag to swing · tap to flip/);
});

test("a new agent's card shows today as its issue date", () => {
  const html = desk();
  const today = new Date()
    .toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    })
    .toUpperCase();
  assert.match(html, new RegExp(`<dt>Issued</dt><dd>${today}</dd>`));
});

test("the Rules step offers what it answers, rules and behaviour, as designed", () => {
  const html = desk({ initialStep: "rules" });
  assert.match(html, /<legend class="idd-label">What it answers<\/legend>/);
  // real radio inputs in two-across cards, as in the study
  assert.match(
    html,
    /<label class="idd-scope-option is-on"><input type="radio"[^>]*checked=""[^>]*\/><span><b>Only its purpose<\/b>/,
  );
  assert.match(
    html,
    /<label class="idd-scope-option"><input type="radio"[^>]*\/><span><b>General questions too<\/b>/,
  );
  assert.match(html, /General questions too/);
  assert.match(
    html,
    /Sticks to the purpose you gave it and politely declines anything else\./,
  );
  for (const label of ["Rules", "Behaviour"]) {
    assert.match(html, new RegExp(`aria-label="${label} format"`));
    assert.match(
      html,
      new RegExp(`Add ${label === "Rules" ? "rule" : "behaviour"}`),
    );
  }
  assert.match(html, /aria-label="Suggested rules"/);
  assert.match(html, /Cite the source for every claim/);
  assert.match(html, /aria-label="Suggested behaviours"/);
  assert.doesNotMatch(html, /aren’t saved for agents yet/);
});

test("the Sign step has the optional signature pad and Sign for me", () => {
  const html = desk({ initialStep: "sign" });
  assert.match(html, /Signature <span class="idd-hint">optional<\/span>/);
  assert.match(
    html,
    /<svg class="idd-sign-pad"[^>]*role="img" aria-label="Signature pad, empty"/,
  );
  assert.match(html, />Sign for me</);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Clear</);
  // the card's back shows the empty strip until it's signed
  assert.match(html, /<span class="sig-empty">Not yet signed<\/span>/);
  assert.match(html, /<b>Guide<\/b>on-purpose only/);
});

test("the Rules and signature save is stubbed until the backend stores them", () => {
  const source = readFileSync(
    new URL("../components/tenant/tenant-agent-dialog.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /TODO\(agent-guide\)/);
  assert.match(source, /\/\/ await saveAgentGuide\(saved\.id, \{/);
  assert.doesNotMatch(source, /^\s*await saveAgentGuide/m);
});

test("guide helpers: card summary, ideas in prose, clipped purpose", () => {
  assert.equal(guideSummary(BLANK_GUIDE), "on-purpose only");
  assert.equal(
    guideSummary({
      ...BLANK_GUIDE,
      topics: "open",
      rules: "a\n\nb\n",
      behaviour: "Be brief.",
      behaviourAs: "text",
    }),
    "any topic · 2 rules · behaviour written",
  );
  assert.equal(withIdea("", "Be concise"), "Be concise.");
  assert.equal(
    withIdea("Lead with the answer.", "Be concise"),
    "Lead with the answer. Be concise.",
  );
  assert.equal(withIdea("x".repeat(1300), "y").length, 1200);
  assert.equal(clip("short", 70), "short");
  // cuts at a word when the last space is in the final 40%, else mid-word
  assert.equal(clip("one two three four five", 16), "one two three…");
  assert.equal(clip("one two three four five", 12), "one two thre…");
  assert.match(AUTO_SIG, /^M10 42/);
});

test("the seal renders on the issued card's front with its date", () => {
  const { IdCard } = component("tenant/agent-id-card.tsx");
  const props = {
    name: "Scout",
    handle: "scout",
    purpose: "Finds sources.",
    look: 1,
    tint: "ice",
    model: "Sonnet 5.5",
    issued: "30 OCT 2026",
    workspace: false,
    access: [],
    skills: [],
    face: "front",
  };
  const plain = renderToStaticMarkup(createElement(IdCard, props));
  assert.doesNotMatch(plain, /issued-seal/);
  const sealed = renderToStaticMarkup(
    createElement(IdCard, { ...props, sealed: true }),
  );
  assert.match(
    sealed,
    /<svg class="issued-seal"[^>]*role="img" aria-label="Issued 30 OCT 2026"/,
  );
  assert.match(sealed, /ISSUED · 30 OCT 2026 · /);
  // no issue date on file (an edited agent): no seal even when asked
  const undated = renderToStaticMarkup(
    createElement(IdCard, { ...props, issued: undefined, sealed: true }),
  );
  assert.doesNotMatch(undated, /issued-seal/);
});

test("Issue ID waits for the flip, lands the seal, then gives way to the celebration", () => {
  const source = readFileSync(
    new URL("../components/tenant/tenant-agent-dialog.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /const flip = face === "back" \? 850 : 0;/);
  assert.match(source, /setSealed\(true\);\s*thud\(240\);/);
  assert.match(
    source,
    /setTimeout\(\(\) => setLeaving\(true\), flip \+ 1300\)/,
  );
  assert.match(
    source,
    /setTimeout\(\(\) => setCelebrated\(saved\), flip \+ 1550\)/,
  );
  assert.match(source, /if \(celebrated\)\s*return \(\s*<AgentIssued/);
  // no toast and no automatic close: only Say hi, Done, Esc or Close end it
  assert.doesNotMatch(source, /toast/);
  assert.doesNotMatch(source, /setTimeout\(finishIssue/);
  assert.match(
    source,
    /const close = \(\) => \(issuedAgent\.current \? finishIssue\(\) : onClose\(\)\)/,
  );
  assert.doesNotMatch(source, /onClick=\{onClose\}|onMouseDown=\{onClose\}/);
  // editing saves straight away, with no seal
  assert.match(source, /if \(editing\) \{\s*onSaved\(saved\);\s*return;/);
});

test("the celebration names the agent, offers Say hi and Done, and throws confetti", () => {
  const { AgentIssued } = component("tenant/agent-issued.tsx");
  const props = {
    name: "Scout",
    handle: "scout",
    issued: "30 OCT 2026",
    canChat: true,
    onSayHi() {},
    onDone() {},
  };
  const html = renderToStaticMarkup(
    createElement(AgentIssued, props, createElement("span", null, "card")),
  );
  assert.match(
    html,
    /<div class="idd-celebrate" role="dialog" aria-modal="true"/,
  );
  assert.match(html, /<h2 id="[^"]+" class="t-h2">Scout is on the team<\/h2>/);
  assert.match(
    html,
    /@scout is ready to work\. Drag its card around while you’re here\./,
  );
  assert.match(
    html,
    /<span class="idd-celebrate-mark">Agent ID issued · 30 OCT 2026<\/span>/,
  );
  // the confetti and the card share the stage; the words are outside it
  assert.match(
    html,
    /<div class="idd-celebrate-stage"><div class="idc-confetti"[^>]*>(<i [^>]*><\/i>)+<\/div><div class="lanyard-anchor">/,
  );
  assert.match(html, />Say hi to Scout</);
  assert.match(html, />Done</);
  assert.match(html, /aria-label="Close"/);
  assert.equal((html.match(/<i style=/g) ?? []).length, 56);
  assert.match(html, /<div class="idc-wrap"><span>card<\/span><\/div>/);
  const quiet = renderToStaticMarkup(
    createElement(AgentIssued, { ...props, canChat: false }, null),
  );
  assert.doesNotMatch(quiet, /Say hi/);
});

test("the seal sits over the photo; on the celebration the card falls on a pinned strap, then swings from the window's top", () => {
  const read = (file: string) =>
    readFileSync(new URL(`../styles/app/${file}`, import.meta.url), "utf8");
  const card = read("agent-card.css");
  assert.match(
    card,
    /\.idc-face > \.issued-seal \{\s*position: absolute;[^}]*right: 22px;[^}]*top: 176px;[^}]*animation: sealIn 0\.6s/,
  );
  assert.match(
    card,
    /:root\[data-eff-motion="reduce"\] \.idc-confetti \{\s*display: none;/,
  );
  const desk = read("agent-desk.css");
  // the desk opening has no drop
  assert.doesNotMatch(desk, /\.idd-stage \.lanyard-anchor/);
  // falling: the anchor never moves; only the strap animates
  assert.match(
    desk,
    /\.idd-celebrate \.lanyard-anchor \{[^}]*--strap: 40px;\s*top: -564px;\s*z-index: 1;\s*\}/,
  );
  assert.doesNotMatch(desk, /lanyard-anchor \{[^}]*animation/);
  assert.match(
    desk,
    /\.idd-celebrate \.strap \{\s*height: calc\(560px \+ var\(--strap\)\);\s*animation: idc-unroll 0\.9s cubic-bezier\(0\.34, 1\.56, 0\.64, 1\) backwards;/,
  );
  // a short visible strap
  // a short visible strap of fixed length; short windows shrink the card
  assert.doesNotMatch(desk, /100cqh/);
  assert.match(
    desk,
    /@container \(max-height: 384px\) \{\s*\.idd-celebrate \.lanyard-anchor \{\s*--strap: 24px;/,
  );
  // landed: the same picture, pinned at the window's top, with no transition
  assert.match(
    desk,
    /\.idd-celebrate\.is-landed \.lanyard-anchor \{\s*top: -4px;/,
  );
  assert.match(
    desk,
    /\.idd-celebrate\.is-landed \.strap \{\s*height: var\(--strap\);\s*animation: none;/,
  );
  assert.match(
    desk,
    /\.idd-celebrate\.is-landed:not\(\.is-hung\) \.strap \{\s*transition: none;/,
  );
  assert.match(
    desk,
    /\.idd-celebrate:not\(\.is-hung\) \.lanyard \{\s*pointer-events: none;/,
  );
  // one column: the card above, the words below
  assert.match(desk, /grid-template-rows: minmax\(0, 1fr\) auto;/);
  assert.doesNotMatch(desk, /\.idd-celebrate \{[^}]*grid-template-columns/);
  assert.match(desk, /\.idd-scrim\.is-leaving \.idd \{\s*opacity: 0;/);
  assert.match(
    desk,
    /:root\[data-eff-motion="reduce"\] \.idd-celebrate \.strap \{\s*height: var\(--strap\);/,
  );
});

test("the celebration lands once the strap stops unrolling, then hangs a frame later", () => {
  const source = readFileSync(
    new URL("../components/tenant/agent-issued.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /if \(e\.animationName === "idc-unroll"\) setLanded\(true\);/,
  );
  assert.match(source, /requestAnimationFrame\(\(\) => setHung\(true\)\)/);
});

test("the lanyard reads its resting strap only when nothing animates it", () => {
  const source = readFileSync(
    new URL("../components/v2/agent-badge.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /if \(node\.getAnimations\(\)\.length\) return;/);
  assert.match(source, /addEventListener\("animationend", measure\)/);
  assert.match(source, /setPointerCapture\(e\.pointerId\);\s*measure\(\);/);
});
