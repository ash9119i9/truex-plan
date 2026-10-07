// Evidence rig, not a test: measures the public-demo paths under load against
// the real platform in Google mode. Run with:  npx tsx test/load.rig.ts
// Numbers it prints are measurements on this machine only; they are not
// capacity claims. Parameters are chosen here, not by the operator.
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { startPlatform, waitFor, sleep, root, type Claims } from "./harness";

const claims = (n: string): Claims => ({
  sub: `sub-${n}`,
  email: `${n}@gmail.com`,
  email_verified: true,
  name: n,
});
const pct = (xs: number[], p: number) =>
  [...xs].sort((a, b) => a - b)[
    Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))
  ];
const fs = require("node:fs");
const descendants = (pid: number): number[] => {
  let kids: number[] = [];
  try {
    kids = fs
      .readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number);
  } catch {}
  return [pid, ...kids.flatMap(descendants)];
};
const rssOf = (pid: number) => {
  try {
    return (
      Number(
        fs
          .readFileSync(`/proc/${pid}/status`, "utf8")
          .match(/VmRSS:\s+(\d+)/)![1],
      ) / 1024
    );
  } catch {
    return 0;
  }
};
// The platform runs as a child of the tsx launcher; count them all.
const rss = (pid: number) =>
  descendants(pid).reduce((sum, p) => sum + rssOf(p), 0);

