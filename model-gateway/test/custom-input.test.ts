import { test } from "node:test";
import assert from "node:assert/strict";
import { CustomInputDecoder } from "../src/custom-input";

// Every way of cutting `args` into pieces of `size` decodes to `expected`.
function decodeIn(args: string, size: number): string {
  const decoder = new CustomInputDecoder();
  let out = "";
  for (let i = 0; i < args.length; i += size)
    out += decoder.push(args.slice(i, i + size));
  return out;
}

// JSON with every non-ASCII code unit written as a \u escape, the form some
// providers stream.
function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}

const PATCH =
  '*** Begin Patch\n*** Add File: guide.md\n+# "Quotes", \\back\\slashes\t tabs\n+Emoji 💪 and ü\n*** End Patch\n';

test("decodes the input string across every chunk boundary", () => {
  for (const args of [
    JSON.stringify({ input: PATCH }),
    asciiJson({ input: PATCH }),
    `  {\n "input" :  ${JSON.stringify(PATCH)} }`,
  ])
    for (const size of [1, 2, 3, 5, 7, 64, args.length])
      assert.equal(
        decodeIn(args, size),
        PATCH,
        `size ${size}: ${args.slice(0, 20)}`,
      );
});

test("never emits half a surrogate pair", () => {
  const decoder = new CustomInputDecoder();
  const args = asciiJson({ input: "💪" });
  const cut = args.indexOf("\\udcaa");
  const first = decoder.push(args.slice(0, cut));
  assert.equal(first, "", "the high surrogate waits for its pair");
  assert.equal(decoder.push(args.slice(cut)), "💪");
});

test("drops a surrogate that can never be paired", () => {
  const out = decodeIn('{"input":"a\\ud83db"}', 1);
  assert.equal(out, "ab");
});

test("other argument shapes stream nothing", () => {
  assert.equal(decodeIn(JSON.stringify({ patch: PATCH }), 4), "");
  assert.equal(decodeIn(JSON.stringify({ x: 1, input: PATCH }), 4), "");
  assert.equal(decodeIn("not json at all", 3), "");
  assert.equal(decodeIn('{"input":"bad \\q escape"}', 2), "bad ");
});

test("stops at the closing quote", () => {
  assert.equal(decodeIn('{"input":"done"} trailing "text"', 3), "done");
});
