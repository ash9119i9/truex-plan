import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";
import { loadEgressConfig } from "../src/config";
import {
  createEgress,
  EgressBlockedError,
  isBlockedAddress,
  type ResolvedAddress,
} from "../src/egress";

// Task 10: the gateway reaches only public addresses it checked itself, and
// connects to exactly the address it checked.

let server: Server;
let port = 0;
const seen: Array<{ url: string; headers: IncomingHttpHeaders }> = [];

before(async () => {
  server = createServer((req, res) => {
    seen.push({ url: req.url ?? "", headers: req.headers });
    if (req.url === "/redirect")
      return void res.writeHead(307, { location: "/elsewhere" }).end();
    res
      .writeHead(200, { "content-type": "application/json" })
      .end('{"ok":true}');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  seen.length = 0;
});

// A resolver that answers each lookup with the next answer (the last one
// repeats), recording every host it was asked for.
function resolveTo(...answers: ResolvedAddress[][]) {
  const calls: string[] = [];
  return {
    calls,
    resolve: async (host: string) => {
      calls.push(host);
      return answers[Math.min(calls.length - 1, answers.length - 1)]!;
    },
  };
}
const v4 = (address: string): ResolvedAddress => ({ address, family: 4 });
const v6 = (address: string): ResolvedAddress => ({ address, family: 6 });

// The ranges the acceptance criteria name, plus CGNAT.
const BLOCKED = [
  v4("127.0.0.1"),
  v4("10.1.2.3"),
  v4("169.254.169.254"),
  v4("100.64.0.1"),
  v6("::1"),
  v6("fd00::1"),
  v6("::ffff:10.0.0.1"),
];

describe("egress: address checks", () => {
  test("blocked and allowed addresses", () => {
    for (const { address } of BLOCKED)
      assert.equal(isBlockedAddress(address), true, address);
    for (const address of ["8.8.8.8", "2606:4700::1111", "::ffff:8.8.8.8"])
      assert.equal(isBlockedAddress(address), false, address);
  });

  test("a host that resolves to a blocked address is refused before connecting", async () => {
    for (const address of BLOCKED) {
      const { resolve } = resolveTo([address]);
      // A refusal is EgressBlockedError; a connection attempt would fail
      // with a socket error instead.
      await assert.rejects(
        createEgress({ resolve }).fetch("https://mcp.example.test/mcp"),
        EgressBlockedError,
        address.address,
      );
    }
  });

  test("an address written in the URL is checked too", async () => {
    const egress = createEgress();
    for (const url of [
      "https://127.0.0.1/mcp",
      "https://10.0.0.1/mcp",
      "https://169.254.169.254/",
      "https://[::1]/mcp",
      "https://[fc00::1]/mcp",
      "https://[::ffff:10.0.0.1]/mcp",
    ])
      await assert.rejects(egress.fetch(url), EgressBlockedError, url);
  });

  test("one blocked address among several refuses the host", async () => {
    const { resolve } = resolveTo([v4("127.0.0.1"), v4("10.0.0.1")]);
    await assert.rejects(
      createEgress({ allowLoopback: true, resolve }).fetch(
        `http://mixed.example.test:${port}/mcp`,
      ),
      EgressBlockedError,
    );
    assert.deepEqual(seen, [], "nothing was sent");
  });

  test("loopback is refused unless allowed, and is the only thing allowLoopback opens", async () => {
    await assert.rejects(
      createEgress().fetch(`http://127.0.0.1:${port}/mcp`),
      EgressBlockedError,
    );
    const { resolve } = resolveTo([v4("8.8.8.8")]);
    // http is for loopback fixtures only, even with the flag.
    await assert.rejects(
      createEgress({ allowLoopback: true, resolve }).fetch(
        "http://public.example.test/mcp",
      ),
      EgressBlockedError,
    );
    assert.deepEqual(seen, []);
  });

  test("credentials in the URL are refused", async () => {
    await assert.rejects(
      createEgress({ allowLoopback: true }).fetch(
        `http://user:pass@127.0.0.1:${port}/mcp`,
      ),
      EgressBlockedError,
    );
    assert.deepEqual(seen, []);
  });
});

describe("egress: rebinding", () => {
  test("the connection goes to the checked address, keeping the original host", async () => {
    // A second lookup would answer a private address; it must never happen.
    const { calls, resolve } = resolveTo([v4("127.0.0.1")], [v4("10.0.0.1")]);
    const res = await createEgress({ allowLoopback: true, resolve }).fetch(
      `http://rebind.example.test:${port}/mcp`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.deepEqual(
      calls,
      ["rebind.example.test"],
      "resolved once, by the check",
    );
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.headers.host, `rebind.example.test:${port}`);
  });
});

describe("egress: responses", () => {
  test("a redirect is returned as is, never followed", async () => {
    const res = await createEgress({ allowLoopback: true }).fetch(
      `http://127.0.0.1:${port}/redirect`,
    );
    assert.equal(res.status, 307);
    assert.deepEqual(
      seen.map((s) => s.url),
      ["/redirect"],
    );
  });
});

describe("egress config", () => {
  test("loopback is off by default and refused outside local dev", () => {
    const problems: string[] = [];
    assert.deepEqual(loadEgressConfig({}, problems), { allowLoopback: false });
    assert.deepEqual(
      loadEgressConfig({ CONNECTORS_ALLOW_LOOPBACK: "1" }, problems),
      { allowLoopback: true },
    );
    assert.deepEqual(problems, []);

    for (const env of [
      { CONNECTORS_ALLOW_LOOPBACK: "1", NODE_ENV: "production" },
      // A deployed gateway listens beyond loopback.
      { CONNECTORS_ALLOW_LOOPBACK: "1", HOST: "0.0.0.0" },
    ]) {
      const refused: string[] = [];
      assert.deepEqual(loadEgressConfig(env, refused), {
        allowLoopback: false,
      });
      assert.match(
        refused.join(" "),
        /CONNECTORS_ALLOW_LOOPBACK/,
        JSON.stringify(env),
      );
    }
  });
});
