// One-off migration to the tenancy layout: copies the shared catalog
// (truex_models, truex_skills) from MONGO_DB into CATALOG_MONGO_DB and
// registers the "default" tenant, whose data stays in MONGO_DB.
//
//   npm run migrate:tenancy -- --dry-run
//   npm run migrate:tenancy
//
// Inserts only missing _ids (original string/ObjectId type preserved), never
// overwrites or deletes. Safe to run repeatedly. The old collections in
// MONGO_DB stay until an operator removes them.
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(resolve(root, "platform/package.json"));
const envFile = resolve(root, "platform/.env");
if (existsSync(envFile))
  require("dotenv").config({ path: envFile, quiet: true });
const { MongoClient } = require("mongodb");

const args = process.argv.slice(2);
const unknown = args.filter((a) => a !== "--dry-run");
if (unknown.length) {
  console.error(
    `error: unknown argument ${unknown.join(" ")}\nusage: node scripts/migrate-tenancy.mjs [--dry-run]`,
  );
  process.exit(1);
}
const dryRun = args.includes("--dry-run");
const uri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017";
const database = process.env.MONGO_DB || "truex";
const catalogDatabase = process.env.CATALOG_MONGO_DB;
if (!catalogDatabase || catalogDatabase === database) {
  console.error(
    `error: CATALOG_MONGO_DB is ${catalogDatabase ? `the same as MONGO_DB (${database})` : "unset"}; the catalog already lives in MONGO_DB, nothing to migrate`,
  );
  process.exit(1);
}

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000 });
try {
  await client.connect();
  const source = client.db(database);
  const catalog = client.db(catalogDatabase);
  const prefix = dryRun ? "[dry run] " : "";
  console.log(`${prefix}migrating catalog ${database} -> ${catalogDatabase}`);

  for (const name of ["truex_models", "truex_skills"]) {
    const docs = await source.collection(name).find({}).toArray();
    let copied = 0,
      skipped = 0;
    for (const doc of docs) {
      // Match on the exact _id value, so its BSON type is part of the key.
      if (
        await catalog
          .collection(name)
          .findOne({ _id: doc._id }, { projection: { _id: 1 } })
      ) {
        skipped++;
        continue;
      }
      if (!dryRun) {
        const result = await catalog
          .collection(name)
          .updateOne({ _id: doc._id }, { $setOnInsert: doc }, { upsert: true });
        if (!result.upsertedCount) {
          skipped++; // inserted concurrently
          continue;
        }
      }
      copied++;
    }
    console.log(
      `${prefix}${name}: ${docs.length} in source, ${copied} ${dryRun ? "would be copied" : "copied"}, ${skipped} already present (skipped)`,
    );
  }

  const tenants = catalog.collection("tenants");
  const existing = await tenants.findOne({ _id: "default" });
  if (existing) {
    console.log(
      `${prefix}tenant "default": already registered (db ${existing.dbName}, ${existing.status})`,
    );
    if (existing.dbName !== database)
      console.warn(
        `warning: registered default tenant uses ${existing.dbName}, but MONGO_DB is ${database}`,
      );
  } else {
    if (!dryRun) {
      const at = new Date().toISOString();
      await tenants.updateOne(
        { _id: "default" },
        {
          $setOnInsert: {
            name: "Default",
            dbName: database,
            status: "active",
            createdAt: at,
            updatedAt: at,
          },
        },
        { upsert: true },
      );
    }
    console.log(
      `${prefix}tenant "default": ${dryRun ? "would be registered" : "registered"} with db ${database}`,
    );
  }

  if (!dryRun) {
    await Promise.all([
      tenants.createIndex({ dbName: 1 }, { unique: true }),
      catalog
        .collection("truex_skills")
        .createIndex({ name: 1 }, { unique: true }),
    ]);
  }
  console.log(
    `${prefix}catalog indexes: ${dryRun ? "would be ensured" : "ensured"} (tenants.dbName, truex_skills.name)`,
  );
  console.log(
    `${prefix}done. Nothing was deleted; once verified, the old ${database}.truex_models (and truex_skills) can be dropped manually.`,
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await client.close();
}
