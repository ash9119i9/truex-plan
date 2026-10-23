import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { DomainError } from "../../src/common/domain-error";
import { parseConnectorSpec } from "../../src/modules/connectors/connector";
import { egressHost } from "../../src/modules/network/network-host";
import {
  BASELINE_HOSTS,
  buildNetworkPolicy,
  parseConnectorEgress,
  type RunNetworkConnector,
} from "../../src/modules/network/network-policy";
import { parseUpdateTenantNetwork } from "../../src/modules/network/tenant-network.service";

const MCP_URL = "https://api.githubcopilot.com/mcp";

function invalidInput(run: () => unknown, pattern?: RegExp): void {
  assert.throws(
    run,
    (error: unknown) =>
      error instanceof DomainError &&
      error.code === "INVALID_INPUT" &&
      (!pattern || pattern.test(error.message)),
  );
}

function egress(overrides: Record<string, unknown> = {}): unknown {
  return {
    hosts: ["api.githubcopilot.com", "github.com", "api.github.com"],
    credential: {
      auth: ["basic", "bearer"],
      urlPrefixes: ["https://github.com/", "https://api.github.com/"],
      tokenPattern: "ghu_[A-Za-z0-9_]{30,251}",
    },
    reads: [
      { methods: ["GET", "HEAD"] },
      {
        methods: ["POST"],
        hosts: ["github.com"],
        paths: ["/**/git-upload-pack"],
      },
    ],
    critical: [{ methods: ["DELETE"] }],
    ...overrides,
  };
}

describe("egressHost", () => {
  test("accepts exact public names and lowercases them", () => {
    assert.equal(egressHost("API.GitHub.com", "h"), "api.github.com");
    assert.equal(egressHost("xn--bcher-kva.de", "h"), "xn--bcher-kva.de");
  });

  test("refuses addresses, wildcards, ports and private zones", () => {
    for (const host of [
      "169.254.169.254",
      "127.0.0.1",
      "10.0.0.1",
      "0x7f.1",
      "::1",
      "[::1]",
      "fd00::1",
      "*.github.com",
      "github.com:443",
      "localhost",
      "metadata.google.internal",
      "printer.local",
      "router.home.arpa",
      "1.0.0.127.in-addr.arpa",
      "intranet",
      "a..b.com",
      "-bad.com",
      "",
      "a".repeat(64) + ".com",
    ])
      invalidInput(() => egressHost(host, "h"));
  });

  test("never echoes the refused value", () => {
    assert.throws(
      () => egressHost("secret-db.internal", "hosts[0]"),
      (error: unknown) =>
        error instanceof DomainError &&
        error.message.includes("hosts[0]") &&
        !error.message.includes("secret-db"),
    );
  });
});

