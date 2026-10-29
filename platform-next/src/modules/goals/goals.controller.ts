import {
  Body,
  Controller,
  Delete,
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
import { parseWireId } from "../../database/object-id";
import {
  parseGoalEdit,
  parseGoalStart,
  parseRaiseBudget,
  parseRequestChanges,
} from "./goal-input";
import { GoalsService, type GoalView } from "./goals.service";

// An unknown or malformed chat ID gets the same answer as another member's
// chat.
export function chatIdOf(value: string): ObjectId {
  const id = parseWireId(value);
  if (!id)
    throw new DomainError(
      "NOT_FOUND",
      "This chat does not exist or you cannot see it.",
    );
  return id;
}

// The owner's goal in a chat (tasks/goal-mode-plan.md). Another member's,
// another tenant's, an archived or an unknown chat is the same 404.
@Controller("chats/:id/goal")
@UseGuards(TenantGuard)
@UseInterceptors(DomainErrorsInterceptor)
export class GoalsController {
  constructor(@Inject(GoalsService) private readonly goals: GoalsService) {}

  // The chat's goal, or null when it has none or goal mode ended.
  @Get()
  get(
    @CurrentTenant() context: TenantContext,
    @Param("id") id: string,
  ): Promise<{ goal: GoalView | null }> {
    return this.goals.get(context, chatIdOf(id));
  }

  // 201: started; 200: a retry of a start that succeeded.
  @Post()
  async start(
    @CurrentTenant() context: TenantContext,
    @Param("id") id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ goal: GoalView }> {
    const chatId = chatIdOf(id);
    const { goal, created } = await this.goals.start(
      context,
      chatId,
      parseGoalStart(body),
    );
    res.status(created ? 201 : 200);
    return { goal };
  }

  @Patch()
  edit(
    @CurrentTenant() context: TenantContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<{ goal: GoalView }> {
    const chatId = chatIdOf(id);
    return this.goals.editObjective(
      context,
      chatId,
      parseGoalEdit(body).objective,
    );
  }

  @Post("pause")
  @HttpCode(200)
  pause(
    @CurrentTenant() context: TenantContext,
    @Param("id") id: string,
  ): Promise<{ goal: GoalView }> {
    return this.goals.pause(context, chatIdOf(id));
  }

  @Post("resume")
  @HttpCode(200)
  resume(
    @CurrentTenant() context: TenantContext,
    @Param("id") id: string,
  ): Promise<{ goal: GoalView }> {
    return this.goals.resume(context, chatIdOf(id));
  }

  // The owner's review of a goal Codex marked complete.
  @Post("approve")
  @HttpCode(200)
  approve(
    @CurrentTenant() context: TenantContext,
    @Param("id") id: string,
  ): Promise<{ goal: GoalView }> {
    return this.goals.approve(context, chatIdOf(id));
  }

  @Post("request-changes")
  @HttpCode(200)
  requestChanges(
    @CurrentTenant() context: TenantContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<{ goal: GoalView }> {
    const chatId = chatIdOf(id);
    return this.goals.requestChanges(
      context,
      chatId,
      parseRequestChanges(body),
    );
  }

  // For a goal that ran out of budget at the chat's maximum.
  @Post("accept")
  @HttpCode(200)
  accept(
    @CurrentTenant() context: TenantContext,
    @Param("id") id: string,
  ): Promise<{ goal: GoalView }> {
    return this.goals.acceptAsIs(context, chatIdOf(id));
  }

  @Post("budget")
  @HttpCode(200)
  raiseBudget(
    @CurrentTenant() context: TenantContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<{ goal: GoalView }> {
    const chatId = chatIdOf(id);
    return this.goals.raiseBudget(
      context,
      chatId,
      parseRaiseBudget(body).tokenBudget,
    );
  }

  @Delete()
  @HttpCode(200)
  clear(
    @CurrentTenant() context: TenantContext,
    @Param("id") id: string,
  ): Promise<{ cleared: true }> {
    return this.goals.clear(context, chatIdOf(id));
  }
}
