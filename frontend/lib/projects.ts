// Projects group conversations in the sidebar. Pure helpers plus thin API
// wrappers so the sidebar component stays declarative and testable.
import type { Project, PublicSession } from "../../shared/contracts";
import { api } from "./api.ts";

export const PROJECT_NAME_MAX = 80;

export type ProjectNameCheck =
  { ok: true; name: string } | { ok: false; error: string };

// Mirrors the server rule (INVALID_PROJECT): trimmed, 1-80 characters.
export function checkProjectName(raw: string): ProjectNameCheck {
  const name = raw.trim();
  if (!name) return { ok: false, error: "Enter a project name." };
  if (name.length > PROJECT_NAME_MAX)
    return {
      ok: false,
      error: `Use ${PROJECT_NAME_MAX} characters or fewer.`,
    };
  return { ok: true, name };
}

// Most recently updated first; name breaks ties so the order is stable.
export function sortProjects(projects: Project[]): Project[] {
  return [...projects].sort(
    (a, b) =>
      (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0) ||
      a.name.localeCompare(b.name),
  );
}

export interface SessionProjectActions {
  // "add" when the conversation is in no project, "move" otherwise.
  mode: "add" | "move";
  // Projects the conversation can be put into (never its current one).
  targets: Project[];
  // A conversation in a project can always be taken out, even if that
  // project is not in the loaded list.
  canRemove: boolean;
  current: Project | null;
}

export function sessionProjectActions(
  session: Pick<PublicSession, "projectId">,
  projects: Project[],
): SessionProjectActions {
  const id = session.projectId || null;
  return {
    mode: id ? "move" : "add",
    targets: projects.filter((p) => p._id !== id),
    canRemove: Boolean(id),
    current: (id && projects.find((p) => p._id === id)) || null,
  };
}

// The project a new chat will be created in, if it still exists.
export function draftProject(
  draftProjectId: string | null,
  projects: Project[],
): Project | null {
  if (!draftProjectId) return null;
  return projects.find((p) => p._id === draftProjectId) || null;
}

// Body for POST /api/sessions; projectId is omitted when not set.
export function createSessionBody<T>(
  agentId: string,
  subAgents: T,
  projectId?: string | null,
): { agentId: string; subAgents: T; projectId?: string } {
  return projectId ? { agentId, subAgents, projectId } : { agentId, subAgents };
}

const projectPath = (id: string) => `/api/projects/${encodeURIComponent(id)}`;

export const listProjects = (): Promise<Project[]> => api("/api/projects");
export const listProjectSessions = (
  projectId: string,
): Promise<PublicSession[]> =>
  api(`/api/sessions?projectId=${encodeURIComponent(projectId)}`);

// Name helpers validate first so the server only sees clean input.
function validName(raw: string): string {
  const check = checkProjectName(raw);
  if (!check.ok) throw new Error(check.error);
  return check.name;
}
export const createProject = async (name: string): Promise<Project> =>
  api("/api/projects", { name: validName(name) });
export const renameProject = async (
  id: string,
  name: string,
): Promise<Project> => api(projectPath(id), { name: validName(name) });
export const deleteProject = (id: string): Promise<{ ok: true }> =>
  api(projectPath(id) + "/delete", {});
export const setSessionProject = (
  sessionId: string,
  projectId: string | null,
): Promise<PublicSession> =>
  api(`/api/sessions/${encodeURIComponent(sessionId)}/project`, { projectId });
