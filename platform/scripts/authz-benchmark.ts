// Local engine-selection experiment. Uses isolated POC services and fixture
// identities, never production routing or credentials. Run from platform/.
import { randomUUID } from "node:crypto";
import { cpus, totalmem, platform, release } from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  pocEngine,
  node,
  assertSnapshot,
  type EngineKind,
  type Tuple,
  type PocEngine,
} from "../test/authz-integration/poc-engine";
import {
  component,
  compileComponent,
  type Component,
} from "../test/authz-integration/poc-components";

import { ACTIONS } from "../../shared/authorization";
import { enginePermission } from "../src/authorization-model";

const defaults = {
  principals: 10_000,
  resources: 100_000,
  relationships: 1_000_000,
  checks: 1000,
  concurrency: 16,
  tenants: 10,
  copies: 2,
  writeConcurrency: 4,
  writeBatchSize: 100,
};
const options = { ...defaults };
let selected: "both" | EngineKind = "both";
let publication: "snapshot" | "components" | "catalog" = "snapshot";
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]
    .replace(/^--/, "")
    .replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
  const value = process.argv[i + 1];
  if (key === "engine" && ["both", "openfga", "spicedb"].includes(value))
    selected = value as "both" | EngineKind;
  else if (
    key === "publication" &&
    ["snapshot", "components", "catalog"].includes(value)
  )
    publication = value as "snapshot" | "components" | "catalog";
  else if (
    Object.hasOwn(options, key) &&
    Number.isSafeInteger(Number(value)) &&
    Number(value) > 0
  )
    options[key as keyof typeof options] = Number(value);
  else throw new Error(`Invalid benchmark option: ${process.argv[i]}`);
}
if (
  options.principals > 100_000 ||
  options.resources > 1_000_000 ||
  options.relationships > 10_000_000 ||
  options.concurrency > 64 ||
  options.tenants > 100 ||
  options.copies > 3 ||
  options.checks > 10_000 ||
  options.writeConcurrency > 16 ||
  options.writeBatchSize > 1000
)
  throw new Error("Benchmark exceeds the explicit local experiment limits");

const catalogMode = publication === "catalog";
if (catalogMode && selected !== "spicedb")
  throw new Error(
    "The complete candidate action model experiment is SpiceDB-only; use --engine spicedb",
  );
const componentMode = publication !== "snapshot";
const readPermission = catalogMode ? "conversation_read" : "can_read";
const principalType = catalogMode ? "az_v1_principal" : "cmp_user";

const distribute = (total: number) => {
  if (options.tenants === 1) return [total];
  const hot = Math.floor(total * 0.8);
  const rest = total - hot;
  const small = Math.floor(rest / (options.tenants - 1));
  return [
    hot,
    ...Array.from(
      { length: options.tenants - 1 },
      (_, i) => small + (i < rest % (options.tenants - 1) ? 1 : 0),
    ),
  ];
};
const counts = {
  principals: distribute(options.principals),
  resources: distribute(options.resources),
  relationships: distribute(options.relationships),
};
type Layout = {
  namespace: string;
  principals: number;
  resources: number;
  relationships: number;
};
const layouts = (): Layout[] =>
  counts.principals.map((principals, i) => ({
    namespace: randomUUID(),
    principals,
    resources: counts.resources[i],
    relationships: counts.relationships[i],
  }));
