import { test } from "node:test";
import assert from "node:assert/strict";
import {
  barPercent,
  checkup,
  clean,
  errorNotice,
  expiryLabel,
  firstName,
  initials,
  inviteKind,
  isValid,
  logoInitial,
  parseLookup,
  roleLabel,
  startUrl,
  ttlCopy,
  type InviteLookup,
} from "../lib/invite-form.ts";

const NOW = "2026-10-01T12:00:00.000Z";
const at = (ms: number) => new Date(Date.parse(NOW) + ms).toISOString();
const DAY = 86_400_000;

test("clean trims and collapses whitespace", () => {
  assert.equal(clean("  alex   rivera \t jones  "), "alex rivera jones");
  assert.equal(clean("\n\n"), "");
  assert.equal(clean("Cher"), "Cher");
});

test("isValid follows the spec rule plus the 60-character cap", () => {
  assert.equal(isValid("A1"), true);
  assert.equal(isValid("12"), false);
  assert.equal(isValid("--"), false);
  assert.equal(isValid("a"), false);
  assert.equal(isValid("ab"), true);
  assert.equal(isValid("Zoë"), true);
  assert.equal(isValid("李"), false); // one UTF-16 unit
  assert.equal(isValid("李明"), true);
  assert.equal(isValid("a".repeat(60)), true);
  assert.equal(isValid("a".repeat(61)), false);
});

test("initials takes the first character of the first two words", () => {
  assert.equal(initials("alex rivera jones"), "AR");
  assert.equal(initials("Cher"), "C");
  assert.equal(initials(""), "");
  // An astral character stays whole instead of half a surrogate pair.
  assert.equal(initials("😀 smile"), "😀S");
  assert.equal(initials("𝒜da lovelace"), "𝒜L");
});

test("firstName, roleLabel, logoInitial", () => {
  assert.equal(firstName("  Alex   Rivera "), "Alex");
  assert.equal(roleLabel("admin"), "Admin");
  assert.equal(roleLabel("user"), "Member");
  assert.equal(roleLabel(undefined), "Member");
  assert.equal(logoInitial(" northwind labs"), "N");
  assert.equal(logoInitial(""), "?");
});

test("expiryLabel at its boundaries", () => {
  assert.deepEqual(expiryLabel(NOW, NOW, "UTC"), { expired: true, text: "Expired Oct 1" });
  assert.deepEqual(expiryLabel(at(-1), NOW, "UTC"), { expired: true, text: "Expired Oct 1" });
  assert.deepEqual(expiryLabel(at(1), NOW, "UTC"), { expired: false, text: "Expires today" });
  assert.deepEqual(expiryLabel(at(DAY - 1), NOW, "UTC"), { expired: false, text: "Expires today" });
  assert.deepEqual(expiryLabel(at(DAY), NOW, "UTC"), { expired: false, text: "Expires in 1 day" });
  assert.deepEqual(expiryLabel(at(2 * DAY - 1), NOW, "UTC"), { expired: false, text: "Expires in 1 day" });
  assert.deepEqual(expiryLabel(at(2 * DAY), NOW, "UTC"), { expired: false, text: "Expires in 2 days" });
  assert.deepEqual(expiryLabel(at(6 * DAY + 5), NOW, "UTC"), { expired: false, text: "Expires in 6 days" });
  assert.equal(expiryLabel(undefined, NOW), null);
  assert.equal(expiryLabel("not a date", NOW), null);
  assert.equal(expiryLabel(at(DAY), "garbage"), null);
});

test("ttlCopy and startUrl", () => {
  assert.equal(ttlCopy(7), "Invites last 7 days.");
  assert.equal(ttlCopy(1), "Invites last 1 day.");
  assert.equal(startUrl("tok_1", "Zoë O'Neil & co"), "/auth/google/start?invite=tok_1&name=Zo%C3%AB%20O'Neil%20%26%20co");
});

test("parseLookup rejects bodies that aren't the contract's shape", () => {
  assert.equal(parseLookup(null), null);
  assert.equal(parseLookup("valid"), null);
  assert.equal(parseLookup([]), null);
  assert.equal(parseLookup({}), null);
  assert.equal(parseLookup({ status: "valid" }), null); // no serverNow
  assert.equal(parseLookup({ status: "weird", serverNow: NOW }), null);
  assert.equal(parseLookup({ status: "valid", serverNow: 5 }), null);
});

