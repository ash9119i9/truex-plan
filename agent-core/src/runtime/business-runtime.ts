import {
  businessCapabilities,
  businessCapabilityParams,
} from "../../../shared/business-capabilities";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CodexClient } from "./client";
import {
  threadMarker,
  readThreadRecord,
  writeThreadRecord,
} from "./thread-records";
import { HttpError } from "../errors";
import { errorFields, log } from "../../../shared/logging";
import { ConversationFiles } from "../tools/documents/files";
import { fileTools } from "../tools/documents/specs";
import { WorkspaceFiles } from "../tools/workspace/files";
import { workspaceTools } from "../tools/workspace/specs";
import {
  DisabledScriptRunner,
  ScriptTools,
  scriptRunnerFromEnv,
  scriptTools,
  type ScriptRunner,
} from "../tools/scripts";
import {
  DEFAULT_TENANT,
  skillSet,
  tenantId,
  tenantWorkspaces,
  type Skill,
} from "./tenancy";

export {
  defaultPersona,
  businessInstructions,
  personaOptions,
  subAgentOptions,
} from "./policy";
export type {
  AgentScope,
  PersonaOptions,
  SubAgentMode,
  SubAgentOptions,
} from "./policy";
import {
  runtimeConfiguration,
  subAgentOptions,
  type SubAgentOptions,
} from "./policy";

const workspaceToolNames = new Set(
  workspaceTools.map((t) => (t as { name: string }).name),
);

