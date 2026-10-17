import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Logger,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import type { Request, Response } from "express";
import type { ObjectId } from "mongodb";
import { bearerTokenOf } from "../../common/access/authenticated.guard";
import {
  CurrentTenant,
  TenantGuard,
  type TenantContext,
} from "../../common/access/tenant.guard";
import { DomainError } from "../../common/domain-error";
import { DomainErrorsInterceptor } from "../../common/http/domain-errors.interceptor";
import { parseWireId, toWireId } from "../../database/object-id";
import { MembershipsService } from "../memberships/memberships.service";
import {
  InvalidSessionError,
  SessionsService,
} from "../sessions/sessions.service";
import {
  isSettled,
  parseRename,
  parseSend,
  parseStartChat,
  type MessageDoc,
  type RunDoc,
} from "./chat";
import {
  ChatsService,
  messageView,
  runView,
  type ChatView,
  type HistoryPage,
  type SendReceipt,
} from "./chats.service";
import { RunExecutor, type LiveEvent } from "./run-executor";

// Heartbeat and access re-check interval for browser streams.
export const STREAM_HEARTBEAT_MS = 15_000;
// A browser this far behind is dropped; it reconnects and gets a snapshot.
const MAX_BUFFERED = 1024 * 1024;

function idOf(value: string, what: string): ObjectId {
  const id = parseWireId(value);
  if (!id)
    throw new DomainError(
      "NOT_FOUND",
      `This ${what} does not exist or you cannot see it.`,
    );
  return id;
}

function cursorOf(value: unknown): { before?: Date; beforeId?: ObjectId } {
  if (value === undefined || value === "") return {};
  const match =
    typeof value === "string"
      ? /^(\d{1,15})_([0-9a-f]{24})$/.exec(value)
      : null;
  const beforeId = match ? parseWireId(match[2]) : null;
  if (!match || !beforeId)
    throw new DomainError("INVALID_INPUT", "cursor is not valid.");
  return { before: new Date(Number(match[1])), beforeId };
}

function seqOf(value: unknown): number {
  if (typeof value !== "string" || !/^\d{1,9}$/.test(value))
    throw new DomainError("INVALID_INPUT", "before must be a message number.");
  return Number(value);
}

@Controller("chats")
@UseGuards(TenantGuard)
@UseInterceptors(DomainErrorsInterceptor)
export class ChatsController {
  private readonly logger = new Logger("ChatStream");

  constructor(
    @Inject(ChatsService) private readonly chats: ChatsService,
    @Inject(RunExecutor) private readonly executor: RunExecutor,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(MembershipsService)
    private readonly memberships: MembershipsService,
  ) {}

  @Get()
  list(
    @CurrentTenant() context: TenantContext,
    @Query("cursor") cursor: unknown,
    @Query("status") status: unknown,
  ): Promise<{ chats: ChatView[]; nextCursor: string | null }> {
    if (status !== undefined && status !== "active" && status !== "archived")
      throw new DomainError(
        "INVALID_INPUT",
        "status must be active or archived.",
      );
    return this.chats.list(
      context,
      cursorOf(cursor),
      (status as "active" | "archived" | undefined) ?? "active",
    );
  }

