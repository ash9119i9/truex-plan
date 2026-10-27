import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import type { Request } from "express";
import {
  CurrentTenant,
  TenantGuard,
  type TenantContext,
} from "../../common/access/tenant.guard";
import { DomainError } from "../../common/domain-error";
import { DomainErrorsInterceptor } from "../../common/http/domain-errors.interceptor";
import { parseWireId } from "../../database/object-id";
import {
  ChatUploadsService,
  MAX_UPLOAD_BYTES,
  tooLarge,
  uploadName,
  type UploadSettings,
  type UploadView,
} from "./chat-uploads";

// Attaching files to a message: each file is uploaded on its own as the raw
// request body (`application/octet-stream`, name in the query), then its ID
// goes in the message's `attachments`.
@Controller("uploads")
@UseGuards(TenantGuard)
@UseInterceptors(DomainErrorsInterceptor)
export class UploadsController {
  constructor(
    @Inject(ChatUploadsService) private readonly uploads: ChatUploadsService,
  ) {}

  // Whether files can be attached here, and the limits the composer shows.
  @Get()
  settings(): UploadSettings {
    return this.uploads.settings();
  }

  @Post()
  async upload(
    @CurrentTenant() context: TenantContext,
    @Query("name") name: unknown,
    @Req() req: Request,
  ): Promise<{ upload: UploadView }> {
    const type = req.headers["content-type"] ?? "";
    if (!/^application\/octet-stream(\s*;|$)/i.test(type))
      throw new DomainError(
        "INVALID_INPUT",
        "Content-Type must be application/octet-stream.",
      );
    const checked = uploadName(name);
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > MAX_UPLOAD_BYTES) throw tooLarge();
    const release = this.uploads.admit(context);
    try {
      const data = await readBody(req);
      return { upload: await this.uploads.stage(context, checked, data) };
    } finally {
      release();
    }
  }

  // A staged file taken off the message before it was sent.
  @Delete(":id")
  @HttpCode(204)
  async discard(
    @CurrentTenant() context: TenantContext,
    @Param("id") id: string,
  ): Promise<void> {
    const uploadId = parseWireId(id);
    if (!uploadId)
      throw new DomainError(
        "NOT_FOUND",
        "This attached file does not exist or was already sent.",
      );
    await this.uploads.discard(context, uploadId);
  }
}

// The body, refused as soon as it passes the limit so nothing larger is held.
// Node discards the rest once the 413 is sent.
async function readBody(req: Request): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_UPLOAD_BYTES) throw tooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}
