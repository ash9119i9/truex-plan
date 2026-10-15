import type { DatabaseService } from "../../src/database/database.service";
import { OWNED_DATABASE_PREFIX } from "../../src/config/app-config";

// Synthetic fixtures only: returns every database this app owns to empty.
// Tenant databases are dropped; catalog collections are emptied but kept, so
// the indexes the services built once per process stay in place.
export async function resetOwnedData(database: DatabaseService): Promise<void> {
  const catalog = database.catalog();
  const { databases } = (await catalog.client
    .db("admin")
    .command({ listDatabases: 1, nameOnly: true })) as {
    databases: { name: string }[];
  };
  for (const { name } of databases)
    if (name.startsWith(OWNED_DATABASE_PREFIX) && name !== catalog.databaseName)
      await catalog.client.db(name).dropDatabase();
  for (const collection of await catalog.collections())
    await collection.deleteMany({});
}
