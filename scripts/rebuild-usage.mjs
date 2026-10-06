// Brings stored usage up to date in every tenant database including the
// default one (MONGO_DB), after cost moved onto traces and sessions:
//
//   npm run rebuild:usage                                dry run
//   npm run rebuild:usage -- --confirm rebuild-usage     apply
//
// 1. Traces with no cost (turns that finished before cost was recorded on the
//    trace) are priced from the prices in force when each request ran, the
//    same way the platform prices a finished turn. Traces that already have a
//    cost are never re-priced, so their recorded rates stay as they were.
// 2. Traces get the owner's userId when they lack one.
// 3. Each session's usage (running totals) is rebuilt from its traces that
//    have a cost, and written only when it differs from what is stored.
//
// Every step is conditional, so running it again changes nothing. A turn whose
// model has no price is stored as unpriced, never as zero, and counts again
// once a price is added and the script is run for it (re-run is not needed for
// new turns; the platform prices those itself).
//
// Run it while the platform is idle or stopped: a turn finishing between its
// read of a session and its write can be counted again by the platform, which
// the rebuild corrects the next time it runs.
//
// Reads MONGO_URI, MONGO_DB and CATALOG_MONGO_DB (process env first, then
// platform/.env; dotenv never overrides set values).
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(resolve(root, "platform/package.json"));
const envFile = resolve(root, "platform/.env");
if (existsSync(envFile))
  require("dotenv").config({ path: envFile, quiet: true });
const { MongoClient, ObjectId } = require("mongodb");

const CONFIRM = "rebuild-usage";
const DEFAULT_TENANT_ID = "default";
const uri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017";
const database = process.env.MONGO_DB || "truex";
const catalogDatabase = process.env.CATALOG_MONGO_DB || database;

const usage = `usage: node scripts/rebuild-usage.mjs [--confirm ${CONFIRM}]
  (no arguments)              dry run: print what would change, write nothing
  --confirm ${CONFIRM}   apply to every tenant database`;

const args = process.argv.slice(2);
const confirmed =
  args.length === 2 && args[0] === "--confirm" && args[1] === CONFIRM;
if (args.length && !confirmed) {
  console.error(`error: unknown arguments ${args.join(" ")}\n${usage}`);
  process.exit(1);
}
const dryRun = !confirmed;
const prefix = dryRun ? "[dry run] " : "";
const would = (done, pending) => (dryRun ? pending : done);

// The platform's own pricing code (platform/src/costs.ts): the built copy
// when present, else the source through tsx.
async function loadCosts() {
  const built = resolve(root, "platform/dist/platform/src/costs.js");
  return existsSync(built)
    ? require(built)
    : await require("tsx/esm/api").tsImport(
        pathToFileURL(resolve(root, "platform/src/costs.ts")).href,
        import.meta.url,
      );
}

// Same candidates as idCandidates() in platform/src/documents.ts.
const idCandidates = (id) => {
  const text = String(id);
  return ObjectId.isValid(text) ? [text, new ObjectId(text)] : [text];
};

// Every registered tenant database, plus the default one.
async function tenantDatabases(client) {
  const docs = await client
    .db(catalogDatabase)
    .collection("tenants")
    .find({}, { projection: { dbName: 1 } })
    .toArray();
  const names = new Map([[database, DEFAULT_TENANT_ID]]);
  for (const d of docs)
    if (d._id !== DEFAULT_TENANT_ID && typeof d.dbName === "string")
      names.set(d.dbName, d._id);
  return [...names].map(([dbName, tenant]) => ({ dbName, tenant }));
}

// "usage.costMicros" -> "costMicros": the same sums the platform adds per turn.
const totalsOf = (increment) =>
  Object.fromEntries(
    Object.entries(increment).map(([k, v]) => [k.replace(/^usage\./, ""), v]),
  );
const TOTAL_KEYS = [
  "turns",
  "costMicros",
  "requests",
  "unpricedRequests",
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
];
const same = (a, b) =>
  !!a &&
  TOTAL_KEYS.every((k) => (a[k] ?? 0) === (b[k] ?? 0)) &&
  [...(a.turnIds ?? [])].sort().join("\n") ===
    [...(b.turnIds ?? [])].sort().join("\n");

