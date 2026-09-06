import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Logger,
  BadRequestException,
  UnauthorizedException,
  InternalServerErrorException,
  Headers,
  Req,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiConsumes,
  ApiBody,
} from "@nestjs/swagger";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { Public } from "../../common/decorators/public.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { UserRole } from "../users/entities/user.entity";
import { ApplicationService } from "./application.service";
import { AppDeploymentService } from "./app-deployment.service";
import {
  CreateApplicationDto,
  UpdateApplicationDto,
  UploadApplicationDto,
} from "./dto/application.dto";
import { AppReleaseWebhookDto } from "./dto/app-release-webhook.dto";
import * as fs from "fs";
import * as path from "path";
import { createHmac, timingSafeEqual } from "crypto";
import type { Request } from "express";

@ApiTags("Application Management")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("applications")
export class ApplicationController {
  private readonly logger = new Logger(ApplicationController.name);

  // APP-001: 该端点公开给 CI/CD 调用，属于未认证攻击面。所有鉴权失败路径
  // （应用不存在 / webhookSecret 未配置 / 签名缺失或无效 / 时间戳过期 /
  // raw body 缺失）必须返回完全相同的 401 响应——任何响应差异（状态码或
  // 错误消息）都会成为枚举应用名的判定依据。具体失败原因只写入服务端日志。
  private static readonly WEBHOOK_AUTH_FAILURE_MESSAGE =
    "Webhook authentication failed";

  constructor(
    private readonly svc: ApplicationService,
    private readonly deploymentSvc: AppDeploymentService,
  ) {}

  @Get()
  @ApiOperation({ summary: "Get application list" })
  findAll() {
    return this.svc.findAll();
  }

  @Get(":id")
  @ApiOperation({ summary: "Get application details" })
  findById(@Param("id") id: string) {
    return this.svc.findById(id);
  }

