import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  Logger,
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
} from "@nestjs/swagger";
import { Public } from "../../common/decorators/public.decorator";
import { buildContentDisposition } from "../executor-package/executor-package.controller";
import { ArtifactsService } from "./artifacts.service";
import { MAX_ARTIFACT_SIZE_BYTES } from "./artifacts.constants";

/**
 * FEAT-05：执行产物通道。
 *
 *  - 上传（机器对机器，`@Public` + 处理器内校验执行器凭据）：
 *    PUT /api/executions/:execId/artifacts/:name
 *  - 下载 / 列表（管理台 JWT，经全局 JwtAuthGuard）：
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

  constructor(private readonly svc: ArtifactsService) {}

  @Public()
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
  @ApiResponse({ status: 201, description: "Stored" })
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

  @Get("tasks/executions/:execId/artifacts")
  @ApiBearerAuth("JWT")
  @ApiOperation({
    summary: "List execution artifacts (manifest)",
    description:
      "Returns the persisted artifact manifest reported by the executor's " +
      "terminal callback. Requires an administrator JWT (global JwtAuthGuard).",
  })
  @ApiParam({ name: "execId", description: "Execution ID (UUID)" })
  @ApiResponse({ status: 200, description: "Artifact manifest" })
  @ApiResponse({ status: 404, description: "Execution not found" })
  list(@Param("execId") execId: string) {
    return this.svc.getManifest(execId);
  }

  @Get("tasks/executions/:execId/artifacts/:name")
  @ApiBearerAuth("JWT")
  @ApiOperation({
    summary: "Download one execution artifact (streamed)",
    description:
      "Streams a stored artifact to an authenticated administrator. Enforces a " +
      "bare-safe file-name (path-traversal guarded) and 404 when absent.",
  })
  @ApiParam({ name: "execId", description: "Execution ID (UUID)" })
  @ApiParam({ name: "name", description: "Bare artifact file name" })
  @ApiResponse({ status: 200, description: "File content" })
  @ApiResponse({ status: 404, description: "Artifact not found" })
  async download(
    @Param("execId") execId: string,
    @Param("name") name: string,
    @Res() res: Response,
  ): Promise<void> {
    const { stream, fileSize, contentType } = await this.svc.openArtifact(
      execId,
      name,
    );
    res.setHeader("Content-Disposition", buildContentDisposition(name));
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", fileSize);
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
