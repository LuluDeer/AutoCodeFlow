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
import { ApplicationService } from "./application.service";
import { AppDeploymentService } from "./app-deployment.service";
import {
  CreateApplicationDto,
  UpdateApplicationDto,
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

  @Post()
  @ApiOperation({ summary: "Create application" })
  create(@Body() dto: CreateApplicationDto) {
    return this.svc.create(dto);
  }

  @Put(":id")
  @ApiOperation({ summary: "Update application" })
  update(@Param("id") id: string, @Body() dto: UpdateApplicationDto) {
    return this.svc.update(id, dto);
  }

  @Delete(":id")
  @ApiOperation({ summary: "Delete application" })
  remove(@Param("id") id: string) {
    return this.svc.remove(id);
  }

  @Post("upload")
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
  @UseInterceptors(FileInterceptor("file"))
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @Body("name") name: string,
    @Body("runtime") runtime: string,
  ) {
    if (!file) throw new BadRequestException("No file uploaded");
    if (!name) throw new BadRequestException("Application name is required");

    // Save uploaded zip to persistent uploads directory (served as static files)
    const uploadsDir = path.join(process.cwd(), "uploads", "packages");
    if (!fs.existsSync(uploadsDir))
      fs.mkdirSync(uploadsDir, { recursive: true });
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
    const filename = `${safeName}_${Date.now()}.zip`;
    const zipPath = path.join(uploadsDir, filename);
    fs.writeFileSync(zipPath, file.buffer);

    // Build a URL that the executor can use to download the package
    const apiBase =
      process.env.API_BASE_URL ||
      `http://localhost:${process.env.PORT || 3105}`;
    const packageUrl = `${apiBase}/uploads/packages/${filename}`;

    // Upsert the application record: create if not exists, update packageUrl if exists.
    // This makes upload idempotent and supports iterative releases.
    const existing = await this.svc.findByName(name);
    let app;
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
    const targetApp = await this.svc.findByNameWithSecret(dto.appName);
    if (!targetApp) {
      logger.warn(`Webhook: no application found with name "${dto.appName}"`);
      return { ok: true, message: "No matching application" };
    }

    // HMAC-SHA256 signature verification (same convention as GitHub webhooks)
    // This route is public for CI/CD systems, so every matching application must
    // have a webhookSecret and callers must sign the raw body with a timestamp.
    if (!targetApp.webhookSecret) {
      logger.warn(
        `Webhook: app "${dto.appName}" has no webhookSecret configured`,
      );
      throw new UnauthorizedException(
        "Application webhookSecret is required for release webhooks",
      );
    }
    if (!signature) {
      logger.warn(
        `Webhook: missing X-Hub-Signature-256 header for app "${dto.appName}"`,
      );
      throw new UnauthorizedException(
        "X-Hub-Signature-256 header is required",
      );
    }
    if (!timestamp) {
      logger.warn(
        `Webhook: missing X-AutoCodeFlow-Timestamp header for app "${dto.appName}"`,
      );
      throw new UnauthorizedException(
        "X-AutoCodeFlow-Timestamp header is required",
      );
    }
    const timestampMs = Number(timestamp);
    const now = Date.now();
    if (
      !Number.isFinite(timestampMs) ||
      Math.abs(now - timestampMs) > 5 * 60 * 1000
    ) {
      logger.warn(`Webhook: stale timestamp for app "${dto.appName}"`);
      throw new UnauthorizedException("Webhook timestamp is stale");
    }
    const body = req?.rawBody;
    if (!body) {
      logger.warn(`Webhook: raw request body is unavailable for app "${dto.appName}"`);
      throw new UnauthorizedException(
        "Raw request body is required for webhook signature verification",
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
      throw new UnauthorizedException("Invalid webhook signature");
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
  @ApiOperation({
    summary: "Sync task registration from manifest.json",
    description: "Parse app manifest.json and auto-register task definitions",
  })
  async syncTasks(@Param("id") id: string) {
    const count = await this.svc.syncTasksFromManifest(id);
    return { ok: true, registeredCount: count };
  }

  @Post(":id/analyze")
  @ApiOperation({
    summary: "AI application health analysis",
    description:
      "Aggregate execution stats across all tasks in this app and run AI health assessment",
  })
  async analyzeHealth(@Param("id") id: string) {
    return this.svc.analyzeHealth(id);
  }

  @Post(":id/rollback/:deploymentId")
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