// This adapter is the only runtime used by the service. No browser-controlled
// config, history import, path, environment or arbitrary RPC can reach the engine.
export class BusinessRuntime extends CodexClient {
  // Helper agent threads spawned by conversations. They have no workspace of
  // their own and may only be interrupted.
  readonly helpers = new Set<string>();
  readonly files = new ConversationFiles((id) => this.workspace(id));
  readonly workspaceFiles = new WorkspaceFiles(
    (id) => this.workspace(id),
    (id, name, data) => this.files.publish(id, name, data),
  );
  readonly scripts: ScriptTools;
  constructor(
    binary: string,
    home: string,
    timeoutMs?: number,
    readonly scriptRunner: ScriptRunner = scriptRunnerFromEnv(),
  ) {
    super(binary, home, timeoutMs);
    this.scripts = new ScriptTools(
      (id) => join(this.workspace(id), "work"),
      scriptRunner,
    );
    // tmp/ is scratch space for a single task.
    this.on("notification", (msg: any) => {
      const id = msg?.params?.threadId;
      if (msg?.method !== "turn/completed" || typeof id !== "string") return;
      if (this.helpers.has(id) || !/^[\w-]+$/.test(id)) return;
      if (existsSync(this.marker(id)))
        this.workspaceFiles.clearTemp(id).catch(() => {});
    });
  }
  get scriptsEnabled() {
    return !(this.scriptRunner instanceof DisabledScriptRunner);
  }
  private dynamicTools() {
    return [
      ...fileTools,
      ...workspaceTools,
      ...(this.scriptsEnabled ? scriptTools : []),
    ];
  }
  visualizationToolsAvailable(id: string) {
    try {
      return readThreadRecord(this.marker(id)).visualizationTools === 1;
    } catch {
      return false;
    }
  }
  documentToolsAvailable(id: string) {
    try {
      return readThreadRecord(this.marker(id)).documentTools === 1;
    } catch {
      return false;
    }
  }
  async executeTool(params: any) {
    try {
      if (params.namespace) throw new HttpError(400, "Unknown tool namespace");
      if (
        params.tool === "create_visualization" &&
        !this.visualizationToolsAvailable(params.threadId)
      )
        throw new HttpError(409, "Start a new conversation to use Visualize");
      if (!this.documentToolsAvailable(params.threadId))
        throw new HttpError(
          409,
          "Use document tools in the main conversation. Older conversations need a new conversation for document tools.",
        );
      const result = workspaceToolNames.has(params.tool)
        ? await this.workspaceFiles.execute(
            params.threadId,
            params.tool,
            params.arguments,
          )
        : params.tool === "run_script"
          ? await this.scripts.execute(
              params.threadId,
              params.tool,
              params.arguments,
            )
          : await this.files.execute(
              params.threadId,
              params.tool,
              params.arguments,
            );
      return {
        success: true,
        contentItems: [{ type: "inputText", text: JSON.stringify(result) }],
      };
    } catch (error) {
      if (!(error instanceof HttpError))
        log("error", "tool call failed", {
          threadId: params?.threadId,
          tool: params?.tool,
          ...errorFields(error),
        });
      return {
        success: false,
        contentItems: [
          {
            type: "inputText",
            text:
              error instanceof HttpError
                ? error.message
                : workspaceToolNames.has(params.tool) ||
                    params.tool === "run_script"
                  ? "The workspace operation failed. Check the path and try again."
                  : "Document processing failed. Check the format, content and size. PDF output supports Western European text; encrypted or damaged files may be unreadable.",
          },
        ],
      };
    }
  }
  private profiles = new Map<
    string,
    ReturnType<BusinessRuntime["configuration"]>
  >();
  private marker(id: string) {
    return threadMarker(this.home, id);
  }
  private workspace(id: string): string {
    try {
      return readThreadRecord(this.marker(id)).cwd;
    } catch {
      throw new HttpError(
        409,
        "Start a new Truex conversation",
        "LEGACY_SESSION",
      );
    }
  }
  private record(id: string): any {
    try {
      return readThreadRecord(this.marker(id));
    } catch {
      return {};
    }
  }
  // Threads created before tenancy belong to the default tenant.
  tenant(id: string): string {
    const value = this.record(id).tenantId;
    return typeof value === "string" ? value : DEFAULT_TENANT;
  }
  private skills(id: string): Skill[] {
    try {
      return skillSet(this.record(id).skills);
    } catch {
      return [];
    }
  }
  private helperSettings(id: string): SubAgentOptions {
    try {
      return subAgentOptions(readThreadRecord(this.marker(id)).subAgents);
    } catch {
      return subAgentOptions(undefined);
    }
  }
  private configuration(params: any, cwd: string) {
    return runtimeConfiguration(params, cwd, this);
  }
  override async request(method: string, params: any = {}): Promise<any> {
    // Helper threads have no workspace; only these narrow calls reach them.
    if (method === "turn/interrupt" && this.helpers.has(params.threadId))
      return super.request(method, {
        threadId: params.threadId,
        turnId: params.turnId,
      });
    // Stopping a helper shuts it down so the main agent stops waiting on it.
    if (method === "thread/archive" && this.helpers.has(params.threadId))
      return super.request(method, { threadId: params.threadId });
    // A helper's name lives on its own thread; its history stays private.
    if (method === "thread/read" && this.helpers.has(params.threadId))
      return super.request(method, {
        threadId: params.threadId,
        includeTurns: false,
      });
    if (method === "thread/start") {
      const tenant = tenantId(params.tenantId),
        skills = skillSet(params.skills);
      const cwd = join(tenantWorkspaces(this.home, tenant), randomUUID());
      const profile = this.configuration(params, cwd);
      mkdirSync(cwd, { recursive: true, mode: 0o700 });
      const result = await super.request(method, {
        ...profile,
        dynamicTools: this.dynamicTools(),
        environments: [],
        selectedCapabilityRoots: [],
        experimentalRawEvents: false,
      });
      this.profiles.set(result.thread.id, profile);
      try {
        mkdirSync(join(this.home, "business-threads"), {
          recursive: true,
          mode: 0o700,
        });
        writeThreadRecord(this.marker(result.thread.id), {
          cwd,
          tenantId: tenant,
          documentTools: 1,
          visualizationTools: 1,
          subAgents: subAgentOptions(params.subAgents),
          skills,
        });
      } catch (error) {
        this.profiles.delete(result.thread.id);
        throw error;
      }
      return result;
    }
    if (method === "thread/resume") {
      const cwd = this.workspace(params.threadId);
      // A thread is only ever resumed by the tenant that created it.
      if (
        params.tenantId !== undefined &&
        tenantId(params.tenantId) !== this.tenant(params.threadId)
      )
        throw new HttpError(404, "Conversation not found", "THREAD_NOT_FOUND");
      const profile = this.configuration(
        {
          ...params,
          subAgents: params.subAgents ?? this.helperSettings(params.threadId),
          skills: params.skills ?? this.skills(params.threadId),
        },
        cwd,
      );
      const result = await super.request(method, {
        ...profile,
        threadId: params.threadId,
      });
      this.profiles.set(params.threadId, profile);
      return result;
    }
    if (method === "turn/start") {
      this.workspace(params.threadId);
      return super.request(method, {
        threadId: params.threadId,
        input: params.input,
        clientUserMessageId: params.clientUserMessageId,
        environments: [],
        approvalPolicy: "on-request",
      });
    }
    if (Object.hasOwn(businessCapabilities, method)) {
      try {
        businessCapabilityParams(method, params, true);
      } catch {
        throw new HttpError(
          403,
          "This setting is not available in Truex",
          "CAPABILITY_DENIED",
        );
      }
      this.workspace(params.threadId);
      if (method === "thread/fork") {
        const activeSource = this.profiles.get(params.threadId);
        const source = activeSource && structuredClone(activeSource);
        if (!source)
          throw new HttpError(409, "Resume the conversation before forking");
        const tenant = this.tenant(params.threadId);
        const cwd = join(tenantWorkspaces(this.home, tenant), randomUUID());
        mkdirSync(cwd, { recursive: true, mode: 0o700 });
        source.cwd = cwd;
        const result = await super.request(method, {
          ...source,
          ...params,
          cwd,
          runtimeWorkspaceRoots: [],
          sandbox: "read-only",
          approvalPolicy: "on-request",
          deferGoalContinuation: true,
        });
        writeThreadRecord(this.marker(result.thread.id), {
          cwd,
          tenantId: tenant,
          documentTools: this.documentToolsAvailable(params.threadId) ? 1 : 0,
          visualizationTools: this.visualizationToolsAvailable(params.threadId)
            ? 1
            : 0,
          subAgents: this.helperSettings(params.threadId),
          skills: this.skills(params.threadId),
        });
        this.profiles.set(result.thread.id, { ...source, cwd });
        await this.files.copy(params.threadId, result.thread.id);
        await this.workspaceFiles.copy(params.threadId, result.thread.id);
        return result;
      }
      const result = await super.request(method, params);
      if (method === "thread/settings/update") {
        const profile = this.profiles.get(params.threadId);
        if (profile) {
          if (params.model) profile.model = params.model;
          if (params.effort)
            profile.config.model_reasoning_effort = params.effort;
        }
      }
      return result;
    }
    // Only agent-core calls this, to reload a thread with a new MCP config.
    if (method === "thread/unsubscribe") {
      this.workspace(params.threadId);
      return super.request(method, { threadId: params.threadId });
    }
    // Approval modes read tool annotations; only agent-core calls this.
    if (method === "mcpServerStatus/list") {
      this.workspace(params.threadId);
      return super.request(method, {
        threadId: params.threadId,
        detail: "toolsAndAuthOnly",
        ...(typeof params.cursor === "string" ? { cursor: params.cursor } : {}),
      });
    }
    if (
      [
        "turn/steer",
        "turn/interrupt",
        "thread/read",
        "thread/items/list",
        "thread/delete",
      ].includes(method)
    ) {
      this.workspace(params.threadId);
      return super.request(method, params);
    }
    throw new HttpError(
      403,
      "This operation is not available in Truex",
      "CAPABILITY_DENIED",
    );
  }
}
