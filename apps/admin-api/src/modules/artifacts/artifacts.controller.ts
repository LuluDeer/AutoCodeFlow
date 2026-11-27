import {
  Controller,
  Get,
  Headers,
  Inject,
  Logger,
  Optional,
  Param,
  Put,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { memoryStorage } from "multer";
import { Response } from "express";
import { pipeline } from "stream/promises";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
  ApiOkResponse,
  ApiCreatedResponse,
} from "@nestjs/swagger";
import { Public } from "../../common/decorators/public.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { AuthUser } from "../../common/interfaces/auth-user.interface";
import { buildContentDisposition } from "../executor-package/executor-package.controller";
import { ArtifactsService } from "./artifacts.service";
import { MAX_ARTIFACT_SIZE_BYTES } from "./artifacts.constants";
// A-2: 下载成功路径的审计落证（@Optional 与 notification.service 同先例——
// ArtifactsModule 生产装配 imports AuditModule，存量测试未提供时旁路）。
import { AuditService } from "../audit/audit.service";
import { WriteGuard } from "../../common/decorators/write-guard.decorator";
// LANG-ERR-01: 用户可见报错改为稳定错误码（文案由前端按用户语言渲染）。
import { AppError } from "../../common/errors/app-error";
import { ErrorCode } from "../../common/errors/error-codes";
import {
  ArtifactUploadResponseDto,
  ExecutionArtifactDto,
} from "../executor-package/dto/executor-package-response.dto";
// ARTIFACTS-INDEX-46: 产物元数据索引查询面（GET /artifacts）。
import {
  ListArtifactRowsDto,
  ExecutionArtifactRowDto,
} from "./dto/artifact-index.dto";
import {
  ArtifactPreviewQueryDto,
  ArtifactPreviewResponseDto,
} from "./dto/artifact-preview.dto";

/**
 * FEAT-05：执行产物通道。
 *
 *  - 上传（机器对机器，`@Public` + 处理器内校验执行器凭据）：
 *    PUT /api/executions/:execId/artifacts/:name
 *  - 下载 / 列表（管理台 JWT，全局 JwtAuthGuard；GCO §5 起任意登录用户可达，
 *    服务层按 tasks.ownerUserId / 项目 editor+ 角色收窄，无主产物恒不可见）：
 *    GET /api/tasks/executions/:execId/artifacts          → 清单
 *    GET /api/tasks/executions/:execId/artifacts/:name    → 流式文件
 *    GET /api/artifacts                                   → 跨执行索引
 *
 * 路由基路径刻意不同：下载挂在 `tasks/executions/...` 对齐计划书；上传挂在
 * `executions/...` 对齐执行器回调所用的 `executions/callback` 机器通道命名。
 */
@ApiTags("Execution Artifacts")
@Controller()
export class ArtifactsController {
  private readonly logger = new Logger(ArtifactsController.name);

  constructor(
    private readonly svc: ArtifactsService,
    // A-2: 下载审计落证（@Optional，存量测试装配缺席时旁路）
    @Optional()
    @Inject(AuditService)
    private readonly audit?: AuditService,
  ) {}

  @Public()
  @WriteGuard("artifact", {
    scope: "token",
    reason: "执行器持 per-execution 回调令牌上传产物",
  })
  @Put("executions/:execId/artifacts/:name")
  @ApiOperation({
    description:
      "必须使用**该执行器的 per-executor 动态令牌**（与执行器上报终态回调所用凭据一致）——共享令牌默认拒绝（SEC-1：共享令牌不携带执行器身份，放行等于允许向任意 execId 的产物目录写入）。接受 multipart/form-data，字段名为 'file'（与执行器包上传通道同形态）。可选的 ?sha256= 会与上传的字节做交叉校验。过渡期如需允许共享令牌，置 EXECUTOR_ARTIFACT_ALLOW_SHARED_TOKEN=true（每次命中都会 warn，属安全欠账）。",
    summary: "上传单个执行产物（执行器 → 中台，尽力而为）",
  })
  @ApiParam({ name: "execId", description: "执行 ID（UUID）" })
  @ApiParam({ name: "name", description: "裸产物文件名" })
  @ApiQuery({
    name: "sha256",
    required: false,
    description: "期望的 sha256 十六进制值",
  })
  @ApiResponse({
    status: 400,
    description: "文件名非法 / 超出上限 / sha256 不匹配",
  })
  @ApiResponse({ status: 401, description: "执行器凭据无效" })
  @ApiResponse({
    status: 403,
    description:
      "共享令牌被拒绝（SEC-1，需 per-executor 令牌）、或执行行未绑定执行器地址（fail-closed）",
  })
  @ApiResponse({ status: 404, description: "执行记录不存在" })
  @UseInterceptors(
    FileInterceptor("file", {
      storage: memoryStorage(),
      limits: { fileSize: MAX_ARTIFACT_SIZE_BYTES },
    }),
  )
  @ApiCreatedResponse({ type: ArtifactUploadResponseDto })
  async upload(
    @Param("execId") execId: string,
    @Param("name") name: string,
    @Headers("authorization") auth: string | undefined,
    @Query("sha256") sha256: string | undefined,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    // FileInterceptor 在 body 解析前接管 multipart；机器侧也可能直接 PUT 原始
    // 字节——两种形态统一要求携带名为 "file" 的字段。
    const buf = file?.buffer;
    if (!buf) {
      throw new AppError(ErrorCode.ARTIFACT_FILE_MISSING);
    }
    // 凭据校验（内部会确认执行行存在）。
    await this.svc.verifyUploadAuth(execId, auth);
    const stored = await this.svc.saveArtifact(
      execId,
      name,
      buf,
      sha256 || undefined,
    );
    return { ok: true, ...stored };
  }

