import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAppearance } from "../lib/use-appearance.ts";

test("embedded content follows what the page shows, then the system", () => {
  // The attribute is what the app's styles follow, so it wins over the system.
  assert.equal(resolveAppearance("light", true), "light");
  assert.equal(resolveAppearance("dark", false), "dark");
  // No attribute: the system decides, as the app's own styles do.
  assert.equal(resolveAppearance(undefined, true), "dark");
  assert.equal(resolveAppearance(null, false), "light");
  assert.equal(resolveAppearance("", true), "dark");
  // Anything unexpected is not a theme.
  assert.equal(resolveAppearance("purple", false), "light");
  assert.equal(resolveAppearance("purple", true), "dark");
});