function* snapshotTuples(layout: Layout): Generator<Tuple> {
  const { namespace, principals, resources, relationships } = layout;
  const n = (type: string, id: string) => node(namespace, type, id);
  const role = n("role", "member-v1");
  const organization = n("organization", "org-g1");
  const workspace = n("workspace", "workspace-g1");
  const base = principals + 5 + resources * 2;
  const extra = relationships - base;
  const perResource = Math.floor(extra / resources);
  const remainder = extra % resources;
  if (
    principals < 10 ||
    resources < 1 ||
    extra < 0 ||
    perResource + 1 >= principals
  )
    throw new Error(
      "Dataset cannot represent the requested distinct relationships",
    );
  for (let i = 0; i < principals; i++)
    yield {
      user: n("user", `person-${i}-g1`),
      relation: "assignee",
      object: role,
    };
  for (const cap of ["read", "send", "approve", "settings"])
    yield {
      user: `${role}#assignee`,
      relation: `${cap}_cap`,
      object: organization,
    };
  yield { user: organization, relation: "organization", object: workspace };
  for (let i = 0; i < resources; i++) {
    const object = n("conversation", `conversation-${i}-g1`);
    const owner = i % principals;
    yield { user: workspace, relation: "workspace", object };
    yield { user: n("user", `person-${owner}-g1`), relation: "owner", object };
    for (let j = 0; j < perResource + (i < remainder ? 1 : 0); j++)
      yield {
        user: n("user", `person-${(owner + j + 1) % principals}-g1`),
        relation: "reader",
        object,
      };
  }
}
const groupSize = (layout: Layout) =>
  Math.min(100, Math.floor(layout.principals / 10));
type BenchPart = { alias: string; version: string; source?: Component };
const benchPart = (
  layout: Layout,
  kind: "group" | "role" | "org" | "conversation" | "workspace",
  id: string,
  revision: string,
): BenchPart => {
  if (catalogMode)
    return {
      alias: node(layout.namespace, `az_v1_${kind}`, id),
      version: node(
        layout.namespace,
        `az_v1_${kind}_version`,
        `${id}__${revision}`,
      ),
    };
  if (kind === "workspace")
    throw new Error("Minimal component model has no workspace component");
  const source = component(layout.namespace, kind, id, revision);
  return { alias: source.alias, version: source.version, source };
};
const compilePart = (
  part: BenchPart,
  edges: readonly { user: string; relation: string }[],
): Tuple[] =>
  part.source
    ? compileComponent(part.source, edges)
    : [
        ...edges.map((edge) => ({ ...edge, object: part.version })),
        {
          user: part.version,
          relation: "version",
          object: part.alias,
          condition: {
            name: "az_v1_active_version",
            context: { key: part.alias, revision: part.version },
          },
        },
      ];
