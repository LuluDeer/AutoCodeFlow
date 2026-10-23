import {
  Body,
  Controller,
  Get,
  Ip,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";

import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiOkResponse,
  ApiCreatedResponse,
  ApiExtraModels,
} from "@nestjs/swagger";
import {
  IsIn,
  IsNotEmpty,
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
// LANG-ERR-01: 用户可见报错改为稳定错误码（文案由前端按用户语言渲染）。
import { AppError } from "../../common/errors/app-error";
import { ErrorCode } from "../../common/errors/error-codes";
// ARCH-23 / N-12: SOP 域响应契约（sop + SopCollab 两 tag 共用本文件）。
import {
  AgentMediaDto,
  ClarificationReplyResponseDto,
  SopAssignmentDetailResponseDto,
  SopAssignmentDto,
  SopCapableExecutorDto,
  SopListResponseDto,
  SopPublishResponseDto,
  SopResponseDto,
  SopVersionDto,
} from "./dto/sop-response.dto";

/**
 * R41-A1：审计行的 `userId` 列是**整数**（audit_logs.userId int），而控制器
 * 这一侧的历史类型把主体 id 写成 string（模板拼 `user:<id>` 两种入参都吃）。
 * 统一在此收敛：非有限数一律 null——宁可留空，也不把 NaN 写进可被
 * 「按 userId 过滤」的列（NaN 会静默筛不到任何行）。
 */
function auditUserId(user?: { id: number | string }): number | null {
  const id = Number(user?.id);
  return Number.isFinite(id) ? id : null;
}

/**
 * P5：SOP 管理面（ADMIN-only）。
 *
 * 权限与 agent 面同理：SOP 会成为执行器 Agent 的执行依据，**发布权 = 间接
 * 的指令注入权**（04 §4.3）。管理面的发布/指派/修订入口全部收紧到 ADMIN；
 * Agent 侧的同名能力走工具面（sop_publish 需审批，澄清小版本修订自主）。
 */

export class DraftSopDto {
  @ApiProperty({ example: "daily-report" })
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9-]{0,127}$/, {
    message: "slug 只允许小写字母/数字/连字符，1..128",
  })
  slug: string;

  @ApiProperty()
  @IsString()
  // 前端（c5c46a58）已拦截空标题草稿，但 API 直调仍可绕过——服务端必须
  // 同样设防：title 是 SOP 的展示主键，空串/纯空白草稿没有存在价值。
  @IsNotEmpty()
  // IsNotEmpty 只挡 ""，纯空白（"   "）会被它放行——这里补一条
  // 「至少含一个非空白字符」，两者都不改写入值（trim 是另一个话题）。
  @Matches(/\S/, { message: "title 不能为空或纯空白" })
  @MaxLength(255)
  title: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100_000)
  frontMatterYaml?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500_000)
  bodyMarkdown?: string;

  @IsOptional()
  @IsUUID()
  applicationId?: string;
}

export class UpdateSopDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  // 与 DraftSopDto.title 同等设防（67ddaa9e 只补了 POST 路径）：PATCH 显式
  // 传 ""/"   " 同样能把标题改成空。@IsOptional 保证缺省（undefined）跳过
  // 全部校验——「不传 = 沿用原值」的 PATCH 语义不受影响，只有**显式**传
  // 空值才被 400。
  @IsNotEmpty({ message: "title 不能为空" })
  // IsNotEmpty 只挡 ""，纯空白（"   "）会被它放行——补「至少含一个非空白
  // 字符」，两者都不改写入值（trim 是另一个话题）。
  @Matches(/\S/, { message: "title 不能为空或纯空白" })
  @MaxLength(255)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100_000)
  frontMatterYaml?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500_000)
  bodyMarkdown?: string;
}

class PublishSopDto {
  @ApiPropertyOptional({ enum: ["patch", "minor", "major"] })
  @IsOptional()
  @IsIn(["patch", "minor", "major"])
  bump?: "patch" | "minor" | "major";

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  changelog?: string;
}