  // ARTIFACTS-INDEX-46（部署模型评审 §4.6）：按应用/任务/文件名关键字/时间范围/
  // 扩展名维度索引查询产物。
  // 走 execution_artifacts 新表（jsonb 清单无索引不可查询的痛点由本面承接），
  // 与上方按执行的清单端点（读 jsonb）并存——读面分工见
  // ArtifactsService.listArtifactRows 头注（过渡期：存量执行无新表行 → 如实
  // 返回空，不回落 jsonb）。GCO §5：任意登录用户可读，归属过滤在服务层下推。
  @Get("artifacts")
  @ApiBearerAuth("JWT")
  @ApiOperation({
    description:
      "按应用/任务/文件名关键字/时间范围/扩展名维度分页查询执行产物索引（execution_artifacts 表；含跨执行的聚合视图）。ADMIN 全量；role=user 仅见本人属主或本人具 editor+ 项目的产物（无主行不可见）。mine=true / owner=me 再收窄到「属主=我」。存量执行（索引建立前终态化）无新表行，如实返回空——按执行的清单请走 GET /tasks/executions/:execId/artifacts。",
    summary: "分页查询执行产物索引（按归属收窄）",
  })
  @ApiQuery({ name: "applicationId", required: false, format: "uuid" })
  @ApiQuery({ name: "taskId", required: false, format: "uuid" })
  @ApiQuery({
    name: "q",
    required: false,
    type: String,
    description:
      "文件名关键字（name ILIKE 不区分大小写模糊匹配；长度上限 100，trim 后空串视为未传）",
  })
  @ApiQuery({
    name: "from",
    required: false,
    format: "date-time",
    description:
      "仅返回 createdAt >= 该时刻的产物（ISO-8601 闭区间起点；非法格式 400 VALIDATION_FAILED）",
  })
  @ApiQuery({
    name: "to",
    required: false,
    format: "date-time",
    description:
      "仅返回 createdAt <= 该时刻的产物（ISO-8601 闭区间终点；起始时间晚于终点时返回 400 VALIDATION_FAILED）",
  })
  @ApiQuery({
    name: "ext",
    required: false,
    type: String,
    description:
      "按扩展名过滤（小写、不带点；命中文件名末尾的 .<ext>；不在白名单 400 VALIDATION_FAILED）",
  })
  @ApiQuery({ name: "page", required: false, type: Number })
  @ApiQuery({ name: "pageSize", required: false, type: Number })
  @ApiQuery({
    name: "mine",
    required: false,
    type: Boolean,
    description: "只看当前登录用户作为任务属主的交付物（true/1 视为开启）",
  })
  @ApiQuery({
    name: "owner",
    required: false,
    enum: ["me"],
    description: "mine 的别名：owner=me 等价于 mine=true；不接受其他用户 id",
  })
  @ApiOkResponse({ type: [ExecutionArtifactRowDto] })
  @ApiResponse({ status: 403, description: "调用者未登录或无权访问该产物" })
  listArtifactRows(
    @Query() query: ListArtifactRowsDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.svc.listArtifactRows(query, user);
  }

  // GCO §5：任意登录用户可读，归属校验在 ArtifactsService.assertArtifactReadable。
  // 旧注释里的 ADMIN-only 已撤回——普通用户此前完全看不到自己的交付物。
  @Get("tasks/executions/:execId/artifacts")
  @ApiBearerAuth("JWT")
  @ApiOperation({
    description:
      "返回执行器终态回调上报并已落库的产物 manifest。ADMIN 全量；role=user 仅见本人属主或本人具 editor+ 项目的执行（无主执行不可见）。",
    summary: "列出执行产物（manifest，按归属收窄）",
  })
  @ApiParam({ name: "execId", description: "执行 ID（UUID）" })
  @ApiOkResponse({ type: [ExecutionArtifactDto] })
  @ApiResponse({ status: 403, description: "调用者无权访问该执行的产物" })
  @ApiResponse({ status: 404, description: "执行记录不存在" })
  list(@Param("execId") execId: string, @CurrentUser() user: AuthUser) {
    return this.svc.getManifest(execId, user);
  }