async function rebuild(db, catalog, costs, label) {
  const sessions = db.collection("sessions");
  const traces = db.collection("traces");
  const agents = db.collection("truex_agents");
  const profiles = catalog.collection("truex_models");
  const pricing = catalog.collection("truex_model_pricing");

  const modelNames = new Map();
  const modelNameFor = async (session) => {
    if (session.settings?.model) return session.settings.model;
    if (!modelNames.has(session.agentId)) {
      const agent = await agents.findOne({
        _id: { $in: idCandidates(session.agentId) },
      });
      const profile = agent
        ? await profiles.findOne({
            _id: { $in: idCandidates(agent.modelProfileId) },
          })
        : null;
      modelNames.set(session.agentId, profile?.modelName ?? null);
    }
    return modelNames.get(session.agentId);
  };
  const priceLists = new Map();
  const pricesFor = async (modelName) => {
    if (!priceLists.has(modelName))
      priceLists.set(
        modelName,
        await pricing.find({ modelName }).sort({ effectiveFrom: -1 }).toArray(),
      );
    return priceLists.get(modelName);
  };

  let priced = 0,
    unpriced = 0,
    owned = 0,
    sessionsChanged = 0,
    sessionsChecked = 0;

  for await (const session of sessions.find(
    {},
    { projection: { userId: 1, agentId: 1, settings: 1, usage: 1 } },
  )) {
    const modelName = await modelNameFor(session);
    const prices = modelName ? await pricesFor(modelName) : [];
    const owner = session.userId ?? null;
    // The session's running totals, from its traces' costs as they will be
    // after this run, so a dry run reports what a real run writes.
    const totals = {
      ...totalsOf(costs.usageIncrement({})),
      turns: 0,
      turnIds: [],
    };
    for await (const t of traces.find({ sessionId: session._id })) {
      const set = {};
      let cost = t.cost;
      // 1. A trace with no cost is priced; one with a cost keeps its rates.
      if (!cost) {
        const result = costs.priceTrace(t, modelName, prices, t.startedAt);
        if (result) {
          cost = set.cost = result.cost;
          if (Array.isArray(t.calls) && t.calls.length)
            set.calls = result.calls;
          if (cost.unpricedRequests) unpriced++;
          else priced++;
        }
      }
      // 2. The owner, for per-user totals.
      if (t.userId === undefined) {
        set.userId = owner;
        owned++;
      }
      if (!dryRun && Object.keys(set).length)
        await traces.updateOne({ _id: t._id }, { $set: set });
      if (cost) {
        for (const [k, v] of Object.entries(
          totalsOf(costs.usageIncrement(cost)),
        ))
          totals[k] += v;
        totals.turnIds.push(t.turnId);
      }
    }
    // 3. Written only when it differs from what is stored.
    sessionsChecked++;
    if (totals.turns === 0 && !session.usage) continue;
    if (same(session.usage, totals)) continue;
    sessionsChanged++;
    if (!dryRun)
      await sessions.updateOne(
        { _id: session._id },
        { $set: { usage: totals } },
      );
  }

  console.log(
    `${prefix}${label}: ${priced + unpriced} trace(s) ${would("priced", "would be priced")} (${unpriced} without a usable price), ${owned} ${would("given", "would be given")} a userId`,
  );
  console.log(
    `${prefix}${label}: ${sessionsChanged} of ${sessionsChecked} session(s) ${would("had", "would have")} their usage totals rebuilt`,
  );
  return true;
}

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000 });
try {
  await client.connect();
  const costs = await loadCosts();
  const targets = await tenantDatabases(client);
  console.log(
    `${prefix}rebuilding usage in ${targets.length} tenant database(s): ${targets.map((t) => `${t.tenant} (${t.dbName})`).join(", ")}`,
  );
  const catalog = client.db(catalogDatabase);
  let ok = true;
  for (const { dbName, tenant } of targets)
    ok = (await rebuild(client.db(dbName), catalog, costs, tenant)) && ok;
  if (!ok) process.exitCode = 1;
  console.log(
    `${prefix}done${ok ? "" : " with errors (see above)"}.${dryRun ? ` Nothing was written; apply with --confirm ${CONFIRM}.` : ""}`,
  );
} catch (error) {
  console.error(`error: ${error?.message ?? error}`);
  process.exitCode = 1;
} finally {
  await client.close();
}
