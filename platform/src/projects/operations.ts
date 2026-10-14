import { publicSession } from "../public/conversation";
import { randomUUID } from "node:crypto";
import { Store } from "../persistence/store";
import type { Project } from "../../../shared/contracts";
import { ApiError } from "../core/errors";
import { currentUser } from "../identity/user";
import {
  checkProject,
  ownerFilter,
  readsOthersPrivate,
  type Access,
} from "../tenancy/access";
import type { ApprovalModesConfig } from "../../../shared/contracts";
import type { SessionDocument } from "../persistence/store";
import { projectIdOf, projectName } from "./validation";
export class ProjectService {
  constructor(
    private readonly store: Store,
    private readonly approvalModes: ApprovalModesConfig,
    private readonly auditRead: (
      type: string,
      id: string,
      ownerId?: string,
      action?: "read" | "list",
    ) => Promise<void>,
    private readonly sessionFor: (
      id: string,
      mode: Access,
    ) => Promise<SessionDocument>,
    private readonly projectFor: (
      id: unknown,
      mode?: Access,
    ) => Promise<Project>,
    private readonly touchProject: (id: string) => Promise<void>,
  ) {}

  // --- Projects: named folders; a session belongs to at most one. ---
  // Ownership: the creator renames, deletes and files chats into a project.
  // Others may see it only where they may see chats (access.ts).
  async projects(): Promise<Project[]> {
    const projects = await this.store.projects
      .find(ownerFilter("ownerId"))
      .sort({ updatedAt: -1 })
      .limit(500)
      .toArray();
    if (projects.some((p) => readsOthersPrivate(p.ownerId)))
      await this.auditRead("project", "list", undefined, "list");
    return projects;
  }
  async project(id: unknown, mode: Access = "read") {
    const project = await this.store.projects.findOne({ _id: projectIdOf(id) });
    if (!project)
      throw new ApiError(404, "Project not found", "PROJECT_NOT_FOUND");
    return checkProject(project, mode);
  }
  async createProject(name: unknown) {
    const now = new Date().toISOString();
    const owner = currentUser()?.id;
    const project: Project = {
      _id: "proj_" + randomUUID(),
      ...(owner ? { ownerId: owner } : {}),
      name: projectName(name),
      createdAt: now,
      updatedAt: now,
    };
    await this.store.projects.insertOne(project);
    return project;
  }
  async renameProject(id: unknown, name: unknown) {
    const next = projectName(name);
    const { _id } = await this.projectFor(id, "write");
    const project = await this.store.projects.findOneAndUpdate(
      { _id },
      { $set: { name: next, updatedAt: new Date().toISOString() } },
      { returnDocument: "after" },
    );
    if (!project)
      throw new ApiError(404, "Project not found", "PROJECT_NOT_FOUND");
    return project;
  }
  // Its sessions stay, as normal conversations.
  async deleteProject(id: unknown) {
    const project = await this.projectFor(id, "write");
    await this.store.sessions.updateMany(
      { projectId: project._id },
      { $unset: { projectId: "" } },
    );
    await this.store.projects.deleteOne({ _id: project._id });
    return { ok: true };
  }
  // Moves a session into a project, or out of any with null.
  async setSessionProject(id: string, projectId: unknown) {
    const session = await this.sessionFor(id, "write");
    if (projectId === null) {
      await this.store.sessions.updateOne(
        { _id: id },
        { $unset: { projectId: "" } },
      );
      const { projectId: _, ...rest } = session;
      return publicSession(rest, this.approvalModes);
    }
    const project = await this.projectFor(projectId, "write");
    await this.store.sessions.updateOne(
      { _id: id },
      { $set: { projectId: project._id } },
    );
    await this.touchProject(project._id);
    return publicSession(
      { ...session, projectId: project._id },
      this.approvalModes,
    );
  }
}