test("parseLookup keeps known fields and drops bad ones", () => {
  assert.deepEqual(parseLookup({ status: "valid", serverNow: NOW, ttlDays: -3, role: "owner", tenantName: "", viewer: { name: "x" } }), {
    status: "valid",
    serverNow: NOW,
    ttlDays: 7,
  });
  assert.deepEqual(
    parseLookup({
      status: "valid",
      serverNow: NOW,
      ttlDays: 7,
      tenantName: "Northwind Labs",
      email: "alex@gmail.com",
      role: "admin",
      sentAt: NOW,
      expiresAt: at(6 * DAY),
      extra: "ignored",
      viewer: { email: "alex@gmail.com", name: "Alex Rivera", member: "yes", memberSince: NOW },
    }),
    {
      status: "valid",
      serverNow: NOW,
      ttlDays: 7,
      tenantName: "Northwind Labs",
      email: "alex@gmail.com",
      role: "admin",
      sentAt: NOW,
      expiresAt: at(6 * DAY),
      viewer: { email: "alex@gmail.com", name: "Alex Rivera", member: false, memberSince: NOW },
    },
  );
});

test("inviteKind for every status and param combination", () => {
  const statuses = ["valid", "expired", "used", "revoked", "not_found"] as const;
  const errors = [null, "invite_expired", "invite_used", "invite_revoked", "wrong_account", "gmail_only", "invalid_name"];
  const fromError: Record<string, string> = { invite_expired: "expired", invite_used: "used", invite_revoked: "revoked" };
  for (const status of statuses) {
    for (const joined of [false, true]) {
      for (const error of errors) {
        const base: InviteLookup = { status, serverNow: NOW, ttlDays: 7 };
        const label = `${status} joined=${joined} error=${error}`;
        // Signed out, or signed in but not a member: joined=1 alone never shows "joined".
        const expected = (error && fromError[error]) || status;
        assert.equal(inviteKind(base, joined, error), expected, label);
        assert.equal(inviteKind({ ...base, viewer: { email: "a@gmail.com", member: false } }, joined, error), expected, label);
        // A member always sees joined or member, whatever the invite's status.
        assert.equal(inviteKind({ ...base, viewer: { email: "a@gmail.com", member: true } }, joined, error), joined ? "joined" : "member", label);
      }
    }
  }
});

test("errorNotice gives a banner only for codes without their own state", () => {
  for (const code of [null, "invite_expired", "invite_used", "invite_revoked", "invalid_name", "wrong_account"])
    assert.equal(errorNotice(code), null, String(code));
  assert.equal(errorNotice("gmail_only")?.tone, "warn");
  assert.equal(errorNotice("account_conflict")?.tone, "warn");
  assert.equal(errorNotice("something_new")?.lead, "Sign-in didn't finish.");
});

const shape = (c: ReturnType<typeof checkup>) => c.steps.map((s) => `${s.tone}|${s.glyph}|${s.label}`);

test("checkup: valid, typing and submitting", () => {
  const empty = checkup("valid", false, false);
  assert.deepEqual(shape(empty), ["is-done|✓|Invite verified", "is-on|2|Add your name", "|3|Join workspace"]);
  assert.equal(empty.count, 1);
  assert.equal(barPercent(empty), 100 / 3);

  const typed = checkup("valid", true, false);
  assert.deepEqual(shape(typed), ["is-done|✓|Invite verified", "is-done|✓|Add your name", "is-on|3|Join workspace"]);
  assert.equal(typed.count, 2);

  const busy = checkup("valid", true, true);
  assert.deepEqual(shape(busy), ["is-done|✓|Invite verified", "is-done|✓|Add your name", "is-on is-busy||Join workspace"]);
  assert.equal(busy.count, 2);
});

test("checkup: joined and member are all done", () => {
  for (const kind of ["joined", "member"] as const) {
    const c = checkup(kind, false, false);
    assert.deepEqual(shape(c), ["is-done|✓|Invite verified", "is-done|✓|Add your name", "is-done|✓|Join workspace"]);
    assert.equal(c.count, 3);
    assert.equal(barPercent(c), 100);
    assert.equal(c.bad, false);
  }
});

test("checkup: bad states mark step 1 and keep a third of the bar", () => {
  const labels = { expired: "Invite expired", used: "Invite already used", revoked: "Invite revoked", not_found: "Invite not found" } as const;
  for (const [kind, label] of Object.entries(labels) as [keyof typeof labels, string][]) {
    const c = checkup(kind, true, false);
    assert.deepEqual(shape(c), [`is-bad|!|${label}`, "|2|Add your name", "|3|Join workspace"]);
    assert.equal(c.count, 0);
    assert.equal(c.bad, true);
    assert.equal(barPercent(c), 100 / 3);
  }
});
