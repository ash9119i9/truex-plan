import { randomUUID } from "node:crypto";
import { node, type Tuple } from "./poc-engine";

export type ComponentKind = "group" | "role" | "org" | "conversation";
export interface Component {
  tenant: string;
  kind: ComponentKind;
  alias: string;
  version: string;
}

/** Prototype input is an immutable, server-owned projection payload. */
export function component(
  tenant: string,
  kind: ComponentKind,
  id: string,
  revision: string = randomUUID(),
): Component {
  if (
    !Object.hasOwn(references, kind) ||
    id.includes("__") ||
    revision.includes("__")
  )
    throw new Error("Invalid immutable component identity");
  return {
    tenant,
    kind,
    alias: node(tenant, `cmp_${kind}`, id),
    version: node(tenant, `cmp_${kind}_version`, `${id}__${revision}`),
  };
}

const references: Record<ComponentKind, Record<string, readonly string[]>> = {
  group: { member: ["cmp_user", "cmp_group#member"] },
  role: { assignee: ["cmp_user", "cmp_group#member"] },
  org: Object.fromEntries(
    ["read", "send", "approve", "settings"].map((cap) => [
      `${cap}_cap`,
      ["cmp_role#assignee"],
    ]),
  ),
  conversation: {
    scope: ["cmp_org"],
    owner: ["cmp_user"],
    reader: ["cmp_user", "cmp_group#member"],
    emergency_reader: ["cmp_user"],
  },
};

/**
 * No arbitrary tuples, deletes or caller conditions. A delayed payload can
 * write only its own immutable version and its exactly bound selector.
 * This is not a production projector or a substitute for authenticated workers.
 */
export function compileComponent(
  c: Component,
  edges: readonly { user: string; relation: string }[],
): Tuple[] {
  const [aliasType, aliasId, extraColon] = c.alias.split(":");
  const aliasLocal = aliasId?.slice(c.tenant.length + 2);
  const expectedVersionPrefix = `cmp_${c.kind}_version:${c.tenant}__${aliasLocal}__`;
  if (
    aliasType !== `cmp_${c.kind}` ||
    extraColon !== undefined ||
    !aliasId?.startsWith(`${c.tenant}__`) ||
    !aliasLocal ||
    aliasLocal.includes("__") ||
    !c.version.startsWith(expectedVersionPrefix) ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(c.tenant) ||
    !/^[A-Za-z0-9_-]+$/.test(aliasLocal) ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(
      c.version.slice(expectedVersionPrefix.length),
    ) ||
    c.version.slice(expectedVersionPrefix.length).includes("__")
  )
    throw new Error("Invalid immutable component identity");
  const tuples: Tuple[] = edges.map(({ user, relation }) => {
    const [subject, userset, extra] = user.split("#");
    const [type, id, extraColon] = subject.split(":");
    const referenceType = type + (userset ? `#${userset}` : "");
    if (
      extra !== undefined ||
      extraColon !== undefined ||
      !id?.startsWith(`${c.tenant}__`) ||
      !/^[A-Za-z0-9_-]+$/.test(id) ||
      !references[c.kind][relation]?.includes(referenceType)
    )
      throw new Error("Invalid component edge or tenant reference");
    return { user, relation, object: c.version };
  });
  return [
    ...tuples,
    {
      user: c.version,
      relation: "version",
      object: c.alias,
      condition: {
        name: "cmp_active_version",
        context: { key: c.alias, revision: c.version },
      },
    },
  ];
}

export function componentFixture(tenant = randomUUID()) {
  const user = (id: string) => node(tenant, "cmp_user", id);
  const group = component(tenant, "group", "readers");
  const role = component(tenant, "role", "member");
  const org = component(tenant, "org", "organization");
  const owned = component(tenant, "conversation", "owned");
  const privateOther = component(tenant, "conversation", "private-other");
  const components = [group, role, org, owned, privateOther];
  const active = Object.fromEntries(
    components.map((c) => [c.alias, c.version]),
  );
  const tuples = [
    ...compileComponent(group, [{ user: user("reader"), relation: "member" }]),
    ...compileComponent(
      role,
      ["owner", "reader", "administrator", "service-owner"].map((id) => ({
        user: user(id),
        relation: "assignee",
      })),
    ),
    ...compileComponent(
      org,
      ["read", "send", "approve", "settings"].map((cap) => ({
        user: `${role.alias}#assignee`,
        relation: `${cap}_cap`,
      })),
    ),
    ...compileComponent(owned, [
      { user: org.alias, relation: "scope" },
      { user: user("owner"), relation: "owner" },
      { user: `${group.alias}#member`, relation: "reader" },
    ]),
    ...compileComponent(privateOther, [
      { user: org.alias, relation: "scope" },
      { user: user("service-owner"), relation: "owner" },
    ]),
  ];
  return {
    tenant,
    user,
    group,
    role,
    org,
    owned,
    privateOther,
    active,
    tuples,
  };
}
