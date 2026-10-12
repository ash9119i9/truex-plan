// No dotenv/default URI. Operator must explicitly select the target catalog.
import { Store } from "../src/store";
import { IdentityStore } from "../src/identity";
import { backfillGoogleIdentities } from "../src/identity-migration";
import { isPrincipal, type PrincipalRef } from "../../shared/authorization";
async function main() {
  const args = process.argv.slice(2);
  const apply = args.at(-1) === "--apply";
  if (apply) args.pop();
  if (
    args.length !== 2 ||
    !process.env.AUTHZ_MIGRATION_MONGO_URI ||
    !/^[A-Za-z0-9_-]{1,63}$/.test(args[0])
  )
    throw new Error(
      "Usage: AUTHZ_MIGRATION_MONGO_URI=<explicit URI> npm run authz:identity:backfill -- <catalog database> <installed Google connection ID> [--apply]",
    );
  // Direct catalog connection: avoid legacy startup indexes/default tenant
  // access while inspecting collisions and preparing the additive migration.
  const store = new Store(
    process.env.AUTHZ_MIGRATION_MONGO_URI,
    args[0],
    args[0],
  );
  const actor: PrincipalRef = {
    kind: "human",
    id: process.env.AUTHZ_MIGRATION_ACTOR_ID ?? "",
    generation: process.env.AUTHZ_MIGRATION_ACTOR_GENERATION ?? "",
  };
  if (apply && !isPrincipal(actor))
    throw new Error(
      "Apply requires an explicit named migration actor ID and generation",
    );
  try {
    await store.client.connect();
    store.catalog = store.client.db(args[0]);
    const identity = new IdentityStore(store);
    if (apply) await identity.ensureIndexes();
    const report = await backfillGoogleIdentities(
      identity,
      args[1],
      apply,
      apply ? actor : undefined,
    );
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    if (report.issueCount) process.exitCode = 1;
  } finally {
    await store.client.close();
  }
}
main().catch(() => {
  // Driver errors may contain credential-bearing URIs; do not dump them.
  process.stderr.write(
    "Identity migration failed. Verify explicit catalog/connection configuration and database health.\n",
  );
  process.exitCode = 1;
});
