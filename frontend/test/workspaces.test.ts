// Presentation tests retained while workspace management is deferred.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { component } from "./next-details-runtime.ts";

const { UserMenu } = component("v2/user-menu.tsx");
test("the account menu exposes one workspace destination with the other actions intact", () => {
  const html = renderToStaticMarkup(
    createElement(UserMenu, {
      name: "Dhaya",
      email: "dhaya@gmail.com",
      workspace: "Dhaya Labs",
      role: "admin",
      onSettings() {},
      onWorkspaces() {},
      // A stale caller must not reintroduce the retired second entry.
      onSwitchWorkspace() {},
      onSignOut() {},
    }),
  );
  assert.equal((html.match(/Manage workspaces/g) ?? []).length, 1);
  assert.ok(!html.includes("Switch workspace"));
  for (const label of ["Dhaya Labs", "Settings", "Sign out", "Dark mode"])
    assert.ok(html.includes(label));
});
test("the account menu hides workspace navigation when it is unavailable", () => {
  const html = renderToStaticMarkup(createElement(UserMenu, { name: "Dhaya" }));
  assert.ok(!html.includes("Manage workspaces"));
  assert.ok(!html.includes("Sign out"));
  assert.ok(html.includes("Dark mode"));
});

test("default tenant users see their account actions without workspace controls", () => {
  for (const role of ["user", "admin"]) {
    const html = renderToStaticMarkup(
      createElement(UserMenu, {
        name: "Dhaya",
        email: "dhaya@gmail.com",
        workspace: "Default tenant",
        showWorkspaces: false,
        role,
        onSettings() {},
        onWorkspaces() {},
        onSignOut() {},
      }),
    );
    for (const label of [
      "Default tenant",
      "Manage workspaces",
      "Switch workspace",
    ])
      assert.ok(!html.includes(label));
    for (const label of [
      "Dhaya",
      "dhaya@gmail.com",
      "Settings",
      "Sign out",
      "Dark mode",
    ])
      assert.ok(html.includes(label));
  }
});
