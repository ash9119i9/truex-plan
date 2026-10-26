import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FOLLOW_UPS_MAX_CHARS,
  parseFollowUps,
  stripFollowUps,
} from "../../src/modules/chats/followups";

interface GoldenCase {
  name: string;
  text: string;
  streaming?: boolean;
  expect: {
    text: string;
    status: string;
    shape: string;
    stage: string;
    items: Array<{ slot: number; intent: string; text: string }>;
  };
}

const golden = JSON.parse(
  readFileSync(join(__dirname, "../support/followups-golden.json"), "utf8"),
) as GoldenCase[];

describe("follow-up block contract", () => {
  for (const testCase of golden)
    test(testCase.name, () => {
      const parsed = parseFollowUps(testCase.text, testCase.streaming === true);
      assert.deepEqual(
        {
          text: parsed.text,
          ...parsed.followUps,
        },
        testCase.expect,
      );
    });

  test("a 10,000-character row is refused without dropping the block", () => {
    const row = "x".repeat(10_000);
    const text = `Answer\n[truex-suggestions]\nshape: explain; stage: none\nact: ${row}\n[/truex-suggestions]`;
    const parsed = parseFollowUps(text);
    assert.equal(parsed.text, "Answer");
    assert.equal(parsed.followUps.status, "invalid");
    assert.deepEqual(parsed.followUps.items, []);
  });

  test("a row is cut at the contract's length, not before", () => {
    const kept = "y".repeat(FOLLOW_UPS_MAX_CHARS);
    const text = `Answer\n[truex-suggestions]\nshape: explain; stage: none\nverify: ${kept}\n[/truex-suggestions]`;
    assert.equal(parseFollowUps(text).followUps.items[0]?.text, kept);
    const tooLong = `Answer\n[truex-suggestions]\nshape: explain; stage: none\nverify: ${kept}y\n[/truex-suggestions]`;
    assert.equal(parseFollowUps(tooLong).followUps.status, "invalid");
  });

  test("every control and bidi character is refused", () => {
    for (const bad of [
      "\u0000",
      "\u0007",
      "\u001f",
      "\u202a",
      "\u202e",
      "\u2066",
      "\u2069",
    ]) {
      const text = `Answer\n[truex-suggestions]\nshape: explain; stage: none\nact: bad ${bad} row\n[/truex-suggestions]`;
      assert.equal(
        parseFollowUps(text).followUps.status,
        "invalid",
        JSON.stringify(bad),
      );
    }
  });

  test("stripping a block never touches the answer before it", () => {
    const body = "  Keep this spacing.\n\n```ts\nconst x = 1;\n```";
    const parsed = parseFollowUps(
      `${body}\n\n[truex-suggestions]\nshape: explain; stage: none\nact: Go\n[/truex-suggestions]`,
    );
    assert.equal(parsed.text, body);
  });

  test("no trailing blank lines remain after a stripped block", () => {
    for (const tail of ["\n", "\n\n\n", "   \n\t\n"])
      assert.equal(
        stripFollowUps(
          `Answer\n[truex-suggestions]\nshape: explain; stage: none\nact: Go\n[/truex-suggestions]${tail}`,
        ),
        "Answer",
      );
  });

  test("a half block hidden on every chunk boundary leaves no marker", () => {
    const text =
      "Answer\n\n[truex-suggestions]\nshape: how-to; stage: build\nact: Draft a report\n[/truex-suggestions]";
    for (let end = 0; end <= text.length; end++) {
      const seen = stripFollowUps(text.slice(0, end), true);
      assert.doesNotMatch(seen, /truex-suggestions/);
      assert.doesNotMatch(seen, /Draft a report/);
      assert.doesNotMatch(seen, /shape:/);
    }
  });

  test("a bare bracket that is not the marker is answer text", () => {
    assert.equal(stripFollowUps("Use [x] here", true), "Use [x] here");
    assert.equal(stripFollowUps("Use [truex] here", true), "Use [truex] here");
  });
});
