// Candidate native SpiceDB model for the fixed action catalog. Not yet used by
// production guards. Customer roles select action IDs, never expressions.
import { ACTIONS, type Action } from "../../shared/authorization";

export const enginePermission = (action: Action) => action.replaceAll(".", "_");

type ContentRule =
  | "capability"
  | "owner"
  | "read"
  | "parent_read"
  | "parent_owner"
  | "connector"
  | "allowed";
type ResourceModel = {
  scope: "org" | "workspace";
  relations?: readonly string[];
  actions: Partial<Record<Action, ContentRule>>;
};
const actions = <T extends ContentRule>(prefix: string, rule: T) =>
  Object.fromEntries(
    ACTIONS.filter((a) => a.startsWith(prefix)).map((a) => [a, rule]),
  ) as Partial<Record<Action, T>>;

// These are native model construction rules, not runtime permission decisions.
// Candidate-list capability checks cannot substitute for resource permissions.
export const RESOURCE_MODELS = {
  workspace: {
    scope: "org",
    actions: {
      ...actions("workspace.", "capability"),
      "agent.create": "capability",
      "conversation.create": "capability",
      "project.create": "capability",
      "connector.create": "capability",
    },
  },
  agent: {
    scope: "workspace",
    actions: {
      ...actions("agent.", "owner"),
      "agent.read": "read",
      "agent.use": "read",
      "conversation.create": "read",
    },
  },
  conversation: {
    scope: "workspace",
    actions: {
      ...actions("conversation.", "owner"),
      "conversation.read": "read",
      "conversation.trace.read": "read",
      "conversation.goal.read": "read",
      "document.upload": "owner",
      "support.approve_access": "owner",
    },
  },
  document: {
    scope: "workspace",
    relations: ["relation conversation: az_conversation"],
    actions: {
      "document.read": "parent_read",
      "document.download": "parent_read",
      "document.delete": "parent_owner",
    },
  },
  project: { scope: "workspace", actions: actions("project.", "owner") },
  connector: {
    scope: "workspace",
    relations: [
      "relation manager: az_role#assignee",
      "relation allowed: az_principal | az_group#member | az_role#assignee",
    ],
    actions: {
      ...actions("connector.", "owner"),
      "connector.read": "read",
      "connector.use": "allowed",
      "connector.manage": "connector",
      "connector.attach": "connector",
      "connector.update": "connector",
      "connector.delete": "connector",
      ...actions("tool.", "allowed"),
    },
  },
  model: {
    scope: "workspace",
    relations: [
      "relation allowed: az_principal | az_group#member | az_role#assignee",
    ],
    actions: actions("model.", "allowed"),
  },
  skill: {
    scope: "workspace",
    relations: [
      "relation allowed: az_principal | az_group#member | az_role#assignee",
    ],
    actions: actions("skill.", "allowed"),
  },
} as const satisfies Record<string, ResourceModel>;
export type ModelResource = keyof typeof RESOURCE_MODELS;

export const ORGANIZATION_ACTIONS: readonly Action[] = ACTIONS.filter(
  (a) =>
    ["organization.", "platform.", "worker.", "audit."].some((prefix) =>
      a.startsWith(prefix),
    ) || a === "support.request_access",
);

