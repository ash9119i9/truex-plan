import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Res,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import type { Response } from "express";
import type { ObjectId } from "mongodb";
import {
  CurrentTenant,
  TenantGuard,
  type TenantContext,
} from "../../common/access/tenant.guard";
import { DomainError } from "../../common/domain-error";
import { DomainErrorsInterceptor } from "../../common/http/domain-errors.interceptor";
import { requestIdOf } from "../../common/http/request-id";
import { APP_CONFIG, type AppConfig } from "../../config/app-config";
import { parseWireId } from "../../database/object-id";
import { parseCreateAgent, parseUpdateAgent } from "./agent";
import { AgentsService, type AgentView } from "./agents.service";

// A malformed ID names no agent, so it gets the same 404 as a missing one.
function agentIdOf(value: string): ObjectId {
  const id = parseWireId(value);
  if (!id)
    throw new DomainError(
      "NOT_FOUND",
      "This agent does not exist or you cannot see it.",
    );
  return id;
}

@Controller("agents")
@UseGuards(TenantGuard)
@UseInterceptors(DomainErrorsInterceptor)
export class AgentsController {
  constructor(
    @Inject(AgentsService) private readonly agents: AgentsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // `helpers`: whether this server lets agents start helper agents
  // (CHAT_SUBAGENTS). Without it the dialog hides the setting.
  @Get()
  async list(
    @CurrentTenant() context: TenantContext,
  ): Promise<{ agents: AgentView[]; helpers: boolean }> {
    return {
      agents: await this.agents.list(context),
      helpers: (this.config.chat?.subAgents ?? 0) > 0,
    };
  }

  // 201 for a new agent; 200 when a retried request returns the one it
  // already created.
  @Post()
  async create(
    @CurrentTenant() context: TenantContext,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ agent: AgentView }> {
    const { agent, created } = await this.agents.create(
      context,
      parseCreateAgent(body),
      requestIdOf(res),
    );
    res.status(created ? 201 : 200);
    return { agent };
  }

  @Patch(":id")
  async update(
    @CurrentTenant() context: TenantContext,
    @Param("id") id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ agent: AgentView }> {
    const agentId = agentIdOf(id);
    return {
      agent: await this.agents.update(
        context,
        agentId,
        parseUpdateAgent(body),
        requestIdOf(res),
      ),
    };
  }

  @Post(":id/promote")
  @HttpCode(200)
  async promote(
    @CurrentTenant() context: TenantContext,
    @Param("id") id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ agent: AgentView }> {
    return {
      agent: await this.agents.promote(
        context,
        agentIdOf(id),
        requestIdOf(res),
      ),
    };
  }

  @Post(":id/archive")
  @HttpCode(200)
  async archive(
    @CurrentTenant() context: TenantContext,
    @Param("id") id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ agent: AgentView }> {
    return {
      agent: await this.agents.archive(
        context,
        agentIdOf(id),
        requestIdOf(res),
      ),
    };
  }
}
