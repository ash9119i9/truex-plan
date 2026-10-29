import {
  Controller,
  Get,
  Inject,
  Logger,
  Param,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import type { Request, Response } from "express";
import {
  CurrentTenant,
  TenantGuard,
  type TenantContext,
} from "../../common/access/tenant.guard";
import { DomainErrorsInterceptor } from "../../common/http/domain-errors.interceptor";
import { APP_CONFIG, type AppConfig } from "../../config/app-config";
import {
  MAX_BUFFERED,
  STREAM_HEARTBEAT_MS,
  streamStillAllowed,
} from "../chats/chats.controller";
import { MembershipsService } from "../memberships/memberships.service";
import { SessionsService } from "../sessions/sessions.service";
import { GoalStore, type GoalEvent } from "./goal-store";
import { chatIdOf } from "./goals.controller";
import { GoalsService, viewOf } from "./goals.service";

// The owner's chat event stream (tasks/goal-mode-plan.md). It starts with a
// snapshot (the goal and the run the chat is answering), then relays, as
// this process writes them:
//   goal.updated  {goal}            the goal as saved; null once ended
//   goal.cleared  {}                goal mode ended in the chat
//   run.started   {runId, turnId}   a goal turn's run, attachable through
//                                   GET /chats/:id/runs/:runId/stream
// A reconnect starts with a new snapshot, so anything missed is in it.
// Another member's, another tenant's, an archived or an unknown chat is the
// same 404.
@Controller("chats/:id/events")
@UseGuards(TenantGuard)
@UseInterceptors(DomainErrorsInterceptor)
export class ChatEventsController {
  private readonly logger = new Logger("ChatEvents");
  private readonly heartbeatMs: number;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(GoalsService) private readonly goals: GoalsService,
    @Inject(GoalStore) private readonly store: GoalStore,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(MembershipsService)
    private readonly memberships: MembershipsService,
  ) {
    this.heartbeatMs = config.chat?.streamHeartbeatMs ?? STREAM_HEARTBEAT_MS;
  }

  @Get()
  async events(
    @CurrentTenant() context: TenantContext,
    @Param("id") id: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const chatId = chatIdOf(id);
    // Subscribed before the snapshot is read, so an event written meanwhile
    // is sent after it rather than lost.
    const queued: GoalEvent[] = [];
    let deliver: ((event: GoalEvent) => void) | undefined;
    const unsubscribe = this.store.subscribe(
      context.dbName,
      chatId,
      (event) => {
        if (deliver) deliver(event);
        else queued.push(event);
      },
    );
    let snapshot: Awaited<ReturnType<GoalsService["snapshot"]>>;
    try {
      snapshot = await this.goals.snapshot(context, chatId);
    } catch (error) {
      unsubscribe();
      throw error;
    }
    // The browser left while the snapshot was read: its close event has
    // passed, so nothing would ever unsubscribe or stop the heartbeat.
    if (req.destroyed || res.destroyed) {
      unsubscribe();
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
      connection: "keep-alive",
    });
    res.flushHeaders();
    let closed = false;
    let heartbeat: NodeJS.Timeout | undefined;
    const finish = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    };
    res.on("close", finish);
    const write = (chunk: string) => {
      if (closed) return;
      res.write(chunk);
      if (res.writableLength > MAX_BUFFERED) {
        this.logger.warn({ message: "slow stream dropped", chatId: id });
        finish();
        res.destroy();
      }
    };
    const send = (type: string, data: unknown) =>
      write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    const relay = (event: GoalEvent) => {
      if (event.type === "goal.updated")
        send(event.type, {
          goal: event.goal.ended ? null : viewOf(event.goal),
        });
      else if (event.type === "goal.cleared") send(event.type, {});
      else send(event.type, { runId: event.runId, turnId: event.turnId });
    };

    send("snapshot", snapshot);
    deliver = relay;
    for (const event of queued.splice(0)) relay(event);

    heartbeat = setInterval(() => {
      write(": hb\n\n");
      void streamStillAllowed(
        this.sessions,
        this.memberships,
        req,
        context,
      ).then((allowed) => {
        if (allowed || closed) return;
        send("end", { reason: "reauthenticate" });
        finish();
        res.end();
      });
    }, this.heartbeatMs);
  }
}