const parts = (
  layout: Layout,
  resource: number,
  revisions = { group: "v1", role: "v1", content: "v1" },
) => ({
  group: benchPart(layout, "group", "readers", revisions.group),
  role: benchPart(layout, "role", "member-g1", revisions.role),
  org: benchPart(layout, "org", "org-g1", "v1"),
  content: benchPart(
    layout,
    "conversation",
    `conversation-${resource}-g1`,
    revisions.content,
  ),
  ...(catalogMode
    ? { workspace: benchPart(layout, "workspace", "workspace-g1", "v1") }
    : {}),
});
function* componentTuples(layout: Layout): Generator<Tuple> {
  const p = parts(layout, 0);
  const user = (i: number) =>
    node(layout.namespace, principalType, `person-${i}-g1`);
  const overhead = catalogMode ? ACTIONS.length + 5 : 7;
  const base =
    layout.principals + groupSize(layout) + overhead + layout.resources * 4;
  const extra = layout.relationships - base;
  const shares = Math.floor(extra / layout.resources);
  const remainder = extra % layout.resources;
  if (layout.principals < 10 || extra < 0 || shares + 1 >= layout.principals)
    throw new Error(
      "Dataset cannot represent distinct component relationships",
    );
  yield* compilePart(
    p.group,
    Array.from({ length: groupSize(layout) }, (_, i) => ({
      user: user(i),
      relation: "member",
    })),
  );
  yield* compilePart(
    p.role,
    Array.from({ length: layout.principals }, (_, i) => ({
      user: user(i),
      relation: "assignee",
    })),
  );
  yield* compilePart(
    p.org,
    (catalogMode
      ? ACTIONS.map((action) => `cap_${enginePermission(action)}`)
      : ["read", "send", "approve", "settings"].map((cap) => `${cap}_cap`)
    ).map((relation) => ({ user: `${p.role.alias}#assignee`, relation })),
  );
  if (p.workspace)
    yield* compilePart(p.workspace, [{ user: p.org.alias, relation: "scope" }]);
  for (let i = 0; i < layout.resources; i++) {
    const content = parts(layout, i).content;
    const owner = i % layout.principals;
    yield* compilePart(content, [
      { user: (p.workspace ?? p.org).alias, relation: "scope" },
      { user: user(owner), relation: "owner" },
      { user: `${p.group.alias}#member`, relation: "reader" },
      ...Array.from({ length: shares + (i < remainder ? 1 : 0) }, (_, j) => ({
        user: user((owner + j + 1) % layout.principals),
        relation: "reader",
      })),
    ]);
  }
}
const activeContext = (
  layout: Layout,
  resource: number,
  revisions?: Parameters<typeof parts>[2],
) => {
  const p = parts(layout, resource, revisions);
  return {
    active: Object.fromEntries(
      Object.values(p)
        .filter((c): c is BenchPart => !!c)
        .map((c) => [c.alias, c.version]),
    ),
  };
};
const summary = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
  return {
    count: samples.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    maxMs: sorted.at(-1),
  };
};
async function publish(engine: PocEngine, layout: Layout) {
  const pending = new Set<Promise<void>>();
  let failure: unknown;
  let written = 0;
  let sent = 0;
  let batch: Tuple[] = [];
  const submit = (records: Tuple[]) => {
    assertSnapshot(layout.namespace, records);
    sent += records.length;
    let job!: Promise<void>;
    job = engine
      .write(records)
      .then(
        () => {
          written += records.length;
          if (written % 100_000 === 0)
            process.stdout.write(
              JSON.stringify({
                engine: engine.kind,
                namespace: layout.namespace,
                acknowledged: written,
              }) + "\n",
            );
        },
        (error) => {
          failure ??= error;
        },
      )
      .finally(() => pending.delete(job));
    pending.add(job);
  };
  const start = performance.now();
  for (const tuple of componentMode
    ? componentTuples(layout)
    : snapshotTuples(layout)) {
    if (failure) break;
    batch.push(tuple);
    if (batch.length === options.writeBatchSize) {
      submit(batch);
      batch = [];
      if (pending.size >= options.writeConcurrency) await Promise.race(pending);
    }
  }
  if (batch.length && !failure) submit(batch);
  await Promise.all(pending);
  if (failure)
    throw Object.assign(new Error(String(failure)), {
      publication: {
        namespace: layout.namespace,
        sent,
        acknowledged: written,
        unknownOrRejected: sent - written,
        milliseconds: performance.now() - start,
      },
    });
  if (written !== layout.relationships)
    throw new Error(`Incorrect generated relationship count: ${written}`);
  return {
    namespace: layout.namespace,
    principals: layout.principals,
    resources: layout.resources,
    relationships: written,
    milliseconds: performance.now() - start,
  };
}
async function run(kind: EngineKind) {
  const engines: PocEngine[] = [];
  const publications: {
    copy: number;
    tenants: Awaited<ReturnType<typeof publish>>[];
    milliseconds: number;
  }[] = [];
  let active: Layout[] = [];
  const cleanupErrors: string[] = [];
  try {
    // OpenFGA: separate store/model per tenant. SpiceDB: separate immutable
    // namespaces in one isolated datastore. Neither uses an application cache.
    for (let i = 0; i < options.tenants; i++)
      engines.push(await pocEngine(kind, componentMode));
    for (let copy = 1; copy <= options.copies; copy++) {
      const snapshot = layouts();
      const start = performance.now();
      const tenants = [];
      for (let i = 0; i < snapshot.length; i++) {
        tenants.push(await publish(engines[i], snapshot[i]));
        process.stdout.write(
          JSON.stringify({ engine: kind, copy, tenant: i, ...tenants.at(-1) }) +
            "\n",
        );
      }
      publications.push({
        copy,
        tenants,
        milliseconds: performance.now() - start,
      });
      active = snapshot;
    }
    const latency: number[] = [];
    let allowed = 0,
      denied = 0,
      failures = 0;
    const checksStart = performance.now();
    const worker = async (offset: number) => {
      for (let i = offset; i < options.checks; i += options.concurrency) {
        const tenant =
          i % 10 < 8 ? 0 : 1 + (i % Math.max(1, options.tenants - 1));
        const index = Math.min(tenant, options.tenants - 1);
        const layout = active[index];
        const resource = (i * 97) % layout.resources;
        const owner = resource % layout.principals;
        // Even: owner allow. Odd: unrelated capability holder must deny.
        let user =
          i % 2 === 0
            ? owner
            : (owner + Math.floor(layout.principals / 2)) % layout.principals;
        if (componentMode && i % 2 !== 0 && user < groupSize(layout))
          user += groupSize(layout);
        const start = performance.now();
        try {
          const result = await engines[index].check(
            node(
              layout.namespace,
              componentMode ? principalType : "user",
              `person-${user}-g1`,
            ),
            readPermission,
            componentMode
              ? parts(layout, resource).content.alias
              : node(
                  layout.namespace,
                  "conversation",
                  `conversation-${resource}-g1`,
                ),
            componentMode ? activeContext(layout, resource) : undefined,
          );
          if (result !== (i % 2 === 0))
            throw new Error("Privacy result differs from fixture expectation");
          if (result) allowed++;
          else denied++;
        } catch {
          failures++;
        }
        latency.push(performance.now() - start);
      }
    };
    await Promise.all(
      Array.from({ length: options.concurrency }, (_, i) => worker(i)),
    );
    const duration = performance.now() - checksStart;
    const componentUpdates: {
      name: string;
      relationships: number;
      milliseconds: number;
      contextBytes: number;
    }[] = [];
    if (componentMode) {
      const layout = active[0];
      const engine = engines[0];
      const user = (i: number) =>
        node(layout.namespace, principalType, `person-${i}-g1`);
      const revisions = { group: "v1", role: "v1", content: "v1" };
      const check = (who: number, resource: number) =>
        engine.check(
          user(who),
          readPermission,
          parts(layout, resource).content.alias,
          activeContext(layout, resource, revisions),
        );
      const save = async (
        name: string,
        records: Tuple[],
        commit: () => void,
        verify: () => Promise<void>,
      ) => {
        const start = performance.now();
        for (
          let offset = 0;
          offset < records.length;
          offset += options.writeBatchSize
        )
          await engine.write(
            records.slice(offset, offset + options.writeBatchSize),
          );
        const milliseconds = performance.now() - start;
        commit();
        await verify();
        componentUpdates.push({
          name,
          relationships: records.length,
          milliseconds,
          contextBytes: Buffer.byteLength(
            JSON.stringify(activeContext(layout, 0, revisions)),
          ),
        });
      };
      const groupResource = Math.floor(layout.principals / 2);
      if (!(await check(0, groupResource)))
        throw new Error("Group read fixture did not grant before revoke");
      const group = parts(layout, 0, { ...revisions, group: "v2" }).group;
      await save(
        "group-revoke",
        compilePart(group, []),
        () => {
          revisions.group = "v2";
        },
        async () => {
          if (await check(0, groupResource))
            throw new Error("Group revoke failed");
        },
      );
      if (!(await check(0, 0)))
        throw new Error("Owner fixture did not grant before role revoke");
      const role = parts(layout, 0, { ...revisions, role: "v2" }).role;
      await save(
        "role-revoke",
        compilePart(
          role,
          Array.from({ length: layout.principals - 1 }, (_, i) => ({
            user: user(i + 1),
            relation: "assignee",
          })),
        ),
        () => {
          revisions.role = "v2";
        },
        async () => {
          if (await check(0, 0)) throw new Error("Role revoke failed");
        },
      );
      if (!(await check(2, 1)))
        throw new Error("Direct share fixture did not grant before revoke");
      const content = parts(layout, 1, { ...revisions, content: "v2" }).content;
      await save(
        "content-revoke",
        compilePart(content, [
          {
            user: (parts(layout, 0).workspace ?? parts(layout, 0).org).alias,
            relation: "scope",
          },
          { user: user(1), relation: "owner" },
        ]),
        () => {
          revisions.content = "v2";
        },
        async () => {
          if (await check(2, 1)) throw new Error("Content revoke failed");
          if (!(await check(1, 1)))
            throw new Error("Owner lost read on content-only share revoke");
        },
      );
    }
    return {
      engine: kind,
      status: "completed" as const,
      cleanupErrors,
      publications,
      componentUpdates,
      checks: {
        ...summary(latency),
        allowed,
        denied,
        failures,
        milliseconds: duration,
        requestsPerSecond: options.checks / (duration / 1000),
      },
    };
  } catch (error) {
    process.stderr.write(
      JSON.stringify({
        engine: kind,
        status: "failed",
        error: String(error),
        partialPublication: (error as { publication?: unknown }).publication,
      }) + "\n",
    );
    return {
      engine: kind,
      status: "failed" as const,
      cleanupErrors,
      publications,
      error: String(error),
      partialPublication: (error as { publication?: unknown }).publication,
    };
  } finally {
    for (const engine of engines) {
      try {
        await engine.close();
      } catch (error) {
        cleanupErrors.push(String(error));
      }
    }
  }
}