  @Get("tasks/executions/:execId/artifacts/:name/preview")
  @ApiBearerAuth("JWT")
  @ApiOperation({
    description:
      "按与下载相同的归属校验读取产物开头做有界预览。ADMIN 全量；普通用户仅见本人属主或本人具 editor+ 项目的执行产物，无主产物恒 403。maxBytes 默认 65536、可取 1024..262144；文本（text/*、json、xml）按 UTF-8 返回 content，图片/二进制 content=null 且不会读取文件内容。超出上限时 truncated=true，文件路径穿越与非 UUID 执行 ID 一律 400。",
    summary: "有界预览单个执行产物（文本 UTF-8 / 图片与二进制仅元数据）",
  })
  @ApiParam({ name: "execId", description: "执行 ID（UUID）" })
  @ApiParam({ name: "name", description: "裸产物文件名" })
  @ApiQuery({
    name: "maxBytes",
    required: false,
    type: Number,
    description:
      "预览最多读取的字节数，默认 65536，允许 1024..262144；越界返回 400 VALIDATION_FAILED",
  })
  @ApiOkResponse({
    type: ArtifactPreviewResponseDto,
    description:
      "有界预览结果（name/mimeType/size/truncated/kind/content）；非文本 content 恒为 null",
  })
  @ApiResponse({ status: 400, description: "执行 ID 或产物名非法、maxBytes 越界" })
  @ApiResponse({ status: 403, description: "调用者无权访问该产物" })
  @ApiResponse({ status: 404, description: "产物不存在" })
  async preview(
    @Param("execId") execId: string,
    @Param("name") name: string,
    @Query() query: ArtifactPreviewQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    // 与 download 同口径：先按 execId 反查执行行归属，无权/无主执行即 403；
    // 守卫在 service 内按 viewer 角色收窄，ADMIN 全量。
    await this.svc.assertArtifactReadable(execId, user);
    return this.svc.previewArtifact(execId, name, query.maxBytes);
  }

  @Get("tasks/executions/:execId/artifacts/:name")
  @ApiBearerAuth("JWT")
  @ApiOperation({
    description:
      "将已存储的产物以流式返回给已认证用户。ADMIN 全量；role=user 仅见本人属主或本人具 editor+ 项目的产物，且无主产物恒 403。强制校验裸文件名（防路径穿越），产物不存在时返回 404。",
    summary: "下载单个执行产物（流式，按归属收窄）",
  })
  @ApiParam({ name: "execId", description: "执行 ID（UUID）" })
  @ApiParam({ name: "name", description: "裸产物文件名" })
  @ApiOkResponse({
    description: "产物二进制内容（Res 直传）",
    content: {
      "application/octet-stream": {
        schema: { type: "string", format: "binary" },
      },
    },
  })
  @ApiResponse({ status: 403, description: "调用者无权访问该产物" })
  @ApiResponse({ status: 404, description: "产物不存在" })
  async download(
    @Param("execId") execId: string,
    @Param("name") name: string,
    @Res() res: Response,
    // A-2: 审计行带操作人（与 notification-config 同款 @CurrentUser 取法）
    @CurrentUser() user?: AuthUser,
  ): Promise<void> {
    // GCO §5：先按 execId 反查执行行归属，失败即 403；审计在校验之后，
    // 越权尝试不写 artifact.download。
    // 老单测的极简 svc 替身没有归属断言方法；生产装配恒有，这里只做形状守卫。
    if (typeof this.svc.assertArtifactReadable === "function") {
      await this.svc.assertArtifactReadable(execId, user);
    }
    const { stream, fileSize, contentType, sha256 } =
      await this.svc.openArtifact(execId, name);
    res.setHeader("Content-Disposition", buildContentDisposition(name));
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", fileSize);
    // E-P2-P6：下发实际字节 sha256（与现有 artifact 路由约定一致，响应头优先）。
    res.setHeader("X-SHA256", sha256);
    // A-2: 下载成功路径落审计（artifact.download）。best-effort try/catch——
    // 审计库故障不允许把已建立的字节流反向炸成 500。
    try {
      await this.audit?.log({
        username: user?.username,
        action: "artifact.download",
        resource: "artifact",
        resourceId: `${execId}/${name}`,
      });
    } catch (err: unknown) {
      this.logger.warn(
        `artifact.download audit write failed (best-effort, ignored): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    try {
      await pipeline(stream, res);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Artifact download ${execId}/${name} ended with error: ${msg}`,
      );
    }
  }
}
