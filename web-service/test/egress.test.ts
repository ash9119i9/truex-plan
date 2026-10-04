import assert from "node:assert/strict";
import {
  createServer as httpServer,
  request,
  type RequestOptions,
} from "node:http";
import { createServer as netServer, connect, type Socket } from "node:net";
import { test, type TestContext } from "node:test";
import { createEgressProxy } from "../src/egress-proxy";
import {
  isPublicAddress,
  publicUrl,
  vettedDestination,
} from "../src/egress-policy";

test("public IP policy rejects all special IPv4/IPv6 and mapped/transition ranges", () => {
  for (const ip of [
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.0.1",
    "192.0.0.9",
    "192.0.2.1",
    "192.88.99.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:8.8.8.8",
    "64:ff9b::808:808",
    "100::1",
    "2001::1",
    "2001:db8::1",
    "2002:0808:0808::1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "fe80::1%eth0",
  ])
    assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of [
    "8.8.8.8",
    "93.184.215.14",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
  ])
    assert.equal(isPublicAddress(ip), true, ip);
});
test("URL policy rejects credentials, private numeric encodings, nondefault ports and internal names", () => {
  for (const url of [
    "file:///etc/passwd",
    "http://a:b@example.com",
    "http://127.1",
    "http://2130706433",
    "http://0x7f000001",
    "https://example.com:80",
    "http://example.com:443",
    "http://service",
    "http://foo.internal",
    "http://foo.local",
    "http://foo.home.arpa",
    "http://foo.onion",
    "https://example.com/\\secret",
    "http://[::1]",
  ])
    assert.throws(() => publicUrl(url), url);
  assert.equal(
    publicUrl("https://EXAMPLE.com.:443/a#hash").href,
    "https://example.com/a",
  );
});
test("all DNS answers must be public, mixed results fail closed, IPv4 is preferred after validating IPv6", async () => {
  const url = publicUrl("https://example.com");
  const mixed = async () => [
    { address: "8.8.8.8", family: 4 },
    { address: "10.1.1.1", family: 4 },
  ];
  await assert.rejects(vettedDestination(url, mixed));
  for (const result of [
    [],
    [{ address: "8.8.8.8", family: 6 }],
    [{ address: "::ffff:8.8.8.8", family: 6 }],
  ])
    await assert.rejects(vettedDestination(url, async () => result));
  assert.deepEqual(
    await vettedDestination(url, async () => [
      { address: "2606:4700:4700::1111", family: 6 },
      { address: "8.8.8.8", family: 4 },
    ]),
    { address: "8.8.8.8", family: 4, port: 443 },
  );
});

async function listen(
  server: ReturnType<typeof httpServer> | ReturnType<typeof netServer>,
  t: TestContext,
) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        if ("closeAllConnections" in server) server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return (server.address() as { port: number }).port;
}
async function proxy(
  t: TestContext,
  options: Parameters<typeof createEgressProxy>[0],
) {
  const p = createEgressProxy(options);
  const port = await listen(p.server, t);
  t.after(() => p.close());
  return port;
}
function get(
  port: number,
  path: string,
  headers = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: "127.0.0.1", port, path, headers, agent: false },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode!, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}
