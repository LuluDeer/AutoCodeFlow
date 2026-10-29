import {
  Controller,
  Get,
  Logger,
  Param,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request, Response } from "express";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { Public } from "../../common/decorators/public.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { UserRole } from "../users/entities/user.entity";
import { AppError } from "../../common/errors/app-error";
import { ErrorCode } from "../../common/errors/error-codes";
import {
  AiMediaService,
  AI_MEDIA_MAX_BYTES,
  parseRangeHeader,
} from "./ai-media.service";
import { AiService } from "./ai.service";
import { verifySignedMediaUrl } from "./ai-media-url";

/**
 * 视频转 SOP 的媒体面：**上传（ADMIN）** + **签名直链下载（@Public）**。
 *
 * ## 为什么下载端必须是 @Public
 * 取视频的是**模型 provider**，它没有也不该有平台凭据：挂 JWT 守卫会把它
 * 401 掉。授权改由 URL 里的短时签名承担（`ai-media-url.ts`：HMAC 覆盖
 * mediaId+exp+fileName，常量时间比较）——这是"能力型 URL"，有效期内谁拿到
 * 谁就能取这一段视频，但取不到别的文件。
 *
 * ## 为什么必须支持 HEAD / Range(206)
 * 视频 fetcher 普遍先探测（HEAD）再分段拉（Range）；只支持整文件响应时，
 * 有的实现会整段下载并超时——表现为"视频理解一直失败"。
 */
@ApiTags("AI Media")
@Controller("ai/media")
export class AiMediaController {
  private readonly logger = new Logger(AiMediaController.name);

  constructor(
    private readonly media: AiMediaService,
    private readonly ai: AiService,
  ) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  @Roles(UserRole.ADMIN)
  @UseInterceptors(
    FileInterceptor("file", {
      // 内存缓冲：上传即刻落盘（原子 rename），不经临时目录
      limits: { fileSize: AI_MEDIA_MAX_BYTES, files: 1 },
    }),
  )
  @ApiOperation({ summary: "上传视频（视频转 SOP 的输入；ADMIN）" })
  @ApiBearerAuth("JWT")
  async upload(
    @UploadedFile() file?: Express.Multer.File,
    @CurrentUser() user?: { id: number | string },
  ) {
    if (!file) throw new AppError(ErrorCode.AI_MEDIA_EMPTY);
    const row = await this.media.save({
      name: file.originalname,
      buf: file.buffer,
      uploadedBy: `user:${user?.id ?? "unknown"}`,
    });
    return {
      id: row.id,
      name: row.name,
      mime: row.mime,
      sizeBytes: row.sizeBytes,
      createdAt: row.createdAt,
    };
  }

  /**
   * 签名直链下载（模型侧取字节的唯一入口）。
   *
   * 失败码语义：签名无效/文件名不符 → 403；过期 → 410；文件不存在 → 404；
   * Range 越界 → 416（带 `Content-Range: bytes * /size`）。
   */
  @Get(":mediaId/:fileName")
  @Public()
  @ApiOperation({ summary: "按签名直链取视频字节（模型侧；无需 JWT）" })
  async download(
    @Param("mediaId") mediaId: string,
    @Param("fileName") fileName: string,
    @Query("exp") exp: string | undefined,
    @Query("sig") sig: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const verdict = verifySignedMediaUrl(
      {
        mediaId,
        fileName,
        exp: exp ?? "",
        sig: sig ?? "",
      },
      { secret: await this.ai.signingSecret() },
    );
    if (verdict.status === "error") {
      res
        .status(verdict.reason === "expired" ? 410 : 403)
        .json({ code: verdict.reason, message: verdict.message });
      return;
    }

    let row;
    try {
      row = await this.media.requireById(mediaId);
    } catch {
      res.status(404).json({ code: "not_found", message: "媒体不存在" });
      return;
    }
    // 签名已覆盖文件名，这里再钉一次（数据库里的 name 是唯一合法取值）
    if (row.name !== fileName) {
      res
        .status(403)
        .json({ code: "bad_signature", message: "文件名与签名不符" });
      return;
    }

    const range = parseRangeHeader(req.headers.range, row.sizeBytes);
    if (range === "invalid") {
      res
        .status(416)
        .setHeader("Content-Range", `bytes */${row.sizeBytes}`)
        .end();
      return;
    }

    const { stream, start, end } = this.media.openStream(row, range);
    res.setHeader("Content-Type", row.mime ?? "application/octet-stream");
    res.setHeader("Accept-Ranges", "bytes");
    // 能力型 URL：禁缓存（避免代理把视频留在中间层的缓存里）
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Length", String(end - start + 1));
    if (range) {
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${row.sizeBytes}`);
    }
    stream.on("error", (err: Error) => {
      this.logger.warn(`AI media stream error: ${mediaId} — ${err.message}`);
      if (!res.headersSent) res.status(500);
      res.end();
    });
    stream.pipe(res);
  }
}