async function main() {
  const SIGNUPS = Number(process.env.SIGNUPS ?? 40);
  const STREAMS = Number(process.env.STREAMS ?? 200);
  const REVAL = 2000;
  const p = await startPlatform({
    env: {
      DEMO_TENANT_ID: "demo",
      DEMO_DAILY_TURNS_GLOBAL: "100000",
      DEMO_DAILY_SIGNUPS: "100000",
      DEMO_CACHE_MS: "500",
      STREAM_REVALIDATE_MS: String(REVAL),
      STREAMS_PER_USER_MAX: "1000",
    },
  });
  const { store } = p;
  try {
    await p.workspace("demo", "Demo");
    await p.approveDemoModel("demo");
    await store.tenantRegistry.updateOne(
      { _id: "demo" },
      { $set: { admissionPolicy: "open" } },
    );
    await sleep(700);

    // 1. Signup contention: N distinct new Google accounts at once, then the same account N times at once.
    const t0 = Date.now();
    const lat: number[] = [];
    const results = await Promise.all(
      Array.from({ length: SIGNUPS }, async (_, i) => {
        const s = Date.now();
        const r = await p.signIn(claims(`load${i}`));
        lat.push(Date.now() - s);
        return !!r.cookie;
      }),
    );
    console.log(
      `signup: ${SIGNUPS} distinct accounts in parallel: ${results.filter(Boolean).length} succeeded, wall ${Date.now() - t0} ms, per-flow p50 ${pct(lat, 50)} ms p95 ${pct(lat, 95)} ms max ${Math.max(...lat)} ms`,
    );
    console.log(
      `        users=${await store.users.countDocuments({ googleSub: /^sub-load/ })} demo memberships=${await store.memberships.countDocuments({ tenantId: "demo" })}`,
    );
    const same = await Promise.all(
      Array.from({ length: SIGNUPS }, () => p.signIn(claims("sameperson"))),
    );
    const failed = same
      .filter((r) => !r.cookie)
      .map((r) => r.location.searchParams.get("error"));
    console.log(
      `        one account x${SIGNUPS} in parallel: ${same.filter((r) => r.cookie).length} sessions${failed.length ? ` (refused: ${failed.join(",")})` : ""}, users=${await store.users.countDocuments({ googleSub: "sub-sameperson" })} memberships=${await store.memberships.countDocuments({ userId: (await store.users.findOne({ googleSub: "sub-sameperson" }))!._id })}`,
    );

    // 2. Per-request cost: queries per /api/me and per authenticated list call.
    const cookie = await p.session(claims("measure"));
    const ops = async () =>
      (await store.client.db("admin").command({ serverStatus: 1 })).opcounters;
    const delta = async (fn: () => Promise<unknown>, n: number) => {
      const before = await ops();
      for (let i = 0; i < n; i++) await fn();
      const after = await ops();
      return ["query", "insert", "update", "delete", "command"]
        .map((k) => `${k}=${((after[k] - before[k]) / n).toFixed(1)}`)
        .join(" ");
    };
    const a = await p.request(cookie, "POST", "/api/agents", {
      name: "M",
      description: "d",
      systemPrompt: "s",
      modelProfileId: "demo-model",
    });
    await p.request(cookie, "POST", "/api/sessions", { agentId: a.data.id });
    for (const [name, path] of [
      ["/api/me", "/api/me"],
      ["/api/agents", "/api/agents"],
      ["/api/sessions", "/api/sessions"],
      ["/api/projects", "/api/projects"],
    ] as const)
      console.log(
        `per request ${name.padEnd(14)} server ops/request: ${await delta(() => p.request(cookie, "GET", path), 20)}`,
      );

    // 3. Many live streams: memory, timers and revalidation load; then mass revocation.
    const platformPid = p.pid;
    const baseRss = rss(platformPid);
    const people = await Promise.all(
      Array.from({ length: 20 }, (_, i) => p.session(claims(`viewer${i}`))),
    );
    const sess: string[] = [];
    for (const [i, c] of people.entries()) {
      const ag = await p.request(c, "POST", "/api/agents", {
        name: `V${i}`,
        description: "d",
        systemPrompt: "s",
        modelProfileId: "demo-model",
      });
      sess.push(
        (await p.request(c, "POST", "/api/sessions", { agentId: ag.data.id }))
          .data._id,
      );
    }
    const controllers: AbortController[] = [];
    const closed: number[] = [];
    let revokedAt = 0;
    const started = Date.now();
    await Promise.all(
      Array.from({ length: STREAMS }, async (_, i) => {
        const c = new AbortController();
        controllers.push(c);
        const res = await fetch(
          `${p.base}/api/sessions/${sess[i % sess.length]}/events`,
          {
            headers: {
              cookie: people[i % people.length],
              "x-forwarded-for": p.nextIp(),
            },
            signal: c.signal,
          },
        );
        if (res.status !== 200) throw new Error("stream " + res.status);
        (async () => {
          try {
            const reader = res.body!.getReader();
            for (;;) {
              const { done } = await reader.read();
              if (done) break;
            }
          } catch {}
          if (revokedAt) closed.push(Date.now() - revokedAt);
        })();
      }),
    );
    console.log(
      `streams: ${STREAMS} open in ${Date.now() - started} ms; platform RSS ${baseRss.toFixed(0)} MB -> ${rss(platformPid).toFixed(0)} MB (${(((rss(platformPid) - baseRss) / STREAMS) * 1024).toFixed(0)} KB per stream)`,
    );
    const q0 = await ops();
    await sleep(10_000);
    const q1 = await ops();
    console.log(
      `        revalidation every ${REVAL} ms: ${((q1.query - q0.query) / 10).toFixed(0)} queries/s on the database for ${STREAMS} idle streams (${((q1.query - q0.query) / 10 / STREAMS).toFixed(2)} per stream per second)`,
    );
    // Remove every viewer's membership at once and time how long the streams take to close.
    for (let i = 0; i < people.length; i++) {
      const u = await store.users.findOne({ googleSub: `sub-viewer${i}` });
      await store.memberships.updateOne(
        { userId: u!._id, tenantId: "demo" },
        { $set: { status: "removed" } },
      );
    }
    revokedAt = Date.now();
    await waitFor(() => closed.length >= STREAMS, {
      timeout: 60_000,
      what: "all streams to close",
    });
    console.log(
      `        mass revocation: all ${STREAMS} streams closed; p50 ${pct(closed, 50)} ms p95 ${pct(closed, 95)} ms max ${Math.max(...closed)} ms after the membership change (check interval ${REVAL} ms)`,
    );
    await sleep(500);
    console.log(
      `        platform RSS after the streams closed: ${rss(platformPid).toFixed(0)} MB; open upstream streams at the fake core: ${p.core.openStreams()}`,
    );

    // 4. Revocation across two platform instances sharing one database.
    const port2 = 4999;
    let logs2 = "";
    const second = spawn(
      process.execPath,
      [resolve(root, "platform/node_modules/tsx/dist/cli.mjs"), "src/index.ts"],
      {
        cwd: resolve(root, "platform"),
        env: {
          ...process.env,
          DOTENV_CONFIG_PATH: "/nonexistent",
          PORT: String(port2),
          MONGO_URI: p.mongo.getUri(),
          MONGO_DB: "harness",
          CATALOG_MONGO_DB: "harness",
          AGENT_CORE_URLS: p.core.url,
          AGENTCORE_RUNTIME_ARN: "",
          AUTH_MODE: "google",
          GOOGLE_CLIENT_ID: "test-client",
          GOOGLE_CLIENT_SECRET: "x",
          GOOGLE_ISSUER_URL: p.idp.issuer,
          FRONTEND_ORIGIN: "http://localhost:3000",
          APP_PUBLIC_URL: "http://localhost:3000",
          TRUST_PROXY: "loopback",
          STREAM_REVALIDATE_MS: String(REVAL),
          MCP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
          NODE_ENV: "",
          DEMO_TENANT_ID: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    second.stderr?.on("data", (x) => (logs2 += x));
    await waitFor(
      async () => (await fetch(`http://127.0.0.1:${port2}/livez`)).ok,
      { what: "second instance" },
    );
    const who = await p.session(claims("twoinst"));
    const ag = await p.request(who, "POST", "/api/agents", {
      name: "T",
      description: "d",
      systemPrompt: "s",
      modelProfileId: "demo-model",
    });
    const sid = (
      await p.request(who, "POST", "/api/sessions", { agentId: ag.data.id })
    ).data._id;
    // A session minted on instance 1 is honoured by instance 2: both share the catalog.
    const res2 = await fetch(
      `http://127.0.0.1:${port2}/api/sessions/${sid}/events`,
      { headers: { cookie: who, "x-forwarded-for": p.nextIp() } },
    );
    console.log(
      `two instances: stream opened on instance 2 with a session created on instance 1: HTTP ${res2.status}`,
    );
    const user = await store.users.findOne({ googleSub: "sub-twoinst" });
    const reader = res2.body!.getReader();
    let text = "";
    const done = (async () => {
      const d = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          text += d.decode(value);
        }
      } catch {}
    })();
    await sleep(500);
    const at = Date.now();
    await store.memberships.updateOne(
      { userId: user!._id, tenantId: "demo" },
      { $set: { status: "removed" } },
    );
    await done;
    console.log(
      `        removed the member through the database: instance 2 closed the stream after ${Date.now() - at} ms (check interval ${REVAL} ms); frame: ${/ACCESS_REVOKED/.test(text)}`,
    );
    second.kill("SIGTERM");
    controllers.forEach((c) => c.abort());
  } finally {
    await p.stop();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
