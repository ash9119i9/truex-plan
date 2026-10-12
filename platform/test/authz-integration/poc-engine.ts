import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

export type EngineKind = "openfga" | "spicedb";
export interface Tuple {
  user: string;
  relation: string;
  object: string;
  condition?: { name: string; context: Record<string, unknown> };
}
export type CheckContext = Record<string, unknown>;
export interface CheckItem {
  user: string;
  relation: string;
  object: string;
  context?: CheckContext;
}
export interface PocEngine {
  kind: EngineKind;
  readonly lastObservedToken?: string;
  write(tuples: readonly Tuple[]): Promise<void>;
  remove(tuples: readonly Tuple[]): Promise<void>;
  check(
    user: string,
    relation: string,
    object: string,
    context?: CheckContext,
    consistencyToken?: string,
  ): Promise<boolean>;
  list(
    user: string,
    type: string,
    relation: string,
    context?: CheckContext,
  ): Promise<string[]>;
  checkMany(
    items: readonly CheckItem[],
    consistencyToken?: string,
  ): Promise<boolean[]>;
  close(): Promise<void>;
}
const token = "truex-poc-fixture-only";
async function request(
  base: string,
  path: string,
  body?: unknown,
  method = "POST",
) {
  const response = await fetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const text = await response.text();
  if (!response.ok)
    throw new Error(
      `${base}${path}: ${response.status}: ${text.slice(0, 1000)}`,
    );
  return text;
}
export function node(namespace: string, type: string, id: string) {
  if (
    !/^[A-Za-z0-9_-]{1,64}$/.test(namespace) ||
    !/^[a-z][a-z0-9_]{0,63}$/.test(type) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(id)
  )
    throw new Error("Invalid POC node");
  return `${type}:${namespace}__${id}`;
}
export function assertSnapshot(namespace: string, tuples: readonly Tuple[]) {
  for (const tuple of tuples) {
    for (const side of [tuple.user.split("#")[0], tuple.object]) {
      const id = side.slice(side.indexOf(":") + 1);
      if (!id.startsWith(`${namespace}__`))
        throw new Error("Snapshot edge crosses namespaces");
    }
    if (tuple.user.includes("*") || tuple.object.includes("*"))
      throw new Error("Snapshot wildcard is forbidden");
  }
}
const objectRef = (value: string) => {
  const [objectType, objectId] = value.split(":");
  return { objectType, objectId };
};
const subjectRef = (value: string) => {
  const [object, optionalRelation] = value.split("#");
  return {
    object: objectRef(object),
    ...(optionalRelation ? { optionalRelation } : {}),
  };
};

