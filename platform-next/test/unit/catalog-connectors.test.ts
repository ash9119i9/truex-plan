import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ObjectId } from "mongodb";
import { parseConnectorSpec } from "../../src/modules/connectors/connector";
import { applyNetworkGrants } from "../../src/modules/network/network-grants";
import {
  buildNetworkPolicy,
  type RunNetworkConnector,
} from "../../src/modules/network/network-policy";

// The connector definitions the product team loads with the operator CLI
// (catalog/connectors). Each is data only: adding Gmail's network rules after
// GitHub's needed no connector-specific code (coding plan task 17).

const DIR = join(__dirname, "../../catalog/connectors");
const load = (slug: string) =>
  parseConnectorSpec(
    JSON.parse(readFileSync(join(DIR, `${slug}.json`), "utf8")) as unknown,
  );

function connection(slug: string, token: string): RunNetworkConnector {
  const spec = load(slug);
  const egress = spec.egress!;
  return {
    name: spec.slug,
    displayName: spec.displayName,
    access: "read_write",
    hosts: egress.hosts,
    reads: egress.reads,
    critical: egress.critical,
    credential: { ...egress.credential!, token },
  };
}

describe("catalog connector definitions", () => {
  test("GitHub writes go through approved MCP tools; deletes and merges ask every time", () => {
    const github = load("github");
    assert.deepEqual(github.criticalTools, [
      "delete_file",
      "merge_pull_request",
    ]);
    for (const tool of [
      "create_or_update_file",
      "push_files",
      "create_pull_request",
    ])
      assert.ok(github.writeTools?.includes(tool), tool);
    // The sandbox reads (clone, fetch) and nothing else passes unasked.
    const reads = github.egress!.reads;
    assert.deepEqual(reads[0]!.methods, ["GET", "HEAD"]);
    assert.deepEqual(reads[1]!.paths, ["/**/git-upload-pack"]);
    assert.ok(!JSON.stringify(reads).includes("receive-pack"));
  });

  test("Gmail's network data is valid and sends always ask", () => {
    const gmail = load("gmail");
    assert.equal(
      gmail.egress!.credential!.urlPrefixes[0],
      "https://gmail.googleapis.com/",
    );
    assert.ok(
      gmail.egress!.critical.some((rule) =>
        rule.paths?.includes("/gmail/v1/users/*/messages/send"),
      ),
    );
  });

  test("both connections in one run keep separate hosts, tokens and rules", () => {
    const policy = buildNetworkPolicy({
      tenantHosts: [],
      connectors: [
        connection("github", "gh-token"),
        connection("gmail", "g-token"),
      ],
    });
    const [github, gmail] = policy.connectors;
    assert.ok(github!.hosts.includes("api.github.com"));
    assert.ok(gmail!.hosts.includes("gmail.googleapis.com"));
    assert.ok(!github!.hosts.some((h) => gmail!.hosts.includes(h)));
    assert.equal(github!.credential!.token, "gh-token");
    assert.equal(gmail!.credential!.token, "g-token");
    assert.ok(
      gmail!.credential!.urlPrefixes.every((p) =>
        p.startsWith("https://gmail.googleapis.com/"),
      ),
    );
    // A chat allow for one connection never widens the other.
    const { policy: widened } = applyNetworkGrants(policy, [
      {
        messageId: new ObjectId(),
        host: "gmail.googleapis.com",
        connector: "github",
        method: "POST",
        scope: "chat",
        at: new Date(),
      },
    ]);
    assert.deepEqual(widened, policy);
  });
});
