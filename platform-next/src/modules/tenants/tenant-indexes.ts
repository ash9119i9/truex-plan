import type { Db } from "mongodb";
import { AGENT_INDEXES } from "../agents/agent";
import { CHAT_INDEXES } from "../chats/chat";

// Every index a tenant database needs. Provisioning builds them before the
// tenant becomes usable, so requests never check or build indexes.
//
// Bump TENANT_INDEX_VERSION whenever an index here is added or changed, and
// run `operator ensure-tenant-indexes --all` as a deploy step before the code
// that relies on it. A server logs an error at startup while any ready tenant
// is behind.
//
// 2: active_lease on chats, for the recovery sweep. A tenant still at 1 is
// swept correctly, by a collection scan.
export const TENANT_INDEX_VERSION = 2;

const TENANT_INDEXES = { ...CHAT_INDEXES, ...AGENT_INDEXES };

// Safe to repeat: an index that already exists with the same definition is a
// no-op. One with the same name and a different definition fails loudly.
export async function createTenantIndexes(db: Db): Promise<void> {
  await Promise.all(
    Object.entries(TENANT_INDEXES).map(([name, indexes]) =>
      db.collection(name).createIndexes(indexes),
    ),
  );
}