export function candidateSpiceSchema() {
  const caps = ACTIONS.map((action) => `cap_${enginePermission(action)}`);
  const lines = [
    "// Generated from authorization-model.ts. Candidate only: no production guards yet.",
    "caveat az_active_version(active map<string>, key string, revision string) {",
    "  key in active && active[key] == revision",
    "}",
    "caveat az_emergency_unexpired(current_time timestamp, expires_at timestamp) {",
    "  current_time < expires_at",
    "}",
    "definition az_principal {}",
    "definition az_workload {}",
    "definition az_group_version {",
    "  relation member: az_principal | az_group#member",
    "}",
    "definition az_group {",
    "  relation version: az_group_version with az_active_version",
    "  permission member = version->member",
    "}",
    "definition az_role_version {",
    "  relation assignee: az_principal | az_workload | az_group#member",
    "}",
    "definition az_role {",
    "  relation version: az_role_version with az_active_version",
    "  permission assignee = version->assignee",
    "}",
    "definition az_org_version {",
    ...caps.map((cap) => `  relation ${cap}: az_role#assignee`),
    "}",
    "definition az_org {",
    "  relation version: az_org_version with az_active_version",
    ...caps.map((cap) => `  permission ${cap} = version->${cap}`),
    ...ORGANIZATION_ACTIONS.map(
      (action) =>
        `  permission ${enginePermission(action)} = cap_${enginePermission(action)}`,
    ),
    "}",
  ];
  for (const [type, spec] of Object.entries(RESOURCE_MODELS) as [
    ModelResource,
    ResourceModel,
  ][]) {
    const isWorkspace = type === "workspace";
    lines.push(
      `definition az_${type}_version {`,
      `  relation scope: az_${spec.scope}`,
    );
    if (isWorkspace) {
      lines.push(
        ...caps.map((cap) => `  relation ${cap}_local: az_role#assignee`),
      );
      lines.push(
        ...caps.map(
          (cap) => `  permission ${cap} = ${cap}_local + scope->${cap}`,
        ),
      );
    } else {
      if (type === "document") {
        lines.push(
          "  permission owned = conversation->owned",
          "  permission content_read = conversation->conversation_read",
        );
      } else if (type !== "model" && type !== "skill") {
        lines.push(
          "  relation owner: az_principal",
          "  relation reader: az_principal | az_group#member | az_role#assignee",
        );
        if (type === "conversation")
          lines.push(
            "  relation emergency_reader: az_principal with az_emergency_unexpired",
          );
        lines.push(
          "  permission owned = owner",
          `  permission content_read = owner + reader${type === "conversation" ? " + emergency_reader" : ""}${type === "connector" ? " + manager" : ""}`,
        );
      }
      lines.push(...(spec.relations ?? []).map((line) => `  ${line}`));
    }
    for (const [action, rule] of Object.entries(spec.actions) as [
      Action,
      ContentRule,
    ][]) {
      // Create actions apply at a parent before the child exists. They must
      // never become an owner mutation on an existing private child.
      if (!isWorkspace && action.endsWith(".create")) {
        if (type === "agent" && action === "conversation.create")
          lines.push(
            `  permission ${enginePermission(action)} = scope->cap_${enginePermission(action)} & agent_use`,
          );
        continue;
      }
      const content = {
        capability: "",
        owner: " & owner",
        read: " & content_read",
        parent_read: " & conversation->conversation_read",
        parent_owner: " & conversation->owned",
        connector: " & (owner + manager)",
        allowed: type === "connector" ? " & (owner + allowed)" : " & allowed",
      }[rule];
      const cap = isWorkspace
        ? `cap_${enginePermission(action)}`
        : `scope->cap_${enginePermission(action)}`;
      lines.push(`  permission ${enginePermission(action)} = ${cap}${content}`);
    }
    lines.push(
      "}",
      `definition az_${type} {`,
      `  relation version: az_${type}_version with az_active_version`,
    );
    if (isWorkspace)
      lines.push(...caps.map((cap) => `  permission ${cap} = version->${cap}`));
    else if (type !== "model" && type !== "skill")
      lines.push(
        "  permission owned = version->owned",
        "  permission content_read = version->content_read",
      );
    for (const action of Object.keys(spec.actions) as Action[]) {
      if (
        !isWorkspace &&
        action.endsWith(".create") &&
        !(type === "agent" && action === "conversation.create")
      )
        continue;
      lines.push(
        `  permission ${enginePermission(action)} = version->${enginePermission(action)}`,
      );
    }
    lines.push("}");
  }
  return (lines.join("\n") + "\n").replaceAll("az_", "az_v1_");
}
