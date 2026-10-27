import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { portInUse } from "./dev-readiness.mjs";

const listen = (host) =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, host, () => resolve(server));
  });

// Regression: on macOS a wildcard bind succeeds while another process listens
// on 127.0.0.1, so a bind check reported the gateway's and adapter's ports free.
test("a listener on IPv4 loopback makes its port in use", async (t) => {
  const server = await listen("127.0.0.1");
  t.after(() => server.close());
  assert.equal(await portInUse(server.address().port), true);
});

test("a listener on IPv6 loopback makes its port in use", async (t) => {
  const server = await listen("::1").catch(() => null);
  if (!server) return t.skip("no IPv6 loopback on this machine");
  t.after(() => server.close());
  assert.equal(await portInUse(server.address().port), true);
});

test("a port nothing listens on is free", async () => {
  const server = await listen("127.0.0.1");
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await portInUse(port), false);
});
