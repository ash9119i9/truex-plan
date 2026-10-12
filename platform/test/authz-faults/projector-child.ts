// Fixture worker for process-crash proof, not the production A07 publisher.
// Durable payloads are deliberately staged separately in this experiment;
// production must bind their immutable digest to the transactional outbox.
import { Store } from "../../src/store";
import {
  PolicyStateStore,
  policyOperationDigest,
} from "../../src/policy-state";
import { workerContext } from "../authz-integration/harness";
import { pocEngine, type Tuple } from "../authz-integration/poc-engine";
import {
  isPolicyRevision,
  type PolicyRevision,
} from "../../../shared/authorization";

export interface FixturePayload {
  _id: string;
  revision: PolicyRevision;
  tuples: Tuple[];
  digest: string;
}
async function main() {
  const uri = process.env.AUTHZ_FIXTURE_MONGO_URI ?? "";
  const url = new URL(uri);
  const eventId = process.argv[2];
  if (
    url.protocol !== "mongodb:" ||
    url.hostname !== "127.0.0.1" ||
    url.username ||
    url.password ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(eventId ?? "")
  )
    throw new Error(
      "Fixture projector requires an explicit loopback Mongo event",
    );
  const store = new Store(uri, "authz_fixture", "authz_fixture");
  await store.connect();
  try {
    const payload = await store.catalog
      .collection<FixturePayload>("authorization_poc_payloads")
      .findOne({ _id: eventId });
    if (
      !payload ||
      !isPolicyRevision(payload.revision) ||
      policyOperationDigest(JSON.stringify(payload.tuples)) !== payload.digest
    )
      throw new Error("Missing or changed sealed fixture payload");
    const outbox = await store.catalog
      .collection("authorization_outbox")
      .findOne({
        tenantId: payload.revision.tenantId,
        "revision.namespace": payload.revision.namespace,
      });
    if (!outbox)
      throw new Error("Fixture payload has no committed outbox event");
    const engine = await pocEngine("spicedb", true);
    try {
      if (process.env.AUTHZ_FIXTURE_CRASH_AFTER_FIRST === "1") {
        await engine.write(payload.tuples.slice(0, 1));
        process.exit(42); // Abrupt process loss, with a real partial engine write.
      }
      await engine.write(payload.tuples); // TOUCH is idempotent after unknown outcome.
      const policy = new PolicyStateStore(store);
      const published = await policy.publish(
        payload.revision,
        workerContext(payload.revision.tenantId, "projection"),
      );
      process.stdout.write(JSON.stringify({ eventId, published }) + "\n");
    } finally {
      await engine.close();
    }
  } finally {
    await store.client.close();
  }
}
main().catch((error) => {
  process.stderr.write(String(error) + "\n");
  process.exitCode = 1;
});
