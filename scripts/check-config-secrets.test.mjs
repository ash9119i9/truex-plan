import { test } from "node:test";
import assert from "node:assert/strict";
import { findCredentials, isSafeValue } from "./check-config-secrets.mjs";

test("credential fields must be empty, an env reference or a placeholder", () => {
  for (const value of ["", "${PROVIDER_KEY}", "<set through Connected tools>"])
    assert.equal(isSafeValue(value), true, value);
  for (const value of ["abc123", "Bearer x", "$PROVIDER_KEY"])
    assert.equal(isSafeValue(value), false, value);
});

test("findings name the line and field, never the value", () => {
  const text = [
    "{",
    "  apikey: 'literal-credential-value',",
    '  "apiKey": "${PROVIDER_KEY}",',
    "  apiKey: '<MCP credential>',",
    '  "headerName": "x-api-qlik-key",',
    "  note: 'sk-" + "a".repeat(24) + "',",
    "}",
  ].join("\n");
  const findings = findCredentials(text);
  assert.deepEqual(findings, [
    { line: 2, field: "apikey" },
    { line: 6, field: "credential-like token" },
  ]);
  assert.ok(!JSON.stringify(findings).includes("literal-credential-value"));
});
