import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { component } from "./next-details-runtime.ts";
import { parseMe, saveProfileName } from "../lib/session.ts";

const { ProfileNameCard } = component("auth/profile-name-card.tsx");
const react = createRequire(import.meta.url)("react");
const user = {
  id: "new-user",
  email: "new@gmail.com",
  name: "Google Name",
  nameRequired: true,
};
const reply = (status: number, code?: string) =>
  new Response(status === 204 ? null : JSON.stringify({ code }), { status });
const asFetch = (fn: (...args: any[]) => Promise<Response>) =>
  fn as typeof fetch;

test("name setup reuses the invite form and live profile board", () => {
  const html = renderToStaticMarkup(
    createElement(ProfileNameCard, {
      user,
      onSaved() {},
      onSessionChanged() {},
      onSignOut() {},
      signingOut: false,
    }),
  );
  assert.match(html, /au-page join-page au-login/);
  assert.match(html, /What should we <em>call you\?<\/em>/);
  assert.match(html, /aria-label="Theme"/);
  assert.match(html, /id="au-profile-name"/);
  assert.match(html, /autoComplete="name"/);
  assert.match(html, /value="Google Name"/);
  assert.match(html, /maxLength="60"/);
  assert.match(html, /readOnly="" value="new@gmail.com"/);
  assert.match(html, /Continue to Truex/);
  assert.match(html, /Sign out/);
  assert.match(html, /class="jp-card jp-join"/);
  assert.match(html, /Set up your profile/);
  assert.match(html, /Progress checkup/);
  assert.match(html, /aria-valuenow="2"/);
  assert.match(html, /aria-valuemax="3"/);
  assert.match(html, /class="jp-input-lock"/);
  assert.match(html, /class="jp-input-av is-set"/);
  assert.match(html, /looks good/);
  assert.match(html, /class="jp-btn"/);
  assert.match(html, /Your profile/);
});

test("the session contract requires an explicit new-account flag", () => {
  const me = {
    user,
    tenant: { id: "default-tenant", name: "Default" },
    role: "user",
    tenants: [],
    auth: "google",
  };
  assert.equal(parseMe(me)?.user.nameRequired, true);
  for (const nameRequired of [undefined, false, "true", 1])
    assert.equal(
      parseMe({ ...me, user: { ...user, nameRequired } })?.user.nameRequired,
      undefined,
    );
});

test("name saving uses the authenticated JSON endpoint and reports failures without dropping the name", async () => {
  let seen: any;
  assert.deepEqual(
    await saveProfileName(
      user.id,
      "Chosen Name",
      asFetch(async (path, init) => {
        seen = { path, init };
        return reply(204);
      }),
    ),
    { ok: true },
  );
  assert.equal(seen.path, "/auth/profile/name");
  assert.equal(seen.init.method, "POST");
  assert.equal(seen.init.cache, "no-store");
  assert.equal(seen.init.credentials, "same-origin");
  assert.equal(seen.init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(seen.init.body), {
    userId: user.id,
    name: "Chosen Name",
  });
  assert.ok(seen.init.signal);
  for (const [status, code, changed] of [
    [401, undefined, true],
    [403, "WRONG_APP", true],
    [409, "ACCOUNT_CHANGED", true],
    [400, "INVALID_NAME", false],
    [403, "CSRF_ORIGIN", false],
    [429, undefined, false],
    [503, undefined, false],
  ] as const) {
    const result = await saveProfileName(
      user.id,
      "Chosen Name",
      asFetch(async () => reply(status, code)),
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.signedOut, changed);
      assert.ok(result.message);
    }
  }
  for (const fetchImpl of [
    asFetch(async () => {
      throw new TypeError("offline");
    }),
    asFetch(async () => new Response("not json", { status: 502 })),
  ]) {
    const result = await saveProfileName(user.id, "Chosen Name", fetchImpl);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.signedOut, false);
  }
});

function find(node: any, predicate: (node: any) => boolean): any {
  if (!node || typeof node !== "object") return undefined;
  if (predicate(node)) return node;
  const children = Array.isArray(node.props?.children)
    ? node.props.children
    : [node.props?.children];
  for (const child of children.flat(Infinity)) {
    const found = find(child, predicate);
    if (found) return found;
  }
}

test("name form validates, retains input after outages, prevents duplicates and retries", async (t) => {
  const states: any[] = [],
    refs: any[] = [];
  let stateIndex = 0,
    refIndex = 0;
  let saved = 0,
    changed = 0,
    requests = 0;
  let resolve!: (value: Response) => void;
  let submitted: any;
  t.mock.method(react, "useState", (initial: any) => {
    const i = stateIndex++;
    if (!(i in states)) states[i] = initial;
    return [
      states[i],
      (next: any) => {
        states[i] = next;
      },
    ];
  });
  t.mock.method(
    react,
    "useRef",
    (initial: any) => (refs[refIndex++] ??= { current: initial }),
  );
  t.mock.method(
    globalThis,
    "fetch",
    async (_path: string, init: RequestInit) => {
      requests++;
      submitted = JSON.parse(String(init.body));
      return await new Promise<Response>((done) => {
        resolve = done;
      });
    },
  );
  const render = () => {
    stateIndex = refIndex = 0;
    return ProfileNameCard({
      user,
      signingOut: false,
      onSaved() {
        saved++;
      },
      onSessionChanged() {
        changed++;
      },
      onSignOut() {},
    });
  };
  const nameInput = (tree: any) =>
    find(tree, (node) => node.props?.id === "au-profile-name");
  const form = (tree: any) => find(tree, (node) => node.type === "form");
  const event = { preventDefault() {} };
  for (const value of ["", "A", "123", "x".repeat(61), "A\u200bB"]) {
    nameInput(render()).props.onChange({ target: { value } });
    await form(render()).props.onSubmit(event);
    assert.equal(nameInput(render()).props["aria-invalid"], true);
    assert.equal(requests, 0);
  }
  nameInput(render()).props.onChange({ target: { value: "  Анна \t  Ли " } });
  assert.equal(render().props.profile.name, "Анна Ли");
  assert.equal(render().props.profile.initials, "АЛ");
  assert.equal(render().props.profile.joined, false);
  const pending = form(render()).props.onSubmit(event);
  await form(render()).props.onSubmit(event);
  assert.equal(requests, 1);
  assert.deepEqual(submitted, { userId: user.id, name: "Анна Ли" });
  resolve(reply(503));
  await pending;
  assert.equal(saved, 0);
  assert.equal(nameInput(render()).props.value, "  Анна \t  Ли ");
  const retry = form(render()).props.onSubmit(event);
  resolve(reply(401));
  await retry;
  assert.equal(changed, 1);
  const success = form(render()).props.onSubmit(event);
  resolve(reply(204));
  await success;
  assert.equal(saved, 1);
});