  // R1: application lifecycle (create/update/delete) plus all deployment
  // management routes below are admin-only — they mutate cluster-level
  // state (deployments, versions, env vars, git refs) that affects every
  // executor. Read endpoints (findAll/findById/version history) stay
  // visible to any authenticated user; the env field on the read surface
  // is masked the same way notification channel credentials are (see
  // NotificationConfigService). The @Public() webhook is a CI machine
  // endpoint with HMAC auth — RolesGuard finds no @Roles metadata on it
  // and lets the request through after JwtAuthGuard's @Public opt-out.
  @Post()
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "Create application" })
  create(@Body() dto: CreateApplicationDto) {
    return this.svc.create(dto);
  }

  @Put(":id")
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "Update application" })
  update(@Param("id") id: string, @Body() dto: UpdateApplicationDto) {
    return this.svc.update(id, dto);
  }

  @Delete(":id")
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "Delete application" })
  remove(@Param("id") id: string) {
    return this.svc.remove(id);
  }

  @Post("upload")
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "Upload application package (zip)" })
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        file: { type: "string", format: "binary" },
        name: { type: "string" },
        runtime: { type: "string" },
      },
      required: ["file", "name"],
    },
  })
  @UseInterceptors(
    FileInterceptor("file", { limits: { fileSize: 200 * 1024 * 1024 } }),
  )
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: UploadApplicationDto,
  ) {
    if (!file) throw new BadRequestException("No file uploaded");
    // ARCH-003: name/runtime 经全局 ValidationPipe（whitelist + MaxLength）校验，
    // 不再用裸 @Body("name") 字符串绕过验证管道
    const { name, runtime } = body;
    if (!name) throw new BadRequestException("Application name is required");

    // P1: upload validation — extension whitelist plus ZIP magic number, so
    // arbitrary content cannot be stored and served as a trusted .zip.
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (ext !== ".zip") {
      throw new BadRequestException("Application package must be a .zip file");
    }
    const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
    if (
      !file.buffer ||
      file.buffer.length < 4 ||
      !file.buffer.subarray(0, 4).equals(ZIP_MAGIC)
    ) {
      throw new BadRequestException("File is not a valid ZIP archive");
    }

    // APP-002: packageUrl 会被 executor 节点拉取。旧实现缺 API_BASE_URL 时静默
    // 回退 `http://localhost:PORT`，生成的 URL 在其它机器上不可达，问题被推迟到
    // 部署阶段才暴露。这里选择 fail-fast（使用时记 error 并抛 500）而非从请求
    // Host 推导：上传请求的 Host 可能是 CI 容器的 localhost 或反向代理地址，
    // 静默推导同样会存下不可达的 URL，只是把失败换个地方隐藏；显式报错能在
    // 上传这一步就把配置缺失暴露给调用方。
    // R9b: the API_BASE_URL check runs BEFORE anything is written to disk —
    // the old order (write file → check) leaked an orphan zip on every
    // misconfigured upload.
    const apiBase = process.env.API_BASE_URL;
    if (!apiBase) {
      this.logger.error(
        "API_BASE_URL is not configured — cannot build a package download URL reachable by executors. Set API_BASE_URL to the externally reachable base URL of this API and retry.",
      );
      throw new InternalServerErrorException(
        "API_BASE_URL is not configured; cannot build a package download URL",
      );
    }

    // Save uploaded zip to persistent uploads directory (served as static files)
    // R9b: async write (fs.promises.writeFile) — no 200 MB synchronous disk
    // stall on the event loop; and any failure AFTER the write unlinks the
    // freshly written file so a failed upsert cannot leave orphan zips.
    const uploadsDir = path.join(process.cwd(), "uploads", "packages");
    if (!fs.existsSync(uploadsDir))
      fs.mkdirSync(uploadsDir, { recursive: true });
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
    const filename = `${safeName}_${Date.now()}.zip`;
    const zipPath = path.join(uploadsDir, filename);
    await fs.promises.writeFile(zipPath, file.buffer);
    const packageUrl = `${apiBase}/uploads/packages/${filename}`;

    // Upsert the application record: create if not exists, update packageUrl if exists.
    // This makes upload idempotent and supports iterative releases.
    let app;
    try {
      const existing = await this.svc.findByName(name);
      if (existing) {
        app = await this.svc.update(existing.id, {
          packageUrl,
          ...(runtime ? { runtime } : {}),
        });
      } else {
        app = await this.svc.create({
          name,
          packageUrl,
          runtime: runtime || "python",
          version: "1.0.0",
        });
      }
    } catch (err: unknown) {
      // R9b: DB upsert failed after the file landed — best-effort unlink so
      // the failed upload does not leave an orphan file behind.
      try {
        await fs.promises.unlink(zipPath);
      } catch {
        // best-effort
      }
      throw err;
    }
    return app;
  }

  @Public()
  @Post("webhook")
  @ApiOperation({
    summary: "Version release webhook",
    description:
      "Receive version release notification and update app version. If triggerDeploy=true, trigger rolling upgrade on all RUNNING deployments. This route is public for CI/CD callers, and matching applications must have webhookSecret configured. Callers must include X-AutoCodeFlow-Timestamp and X-Hub-Signature-256 headers. The signature is HMAC-SHA256 over `${timestamp}.${rawBody}`.",
  })
  async webhook(
    @Body() dto: AppReleaseWebhookDto,
    @Headers("x-hub-signature-256") signature?: string,
    @Headers("x-autocodeflow-timestamp") timestamp?: string,
    @Req() req?: Request & { rawBody?: Buffer },
  ) {
    const logger = new Logger("ReleaseWebhook");

    // Find application by name (include webhookSecret for HMAC validation)
    // APP-001: 无论后续哪一步失败，对外只暴露同一个 401 消息，
    // 使"应用不存在"与"secret/签名错误"不可区分，防止应用名枚举。
    const targetApp = await this.svc.findByNameWithSecret(dto.appName);
    if (!targetApp) {
      logger.warn(`Webhook: no application found with name "${dto.appName}"`);
      throw new UnauthorizedException(
        ApplicationController.WEBHOOK_AUTH_FAILURE_MESSAGE,
      );
    }

    // HMAC-SHA256 signature verification (same convention as GitHub webhooks)
    // This route is public for CI/CD systems, so every matching application must
    // have a webhookSecret and callers must sign the raw body with a timestamp.
    if (!targetApp.webhookSecret) {
      logger.warn(
        `Webhook: app "${dto.appName}" has no webhookSecret configured`,
      );
      throw new UnauthorizedException(
        ApplicationController.WEBHOOK_AUTH_FAILURE_MESSAGE,
      );
    }
    if (!signature) {
      logger.warn(
        `Webhook: missing X-Hub-Signature-256 header for app "${dto.appName}"`,
      );
      throw new UnauthorizedException(
        ApplicationController.WEBHOOK_AUTH_FAILURE_MESSAGE,
      );
    }
    if (!timestamp) {
      logger.warn(
        `Webhook: missing X-AutoCodeFlow-Timestamp header for app "${dto.appName}"`,
      );
      throw new UnauthorizedException(
        ApplicationController.WEBHOOK_AUTH_FAILURE_MESSAGE,
      );
    }
    const timestampMs = Number(timestamp);
    const now = Date.now();
    if (
      !Number.isFinite(timestampMs) ||
      Math.abs(now - timestampMs) > 5 * 60 * 1000
    ) {
      logger.warn(`Webhook: stale timestamp for app "${dto.appName}"`);
      throw new UnauthorizedException(
        ApplicationController.WEBHOOK_AUTH_FAILURE_MESSAGE,
      );
    }
    const body = req?.rawBody;
    if (!body) {
      logger.warn(
        `Webhook: raw request body is unavailable for app "${dto.appName}"`,
      );
      throw new UnauthorizedException(
        ApplicationController.WEBHOOK_AUTH_FAILURE_MESSAGE,
      );
    }
    const expected =
      "sha256=" +
      createHmac("sha256", targetApp.webhookSecret)
        .update(Buffer.concat([Buffer.from(`${timestamp}.`), body]))
        .digest("hex");
    const expectedBuf = Buffer.from(expected);
    const receivedBuf = Buffer.from(signature);
    // Constant-time comparison to prevent timing attacks
    const valid =
      expectedBuf.length === receivedBuf.length &&
      timingSafeEqual(expectedBuf, receivedBuf);
    if (!valid) {
      logger.warn(`Webhook: invalid signature for app "${dto.appName}"`);
      throw new UnauthorizedException(
        ApplicationController.WEBHOOK_AUTH_FAILURE_MESSAGE,
      );
    }

    // Update version / git metadata
    const updatedApp = await this.svc.update(targetApp.id, {
      version: dto.version,
      ...(dto.gitCommit ? { gitCommit: dto.gitCommit } : {}),
      ...(dto.gitBranch ? { gitBranch: dto.gitBranch } : {}),
    });
    logger.log(
      `Release webhook: ${dto.appName} → v${dto.version} (commit=${dto.gitCommit?.slice(0, 8) ?? "n/a"})`,
    );

    // Optionally trigger rolling upgrade on all RUNNING deployments
    let triggeredDeployments = 0;
    if (dto.triggerDeploy) {
      const running = await this.deploymentSvc.findRunningByApp(targetApp.id);
      await Promise.allSettled(
        running.map((d) =>
          this.deploymentSvc
            .upgrade(d.id)
            .catch((err) =>
              logger.error(
                `Upgrade failed for deployment ${d.id}: ${err.message}`,
              ),
            ),
        ),
      );
      triggeredDeployments = running.length;
      logger.log(
        `Triggered upgrade on ${triggeredDeployments} running deployment(s) for "${dto.appName}"`,
      );
    }

    return { ok: true, updatedApp, triggeredDeployments };
  }

  @Get(":id/versions")
  @ApiOperation({
    summary: "Get application version history",
    description:
      "Return persisted application version snapshots, falling back to deployment records for legacy data.",
  })
  async getVersionHistory(@Param("id") id: string) {
    await this.svc.findById(id);
    return this.deploymentSvc.getVersionHistory(id);
  }

  @Post(":id/upgrade-all")
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: "Trigger all running instances to upgrade to latest version",
  })
  async upgradeAll(@Param("id") id: string) {
    await this.svc.findById(id);
    const deployments = await this.deploymentSvc.findRunningByApp(id);
    const results = await Promise.allSettled(
      deployments.map((d) => this.deploymentSvc.upgrade(d.id)),
    );
    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    return {
      ok: true,
      total: deployments.length,
      succeeded,
      failed: deployments.length - succeeded,
    };
  }

  @Post(":id/sync-tasks")
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: "Sync task registration from manifest.json",
    description: "Parse app manifest.json and auto-register task definitions",
  })
  async syncTasks(@Param("id") id: string) {
    const count = await this.svc.syncTasksFromManifest(id);
    return { ok: true, registeredCount: count };
  }

  @Post(":id/analyze")
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: "AI application health analysis",
    description:
      "Aggregate execution stats across all tasks in this app and run AI health assessment",
  })
  async analyzeHealth(@Param("id") id: string) {
    return this.svc.analyzeHealth(id);
  }

  @Post(":id/rollback/:deploymentId")
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: "Rollback application to historical version",
    description:
      "Restore app fields from a version snapshot or legacy deployment record, then trigger running instances to upgrade",
  })
  async rollback(
    @Param("id") appId: string,
    @Param("deploymentId") deploymentId: string,
  ) {
    return this.deploymentSvc.rollbackApplication(appId, deploymentId);
  }
}