  // The first message creates the chat. 202: saved and handed to the
  // assistant; 200: a retry of a message already saved.
  @Post()
  async start(
    @CurrentTenant() context: TenantContext,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SendReceipt> {
    const receipt = await this.chats.start(context, parseStartChat(body));
    res.status(receipt.created ? 202 : 200);
    return receipt;
  }

  @Get(":id")
  get(
    @CurrentTenant() context: TenantContext,
    @Param("id") id: string,
  ): Promise<{ chat: ChatView } & HistoryPage> {
    return this.chats.get(context, idOf(id, "chat"));
  }

  @Get(":id/messages")
  messages(
    @CurrentTenant() context: TenantContext,
    @Param("id") id: string,
    @Query("before") before: unknown,
  ): Promise<HistoryPage> {
    return this.chats.messagesBefore(context, idOf(id, "chat"), seqOf(before));
  }

  @Post(":id/messages")
  async send(
    @CurrentTenant() context: TenantContext,
    @Param("id") id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SendReceipt> {
    const receipt = await this.chats.send(
      context,
      idOf(id, "chat"),
      parseSend(body),
    );
    res.status(receipt.created ? 202 : 200);
    return receipt;
  }

  @Patch(":id")
  async rename(
    @CurrentTenant() context: TenantContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<{ chat: ChatView }> {
    return {
      chat: await this.chats.rename(
        context,
        idOf(id, "chat"),
        parseRename(body),
      ),
    };
  }

  @Post(":id/archive")
  @HttpCode(200)
  async archive(
    @CurrentTenant() context: TenantContext,
    @Param("id") id: string,
  ): Promise<{ chat: ChatView }> {
    return { chat: await this.chats.archive(context, idOf(id, "chat")) };
  }

  @Post(":id/runs/:runId/stop")
  @HttpCode(202)
  stop(
    @CurrentTenant() context: TenantContext,
    @Param("id") id: string,
    @Param("runId") runId: string,
  ): Promise<{ status: string }> {
    return this.chats.stop(context, idOf(id, "chat"), idOf(runId, "reply"));
  }

  // One reply as server-sent events: a snapshot of the text so far, then
  // live events, ending with `saved` once the outcome is in MongoDB. A
  // finished reply is answered from MongoDB. Reconnecting is always safe: the
  // snapshot replaces what the browser has.
  @Get(":id/runs/:runId/stream")
  async stream(
    @CurrentTenant() context: TenantContext,
    @Param("id") id: string,
    @Param("runId") runIdParam: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const chatId = idOf(id, "chat");
    const runId = idOf(runIdParam, "reply");
    const { run, messages } = await this.chats.runForStream(
      context,
      chatId,
      runId,
    );

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
      connection: "keep-alive",
    });
    res.flushHeaders();
    let closed = false;
    let heartbeat: NodeJS.Timeout | undefined;
    let unsubscribe: () => void = () => undefined;
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
        this.logger.warn({ message: "slow stream dropped", runId: runIdParam });
        finish();
        res.destroy();
      }
    };
    const send = (event: LiveEvent | { type: string; data: unknown }) =>
      write(
        `event: ${event.type}\ndata: ${JSON.stringify(present(event))}\n\n`,
      );

    const savedReply = (saved: { run: RunDoc; messages: MessageDoc[] }) => {
      send({
        type: "snapshot",
        data: {
          runId: runIdParam,
          phase: "settled",
          items: saved.messages.map((m) => ({
            itemId: m.runtimeItemId ?? toWireId(m._id),
            text: m.text,
          })),
          usage: saved.run.usage ?? null,
        },
      });
      send({ type: "saved", data: saved });
      finish();
      res.end();
    };
    if (isSettled(run.status)) return savedReply({ run, messages });

    heartbeat = setInterval(() => {
      write(": hb\n\n");
      void this.stillAllowed(req, context).then((allowed) => {
        if (allowed || closed) return;
        send({ type: "end", data: { reason: "reauthenticate" } });
        finish();
        res.end();
      });
    }, STREAM_HEARTBEAT_MS);

    const subscribed = this.executor.subscribe(runId, {
      send,
      end: () => {
        finish();
        res.end();
      },
    });
    if (subscribed) {
      unsubscribe = subscribed;
      return;
    }
    // Not live here and could not be recovered (runtime not configured, or
    // settled in the meantime): answer from MongoDB.
    const fresh = await this.chats.runForStream(context, chatId, runId);
    if (isSettled(fresh.run.status)) return savedReply(fresh);
    send({ type: "end", data: { reason: "unavailable" } });
    finish();
    res.end();
  }

  // Session still live and membership still active; a revoked member's
  // stream closes within one heartbeat.
  private async stillAllowed(
    req: Request,
    context: TenantContext,
  ): Promise<boolean> {
    try {
      const caller = await this.sessions.authenticate(bearerTokenOf(req));
      if (!caller.userId.equals(context.userId)) return false;
      return !!(await this.memberships.findActive(
        context.userId,
        context.tenantId,
      ));
    } catch (error) {
      // A database blip is not a revocation; the next check decides.
      return !(error instanceof InvalidSessionError);
    }
  }
}

// Wire shapes: saved documents become their public views.
function present(event: { type: string; data: unknown }): unknown {
  if (event.type !== "saved") return event.data;
  const data = event.data as {
    run: Parameters<typeof runView>[0];
    messages: Parameters<typeof messageView>[0][];
  };
  return { run: runView(data.run), messages: data.messages.map(messageView) };
}