class AssignSopDto {
  @ApiPropertyOptional({ description: "指派的具体版本；缺省 = currentVersion" })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  version?: string;

  @ApiPropertyOptional({ format: "uuid" })
  @IsOptional()
  @IsUUID()
  executorId?: string;

  @ApiPropertyOptional({
    description: "按地址指派（executorId 缺省时的替代形态）",
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  executorAddress?: string;
}

class HumanReplyDto {
  @ApiProperty({ enum: ["answered", "sop_amended"] })
  @IsIn(["answered", "sop_amended"])
  resolution: "answered" | "sop_amended";

  @ApiProperty()
  @IsString()
  @MaxLength(8000)
  answer: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100_000)
  amendedFrontMatterYaml?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500_000)
  amendedBodyMarkdown?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  changelog?: string;
}

@ApiTags("sop")
@ApiBearerAuth()
// SopVersionDto/SopAssignmentDto/SopClarificationDto 经 detail 响应 DTO 的
// type 直引自动注册；显式列出仅为可读性（openapi 产物不受影响）。
@ApiExtraModels(SopResponseDto, SopVersionDto, SopAssignmentDto)
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
  // N-12: 裸分页 {items,total}——无 page/pageSize/totalPages 元数据（与
  // tasks 的 paginate() 双键信封不同源），契约如实钉住。
  @ApiOkResponse({ type: SopListResponseDto })
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
  @ApiOkResponse({ type: SopAssignmentDetailResponseDto })
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
  // @Res() 直写二进制流（绕过 envelope）——契约按 binary 字符串声明。
  @ApiOkResponse({ schema: { type: "string", format: "binary" } })
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
  @ApiOkResponse({ type: [AgentMediaDto] })
  async mediaList(@Param("assignmentId") assignmentId: string) {
    return this.media.listByAssignment(assignmentId);
  }

  /**
   * 指派可选执行器（P7c 租约投影）：只列**当前租约内**声明了 agent:sop 的
   * 机器。列表投影刻意剥离 agentCapabilities（短效租约，快照会误导），
   * 指派面因此走这台独立端点——Admin Web 的指派对话框据此渲染可选项，
   * 空列表 = 「没有任何机器开着 Agent」，而不是让 assign 端点报错兜圈。
   */
  @Get("assignable-executors")
  @ApiOperation({ summary: "当前租约内可接 SOP 指派的执行器（agent:sop）" })
  @ApiOkResponse({
    type: [SopCapableExecutorDto],
    description:
      "空列表 = 没有任何机器开着 Agent（指派对话框据此渲染，而非 assign 报错兜圈）",
  })
  async assignableExecutors() {
    return this.executors.listSopCapableExecutors();
  }

  /**
   * 人工回复澄清（P6 升级环的收口）：escalated_to_human 的澄清此前只有
   * 通知没有答复路径——升级之后环就断了。人工与中台 Agent 走**同一个**
   * replyClarification（同一道幂等/校验/修订闸门），resolution 限
   * answered | sop_amended（sop_amanded 需修订内容，服务层校验）。
   */
  @Post("assignments/:assignmentId/clarifications/:clarificationId/reply")
  @ApiOperation({ summary: "人工回复一条澄清（升级转人工后的答复入口）" })
  // POST 无 @HttpCode → 实际 201（历史直觉 200 是漂移，按实际落契约）。
  @ApiCreatedResponse({ type: ClarificationReplyResponseDto })
  async humanReply(
    @Param("assignmentId") assignmentId: string,
    @Param("clarificationId") clarificationId: string,
    @Body() dto: HumanReplyDto,
    @CurrentUser() user: { id: number | string } | undefined,
    @Ip() ip?: string,
  ) {
    // 确认澄清确实属于该指派（防跨工单答复）
    const { clarifications } = await this.sops.getAssignment(assignmentId);
    if (!clarifications.some((c) => c.id === clarificationId)) {
      throw new AppError(
        ErrorCode.SOP_CLARIFICATION_NOT_IN_ASSIGNMENT_FORBIDDEN,
      );
    }
    return this.sops.replyClarification({
      clarificationId,
      resolution: dto.resolution,
      answer: dto.answer,
      amendedFrontMatterYaml: dto.amendedFrontMatterYaml,
      amendedBodyMarkdown: dto.amendedBodyMarkdown,
      changelog: dto.changelog,
      replyBy: `user:${user.id}`,
      // R41-A1：人工答复的审计上下文（谁、从哪来）——答复正文由服务层
      // 只记长度，不经控制器进入审计。
      audit: { userId: auditUserId(user), ip: ip ?? null },
    });
  }

  @Get(":id")
  @ApiOperation({ summary: "SOP 详情" })
  @ApiOkResponse({ type: SopResponseDto })
  async detail(@Param("id") id: string) {
    return this.sops.getSop(id);
  }

  @Post()
  @ApiOperation({ summary: "起草 SOP（draft 态；slug 重复则覆盖草稿）" })
  @ApiCreatedResponse({ type: SopResponseDto })
  async draft(
    @Body() dto: DraftSopDto,
    @CurrentUser() user: { id: number | string } | undefined,
    @Ip() ip?: string,
  ) {
    return this.sops.draft({
      slug: dto.slug,
      title: dto.title,
      frontMatterYaml: dto.frontMatterYaml,
      bodyMarkdown: dto.bodyMarkdown,
      applicationId: dto.applicationId ?? null,
      createdBy: `user:${user.id}`,
      // R41-A1：起草/编辑也留痕（发布的正文就取自工作副本）
      audit: { userId: auditUserId(user), ip: ip ?? null },
    });
  }

  @Patch(":id")
  @ApiOperation({
    summary: "编辑工作副本（published 态也可编辑——真身在不可变版本快照）",
  })
  @ApiOkResponse({
    type: SopResponseDto,
    description: "编辑后的工作副本（published 行的 currentVersion 不变）",
  })
  async update(
    @Param("id") id: string,
    @Body() dto: UpdateSopDto,
    @CurrentUser() user?: { id: number | string },
    @Ip() ip?: string,
  ) {
    const sop = await this.sops.getSop(id);
    return this.sops.draft({
      slug: sop.slug,
      title: dto.title ?? sop.title,
      frontMatterYaml: dto.frontMatterYaml,
      bodyMarkdown: dto.bodyMarkdown,
      // R34-A1（轴 4）：createdBy 是**归属**不是「本次操作者」——库里已是
      // `user:<uuid>` 形态，再套一层前缀会得到 `user:user:<uuid>`（不可解析）。
      // 编辑不改归属：原样透传（draft 对既有 slug 也不写这一列，双重保险）。
      createdBy: sop.createdBy,
      // R41-A1：编辑工作副本留痕（操作者是当前用户，不是 createdBy 属主）
      audit: { userId: auditUserId(user), ip: ip ?? null },
    });
  }

  @Post(":id/publish")
  @ApiOperation({ summary: "发布（严格校验 + 不可变版本快照 + contentHash）" })
  @ApiCreatedResponse({
    type: SopPublishResponseDto,
    description: "内容与当前版本完全一致 → 400（修订必须真的改了什么）",
  })
  async publish(
    @Param("id") id: string,
    @Body() dto: PublishSopDto,
    @CurrentUser() user: { id: number | string } | undefined,
    @Ip() ip?: string,
  ) {
    return this.sops.publish({
      sopId: id,
      bump: dto.bump,
      changelog: dto.changelog,
      publishedBy: `user:${user.id}`,
      // R41-A1：发布是审计的首要动作（「谁发布了哪个版本」）
      audit: { userId: auditUserId(user), ip: ip ?? null },
    });
  }

  @Post(":id/assign")
  @ApiOperation({
    summary: "指派给执行器（executorId 或 executorAddress 二选一）",
  })
  @ApiCreatedResponse({ type: SopAssignmentDto })
  async assign(
    @Param("id") id: string,
    @Body() dto: AssignSopDto,
    @CurrentUser() user: { id: number | string } | undefined,
    @Ip() ip?: string,
  ) {
    let executorId = dto.executorId;
    if (!executorId && dto.executorAddress) {
      const exec = await this.executors.findByAddress(dto.executorAddress);
      if (!exec)
        throw new AppError(ErrorCode.SOP_EXECUTOR_NOT_FOUND_BY_ADDRESS, {
          address: dto.executorAddress,
        });
      executorId = exec.id;
    }
    if (!executorId) {
      throw new AppError(ErrorCode.SOP_ASSIGN_EXECUTOR_REQUIRED);
    }
    return this.sops.assign({
      sopId: id,
      version: dto.version,
      executorId,
      assignedBy: `user:${user.id}`,
      // R41-A1：指派 / 重派留痕（「把哪张单指派给了谁」）
      audit: { userId: auditUserId(user), ip: ip ?? null },
    });
  }

  @Get(":id/versions")
  @ApiOperation({ summary: "版本历史（不可变快照列表）" })
  @ApiOkResponse({ type: [SopVersionDto] })
  async versions(@Param("id") id: string) {
    return this.sops.listVersions(id);
  }

  @Get(":id/assignments")
  @ApiOperation({ summary: "指派记录" })
  @ApiOkResponse({
    type: [SopAssignmentDto],
    description: "最近 100 条，createdAt 降序",
  })
  async assignments(@Param("id") id: string) {
    return this.sops.listAssignments(id);
  }

  /**
   * 归档（2026-10-23）：`deprecated` 此前是死状态，SOP 只增不减。
   *
   * 为什么用 POST 而不是 DELETE：归档**不删数据**——版本快照、指派、澄清记录
   * 全部保留（它们是「这张 SOP 怎么被执行过」的证据）。DELETE 语义会让人以为
   * 数据没了。恢复走 `POST /:id/restore`。
   */
  @Post(":id/deprecate")
  @ApiOperation({ summary: "归档 SOP（停止派新单，保留全部历史）" })
  @ApiOkResponse({ type: SopResponseDto })
  async deprecate(
    @Param("id") id: string,
    @CurrentUser() user: { id: number | string } | undefined,
    @Ip() ip?: string,
  ) {
    return this.sops.deprecate({
      sopId: id,
      actor: user ? `user:${user.id}` : undefined,
      audit: { userId: auditUserId(user), ip: ip ?? null },
    });
  }

  /**
   * 取消该 SOP 下所有未结束的指派（归档前置动作）。
   *
   * 为什么单独成一个端点而不是让 deprecate 隐式取消：取消指派是**会影响执行器
   * 现场**的动作（那边可能正在跑），必须让操作者显式确认；而归档是纯中台状态。
   * 两步分开，审计上也能区分「谁取消了单」与「谁把 SOP 下线」。
   */
  @Post(":id/assignments/cancel")
  @ApiOperation({ summary: "取消该 SOP 下所有未结束的指派（归档前置动作）" })
  @ApiOkResponse({ description: "{ cancelled: 实际取消的条数 }" })
  async cancelAssignments(
    @Param("id") id: string,
    @CurrentUser() user: { id: number | string } | undefined,
    @Ip() ip?: string,
  ) {
    return this.sops.cancelOpenAssignments({
      sopId: id,
      actor: user ? `user:${user.id}` : undefined,
      audit: { userId: auditUserId(user), ip: ip ?? null },
    });
  }

  /** 恢复已归档的 SOP（回到 published；从未发布过的回到 draft）。 */
  @Post(":id/restore")
  @ApiOperation({ summary: "恢复已归档的 SOP" })
  @ApiOkResponse({ type: SopResponseDto })
  async restore(
    @Param("id") id: string,
    @CurrentUser() user: { id: number | string } | undefined,
    @Ip() ip?: string,
  ) {
    return this.sops.restore({
      sopId: id,
      actor: user ? `user:${user.id}` : undefined,
      audit: { userId: auditUserId(user), ip: ip ?? null },
    });
  }
}
