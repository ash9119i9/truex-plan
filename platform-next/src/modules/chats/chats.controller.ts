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
import { APP_CONFIG, type AppConfig } from "../../config/app-config";
import { parseWireId, toWireId } from "../../database/object-id";
import { MembershipsService } from "../memberships/memberships.service";
import { parseNetworkDecision } from "../network/network-grants";
import {
  InvalidSessionError,
  SessionsService,
} from "../sessions/sessions.service";
import {
  isApprovalId,
  parseApprovalAnswer,
  parseRename,
  parseSend,
  parseStartChat,
  type MessageActivity,
} from "./chat";
import type { ChatFileView } from "./chat-files";
import type { SettleItem, SettleResult } from "./chat-store";
import {
  ChatsService,
  messageView,
  runView,
  type ChatView,
  type HistoryPage,
  type SendReceipt,
  type SteerReceipt,
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
  private readonly heartbeatMs: number;
  private readonly followUpsEnabled: boolean;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(ChatsService) private readonly chats: ChatsService,
    @Inject(RunExecutor) private readonly executor: RunExecutor,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(MembershipsService)
    private readonly memberships: MembershipsService,
  ) {
    this.heartbeatMs = config.chat?.streamHeartbeatMs ?? STREAM_HEARTBEAT_MS;
    this.followUpsEnabled =
      config.chat !== undefined && config.chat.followUps !== false;
  }

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

  // 202: saved and handed to the assistant, or added to the reply being
  // written (a steer receipt: `steer`, no `message`); 200: a retry.
  @Post(":id/messages")
  async send(
    @CurrentTenant() context: TenantContext,
    @Param("id") id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SendReceipt | SteerReceipt> {
    const receipt = await this.chats.send(
      context,
      idOf(id, "chat"),
      parseSend(body),
    );
    res.status(receipt.created ? 202 : 200);
    return receipt;
  }

  // Every stored version of the files the chat's replies made, newest
  // first. Empty when file storage is not configured.
  @Get(":id/files")
  async files(
    @CurrentTenant() context: TenantContext,
    @Param("id") id: string,
  ): Promise<{ files: ChatFileView[] }> {
    return { files: await this.chats.files(context, idOf(id, "chat")) };
  }

  // One version's bytes. Always an attachment the browser won't sniff or
  // run: previews read it with fetch and render it themselves.
  @Get(":id/files/:fileId/content")
  async fileContent(
    @CurrentTenant() context: TenantContext,
    @Param("id") id: string,
    @Param("fileId") fileId: string,
    @Res() res: Response,
  ): Promise<void> {
    const { doc, body } = await this.chats.openFile(
      context,
      idOf(id, "chat"),
      idOf(fileId, "file"),
    );
    res.writeHead(200, {
      "content-type": doc.contentType,
      "content-length": doc.size,
      "content-disposition": contentDisposition(
        doc.path.slice(doc.path.lastIndexOf("/") + 1),
      ),
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'",
      "cache-control": "private, no-store",
    });
    body.on("error", (error: Error) => {
      this.logger.warn({ message: "file read failed", error: error.name });
      res.destroy();
    });
    body.pipe(res);
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

  // Tries again to save the files a reply couldn't: the versions stored
  // and the paths still unsaved. 409 CHAT_BUSY while the chat answers.
  @Post(":id/runs/:runId/files/retry")
  @HttpCode(200)
  retryFiles(
    @CurrentTenant() context: TenantContext,
    @Param("id") id: string,
    @Param("runId") runId: string,
  ): Promise<{ files: ChatFileView[]; unsaved: string[] }> {
    return this.chats.retryFiles(
      context,
      idOf(id, "chat"),
      idOf(runId, "reply"),
    );
  }

  // The member's answer to a write-tool approval card. 200 with the decision;
  // 409 APPROVAL_RESOLVED when it was already answered; 404
  // APPROVAL_NOT_FOUND when it expired or the reply finished. Params are
  // never logged.
  @Post(":id/runs/:runId/approvals/:approvalId")
  @HttpCode(200)
  answerApproval(
    @CurrentTenant() context: TenantContext,
    @Param("id") id: string,
    @Param("runId") runId: string,
    @Param("approvalId") approvalId: string,
    @Body() body: unknown,
  ): Promise<{ decision: string }> {
    const decision = parseApprovalAnswer(body);
    if (!isApprovalId(approvalId))
      throw new DomainError(
        "APPROVAL_NOT_FOUND",
        "This request has expired or the reply has finished.",
      );
    return this.chats.answerApproval(
      context,
      idOf(id, "chat"),
      idOf(runId, "reply"),
      approvalId,
      decision,
    );
  }

  // The owner's answer to a network card on a saved reply (a sandbox request
  // the network proxy refused). 200 with the decision; 409 APPROVAL_RESOLVED
  // when it was already answered differently; 404 when it isn't one of the
  // owner's cards; 400 when the card didn't offer that answer.
  @Post(":id/messages/:messageId/network")
  @HttpCode(200)
  answerNetwork(
    @CurrentTenant() context: TenantContext,
    @Param("id") id: string,
    @Param("messageId") messageId: string,
    @Body() body: unknown,
  ): Promise<{ decision: string }> {
    const decision = parseNetworkDecision(body);
    return this.chats.answerNetwork(
      context,
      idOf(id, "chat"),
      idOf(messageId, "message"),
      decision,
    );
  }

  // One reply as server-sent events: a snapshot of the text so far, then
  // live events, ending with `saved` once the outcome is in MongoDB. A
  // finished reply is answered with its saved outcome. Reconnecting is always
  // safe: the snapshot replaces what the browser has.
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
    const { saved } = await this.chats.runForStream(context, chatId, runId);

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
        `event: ${event.type}\ndata: ${JSON.stringify(present(event, this.followUpsEnabled))}\n\n`,
      );

    const savedReply = (saved: SettleResult) => {
      send({
        type: "snapshot",
        data: {
          runId: runIdParam,
          phase: "settled",
          // In order: the replies, tool calls, and the steers the
          // assistant read.
          items: saved.messages.flatMap((m): SettleItem[] =>
            m.role === "tool" && m.activity && m.runtimeItemId
              ? [activitySettleItem(m.runtimeItemId, m.activity)]
              : m.role === "tool" && m.tool && m.runtimeItemId
                ? [
                    {
                      type: "tool",
                      itemId: m.runtimeItemId,
                      connector: m.tool.connector,
                      tool: m.tool.name,
                      status: m.tool.status,
                      ...(m.tool.durationMs !== undefined
                        ? { durationMs: m.tool.durationMs }
                        : {}),
                      ...(m.tool.errorCode
                        ? { errorCode: m.tool.errorCode }
                        : {}),
                      ...(m.tool.approval ? { approval: m.tool.approval } : {}),
                    },
                  ]
                : m.role === "assistant"
                  ? [
                      {
                        type: "reply",
                        itemId: m.runtimeItemId ?? toWireId(m._id),
                        text: m.text,
                        completed: m.state === "complete",
                      },
                    ]
                  : m.state === "complete" && m.clientMessageId
                    ? [{ type: "input", clientMessageId: m.clientMessageId }]
                    : [],
          ),
          usage: saved.run.usage ?? null,
          approvals: [],
        },
      });
      send({ type: "saved", data: saved });
      finish();
      res.end();
    };
    if (saved) return savedReply(saved);

    heartbeat = setInterval(() => {
      write(": hb\n\n");
      void this.stillAllowed(req, context).then((allowed) => {
        if (allowed || closed) return;
        send({ type: "end", data: { reason: "reauthenticate" } });
        finish();
        res.end();
      });
    }, this.heartbeatMs);

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
    if (fresh.saved) return savedReply(fresh.saved);
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
// An attachment header for a file name the model chose: an ASCII fallback
// plus the exact name (RFC 6266 / 5987).
export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_") || "file";
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function present(
  event: { type: string; data: unknown },
  showFollowUps: boolean,
): unknown {
  if (event.type !== "saved") return event.data;
  const data = event.data as {
    run: Parameters<typeof runView>[0];
    messages: Parameters<typeof messageView>[0][];
  };
  return {
    run: runView(data.run, showFollowUps),
    messages: data.messages.map(messageView),
  };
}

// A saved command or file change as the live stream shows it.
function activitySettleItem(
  itemId: string,
  activity: MessageActivity,
): SettleItem {
  const approval = activity.approval ? { approval: activity.approval } : {};
  if (activity.kind === "file_change")
    return {
      type: "file_change",
      itemId,
      files: activity.files,
      status: activity.status,
      ...approval,
    };
  return {
    type: "command",
    itemId,
    command: activity.command,
    status: activity.status,
    ...(activity.exitCode !== undefined ? { exitCode: activity.exitCode } : {}),
    ...(activity.durationMs !== undefined
      ? { durationMs: activity.durationMs }
      : {}),
    output: activity.output,
    outputTruncated: activity.outputTruncated,
    ...approval,
  };
}
