import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { DomainError } from "../../src/common/domain-error";
import {
  applyNetworkGrants,
  blockGrant,
  decisionAllowed,
  networkBlockOf,
  parseNetworkDecision,
  reconcileBlock,
  type ChatNetworkGrant,
} from "../../src/modules/network/network-grants";
import type {
  RunNetworkConnector,
  RunNetworkPolicy,
} from "../../src/modules/network/network-policy";

function connector(
  overrides: Partial<RunNetworkConnector> = {},
): RunNetworkConnector {
  return {
    name: "github",
    displayName: "GitHub",
    access: "read_write",
    hosts: ["github.com", "api.github.com"],
    reads: [{ methods: ["GET", "HEAD"] }],
    critical: [{ methods: ["DELETE"] }],
    ...overrides,
  };
}

function policy(
  connectors: RunNetworkConnector[] = [connector()],
): RunNetworkPolicy {
  return { hosts: ["pypi.org"], connectors };
}

function grant(overrides: Partial<ChatNetworkGrant>): ChatNetworkGrant {
  return {
    messageId: new ObjectId(),
    host: "docs.example.com",
    scope: "chat",
    at: new Date(),
    ...overrides,
  };
}

describe("network cards: what a block may offer", () => {
  test("the widest answer is recomputed, whatever the runtime claims", () => {
    assert.equal(
      blockGrant("unlisted", "docs.example.com", "CONNECT", false),
      "chat",
    );
    for (const host of [
      "127.0.0.1",
      "169.254.169.254",
      "intranet.corp",
      "localhost",
    ])
      assert.equal(
        blockGrant("unlisted", host, "CONNECT", false),
        "none",
        host,
      );
    assert.equal(blockGrant("write", "api.github.com", "POST", false), "chat");
    assert.equal(blockGrant("write", "api.github.com", "DELETE", true), "once");
    assert.equal(
      blockGrant("write", "api.github.com", "CONNECT", false),
      "none",
    );
    assert.equal(
      blockGrant("read_only", "api.github.com", "POST", false),
      "none",
    );
    assert.equal(
      blockGrant("refused", "docs.example.com", "GET", false),
      "none",
    );
  });

  test("a malformed block is dropped; a valid one keeps only known fields", () => {
    assert.equal(
      networkBlockOf({ host: "a b", method: "GET", kind: "unlisted" }),
      null,
    );
    assert.equal(
      networkBlockOf({ host: "x.com", method: "get", kind: "unlisted" }),
      null,
    );
    assert.equal(
      networkBlockOf({ host: "x.com", method: "GET", kind: "other" }),
      null,
    );
    // A write names its connector; a site does not.
    assert.equal(
      networkBlockOf({ host: "x.com", method: "POST", kind: "write" }),
      null,
    );
    assert.equal(
      networkBlockOf({
        host: "x.com",
        method: "GET",
        kind: "unlisted",
        connector: { name: "a", displayName: "A" },
      }),
      null,
    );
    assert.deepEqual(
      networkBlockOf({
        host: "api.github.com",
        method: "DELETE",
        kind: "write",
        critical: true,
        grant: "chat",
        extra: "ignored",
        connector: {
          name: "github",
          displayName: "GitHub",
          account: "octo",
          x: 1,
        },
      }),
      {
        host: "api.github.com",
        method: "DELETE",
        kind: "write",
        connector: { name: "github", displayName: "GitHub", account: "octo" },
        critical: true,
        grant: "once",
      },
    );
  });

  test("only the answers a card offered are accepted", () => {
    assert.equal(decisionAllowed("chat", "allow_for_chat"), true);
    assert.equal(decisionAllowed("once", "allow_for_chat"), false);
    assert.equal(decisionAllowed("once", "allow_once"), true);
    assert.equal(decisionAllowed("none", "allow_once"), false);
    assert.equal(decisionAllowed("none", "keep_blocked"), true);
    assert.equal(
      parseNetworkDecision({ decision: "allow_once" }),
      "allow_once",
    );
    assert.throws(
      () => parseNetworkDecision({ decision: "always" }),
      (e: unknown) => e instanceof DomainError && e.code === "INVALID_INPUT",
    );
    assert.throws(() =>
      parseNetworkDecision({ decision: "allow_once", host: "x" }),
    );
  });
});