async function main() {
  const start = new Date();
  const results = [];
  for (const kind of selected === "both"
    ? (["openfga", "spicedb"] as EngineKind[])
    : [selected])
    results.push(await run(kind));
  const report = {
    startedAt: start.toISOString(),
    finishedAt: new Date().toISOString(),
    options,
    publication,
    environment: {
      node: process.version,
      os: platform(),
      release: release(),
      cpu: cpus()[0]?.model,
      cpuCount: cpus().length,
      memoryBytes: totalmem(),
      images: {
        openfga: "v1.22.0",
        spicedb: "v1.56.2",
        postgres: "17.11-bookworm",
      },
      topology:
        "Docker loopback HTTP, one shared fixture PostgreSQL process with separate engine databases; no production availability/latency claim",
      model: `${catalogMode ? "authorization.candidate.v1.zed" : componentMode ? "poc.components.openfga.json / poc.components.spicedb.zed" : "poc.openfga.json / poc.spicedb.zed"}; private capability/content intersection; not the full production action model`,
      contextSource:
        "Fixed fixture active references only; no production Mongo, outbox, credentials, queue or admission timing measured",
    },
    results,
  };
  const directory = resolve("../docs/authorization/evidence");
  await mkdir(directory, { recursive: true });
  const file = resolve(
    directory,
    `benchmark-${publication}-${selected}-${options.relationships}-${start.toISOString().replace(/[:.]/g, "-")}.json`,
  );
  await writeFile(file, JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(
    JSON.stringify({
      artifact: file,
      results: results.map((r) => ({
        engine: r.engine,
        checks: r.checks,
        copiesMs: r.publications.map((p) => p.milliseconds),
      })),
    }) + "\n",
  );
  if (
    results.some(
      (r) =>
        r.status !== "completed" ||
        r.cleanupErrors.length ||
        r.checks?.failures,
    )
  )
    process.exitCode = 1;
}
main().catch((error) => {
  process.stderr.write(String(error) + "\n");
  process.exitCode = 1;
});
