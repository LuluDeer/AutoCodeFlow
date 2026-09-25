import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
  ForbiddenException,
} from "@nestjs/common";

import { ApiTags, ApiBearerAuth, ApiOperation } from "@nestjs/swagger";
import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Matches,
} from "class-validator";

import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { UserRole } from "../users/entities/user.entity";
import { SopService } from "./sop.service";
import { SopMediaService } from "./sop-media.service";
import { ExecutorService } from "../executor/executor.service";

/**
 * P5：SOP 管理面（ADMIN-only）。
 *
 * 权限与 agent 面同理：SOP 会成为执行器 Agent 的执行依据，**发布权 = 间接
 * 的指令注入权**（04 §4.3）。管理面的发布/指派/修订入口全部收紧到 ADMIN；
 * Agent 侧的同名能力走工具面（sop_publish 需审批，澄清小版本修订自主）。
 */

class DraftSopDto {
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9-]{0,127}$/, {
    message: "slug 只允许小写字母/数字/连字符，1..128",
  })
  slug: string;

  @IsString()
  @MaxLength(255)
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(100_000)
  frontMatterYaml?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500_000)
  bodyMarkdown?: string;

  @IsOptional()
  @IsUUID()
  applicationId?: string;
}

class UpdateSopDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100_000)
  frontMatterYaml?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500_000)
  bodyMarkdown?: string;
}

class PublishSopDto {
  @IsOptional()
  @IsIn(["patch", "minor", "major"])
  bump?: "patch" | "minor" | "major";

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  changelog?: string;
}

class AssignSopDto {
  @IsOptional()
  @IsString()
  @MaxLength(32)
  version?: string;

  @IsOptional()
  @IsUUID()
  executorId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  executorAddress?: string;
}

class HumanReplyDto {
  @IsIn(["answered", "sop_amended"])
  resolution: "answered" | "sop_amended";

  @IsString()
  @MaxLength(8000)
  answer: string;

  @IsOptional()
  @IsString()
  @MaxLength(100_000)
  amendedFrontMatterYaml?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500_000)
  amendedBodyMarkdown?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  changelog?: string;
}

@ApiTags("sop")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Roles(UserRole.ADMIN)
@Controller("sop")
export class SopController {
  constructor(
    private readonly sops: SopService,
    private readonly media: SopMediaService,
    private readonly executors: ExecutorService,
  ) {}

