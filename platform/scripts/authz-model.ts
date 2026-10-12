import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { candidateSpiceSchema } from "../src/authorization-model";

const v1 = candidateSpiceSchema();
writeFileSync(resolve("policy/authorization.candidate.v1.zed"), v1);
// Isolated overlap fixture, deliberately tighter conversation reads. Never a
// customer rollout model. Existing v1 definitions and semantics stay intact.
const overlap = v1
  .replaceAll("az_v1_", "az_overlap_v2_")
  .replace(
    "permission conversation_read = scope->cap_conversation_read & content_read",
    "permission conversation_read = scope->cap_conversation_read & owner",
  );
writeFileSync(resolve("policy/poc.catalog-overlap.spicedb.zed"), overlap);
