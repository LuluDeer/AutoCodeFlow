import {
  Body,
  Controller,
  Get,
  Query,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import type { Response } from "express";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { SkipTimeout } from "../../common/decorators/skip-timeout.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { UserRole } from "../users/entities/user.entity";
import { AiSopSessionService } from "./ai-sop-session.service";

export class CreateSopSessionDto {
  @IsUUID()
  mediaId: string;

  /** 指定 provider（必须支持视频）；空 = 走 ai.routes.video。 */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  providerId?: string;

  /** 第一次开口的补充说明（可空，服务端会给一句缺省）。 */
  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  hint?: string;
}

export class SopSessionTurnDto {
  /** 文字补充（与 mediaId 至少给一个）。 */
  @IsOptional()
  @IsString()
  @MaxLength(4_000)
  text?: string;

  /** 中途补录的一段视频。 */
  @IsOptional()
  @IsUUID()
  mediaId?: string;
}

/**
 * 视频转 SOP（交互式）：**会话式编写**。
 *
 * 与单轮 `/ai/sop-draft/from-video` 的分工：单轮是"一次喂料、一次出稿"，
 * 适合录屏完整且流程简单的场景；会话是"模型可追问、可要求补录、用户随时
 * 补充文字/视频"，适合真实业务（多数录屏都会漏拍关键一步）。
 *
 * 三个动作都以**整条会话**返回（messages/media/draft/remainingQuestions），
 * 前端不必自己拼状态——刷新/换设备靠 `GET :id` 就能续上。
 */
@ApiTags("AI · SOP Session")
@ApiBearerAuth("JWT")
@Controller("ai/sop-sessions")
@UseGuards(JwtAuthGuard)
export class AiSopSessionController {
  constructor(private readonly sessions: AiSopSessionService) {}

  @Post()
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "用一段录屏开启 SOP 编写会话（模型可能追问或直接出稿）",
  })
  async create(
    @Body() dto: CreateSopSessionDto,
    @CurrentUser() user?: { id: number | string },
  ) {
    return this.sessions.create({
      mediaId: dto.mediaId,
      hint: dto.hint,
      providerId: dto.providerId,
      createdBy: this.ownerOf(user),
    });
  }

  @Get()
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "列出本人的编写会话（最近更新在前）" })
  async list(
    @CurrentUser() user?: { id: number | string },
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
  ) {
    return this.sessions.listMine(`user:${user?.id ?? "unknown"}`, {
      page: Number(page) || 1,
      pageSize: Number(pageSize) || 20,
    });
  }

  @Get(":id")
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "读取会话（messages/media/draft/剩余追问次数）" })
  async detail(
    @Param("id") id: string,
    @CurrentUser() user?: { id: number | string },
  ) {
    // 归属口径与列表一致（listMine 只列本人的会话）：他人会话按不存在回报，
    // 不能因为拿到 uuid 就读到别人的录屏转写与未发布草稿。
    return this.sessions.get(id, this.ownerOf(user));
  }

  @Post(":id/turns")
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "补充一句话或一段录屏，继续下一轮" })
  async turn(
    @Param("id") id: string,
    @Body() dto: SopSessionTurnDto,
    @CurrentUser() user?: { id: number | string },
  ) {
    return this.sessions.turn(id, this.ownerOf(user), {
      text: dto.text,
      mediaId: dto.mediaId,
    });
  }

  /**
   * 流式一轮（SSE）：看视频推理可能 30s+，先让人看到字。
   *
   * 帧协议：`delta`（增量文本）→ `done`（整条会话视图）或 `error`
   * （`{code,message}`）。与同步端点**同一套**解析/落库，流只影响"何时看到"。
   *
   * 为什么需要 `@SkipTimeout()`：全局 30s 请求超时会掐断长流（先例：日志/指标
   * 两条 SSE 流同款）。为什么加心跳注释帧：反代通常在 60s 空闲后断连，
   * `: ping` 是 SSE 规范里的合法注释帧，客户端会忽略。
   */
  @Post(":id/turns/stream")
  @Roles(UserRole.ADMIN)
  @SkipTimeout()
  @ApiOperation({ summary: "流式继续一轮（SSE 事件流：三种帧类型）" })
  async turnStream(
    @Param("id") id: string,
    @Body() dto: SopSessionTurnDto,
    @Res() res: Response,
    @CurrentUser() user?: { id: number | string },
  ): Promise<void> {
    const owner = this.ownerOf(user);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    // nginx 默认会把响应缓冲住，逐字效果就没了
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    const send = (event: string, data: unknown): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const heartbeat = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        /* 连接已断，下面的 finally 会收尾 */
      }
    }, 15_000);

    let sentAnyDelta = false;
    try {
      const view = await this.sessions.turn(
        id,
        owner,
        { text: dto.text, mediaId: dto.mediaId },
        (text) => {
          sentAnyDelta = true;
          send("delta", { text });
        },
      );
      send("done", view);
    } catch (err) {
      // 一个字节都还没发出去时，可能是 provider **不支持 stream**（直接 400）。
      // 这种失败重试同步路径是安全的：`turn()` 的落库发生在模型返回之后，
      // 第一轮失败不会在库里留下半截状态（用户消息只在内存数组里）。
      if (!sentAnyDelta) {
        try {
          const view = await this.sessions.turn(id, owner, {
            text: dto.text,
            mediaId: dto.mediaId,
          });
          send("done", view);
          return;
        } catch {
          /* 同步也失败：走下面的 error 帧，如实告知 */
        }
      }
      // 不抛：响应头已经发出去了，抛出去只会让客户端看到一个断掉的流
      send("error", {
        code: (err as { errorCode?: string }).errorCode ?? "AI_SOP_TURN_FAILED",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  }

  @Post(":id/saved")
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "标记会话已保存为 SOP 草稿（前端在 POST /sop 成功后调用）",
  })
  async markSaved(
    @Param("id") id: string,
    @CurrentUser() user?: { id: number | string },
  ) {
    return this.sessions.markSaved(id, this.ownerOf(user));
  }

  /** 归属键与 listMine 的建键方式必须逐字一致（`user:<id>`）。 */
  private ownerOf(user?: { id: number | string }): string {
    return `user:${user?.id ?? "unknown"}`;
  }
}
