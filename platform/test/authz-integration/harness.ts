import { randomUUID } from "node:crypto";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { Store } from "../../src/store";
import {
  PolicyStateStore,
  policyOperationDigest,
  type PolicyOperation,
  type EntityChange,
} from "../../src/policy-state";
import {
  ACTIONS,
  type AuthorizationContext,
  type ResourceRef,
  type PolicyRevision,
} from "../../../shared/authorization";

export function workerContext(
  tenantId: string,
  purpose: "projection" | "reconciliation",
): AuthorizationContext {
  return {
    version: 1,
    tenant: { id: tenantId, generation: "tenant-generation-1" },
    principal: {
      kind: "workload",
      id: `fixture-${purpose}`,
      generation: "workload-generation-1",
      purpose,
    },
    binding: { id: `binding-${purpose}`, generation: "binding-generation-1" },
    credential: {
      kind: "workload",
      id: `credential-${purpose}`,
      issuedAtMs: Date.now() - 1000,
      expiresAtMs: Date.now() + 60_000,
      scopes: [
        purpose === "projection"
          ? "worker.policy.project"
          : "worker.policy.reconcile",
      ],
    },
    requestId: randomUUID(),
  };
}

export function operation(
  tenantId: string,
  operationId: string,
): PolicyOperation {
  return {
    tenantId,
    tenantGeneration: "tenant-generation-1",
    operationId,
    payloadDigest: policyOperationDigest(operationId),
    actor: {
      kind: "human",
      id: "operator-1",
      generation: "principal-generation-1",
    },
    action: "organization.members.manage",
    requestId: randomUUID(),
  };
}
export async function harness(count = 1) {
  const mongo = await MongoMemoryReplSet.create({
    replSet: {
      count,
      args: ["--setParameter", "enableTestCommands=1"],
      configSettings: {
        electionTimeoutMillis: 1000,
        heartbeatIntervalMillis: 250,
      },
    },
  });
  const store = new Store(mongo.getUri(), "authz_fixture", "authz_fixture");
  try {
    await store.connect();
  } catch (error) {
    await store.client.close();
    await mongo.stop();
    throw error;
  }
  const policy = new PolicyStateStore(store);
  await policy.ensureIndexes();
  return {
    mongo,
    store,
    policy,
    publish: (revision: PolicyRevision) =>
      policy.publish(revision, workerContext(revision.tenantId, "projection")),
    fenceForRestore: (tenantId: string) =>
      policy.fenceForRestore(
        tenantId,
        workerContext(tenantId, "reconciliation"),
      ),
    async stop() {
      await store.client.close();
      await mongo.stop();
    },
    async seed(tenantId: string) {
      const context: AuthorizationContext = {
        version: 1,
        principal: {
          kind: "human",
          id: "person-1",
          generation: "principal-generation-1",
        },
        tenant: { id: tenantId, generation: "tenant-generation-1" },
        binding: { id: "member-1", generation: "binding-generation-1" },
        credential: {
          kind: "session",
          id: "session-1",
          issuedAtMs: Date.now() - 1000,
          expiresAtMs: Date.now() + 60_000,
          scopes: [...ACTIONS],
        },
        requestId: randomUUID(),
      };
      const resource: ResourceRef = {
        tenantId,
        type: "conversation",
        id: "conversation-1",
        generation: "resource-generation-1",
      };
      await policy.initialize(
        operation(tenantId, "bootstrap"),
        "model-fixture-1",
      );
      const changes: EntityChange[] = [
        {
          kind: "create",
          entity: {
            tenantId,
            kind: "principal",
            id: context.principal.id,
            generation: context.principal.generation,
            subject: context.principal,
          },
        },
        {
          kind: "create",
          entity: {
            tenantId,
            kind: "binding",
            id: context.binding.id,
            generation: context.binding.generation,
            subject: context.principal,
          },
        },
        {
          kind: "create",
          entity: {
            tenantId,
            kind: resource.type,
            id: resource.id,
            generation: resource.generation,
          },
        },
      ];
      const revision = await policy.mutate({
        ...operation(tenantId, "seed"),
        changes,
        fence: "pending",
      });
      await policy.publish(revision, workerContext(tenantId, "projection"));
      const admit = (
        operationId: string,
        overrides: Partial<Parameters<typeof policy.admit>[0]> = {},
      ) => ({
        context,
        action: "conversation.send" as const,
        resource,
        operationId,
        payloadDigest: policyOperationDigest(operationId),
        ...overrides,
      });
      const revoke = (operationId: string) =>
        policy.mutate({
          ...operation(tenantId, operationId),
          fence: "revoked",
          changes: [
            {
              kind: "revoke",
              entity: {
                tenantId,
                kind: "binding",
                id: context.binding.id,
                generation: context.binding.generation,
                subject: context.principal,
              },
            },
          ],
        });
      return { context, resource, revision, admit, revoke };
    },
  };
}

export function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
