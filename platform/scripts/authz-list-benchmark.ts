// Reuse an existing completed local component experiment; no graph rewrite.
// Measures native candidate batches, not Mongo candidate queries or final leases.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  pocEngine,
  node,
  type CheckItem,
} from "../test/authz-integration/poc-engine";
import { component } from "../test/authz-integration/poc-components";

async function main() {
  if (process.argv.length !== 3)
    throw new Error("Pass one completed component benchmark JSON path");
  const sourcePath = resolve(process.argv[2]);
  const source = JSON.parse(readFileSync(sourcePath, "utf8"));
  const result = source.results?.find(
    (r: any) => r.engine === "spicedb" && r.status === "completed",
  );
  const layouts = result?.publications?.at(-1)?.tenants;
  if (
    source.publication !== "components" ||
    !Array.isArray(layouts) ||
    layouts.length !== 10 ||
    source.options?.relationships !== 1_000_000 ||
    !result.componentUpdates?.some((r: any) => r.name === "content-revoke")
  )
    throw new Error(
      "Reuse requires the completed ten-tenant million-relationship component fixture",
    );
  for (const l of layouts)
    if (
      !/^[a-f0-9-]{36}$/.test(l.namespace) ||
      !Number.isSafeInteger(l.principals) ||
      l.principals < 20 ||
      l.principals > 100_000 ||
      !Number.isSafeInteger(l.resources) ||
      l.resources < l.principals ||
      l.resources > 1_000_000 ||
      !Number.isSafeInteger(l.relationships) ||
      l.relationships > 10_000_000
    )
      throw new Error("Invalid fixture layout");
  const engine = await pocEngine("spicedb", true);
  const samples: number[] = [];
  let allowed = 0,
    denied = 0,
    failures = 0;
  const start = performance.now();
  try {
    for (let offset = 0; offset < 1000; offset += 50) {
      const expected: boolean[] = [];
      const requests: CheckItem[] = Array.from({ length: 50 }, (_, j) => {
        const i = offset + j;
        const tenant = i % 10 < 8 ? 0 : 1 + (i % 9);
        const l = layouts[tenant];
        const resource = (i * 97 + 20) % l.resources;
        const owner = resource % l.principals;
        const groupSize = Math.min(100, Math.floor(l.principals / 10));
        const extra =
          l.relationships - (l.principals + groupSize + 7 + l.resources * 4);
        const shares =
          Math.floor(extra / l.resources) +
          (resource < extra % l.resources ? 1 : 0);
        const distance = (1 - owner + l.principals) % l.principals;
        expected.push(
          owner === 1 ||
            (tenant !== 0 && groupSize > 1) ||
            (!(tenant === 0 && resource === 1) &&
              distance > 0 &&
              distance <= shares),
        );
        const parts = [
          component(
            l.namespace,
            "role",
            "member-g1",
            tenant === 0 ? "v2" : "v1",
          ),
          component(
            l.namespace,
            "group",
            "readers",
            tenant === 0 ? "v2" : "v1",
          ),
          component(l.namespace, "org", "org-g1", "v1"),
          component(
            l.namespace,
            "conversation",
            `conversation-${resource}-g1`,
            tenant === 0 && resource === 1 ? "v2" : "v1",
          ),
        ];
        return {
          user: node(l.namespace, "cmp_user", "person-1-g1"),
          relation: "can_read",
          object: parts[3].alias,
          context: {
            active: Object.fromEntries(parts.map((c) => [c.alias, c.version])),
          },
        };
      });
      const before = performance.now();
      const decisions = await engine.checkMany(requests);
      samples.push(performance.now() - before);
      decisions.forEach((decision, i) => {
        if (decision !== expected[i]) failures++;
        if (decision) allowed++;
        else denied++;
      });
    }
  } finally {
    await engine.close();
  }
  const milliseconds = performance.now() - start;
  samples.sort((a, b) => a - b);
  const percentile = (p: number) => samples[Math.ceil(samples.length * p) - 1];
  const report = {
    sourceArtifact: sourcePath,
    finishedAt: new Date().toISOString(),
    engine: "spicedb:v1.56.2",
    candidates: 1000,
    batchSize: 50,
    batches: samples.length,
    allowed,
    denied,
    failures,
    milliseconds,
    candidatesPerSecond: 1000 / (milliseconds / 1000),
    batchLatency: {
      p50Ms: percentile(0.5),
      p95Ms: percentile(0.95),
      p99Ms: percentile(0.99),
    },
    consistency:
      "fullyConsistent; four server-fixture references per candidate, including completed hot-tenant revocations",
    limitations:
      "Native checks only. No production Mongo candidate query, root snapshot/fence/lease, index/cardinality cost or pagination measured. Twenty samples do not establish production tail latency.",
  };
  const file = resolve(
    "../docs/authorization/evidence",
    `benchmark-bulk-spicedb-${report.finishedAt.replace(/[:.]/g, "-")}.json`,
  );
  writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ artifact: file, ...report }) + "\n");
  if (failures) process.exitCode = 1;
}
main().catch((error) => {
  process.stderr.write(String(error) + "\n");
  process.exitCode = 1;
});
