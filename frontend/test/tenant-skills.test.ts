import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseSkillRefs,
  skillNote,
  skillOptions,
  type SkillRef,
} from "../lib/tenant-skills.ts";

const skill = (overrides: Partial<SkillRef> = {}): SkillRef => ({
  id: "64b7f0c2a1b2c3d4e5f60b01",
  slug: "invoice-check",
  displayName: "Invoice check",
  description: "Checks invoices.",
  hasScripts: false,
  available: true,
  ...overrides,
});

test("parses skills and drops malformed ones", () => {
  assert.deepEqual(
    parseSkillRefs([
      skill(),
      { ...skill(), id: "nope" },
      { ...skill(), slug: "Bad Slug" },
      null,
    ]),
    [skill()],
  );
  assert.deepEqual(parseSkillRefs("x"), []);
});

test("the picker lists the catalog, then attached skills it no longer offers", () => {
  const gone = skill({ id: "64b7f0c2a1b2c3d4e5f60b02", slug: "old" });
  const rows = skillOptions([skill()], [skill(), gone]);
  assert.deepEqual(
    rows.map((r) => [r.slug, r.available]),
    [
      ["invoice-check", true],
      ["old", false],
    ],
  );
});

test("notes: Unavailable wins; Needs coding only for scripts without coding", () => {
  assert.equal(skillNote(skill(), false), null);
  assert.equal(skillNote(skill({ hasScripts: true }), true), null);
  assert.equal(skillNote(skill({ hasScripts: true }), false), "Needs coding");
  assert.equal(
    skillNote(skill({ hasScripts: true, available: false }), false),
    "Unavailable",
  );
});
