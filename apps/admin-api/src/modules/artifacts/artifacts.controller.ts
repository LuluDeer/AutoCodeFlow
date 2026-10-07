import {
  BadRequestException,
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
import {
  ArtifactUploadResponseDto,
  ExecutionArtifactDto,
} from "../executor-package/dto/executor-package-response.dto";

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
    summary: "Upload one execution artifact (executor-to-admin, best-effort)",
    description:
      "Authenticates with the executor shared token or the per-executor dynamic " +
      "token (same credential the executor uses for its terminal callback). " +
      "Accepts multipart/form-data with a 'file' field (same shape as the " +
      "executor-package upload channel). Optional ?sha256= is cross-checked " +
      "against the uploaded bytes.",
  })
  @ApiParam({ name: "execId", description: "Execution ID (UUID)" })
  @ApiParam({ name: "name", description: "Bare artifact file name" })
  @ApiQuery({
    name: "sha256",
    required: false,
    description: "Expected sha256 hex",
  })
  @ApiResponse({
    status: 400,
    description: "Invalid name / over cap / sha mismatch",
  })
  @ApiResponse({ status: 401, description: "Invalid executor credential" })
  @ApiResponse({ status: 404, description: "Execution not found" })
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
      throw new BadRequestException("No artifact file uploaded");
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
    summary: "List execution artifacts (manifest, admin only)",
    description:
      "Returns the persisted artifact manifest reported by the executor's " +
      "terminal callback. Requires an administrator JWT (global JwtAuthGuard " +
      "+ RolesGuard).",
  })
  @ApiParam({ name: "execId", description: "Execution ID (UUID)" })
  @ApiOkResponse({ type: [ExecutionArtifactDto] })
  @ApiResponse({ status: 403, description: "Non-admin caller" })
  @ApiResponse({ status: 404, description: "Execution not found" })
  list(@Param("execId") execId: string) {
    return this.svc.getManifest(execId);
  }

  @Get("tasks/executions/:execId/artifacts/:name")
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth("JWT")
  @ApiOperation({
    summary: "Download one execution artifact (streamed, admin only)",
    description:
      "Streams a stored artifact to an authenticated administrator. Enforces a " +
      "bare-safe file-name (path-traversal guarded) and 404 when absent.",
  })
  @ApiParam({ name: "execId", description: "Execution ID (UUID)" })
  @ApiParam({ name: "name", description: "Bare artifact file name" })
  @ApiOkResponse({
    description: "artifact binary (Res passthrough)",
    content: {
      "application/octet-stream": {
        schema: { type: "string", format: "binary" },
      },
    },
  })
  @ApiResponse({ status: 403, description: "Non-admin caller" })
  @ApiResponse({ status: 404, description: "Artifact not found" })
  @ApiOkResponse({
    description: "artifact binary (Res passthrough)",
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
