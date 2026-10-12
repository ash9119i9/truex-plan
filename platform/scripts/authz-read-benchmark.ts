// Compare native consistency/resource addressing on an existing full-catalog
// fixture. Immutable versions are server-selected here; never client authority.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pocEngine, node } from "../test/authz-integration/poc-engine";

async function main() {
  if (process.argv.length !== 3)
    throw new Error("Pass one completed catalog benchmark JSON path");
  const sourcePath = resolve(process.argv[2]);
  const source = JSON.parse(readFileSync(sourcePath, "utf8"));
  const engineResult = source.results?.find(
    (r: any) => r.engine === "spicedb" && r.status === "completed",
  );
  const layouts = engineResult?.publications?.at(-1)?.tenants;
  if (
    source.publication !== "catalog" ||
    !Array.isArray(layouts) ||
    layouts.length !== 10 ||
    source.options?.relationships !== 1_000_000 ||
    !engineResult.componentUpdates?.some(
      (r: any) => r.name === "content-revoke",
    )
  )
    throw new Error(
      "Reuse requires the completed ten-tenant full-catalog million-relationship fixture",
    );
  const engine = await pocEngine("spicedb");
  const part = (layout: any, type: string, id: string, revision: string) => ({
    alias: node(layout.namespace, `az_v1_${type}`, id),
    version: node(
      layout.namespace,
      `az_v1_${type}_version`,
      `${id}__${revision}`,
    ),
  });
  const input = (i: number, direct: boolean) => {
    const tenant = i % 10 < 8 ? 0 : 1 + (i % 9),
      l = layouts[tenant];
    if (
      !Number.isSafeInteger(l.principals) ||
      l.principals < 20 ||
      l.principals > 100_000 ||
      !Number.isSafeInteger(l.resources) ||
      l.resources < l.principals ||
      l.resources > 1_000_000
    )
      throw new Error("Invalid fixture layout");
    let resource = (i * 97 + 20) % l.resources;
    if (tenant === 0 && resource % l.principals === 0)
      resource = (resource + 1) % l.resources;
    const owner = resource % l.principals;
    let user =
      i % 2 === 0
        ? owner
        : (owner + Math.floor(l.principals / 2)) % l.principals;
    if (
      tenant !== 0 &&
      i % 2 !== 0 &&
      user < Math.min(100, Math.floor(l.principals / 10))
    )
      user += Math.min(100, Math.floor(l.principals / 10));
    const content = part(
      l,
      "conversation",
      `conversation-${resource}-g1`,
      tenant === 0 && resource === 1 ? "v2" : "v1",
    );
    const heads = [
      part(l, "role", "member-g1", tenant === 0 ? "v2" : "v1"),
      part(l, "group", "readers", tenant === 0 ? "v2" : "v1"),
      part(l, "org", "org-g1", "v1"),
      part(l, "workspace", "workspace-g1", "v1"),
      ...(direct ? [] : [content]),
    ];
    return {
      subject: node(l.namespace, "az_v1_principal", `person-${user}-g1`),
      object: direct ? content.version : content.alias,
      context: {
        active: Object.fromEntries(heads.map((p) => [p.alias, p.version])),
      },
      expected: i % 2 === 0,
    };
  };
  const seed = input(0, true);
  if (
    !(await engine.check(
      seed.subject,
      "conversation_read",
      seed.object,
      seed.context,
    ))
  )
    throw new Error("Initial current-root check failed");
  const token = engine.lastObservedToken;
  if (!token) throw new Error("Engine omitted the causally fresh read marker");
  const trials = [];
  const variants = [
    { direct: false, causal: false },
    { direct: true, causal: false },
    { direct: false, causal: true },
    { direct: true, causal: true },
  ];
  try {
    for (let repetition = 1; repetition <= 2; repetition++) {
      for (const variant of repetition === 1
        ? variants
        : [...variants].reverse()) {
        const samples: number[] = [];
        let allowed = 0,
          denied = 0,
          failures = 0;
        const start = performance.now();
        await Promise.all(
          Array.from({ length: 16 }, async (_, offset) => {
            for (let i = offset; i < 1000; i += 16) {
              const request = input(i, variant.direct),
                begin = performance.now();
              try {
                const decision = await engine.check(
                  request.subject,
                  "conversation_read",
                  request.object,
                  request.context,
                  variant.causal ? token : undefined,
                );
                if (decision !== request.expected) failures++;
                if (decision) allowed++;
                else denied++;
              } catch {
                failures++;
              }
              samples.push(performance.now() - begin);
            }
          }),
        );
        const milliseconds = performance.now() - start;
        samples.sort((a, b) => a - b);
        const percentile = (p: number) =>
          samples[Math.ceil(samples.length * p) - 1];
        const trial = {
          repetition,
          resource: variant.direct
            ? "server-selected immutable version"
            : "logical alias",
          consistency: variant.causal ? "atLeastAsFresh" : "fullyConsistent",
          requests: samples.length,
          allowed,
          denied,
          failures,
          milliseconds,
          requestsPerSecond: 1000 / (milliseconds / 1000),
          p50Ms: percentile(0.5),
          p95Ms: percentile(0.95),
          p99Ms: percentile(0.99),
        };
        trials.push(trial);
        process.stdout.write(JSON.stringify(trial) + "\n");
      }
    }
  } finally {
    await engine.close();
  }
  const report = {
    sourceArtifact: sourcePath,
    finishedAt: new Date().toISOString(),
    engine: "spicedb:v1.56.2",
    concurrency: 16,
    trials,
    markerSource:
      "Fully consistent check after all source writes; server-fixture marker, never caller input",
    limitations:
      "Engine cost only. No production metadata snapshot, token publication, live lifecycle/JWT, read lease/admission or restore reconciliation measured. Aliases and versions use the same current fixture heads. Trial order reversed in repetition two; no production SLA claim.",
  };
  const file = resolve(
    "../docs/authorization/evidence",
    `benchmark-read-addressing-${report.finishedAt.replace(/[:.]/g, "-")}.json`,
  );
  writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ artifact: file }) + "\n");
  if (trials.some((t) => t.failures)) process.exitCode = 1;
}
main().catch((error) => {
  process.stderr.write(String(error) + "\n");
  process.exitCode = 1;
});