/** Real services, fixed loopback endpoints and isolated fixture credentials. */
export async function pocEngine(
  kind: EngineKind,
  components = false,
  fixtureProxyPort?: number,
): Promise<PocEngine> {
  if (
    fixtureProxyPort !== undefined &&
    (!Number.isInteger(fixtureProxyPort) ||
      fixtureProxyPort < 1024 ||
      fixtureProxyPort > 65535)
  )
    throw new Error("Invalid loopback fixture proxy port");
  if (kind === "openfga") {
    const base = `http://127.0.0.1:${fixtureProxyPort ?? 18088}`;
    const store = JSON.parse(
      await request(base, "/stores", { name: `truex-poc-${randomUUID()}` }),
    );
    const path = `/stores/${store.id}`;
    const model = JSON.parse(
      readFileSync(
        resolve(
          components
            ? "policy/poc.components.openfga.json"
            : "policy/poc.openfga.json",
        ),
        "utf8",
      ),
    );
    const { authorization_model_id: modelId } = JSON.parse(
      await request(base, `${path}/authorization-models`, model),
    );
    const check: PocEngine["check"] = async (
      user,
      relation,
      object,
      context,
      consistencyToken,
    ) => {
      if (consistencyToken !== undefined)
        throw new Error("SpiceDB token cannot select OpenFGA consistency");
      const result = JSON.parse(
        await request(base, `${path}/check`, {
          authorization_model_id: modelId,
          tuple_key: { user, relation, object },
          consistency: "HIGHER_CONSISTENCY",
          ...(context ? { context } : {}),
        }),
      );
      return result.allowed === true;
    };
    return {
      kind,
      async write(tuples) {
        if (tuples.length)
          await request(base, `${path}/write`, {
            authorization_model_id: modelId,
            writes: { tuple_keys: tuples },
          });
      },
      async remove(tuples) {
        if (tuples.length)
          await request(base, `${path}/write`, {
            authorization_model_id: modelId,
            deletes: {
              tuple_keys: tuples.map(({ user, relation, object }) => ({
                user,
                relation,
                object,
              })),
            },
          });
      },
      check,
      async list(user, type, relation, context) {
        const result = JSON.parse(
          await request(base, `${path}/list-objects`, {
            authorization_model_id: modelId,
            user,
            type,
            relation,
            consistency: "HIGHER_CONSISTENCY",
            ...(context ? { context } : {}),
          }),
        );
        return result.objects;
      },
      async close() {
        await request(base, path, undefined, "DELETE");
      },
      async checkMany(items, consistencyToken) {
        if (consistencyToken !== undefined)
          throw new Error("SpiceDB token cannot select OpenFGA consistency");
        if (items.length > 50)
          throw new Error("POC bulk exceeds 50 candidates");
        return Promise.all(
          items.map((item) =>
            check(item.user, item.relation, item.object, item.context),
          ),
        );
      },
    };
  }
  const base = `http://127.0.0.1:${fixtureProxyPort ?? 18089}`;
  let lastObservedToken: string | undefined;
  const consistency = (token?: string) => {
    if (
      token !== undefined &&
      (typeof token !== "string" ||
        token.length > 2048 ||
        !/^[A-Za-z0-9_+/=-]+$/.test(token))
    )
      throw new Error("Invalid fixture consistency token");
    return token ? { atLeastAsFresh: { token } } : { fullyConsistent: true };
  };
  // Superset for concurrently running POC suites; neither suite deletes the
  // other's types. Production schema overlap still needs a dedicated rollout.
  const schema =
    readFileSync(resolve("policy/poc.spicedb.zed"), "utf8") +
    readFileSync(resolve("policy/poc.components.spicedb.zed"), "utf8") +
    readFileSync(resolve("policy/authorization.candidate.v1.zed"), "utf8") +
    readFileSync(resolve("policy/poc.catalog-overlap.spicedb.zed"), "utf8");
  await request(base, "/v1/schema/write", { schema });
  const mutate = async (tuples: readonly Tuple[], operation: string) => {
    if (tuples.length)
      await request(base, "/v1/relationships/write", {
        updates: tuples.map((tuple) => ({
          operation,
          relationship: {
            resource: objectRef(tuple.object),
            relation: tuple.relation,
            subject: subjectRef(tuple.user),
            ...(tuple.condition
              ? {
                  optionalCaveat: {
                    caveatName: tuple.condition.name,
                    context: tuple.condition.context,
                  },
                }
              : {}),
          },
        })),
      });
  };
  return {
    kind,
    get lastObservedToken() {
      return lastObservedToken;
    },
    write: (tuples) => mutate(tuples, "OPERATION_TOUCH"),
    remove: (tuples) => mutate(tuples, "OPERATION_DELETE"),
    async check(user, permission, object, context, consistencyToken) {
      const result = JSON.parse(
        await request(base, "/v1/permissions/check", {
          consistency: consistency(consistencyToken),
          resource: objectRef(object),
          permission,
          subject: subjectRef(user),
          ...(context ? { context } : {}),
        }),
      );
      if (typeof result.checkedAt?.token === "string")
        lastObservedToken = result.checkedAt.token;
      return result.permissionship === "PERMISSIONSHIP_HAS_PERMISSION";
    },
    async list(user, resourceObjectType, permission, context) {
      const text = await request(base, "/v1/permissions/resources", {
        consistency: { fullyConsistent: true },
        resourceObjectType,
        permission,
        subject: subjectRef(user),
        ...(context ? { context } : {}),
      });
      return text
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line).result)
        .filter(
          (result) =>
            result.permissionship === "LOOKUP_PERMISSIONSHIP_HAS_PERMISSION",
        )
        .map((result) => result.resourceObjectId)
        .map((id) => `${resourceObjectType}:${id}`);
    },
    async checkMany(items, consistencyToken) {
      if (items.length > 50) throw new Error("POC bulk exceeds 50 candidates");
      if (!items.length) return [];
      const requests = items.map((item) => ({
        resource: objectRef(item.object),
        permission: item.relation,
        subject: subjectRef(item.user),
        ...(item.context ? { context: item.context } : {}),
      }));
      const result = JSON.parse(
        await request(base, "/v1/permissions/checkbulk", {
          consistency: consistency(consistencyToken),
          items: requests,
        }),
      );
      if (!Array.isArray(result.pairs) || result.pairs.length !== items.length)
        throw new Error("Native bulk response omitted candidates");
      return result.pairs.map((pair: any, i: number) => {
        const expected = requests[i];
        if (
          pair.error ||
          pair.request?.permission !== expected.permission ||
          pair.request?.resource?.objectType !== expected.resource.objectType ||
          pair.request?.resource?.objectId !== expected.resource.objectId ||
          pair.request?.subject?.object?.objectType !==
            expected.subject.object.objectType ||
          pair.request?.subject?.object?.objectId !==
            expected.subject.object.objectId ||
          !isDeepStrictEqual(
            pair.request?.context ?? {},
            expected.context ?? {},
          ) ||
          (pair.request?.subject?.optionalRelation || undefined) !==
            expected.subject.optionalRelation ||
          ![
            "PERMISSIONSHIP_HAS_PERMISSION",
            "PERMISSIONSHIP_NO_PERMISSION",
            "PERMISSIONSHIP_CONDITIONAL_PERMISSION",
          ].includes(pair.item?.permissionship)
        )
          throw new Error("Native bulk candidate check unavailable");
        return pair.item.permissionship === "PERMISSIONSHIP_HAS_PERMISSION";
      });
    },
    async close() {
      /* Schema/tuples live only in this isolated POC datastore. */
    },
  };
}

