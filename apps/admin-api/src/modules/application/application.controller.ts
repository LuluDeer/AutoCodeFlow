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
  Query,
  BadRequestException,
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
import { ApplicationService } from "./application.service";
import { AppDeploymentService } from "./app-deployment.service";
import {
  CreateApplicationDto,
  UpdateApplicationDto,
} from "./dto/application.dto";
import { AppReleaseWebhookDto } from "./dto/app-release-webhook.dto";
import * as fs from "fs";
import * as path from "path";

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
    const uploadsDir = path.join(process.cwd(), 'uploads', 'packages');
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename = `${safeName}_${Date.now()}.zip`;
    const zipPath = path.join(uploadsDir, filename);
    fs.writeFileSync(zipPath, file.buffer);

    // Build a URL that the executor can use to download the package
    const apiBase = process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 3105}`;
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
        runtime: runtime || 'python',
        version: '1.0.0',
      });
    }
    return app;
  }

  @Post("webhook")
  @ApiOperation({
    summary: "Version release webhook",
    description:
      "Receive version release notification and update app version. If triggerDeploy=true, trigger rolling upgrade on all RUNNING deployments.",
  })
  async webhook(@Body() dto: AppReleaseWebhookDto) {
    const logger = new Logger("ReleaseWebhook");

    // Find application by name
    const targetApp = await this.svc.findByName(dto.appName);
    if (!targetApp) {
      logger.warn(`Webhook: no application found with name "${dto.appName}"`);
      return { ok: true, message: "No matching application" };
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
          this.deploymentSvc.upgrade(d.id).catch((err) =>
            logger.error(`Upgrade failed for deployment ${d.id}: ${err.message}`),
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
    description: "Return all historical deployment records for the app including version, commit, and deployment time",
  })
  async getVersionHistory(@Param("id") id: string) {
    // Verify app exists (throws 404 if not)
    await this.svc.findById(id);
    const deployments = await this.deploymentSvc.findAllByApp(id);
    // Map to a concise version history shape
    return deployments.map((d) => ({
      deploymentId: d.id,
      version: d.deployedVersion,
      commit: d.deployedCommit,
      status: d.status,
      deployedAt: d.deployedAt,
      executorAddress: d.executorAddress,
    }));
  }

  @Post(":id/upgrade-all")
  @ApiOperation({ summary: "Trigger all running instances to upgrade to latest version" })
  async upgradeAll(@Param("id") id: string) {
    await this.svc.findById(id);
    const deployments = await this.deploymentSvc.findRunningByApp(id);
    const results = await Promise.allSettled(
      deployments.map((d) => this.deploymentSvc.upgrade(d.id)),
    );
    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    return { ok: true, total: deployments.length, succeeded, failed: deployments.length - succeeded };
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

  @Post(":id/rollback/:deploymentId")
  @ApiOperation({
    summary: "Rollback application to historical deployment version",
    description: "Restore app version to a specific historical deployment and trigger all running instances to upgrade",
  })
  async rollback(
    @Param("id") appId: string,
    @Param("deploymentId") deploymentId: string,
  ) {
    await this.svc.findById(appId);
    const deployments = await this.deploymentSvc.findAllByApp(appId);
    const target = deployments.find((d) => d.id === deploymentId);
    if (!target) {
      throw new BadRequestException("The specified deployment does not belong to this application");
    }
    // Restore app version to target version
    const updatedApp = await this.svc.update(appId, {
      version: target.deployedVersion ?? undefined,
      gitCommit: target.deployedCommit ?? undefined,
    } as any);
    // Trigger all running instances to upgrade
    const running = await this.deploymentSvc.findRunningByApp(appId);
    const results = await Promise.allSettled(
      running.map((d) => this.deploymentSvc.upgrade(d.id)),
    );
    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    return {
      ok: true,
      rolledBackTo: target.deployedVersion,
      total: running.length,
      succeeded,
      failed: running.length - succeeded,
      updatedApp,
    };
  }
}