describe("parseConnectorEgress", () => {
  test("accepts GitHub's data", () => {
    const parsed = parseConnectorEgress(egress(), MCP_URL);
    assert.deepEqual(parsed.hosts, [
      "api.githubcopilot.com",
      "github.com",
      "api.github.com",
    ]);
    assert.equal(parsed.credential?.urlPrefixes.length, 2);
    assert.equal(parsed.reads.length, 2);
  });

  test("reads default to GET and HEAD, critical to none", () => {
    const parsed = parseConnectorEgress(
      { hosts: ["api.githubcopilot.com"] },
      MCP_URL,
    );
    assert.deepEqual(parsed.reads, [{ methods: ["GET", "HEAD"] }]);
    assert.deepEqual(parsed.critical, []);
    assert.equal(parsed.credential, undefined);
  });

  test("the MCP url's host must be declared", () => {
    invalidInput(
      () => parseConnectorEgress(egress({ hosts: ["github.com"] }), MCP_URL),
      /host of url/,
    );
  });

  test("refuses IP literals and private names in hosts", () => {
    invalidInput(() =>
      parseConnectorEgress(
        egress({ hosts: ["api.githubcopilot.com", "169.254.169.254"] }),
        MCP_URL,
      ),
    );
    invalidInput(() =>
      parseConnectorEgress(
        egress({ hosts: ["api.githubcopilot.com", "vault.internal"] }),
        MCP_URL,
      ),
    );
  });

  test("a token may only go to prefixes on the connector's own hosts", () => {
    const bad = (urlPrefixes: unknown[]) =>
      invalidInput(() =>
        parseConnectorEgress(
          egress({
            credential: {
              auth: ["bearer"],
              urlPrefixes,
              tokenPattern: "ghu_[A-Za-z0-9]{36}",
            },
          }),
          MCP_URL,
        ),
      );
    bad(["https://evil.com/"]);
    bad(["http://github.com/"]);
    bad(["https://github.com:8443/"]);
    bad(["https://github.com/repos"]);
    bad(["https://user@github.com/"]);
    bad(["https://github.com/?x=1"]);
    bad([]);
  });

  test("the token pattern must be a bounded token format", () => {
    for (const tokenPattern of [
      ".*",
      "ghu_.+",
      "ghu_[a-z]{4,}",
      "^ghu_[a-z]{36}$",
      "[",
      "abc",
      "ghu [a-z]{36}",
    ])
      invalidInput(() =>
        parseConnectorEgress(
          egress({
            credential: {
              auth: ["bearer"],
              urlPrefixes: ["https://github.com/"],
              tokenPattern,
            },
          }),
          MCP_URL,
        ),
      );
  });

  test("rules name only known methods and the connector's hosts", () => {
    invalidInput(() =>
      parseConnectorEgress(
        egress({ reads: [{ methods: ["CONNECT"] }] }),
        MCP_URL,
      ),
    );
    invalidInput(() =>
      parseConnectorEgress(egress({ reads: [{ methods: [] }] }), MCP_URL),
    );
    invalidInput(() =>
      parseConnectorEgress(
        egress({ critical: [{ methods: ["DELETE"], hosts: ["gitlab.com"] }] }),
        MCP_URL,
      ),
    );
    invalidInput(() =>
      parseConnectorEgress(
        egress({ reads: [{ methods: ["GET"], paths: ["no-slash"] }] }),
        MCP_URL,
      ),
    );
    invalidInput(
      () =>
        parseConnectorEgress(
          egress({ reads: [{ methods: ["GET"], extra: true }] }),
          MCP_URL,
        ),
      /Unknown field/,
    );
  });

  test("unknown egress fields are refused", () => {
    invalidInput(
      () => parseConnectorEgress(egress({ sandbox: true }), MCP_URL),
      /Unknown field/,
    );
  });

  test("parseConnectorSpec keeps egress and checks it against url", () => {
    const base = {
      slug: "github",
      displayName: "GitHub",
      description: "d",
      icon: "github",
      url: "https://api.githubcopilot.com/mcp/",
      auth: {
        type: "oauth_user",
        registration: "preregistered",
        clientId: "Iv1.abc",
        clientSecret: { env: "GITHUB_SECRET" },
        scopes: [],
        discovery: "protected_resource_metadata",
      },
    };
    const spec = parseConnectorSpec({ ...base, egress: egress() });
    assert.equal(spec.egress?.hosts[0], "api.githubcopilot.com");
    assert.equal(parseConnectorSpec(base).egress, undefined);
    invalidInput(
      () => parseConnectorSpec({ ...base, egress: { hosts: ["github.com"] } }),
      /host of url/,
    );
  });
});

describe("buildNetworkPolicy", () => {
  const github: RunNetworkConnector = {
    name: "github",
    displayName: "GitHub",
    access: "read_write",
    hosts: ["github.com", "api.github.com"],
    reads: [{ methods: ["GET", "HEAD"] }],
    critical: [],
  };

  test("baseline plus tenant hosts, sorted and without duplicates", () => {
    const policy = buildNetworkPolicy({
      tenantHosts: ["docs.acme.com", "pypi.org"],
      connectors: [],
    });
    assert.deepEqual(
      policy.hosts,
      [...new Set([...BASELINE_HOSTS, "docs.acme.com"])].sort(),
    );
    assert.deepEqual(policy.connectors, []);
  });

  test("a connection's hosts leave the plain list and keep its rules", () => {
    const policy = buildNetworkPolicy({
      tenantHosts: ["github.com", "docs.acme.com"],
      connectors: [github],
    });
    assert.equal(policy.hosts.includes("github.com"), false);
    assert.equal(policy.hosts.includes("docs.acme.com"), true);
    assert.deepEqual(policy.connectors, [github]);
  });
});

describe("parseUpdateTenantNetwork", () => {
  test("sorts hosts and requires a revision", () => {
    assert.deepEqual(
      parseUpdateTenantNetwork({
        hosts: ["b.acme.com", "a.acme.com"],
        revision: 0,
      }),
      { hosts: ["a.acme.com", "b.acme.com"], revision: 0 },
    );
    invalidInput(() => parseUpdateTenantNetwork({ hosts: [] }), /revision/);
  });

  test("refuses private hosts, duplicates and too many", () => {
    invalidInput(() =>
      parseUpdateTenantNetwork({ hosts: ["10.0.0.5"], revision: 0 }),
    );
    invalidInput(
      () =>
        parseUpdateTenantNetwork({
          hosts: ["a.acme.com", "A.acme.com"],
          revision: 0,
        }),
      /twice/,
    );
    invalidInput(() =>
      parseUpdateTenantNetwork({
        hosts: Array.from({ length: 51 }, (_, i) => `h${i}.acme.com`),
        revision: 0,
      }),
    );
    invalidInput(
      () =>
        parseUpdateTenantNetwork({
          hosts: ["a.acme.com"],
          revision: 0,
          extra: 1,
        }),
      /Unknown field/,
    );
  });
});
