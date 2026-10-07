import { ApiError } from "./errors";
import { currentTenant, type ChatVisibility } from "./tenant";
import { currentUser, type UserRef } from "./user";

// Who may read or change a conversation or project folder.
//
// | Caller            | "all"          | "own"          |
// | Owner             | read and write | read and write |
// | Admin (not owner) | read only      | read only      |
// | Other user        | read only      | 404            |
//
// Only the owner writes, because a turn runs with the owner's credentials.
// Hidden records answer 404, never 403, so their existence does not leak. A
// record without an owner (should not exist after the purge) is visible to
// admins only, read-only.
//
// No user in context means an internal caller (ingestion, polling, cold
// resume, scripts, service-level tests): every /api request runs inside
// userContext, set by userMiddleware, so HTTP callers always have one.
export type Access = "read" | "write";

export const chatVisibility = (): ChatVisibility =>
  currentTenant()?.chatVisibility ?? "all";
/** The workspace is user-specific: members see only their own content. */
export const isPrivateWorkspace = () => chatVisibility() === "own";

type Decision = "allow" | "hidden" | "readOnly";
export function decide(
  ownerId: string | undefined,
  mode: Access,
  user: UserRef | undefined,
  visibility: ChatVisibility,
): Decision {
  if (!user) return "allow";
  if (ownerId && ownerId === user.id) return "allow";
  const readable =
    user.role === "admin" || (!!ownerId && visibility === "all");
  if (!readable) return "hidden";
  return mode === "read" ? "allow" : "readOnly";
}

export function checkSession<T extends { userId?: string }>(
  session: T,
  mode: Access,
): T {
  const decision = decide(
    session.userId,
    mode,
    currentUser(),
    chatVisibility(),
  );
  if (decision === "hidden")
    throw new ApiError(404, "Session not found", "SESSION_NOT_FOUND");
  if (decision === "readOnly")
    throw new ApiError(
      403,
      "Only the person who started this conversation can change it",
      "NOT_SESSION_OWNER",
    );
  return session;
}

export function checkProject<T extends { ownerId?: string }>(
  project: T,
  mode: Access,
): T {
  const decision = decide(
    project.ownerId,
    mode,
    currentUser(),
    chatVisibility(),
  );
  if (decision === "hidden")
    throw new ApiError(404, "Project not found", "PROJECT_NOT_FOUND");
  if (decision === "readOnly")
    throw new ApiError(
      403,
      "Only the person who created this project can change it",
      "NOT_PROJECT_OWNER",
    );
  return project;
}

// Mongo filter for lists, applied inside the query so hidden records never
// leave the database. Admins and internal callers see everything.
export function ownerFilter(field: "userId" | "ownerId") {
  const user = currentUser();
  if (!user || user.role === "admin") return {};
  if (chatVisibility() === "own") return { [field]: user.id };
  // Ownerless records are admin-only in every mode.
  return { [field]: { $exists: true } };
}

// Agents in a private (user-specific) workspace belong to their creator.
//
// | Caller            | read           | use / change   |
// | Creator           | allow          | allow          |
// | Admin (not creator)| allow          | 403            |
// | Other user        | 404            | 404            |
//
// "use" means starting a conversation with the agent; "change" means its
// attachments. An agent with no creator (it predates ownership) is
// admin-readable only until a trusted operation assigns an owner; nobody
// uses or changes it, and ordinary users do not see it. In a shared workspace
// agents stay visible to the whole workspace, as before. Hidden agents answer
// 404, like missing ones.
export type AgentAccess = "read" | "use" | "write";

export function decideAgent(
  createdBy: string | undefined,
  mode: AgentAccess,
  user: UserRef | undefined,
  privateWorkspace: boolean,
): Decision {
  if (!user || !privateWorkspace) return "allow";
  if (createdBy && createdBy === user.id) return "allow";
  if (user.role !== "admin") return "hidden";
  return mode === "read" ? "allow" : "readOnly";
}

export function checkAgent<T extends { createdBy?: string }>(
  agent: T,
  mode: AgentAccess,
): T {
  const decision = decideAgent(
    agent.createdBy,
    mode,
    currentUser(),
    isPrivateWorkspace(),
  );
  if (decision === "hidden")
    throw new ApiError(404, "Agent not found", "AGENT_NOT_FOUND");
  if (decision === "readOnly")
    throw new ApiError(
      403,
      "Only the person who created this agent can use or change it",
      "NOT_AGENT_OWNER",
    );
  return agent;
}

// Mongo filter for agent lists, applied inside the query.
export function agentFilter() {
  const user = currentUser();
  if (!user || user.role === "admin" || !isPrivateWorkspace()) return {};
  return { createdBy: user.id };
}

/**
 * True when the caller is reading content that is not theirs in a private
 * workspace: an admin looking at someone else's conversation or agent. Such
 * reads are audited, and never start the owner's runtime.
 */
export function readsOthersPrivate(ownerId: string | undefined) {
  const user = currentUser();
  return (
    !!user &&
    isPrivateWorkspace() &&
    user.role === "admin" &&
    ownerId !== user.id
  );
}
