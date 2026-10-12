// Measure obsolete-selector cost and verify they cannot resurrect a revoked
// assignee. Adds only isolated fixture versions, then removes exactly those rows.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  pocEngine,
  node,
  type Tuple,
} from "../test/authz-integration/poc-engine";

async function main() {
  if (process.argv.length !== 3)
    throw new Error("Pass one completed catalog benchmark JSON path");
  const sourcePath = resolve(process.argv[2]);
  const source = JSON.parse(readFileSync(sourcePath, "utf8"));
  const r = source.results?.find(
    (r: any) => r.engine === "spicedb" && r.status === "completed",
  );
  const l = r?.publications?.at(-1)?.tenants?.[0];
  if (
    source.publication !== "catalog" ||
    !l ||
    !r.componentUpdates?.some((r: any) => r.name === "role-revoke")
  )
    throw new Error(
      "Requires completed full-catalog fixture with role revocation",
    );
  const engine = await pocEngine("spicedb");
  const n = (type: string, id: string) =>
    node(l.namespace, `az_v1_${type}`, id);
  const alias = (type: string, id: string) => n(type, `${id}-g1`);
  const version = (type: string, id: string, rev: string) =>
    n(`${type}_version`, `${id}-g1__${rev}`);
  const active = Object.fromEntries([
    [alias("role", "member"), version("role", "member", "v2")],
    [alias("group", "readers"), version("group", "readers", "v2")],
    [alias("org", "org"), version("org", "org", "v1")],
    [alias("workspace", "workspace"), version("workspace", "workspace", "v1")],
  ]);
  // Group aliases in the generator intentionally omit the -g1 suffix.
  delete active[alias("group", "readers")];
  active[n("group", "readers")] = n("group_version", "readers__v2");
  const records: Tuple[] = [];
  const stages = [];
  const experiment = randomUUID();
  try {
    for (const count of [0, 10, 100, 1000]) {
      for (let i = records.length / 2; i < count; i++) {
        const old = version("role", "member", `history-${experiment}-${i}`);
        records.push(
          {
            user: n("principal", "person-0-g1"),
            relation: "assignee",
            object: old,
          },
          {
            user: old,
            relation: "version",
            object: alias("role", "member"),
            condition: {
              name: "az_v1_active_version",
              context: { key: alias("role", "member"), revision: old },
            },
          },
        );
      }
      const previousCount = stages.at(-1)?.obsoleteVersions ?? 0;
      for (
        let offset = previousCount * 2;
        offset < records.length;
        offset += 100
      )
        await engine.write(records.slice(offset, offset + 100));
      const latency: number[] = [];
      let failures = 0;
      for (let i = 0; i < 20; i++) {
        const allow = i % 2 === 0;
        const object = version(
          "conversation",
          `conversation-${allow ? 1 : 0}`,
          allow ? "v2" : "v1",
        );
        const before = performance.now();
        const decision = await engine.check(
          n("principal", `person-${allow ? 1 : 0}-g1`),
          "conversation_read",
          object,
          { active },
        );
        latency.push(performance.now() - before);
        if (decision !== allow) failures++;
      }
      latency.sort((a, b) => a - b);
      const result = {
        obsoleteVersions: count,
        checks: latency.length,
        failures,
        p50Ms: latency[9],
        p95Ms: latency[18],
        maxMs: latency[19],
      };
      stages.push(result);
      process.stdout.write(JSON.stringify(result) + "\n");
    }
  } finally {
    for (let offset = 0; offset < records.length; offset += 100)
      await engine.remove(records.slice(offset, offset + 100));
    await engine.close();
  }
  const finishedAt = new Date().toISOString();
  const file = resolve(
    "../docs/authorization/evidence",
    `benchmark-obsolete-selectors-${finishedAt.replace(/[:.]/g, "-")}.json`,
  );
  writeFileSync(
    file,
    JSON.stringify(
      {
        sourceArtifact: sourcePath,
        finishedAt,
        stages,
        limitations:
          "Single fixture role alias; 20 sequential fully consistent checks per stage, no application/root overhead. Both allowed current assignee and revoked assignee checked. Added fixture rows removed exactly; no production GC proof or SLA claim.",
      },
      null,
      2,
    ) + "\n",
  );
  process.stdout.write(JSON.stringify({ artifact: file }) + "\n");
  if (stages.some((s) => s.failures)) process.exitCode = 1;
}
main().catch((error) => {
  process.stderr.write(String(error) + "\n");
  process.exitCode = 1;
});
