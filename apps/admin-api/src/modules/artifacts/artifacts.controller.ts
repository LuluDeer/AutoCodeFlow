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
import { Roles } from "../../common/decorators/roles.decorator";
import { UserRole } from "../users/entities/user.entity";
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

/**
 * FEAT-05：执行产物通道。
 *
 *  - 上传（机器对机器，`@Public` + 处理器内校验执行器凭据）：
 *    PUT /api/executions/:execId/artifacts/:name
 *  - 下载 / 列表（管理台 JWT，经全局 JwtAuthGuard + A-2 起收紧 @Roles(ADMIN)）：
 *    GET /api/tasks/executions/:execId/artifacts          → 清单
 *    GET /api/tasks/executions/:execId/artifacts/:name    → 流式文件
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

  // ARTIFACTS-INDEX-46（部署模型评审 §4.6）：按应用/任务维度索引查询产物。
  // 走 execution_artifacts 新表（jsonb 清单无索引不可查询的痛点由本面承接），
  // 与上方按执行的清单端点（读 jsonb）并存——读面分工见
  // ArtifactsService.listArtifactRows 头注（过渡期：存量执行无新表行 → 如实
  // 返回空，不回落 jsonb）。权限与产物下载/清单同档 ADMIN-only（A-2 口径）。
  @Get("artifacts")
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth("JWT")
  @ApiOperation({
    description:
      "按应用/任务维度分页查询执行产物索引（execution_artifacts 表；含跨执行的聚合视图）。存量执行（索引建立前终态化）无新表行，如实返回空——按执行的清单请走 GET /tasks/executions/:execId/artifacts。需要管理员 JWT。",
    summary: "按应用/任务查询产物索引（仅管理员）",
  })
  @ApiQuery({ name: "applicationId", required: false, format: "uuid" })
  @ApiQuery({ name: "taskId", required: false, format: "uuid" })
  @ApiQuery({ name: "page", required: false, type: Number })
  @ApiQuery({ name: "pageSize", required: false, type: Number })
  @ApiOkResponse({ type: [ExecutionArtifactRowDto] })
  @ApiResponse({ status: 403, description: "调用者不是管理员" })
  listArtifactRows(@Query() query: ListArtifactRowsDto) {
    return this.svc.listArtifactRows(query);
  }

  // A-2: 产物是任务执行的工作产物（可能含日志/截图/导出数据等运维敏感面），
  // 与 audit 端点同档收紧为 ADMIN-only。此前无 @Roles（RolesGuard 对无元数据
  // 路由放行任意登录用户）、也无跨项目/应用归属校验——任意登录用户可枚举并
  // 下载任意执行的产物。前端消费面（ArtifactsList → TaskDetailPage /
  // ExecutionDetailPage）暂未做角色门控，普通用户访问产物列表将得到 403
  // （admin-web 侧的页面级门控待后续跟进）。
  @Get("tasks/executions/:execId/artifacts")
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth("JWT")
  @ApiOperation({
    description:
      "返回执行器终态回调上报并已落库的产物 manifest。需要管理员 JWT（全局 JwtAuthGuard + RolesGuard）。",
    summary: "列出执行产物（manifest，仅管理员）",
  })
  @ApiParam({ name: "execId", description: "执行 ID（UUID）" })
  @ApiOkResponse({ type: [ExecutionArtifactDto] })
  @ApiResponse({ status: 403, description: "调用者不是管理员" })
  @ApiResponse({ status: 404, description: "执行记录不存在" })
  list(@Param("execId") execId: string) {
    return this.svc.getManifest(execId);
  }

  @Get("tasks/executions/:execId/artifacts/:name")
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth("JWT")
  @ApiOperation({
    description:
      "将已存储的产物以流式返回给已认证的管理员。强制校验裸文件名（防路径穿越），产物不存在时返回 404。",
    summary: "下载单个执行产物（流式，仅管理员）",
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
  @ApiResponse({ status: 403, description: "调用者不是管理员" })
  @ApiResponse({ status: 404, description: "产物不存在" })
  @ApiOkResponse({
    description: "产物二进制内容（Res 直传）",
    content: {
      "application/octet-stream": {
        schema: { type: "string", format: "binary" },
      },
    },
  })
  async download(
    @Param("execId") execId: string,
    @Param("name") name: string,
    @Res() res: Response,
    // A-2: 审计行带操作人（与 notification-config 同款 @CurrentUser 取法）
    @CurrentUser() user?: AuthUser,
  ): Promise<void> {
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
