import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import {
  signGatewayToken,
  verifyGatewayToken,
} from "../../shared/gateway-token";
import {
  signMcpCallerToken,
  verifyMcpCallerToken,
  type McpCallerClaims,
} from "../../shared/mcp-caller-token";

const SECRET = "mcp-caller-secret-0123456789abcdef";
const CLAIMS: McpCallerClaims = {
  tenantId: "64f0c2a9e1b2c3d4e5f60700",
  userId: "64f0c2a9e1b2c3d4e5f60718",
  chatId: "64f0c2a9e1b2c3d4e5f60719",
  connector: "github",
  revision: 3,
};

// Builds a correctly signed token around any payload, pinning the wire format:
// `mcp1.<base64url JSON>.<base64url HMAC-SHA256 of "mcp1.<payload>">`.
function forgeRaw(json: string, secret = SECRET): string {
  const body = Buffer.from(json).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(`mcp1.${body}`)
    .digest("base64url");
  return `mcp1.${body}.${signature}`;
}

function forge(payload: unknown, secret = SECRET): string {
  return forgeRaw(JSON.stringify(payload), secret);
}

const WIRE = {
  t: CLAIMS.tenantId,
  u: CLAIMS.userId,
  c: CLAIMS.chatId,
  s: "github",
  r: 3,
};

test("sign then verify returns the same claims", () => {
  const token = signMcpCallerToken(CLAIMS, SECRET);
  assert.deepEqual(verifyMcpCallerToken(token, SECRET), CLAIMS);
  // Same claims, same token: a chat's header stays stable across runs, so
  // Codex never reloads the thread (gateway probe, 2026-10-29).
  assert.equal(signMcpCallerToken(CLAIMS, SECRET), token);
  assert.equal(token, forge(WIRE), "wire format is pinned");
});

test("a tampered payload or signature is refused", () => {
  const token = signMcpCallerToken(CLAIMS, SECRET);
  assert.ok(
    verifyMcpCallerToken(token, SECRET),
    "control: untouched token verifies",
  );
  const [prefix, payload, signature] = token.split(".") as [
    string,
    string,
    string,
  ];
  const flipped = signature.at(-1) === "A" ? "B" : "A";
  assert.equal(
    verifyMcpCallerToken(
      `${prefix}.${payload}.${signature.slice(0, -1)}${flipped}`,
      SECRET,
    ),
    null,
  );
  const otherChat = Buffer.from(
    JSON.stringify({ ...WIRE, c: "64f0c2a9e1b2c3d4e5f60720" }),
  ).toString("base64url");
  assert.equal(
    verifyMcpCallerToken(`${prefix}.${otherChat}.${signature}`, SECRET),
    null,
  );
});

test("a wrong segment count or prefix is refused", () => {
  const token = signMcpCallerToken(CLAIMS, SECRET);
  assert.ok(
    verifyMcpCallerToken(token, SECRET),
    "control: untouched token verifies",
  );
  const [, payload, signature] = token.split(".") as [string, string, string];
  for (const bad of [
    "",
    `${payload}.${signature}`,
    `${token}.extra`,
    `mcp2.${payload}.${signature}`,
    `mcp1..${signature}`,
    `mcp1.${payload}.`,
  ])
    assert.equal(verifyMcpCallerToken(bad, SECRET), null, JSON.stringify(bad));
});

test("a correctly signed token with a missing or malformed claim is refused", () => {
  assert.deepEqual(
    verifyMcpCallerToken(forge(WIRE), SECRET),
    CLAIMS,
    "control",
  );
  const { c: _chat, ...noChat } = WIRE;
  for (const payload of [
    // An unknown claim is refused, not ignored: an older gateway must fail
    // closed on a token carrying a restriction it doesn't understand.
    { ...WIRE, ro: true },
    noChat,
    { ...WIRE, r: "3" },
    { ...WIRE, r: -1 },
    { ...WIRE, r: 1.5 },
    { ...WIRE, s: "GitHub" },
    { ...WIRE, t: "" },
    { ...WIRE, u: "x".repeat(65) },
    { ...WIRE, c: "chat/../other" },
    [],
    "github",
  ])
    assert.equal(
      verifyMcpCallerToken(forge(payload), SECRET),
      null,
      JSON.stringify(payload),
    );
  assert.equal(verifyMcpCallerToken(forgeRaw("{not json"), SECRET), null);
});

test("a token signed with another secret is refused", () => {
  const other = "another-secret-0123456789abcdefghij";
  const token = signMcpCallerToken(CLAIMS, other);
  assert.ok(
    verifyMcpCallerToken(token, other),
    "control: verifies with its own secret",
  );
  assert.equal(verifyMcpCallerToken(token, SECRET), null);
});

test("model-gateway and caller tokens never verify as each other, even with one secret", () => {
  const modelToken = signGatewayToken("profile1", SECRET, CLAIMS.tenantId);
  assert.ok(
    verifyGatewayToken(modelToken, SECRET),
    "control: it is a valid model token",
  );
  assert.equal(verifyMcpCallerToken(modelToken, SECRET), null);
  assert.equal(verifyMcpCallerToken(`mcp1.${modelToken}`, SECRET), null);

  const callerToken = signMcpCallerToken(CLAIMS, SECRET);
  assert.ok(
    verifyMcpCallerToken(callerToken, SECRET),
    "control: it is a valid caller token",
  );
  assert.equal(verifyGatewayToken(callerToken, SECRET), null);
  assert.equal(
    verifyGatewayToken(callerToken.slice("mcp1.".length), SECRET),
    null,
  );
});

test("a token over 2 KB is refused, even when correctly signed", () => {
  // Whitespace after the JSON still parses to valid claims, so only the size
  // cap can refuse this one.
  const big = forgeRaw(`${JSON.stringify(WIRE)}${" ".repeat(2100)}`);
  assert.ok(big.length > 2048);
  assert.equal(verifyMcpCallerToken(big, SECRET), null);
});

test("sign refuses malformed claims and a short secret", () => {
  for (const claims of [
    { ...CLAIMS, connector: "Git Hub" },
    { ...CLAIMS, tenantId: "" },
    { ...CLAIMS, chatId: "a.b" },
    { ...CLAIMS, revision: -1 },
    { ...CLAIMS, revision: Number.NaN },
  ])
    assert.throws(
      () => signMcpCallerToken(claims, SECRET),
      JSON.stringify(claims),
    );
  assert.throws(() => signMcpCallerToken(CLAIMS, "short"), /secret/);
  assert.throws(() => verifyMcpCallerToken("x", "short"), /secret/);
});