export function snapshot(namespace = randomUUID()) {
  const id = (type: string, value: string) => node(namespace, type, value);
  const user = (value: string) => id("user", value);
  const tuples: Tuple[] = [];
  const put = (who: string, relation: string, object: string) =>
    tuples.push({ user: who, relation, object });
  const organization = id("organization", "org");
  const workspace = id("workspace", "workspace");
  const memberRole = id("role", "member");
  const adminRole = id("role", "administrator");
  const group = id("group", "readers");
  const conversation = id("conversation", "owned");
  const other = id("conversation", "other-private");
  const document = id("document", "file");
  put(user("owner"), "assignee", memberRole);
  put(user("reader"), "assignee", memberRole);
  put(user("service-owner"), "assignee", memberRole);
  put(user("administrator"), "assignee", adminRole);
  for (const cap of ["read", "send", "approve", "settings"])
    put(`${memberRole}#assignee`, `${cap}_cap`, organization);
  put(`${adminRole}#assignee`, "read_cap", organization);
  put(`${adminRole}#assignee`, "administrator", organization);
  put(organization, "organization", workspace);
  for (const resource of [conversation, other])
    put(workspace, "workspace", resource);
  put(user("owner"), "owner", conversation);
  put(user("service-owner"), "owner", other);
  put(`${group}#member`, "reader", conversation);
  put(user("reader"), "member", group);
  put(conversation, "conversation", document);
  assertSnapshot(namespace, tuples);
  return {
    namespace,
    user,
    id,
    tuples,
    conversation,
    other,
    document,
    group,
    memberRole,
    organization,
    workspace,
  };
}
