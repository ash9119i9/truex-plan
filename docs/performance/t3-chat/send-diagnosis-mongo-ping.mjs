// Run from platform/ so dotenv loads the same local configuration as platform.
// Read-only: connection + ping only, no index creation or data reads/writes.
// Credentials, hosts, database names and error messages are never printed.
import dotenv from "../../../platform/node_modules/dotenv/lib/main.js";
import { MongoClient } from "../../../platform/node_modules/mongodb/lib/index.js";
import { writeFile } from "node:fs/promises";
dotenv.config({ quiet: true });
const client = new MongoClient(
  process.env.MONGO_URI || "mongodb://127.0.0.1:27017",
  { serverSelectionTimeoutMS: 5000 },
);
try {
  await client.connect();
  const database = client.db(
    process.env.CATALOG_MONGO_DB || process.env.MONGO_DB || "truex",
  );
  await database.command({ ping: 1 });
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    await database.command({ ping: 1 });
    samples.push(performance.now() - start);
  }
  const result = {
    measuredAt: new Date().toISOString(),
    scope:
      "Existing configured catalog Mongo: warmed connection, one warmup, five read-only pings; no provider or user-data reads/writes",
    node: process.version,
    samplesMs: samples,
    medianMs: [...samples].sort((a, b) => a - b)[2],
  };
  await writeFile(
    new URL("./send-diagnosis-mongo-ping-results.json", import.meta.url),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(
    JSON.stringify({ errorName: error?.name, errorCode: error?.code }),
  );
  process.exitCode = 1;
} finally {
  await client.close();
}
