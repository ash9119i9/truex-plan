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