describe("network grants widen the next run, checked again", () => {
  test("no grants leave the policy as it is", () => {
    const base = policy();
    assert.deepEqual(applyNetworkGrants(base, undefined), {
      policy: base,
      onceIds: [],
    });
  });

  test("a site grant adds a public host; a private or connection host is never added", () => {
    const once = grant({ host: "files.example.org", scope: "once" });
    const { policy: next, onceIds } = applyNetworkGrants(policy(), [
      grant({ host: "docs.example.com" }),
      once,
      grant({ host: "127.0.0.1" }),
      grant({ host: "metadata.google.internal" }),
      // A connection's host keeps its method rules.
      grant({ host: "api.github.com" }),
    ]);
    assert.deepEqual(next.hosts, [
      "docs.example.com",
      "files.example.org",
      "pypi.org",
    ]);
    assert.deepEqual(onceIds, [once.messageId]);
    assert.deepEqual(next.connectors[0]!.reads, [{ methods: ["GET", "HEAD"] }]);
  });

  test("a write grant adds one method on one host of a connection that may write", () => {
    const { policy: next } = applyNetworkGrants(policy(), [
      grant({ host: "api.github.com", connector: "github", method: "POST" }),
    ]);
    assert.deepEqual(next.connectors[0]!.reads, [
      { methods: ["GET", "HEAD"] },
      { methods: ["POST"], hosts: ["api.github.com"] },
    ]);
  });

  test("a critical write is added only once, never for the chat", () => {
    const chat = grant({
      host: "api.github.com",
      connector: "github",
      method: "DELETE",
    });
    const once = grant({
      host: "api.github.com",
      connector: "github",
      method: "DELETE",
      scope: "once",
    });
    assert.equal(
      applyNetworkGrants(policy(), [chat]).policy.connectors[0]!.reads.length,
      1,
    );
    const used = applyNetworkGrants(policy(), [once]);
    assert.equal(used.policy.connectors[0]!.reads.length, 2);
    assert.deepEqual(used.onceIds, [once.messageId]);
  });

  test("a grant for a connection not in this run, read-only, or another host does nothing", () => {
    const grants = [
      grant({ host: "api.github.com", connector: "gmail", method: "POST" }),
      grant({ host: "evil.example.com", connector: "github", method: "POST" }),
      grant({
        host: "api.github.com",
        connector: "github",
        method: "POST",
        scope: "once",
      }),
    ];
    const readOnly = applyNetworkGrants(
      policy([connector({ access: "read_only" })]),
      grants,
    );
    assert.equal(readOnly.policy.connectors[0]!.reads.length, 1);
    // An unused once grant stays for a run that can use it.
    assert.deepEqual(readOnly.onceIds, []);
    const none = applyNetworkGrants(policy([]), grants);
    assert.deepEqual(none.policy.connectors, []);
    assert.deepEqual(none.policy.hosts, ["pypi.org"]);
  });

  test("the input policy is not changed", () => {
    const base = policy();
    applyNetworkGrants(base, [
      grant({ host: "api.github.com", connector: "github", method: "POST" }),
      grant({ host: "docs.example.com" }),
    ]);
    assert.deepEqual(base, policy());
  });
});

describe("a block is checked against the run's own policy", () => {
  const block = (overrides: Record<string, unknown> = {}) =>
    networkBlockOf({
      host: "api.github.com",
      method: "POST",
      kind: "write",
      critical: false,
      connector: { name: "github", displayName: "GitHub" },
      ...overrides,
    })!;

  test("critical comes from the catalog rules, not the runtime", () => {
    const spoofed = reconcileBlock(block({ method: "DELETE" }), policy());
    assert.deepEqual([spoofed.critical, spoofed.grant], [true, "once"]);
    const plain = reconcileBlock(block({ critical: true }), policy());
    assert.deepEqual([plain.critical, plain.grant], [false, "chat"]);
  });

  test("a read-only connection, an unknown one or a foreign host is never offered", () => {
    assert.equal(
      reconcileBlock(block(), policy([connector({ access: "read_only" })]))
        .grant,
      "none",
    );
    assert.equal(reconcileBlock(block(), policy([])).grant, "none");
    assert.equal(reconcileBlock(block(), undefined).grant, "none");
    assert.equal(
      reconcileBlock(block({ host: "evil.example.com" }), policy()).grant,
      "none",
    );
  });

  test("a site block passes through unchanged", () => {
    const site = networkBlockOf({
      host: "docs.example.com",
      method: "CONNECT",
      kind: "unlisted",
    })!;
    assert.deepEqual(reconcileBlock(site, policy()), site);
  });
});