  @Get()
  @ApiOperation({ summary: "SOP 列表（可按 status 过滤）" })
  async list(
    @Query("status") status?: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
  ) {
    return this.sops.list({
      status,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Get("assignments/:assignmentId")
  @ApiOperation({ summary: "指派详情（含澄清对话全量）" })
  async assignment(@Param("assignmentId") id: string) {
    return this.sops.getAssignment(id);
  }

  /**
   * 媒体下载（P7b，ADMIN-only）：执行器上传的截图/录屏按 id 取回。
   * 面向中台 Agent（in-process 直读 service 也行，但 Admin Web 复核澄清时
   * 需要浏览器可达的 URL）与人工复核。
   */
  @Get("media/:mediaId")
  @ApiOperation({ summary: "下载执行器回传的媒体（截图/录屏）" })
  async downloadMedia(
    @Param("mediaId") mediaId: string,
    @Res() res: import("express").Response,
  ) {
    const row = await this.media.requireById(mediaId);
    const { stream, size, mime, name } = this.media.openStream(row);
    res.setHeader("Content-Type", mime ?? "application/octet-stream");
    res.setHeader("Content-Length", String(size));
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(name)}"`,
    );
    stream.pipe(res);
  }

  @Get("assignments/:assignmentId/media")
  @ApiOperation({ summary: "指派的媒体清单" })
  async mediaList(@Param("assignmentId") assignmentId: string) {
    return this.media.listByAssignment(assignmentId);
  }

  /**
   * 人工回复澄清（P6 升级环的收口）：escalated_to_human 的澄清此前只有
   * 通知没有答复路径——升级之后环就断了。人工与中台 Agent 走**同一个**
   * replyClarification（同一道幂等/校验/修订闸门），resolution 限
   * answered | sop_amended（sop_amanded 需修订内容，服务层校验）。
   */
  @Post("assignments/:assignmentId/clarifications/:clarificationId/reply")
  @ApiOperation({ summary: "人工回复一条澄清（升级转人工后的答复入口）" })
  async humanReply(
    @Param("assignmentId") assignmentId: string,
    @Param("clarificationId") clarificationId: string,
    @Body() dto: HumanReplyDto,
    @CurrentUser() user: { id: string },
  ) {
    // 确认澄清确实属于该指派（防跨工单答复）
    const { clarifications } = await this.sops.getAssignment(assignmentId);
    if (!clarifications.some((c) => c.id === clarificationId)) {
      throw new ForbiddenException("澄清不属于该指派");
    }
    return this.sops.replyClarification({
      clarificationId,
      resolution: dto.resolution,
      answer: dto.answer,
      amendedFrontMatterYaml: dto.amendedFrontMatterYaml,
      amendedBodyMarkdown: dto.amendedBodyMarkdown,
      changelog: dto.changelog,
      replyBy: `user:${user.id}`,
    });
  }

  @Get(":id")
  @ApiOperation({ summary: "SOP 详情" })
  async detail(@Param("id") id: string) {
    return this.sops.getSop(id);
  }

  @Post()
  @ApiOperation({ summary: "起草 SOP（draft 态；slug 重复则覆盖草稿）" })
  async draft(@Body() dto: DraftSopDto, @CurrentUser() user: { id: string }) {
    return this.sops.draft({
      slug: dto.slug,
      title: dto.title,
      frontMatterYaml: dto.frontMatterYaml,
      bodyMarkdown: dto.bodyMarkdown,
      applicationId: dto.applicationId ?? null,
      createdBy: `user:${user.id}`,
    });
  }

  @Patch(":id")
  @ApiOperation({
    summary: "编辑工作副本（published 态也可编辑——真身在不可变版本快照）",
  })
  async update(@Param("id") id: string, @Body() dto: UpdateSopDto) {
    const sop = await this.sops.getSop(id);
    return this.sops.draft({
      slug: sop.slug,
      title: dto.title ?? sop.title,
      frontMatterYaml: dto.frontMatterYaml,
      bodyMarkdown: dto.bodyMarkdown,
      createdBy: `user:${sop.createdBy}`,
    });
  }

  @Post(":id/publish")
  @ApiOperation({ summary: "发布（严格校验 + 不可变版本快照 + contentHash）" })
  async publish(
    @Param("id") id: string,
    @Body() dto: PublishSopDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.sops.publish({
      sopId: id,
      bump: dto.bump,
      changelog: dto.changelog,
      publishedBy: `user:${user.id}`,
    });
  }

  @Post(":id/assign")
  @ApiOperation({
    summary: "指派给执行器（executorId 或 executorAddress 二选一）",
  })
  async assign(
    @Param("id") id: string,
    @Body() dto: AssignSopDto,
    @CurrentUser() user: { id: string },
  ) {
    let executorId = dto.executorId;
    if (!executorId && dto.executorAddress) {
      const exec = await this.executors.findByAddress(dto.executorAddress);
      if (!exec)
        throw new ForbiddenException(`执行器 ${dto.executorAddress} 不存在`);
      executorId = exec.id;
    }
    if (!executorId) {
      throw new ForbiddenException(
        "executorId 与 executorAddress 必须提供其一",
      );
    }
    return this.sops.assign({
      sopId: id,
      version: dto.version,
      executorId,
      assignedBy: `user:${user.id}`,
    });
  }

  @Get(":id/versions")
  @ApiOperation({ summary: "版本历史（不可变快照列表）" })
  async versions(@Param("id") id: string) {
    return this.sops.listVersions(id);
  }

  @Get(":id/assignments")
  @ApiOperation({ summary: "指派记录" })
  async assignments(@Param("id") id: string) {
    return this.sops.listAssignments(id);
  }
}
