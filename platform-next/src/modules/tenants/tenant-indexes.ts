import type { Db } from "mongodb";
import { AGENT_INDEXES } from "../agents/agent";
import { CHAT_INDEXES } from "../chats/chat";
import { CONNECTION_INDEXES } from "../connectors/connection";
import { GOAL_INDEXES } from "../goals/goal";

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
// 3: owner_connector_unique on mcp_connections, for directory connectors. A
// tenant still behind cannot store a connection (the upsert would need the
// unique index to resolve a race); ensure-tenant-indexes before enabling a
// connector.
// 4: chat_path_version_unique on chat_files, for stored chat files. A tenant
// still behind stores no files (the first insert would build the collection
// without its unique index); ensure-tenant-indexes before setting
// CHAT_FILES_S3_BUCKET.
// 5: owner_state and staged_ttl on chat_uploads, for attached files. A
// tenant still behind keeps staged uploads forever and counts them by a
// collection scan; ensure-tenant-indexes before setting CHAT_UPLOADS_ENABLED.
// 6: followups_created on runs, for the Follow Up report. A tenant still
// behind reports correctly, by a collection scan; ensure-tenant-indexes
// before running followups-report on a large database.
// 7: chat_unique and slot_held_owner on goals, for goal mode. A tenant still
// behind could store two goal documents for one chat (concurrent first
// updates need the unique index); ensure-tenant-indexes before setting
// tenant goal settings.
// 8: active_watch on goals, for the goal watch sweep. A tenant still behind
// is swept correctly, by a scan of its goals.
export const TENANT_INDEX_VERSION = 8;

const TENANT_INDEXES = {
  ...CHAT_INDEXES,
  ...AGENT_INDEXES,
  ...CONNECTION_INDEXES,
  ...GOAL_INDEXES,
};

// Safe to repeat: an index that already exists with the same definition is a
// no-op. One with the same name and a different definition fails loudly.
export async function createTenantIndexes(db: Db): Promise<void> {
  await Promise.all(
    Object.entries(TENANT_INDEXES).map(([name, indexes]) =>
      db.collection(name).createIndexes(indexes),
    ),
  );
}
