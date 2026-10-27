import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  discoverEndpoints,
  DiscoveryError,
} from "../../src/modules/connectors/oauth-discovery";
import {
  startConnectorFixture,
  type ConnectorFixture,
} from "../support/connector-fixtures";

// The connectors module must hard-code no provider URL: every endpoint is read
// from the server's metadata at run time. A provider id is allowed only inside
// a comment (documentation of GitHub's behaviour).
describe("no hard-coded provider URL in the connectors source", () => {
  const SOURCE_DIR = join(
    __dirname,
    "..",
    "..",
    "src",
    "modules",
    "connectors",
  );
  // Patterns that would mean a provider endpoint was baked into the code.
  const PROVIDER =
    /github\.com|githubcopilot\.com|api\.github|google\.com|googleapis\.com/i;

  // A conservative line-level comment stripper: enough to tell a documentation
  // mention from a real string literal in this well-formatted source.
  function stripComments(source: string): string {
    const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, "");
    return withoutBlocks
      .split("\n")
      .map((line) => {
        const idx = line.indexOf("//");
        return idx >= 0 ? line.slice(0, idx) : line;
      })
      .join("\n");
  }

  test("no provider host appears outside comments", () => {
    const offenders: string[] = [];
    for (const name of readdirSync(SOURCE_DIR)) {
      if (!name.endsWith(".ts")) continue;
      const code = stripComments(readFileSync(join(SOURCE_DIR, name), "utf8"));
      if (PROVIDER.test(code)) offenders.push(name);
    }
    assert.deepEqual(
      offenders,
      [],
      `provider URL found outside comments in: ${offenders.join(", ")}`,
    );
  });
});

describe("discoverEndpoints against the fixture", () => {
  let fixture: ConnectorFixture;

  before(async () => {
    fixture = await startConnectorFixture();
  });

  after(async () => {
    await fixture.close();
  });

  test("reads every endpoint from the server's metadata", async () => {
    const endpoints = await discoverEndpoints({
      connectorUrl: fixture.mcpUrl,
      allowLoopback: true,
    });
    assert.equal(endpoints.issuer, fixture.issuer);
    assert.equal(
      endpoints.authorizationEndpoint,
      `${fixture.origin}/login/oauth/authorize`,
    );
    assert.equal(
      endpoints.tokenEndpoint,
      `${fixture.origin}/login/oauth/access_token`,
    );
    assert.equal(
      endpoints.revocationEndpoint,
      `${fixture.origin}/login/oauth/revoke`,
    );
    assert.equal(endpoints.issParameterSupported, true);
  });

  test("refuses a loopback server when loopback is not allowed", async () => {
    await assert.rejects(
      discoverEndpoints({ connectorUrl: fixture.mcpUrl, allowLoopback: false }),
      DiscoveryError,
    );
  });
});