async function tunnel(port: number, authority: string) {
  const socket = connect(port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
  const first = await new Promise<string>((resolve, reject) => {
    socket.once("data", (chunk) => resolve(String(chunk)));
    socket.once("error", reject);
  });
  return { socket, first };
}

test("real HTTP proxy pins vetted IP, preserves origin Host, strips proxy headers, and rechecks DNS on next connection", async (t) => {
  let hits = 0,
    lookupCount = 0;
  const target = httpServer((req, res) => {
    hits++;
    assert.equal(req.headers.host, "example.com");
    assert.equal(req.headers["proxy-authorization"], undefined);
    assert.equal(req.headers["x-hop"], undefined);
    res.end("page");
  });
  const targetPort = await listen(target, t);
  const pinned: RequestOptions[] = [];
  const outboundRequest = ((options: RequestOptions, callback: any) => {
    pinned.push(options);
    return request(
      { ...options, hostname: "127.0.0.1", port: targetPort },
      callback,
    );
  }) as typeof request;
  const port = await proxy(t, {
    resolver: async () => [
      { address: ++lookupCount === 1 ? "8.8.8.8" : "127.0.0.1", family: 4 },
    ],
    outboundRequest,
  });
  assert.deepEqual(
    await get(port, "http://example.com/a", {
      "Proxy-Authorization": "Bearer secret",
      Connection: "x-hop",
      "x-hop": "secret",
    }),
    { status: 200, body: "page" },
  );
  assert.equal(pinned[0].hostname, "8.8.8.8");
  assert.equal(pinned[0].port, 80);
  assert.equal((await get(port, "http://example.com/a")).status, 403);
  assert.equal(hits, 1);
  assert.equal(lookupCount, 2);
});

test("CONNECT validates exact 443 authority and pins public IP before relaying bytes; capacity recovers after disconnect", async (t) => {
  const peers = new Set<Socket>();
  const echo = netServer((socket) => {
    peers.add(socket);
    socket.on("close", () => peers.delete(socket));
    socket.pipe(socket);
  });
  const echoPort = await listen(echo, t);
  t.after(() => {
    for (const peer of peers) peer.destroy();
  });
  const pinned: any[] = [];
  const port = await proxy(t, {
    maxConnections: 1,
    resolver: async () => [{ address: "8.8.8.8", family: 4 }],
    outboundConnect: (options) => {
      pinned.push(options);
      return connect(echoPort, "127.0.0.1");
    },
  });
  for (const authority of [
    "localhost:443",
    "127.0.0.1:443",
    "[::ffff:8.8.8.8]:443",
    "example.com:80",
    "a:b@example.com:443",
    "example.com:443/path",
  ]) {
    const denied = await tunnel(port, authority);
    assert.match(denied.first, /^HTTP\/1.1 403/);
    denied.socket.destroy();
  }
  const first = await tunnel(port, "example.com:443");
  assert.match(first.first, /^HTTP\/1.1 200/);
  assert.equal(pinned[0].host, "8.8.8.8");
  assert.equal(pinned[0].port, 443);
  const reply = new Promise<string>((resolve) =>
    first.socket.once("data", (chunk) => resolve(String(chunk))),
  );
  first.socket.write("encrypted bytes");
  assert.equal(await reply, "encrypted bytes");
  const busy = await tunnel(port, "example.com:443");
  assert.match(busy.first, /^HTTP\/1.1 503/);
  busy.socket.destroy();
  first.socket.destroy();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const after = await tunnel(port, "example.com:443");
  assert.match(after.first, /^HTTP\/1.1 200/);
  after.socket.destroy();
});

test("HTTP disconnect promptly aborts upstream; CONNECT deadline destroys tunnel and releases capacity", async (t) => {
  let closed!: () => void;
  const upstreamClosed = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const target = httpServer((_req, res) => {
    res.on("close", closed);
    res.writeHead(200);
    res.write("waiting");
  });
  const targetPort = await listen(target, t);
  const outboundRequest = ((options: RequestOptions, callback: any) =>
    request(
      { ...options, hostname: "127.0.0.1", port: targetPort },
      callback,
    )) as typeof request;
  const port = await proxy(t, {
    resolver: async () => [{ address: "8.8.8.8", family: 4 }],
    outboundRequest,
  });
  await new Promise<void>((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path: "http://example.com/",
        agent: false,
      },
      (res) =>
        res.once("data", () => {
          req.destroy();
          resolve();
        }),
    );
    req.on("error", reject);
    req.end();
  });
  await Promise.race([
    upstreamClosed,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("orphan upstream")), 500),
    ),
  ]);
  const echo = netServer((socket) => socket.pipe(socket));
  const echoPort = await listen(echo, t);
  const bounded = await proxy(t, {
    deadlineMs: 50,
    maxConnections: 1,
    resolver: async () => [{ address: "8.8.8.8", family: 4 }],
    outboundConnect: () => connect(echoPort, "127.0.0.1"),
  });
  const first = await tunnel(bounded, "example.com:443");
  await new Promise((resolve) => first.socket.once("close", resolve));
  const second = await tunnel(bounded, "example.com:443");
  assert.match(second.first, /^HTTP\/1.1 200/);
  second.socket.destroy();
});
