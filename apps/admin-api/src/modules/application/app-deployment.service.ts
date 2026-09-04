import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, LessThan } from "typeorm";
import axios from "axios";
import { ConfigService } from "@nestjs/config";
import { Cron } from "@nestjs/schedule";
import {
  AppDeployment,
  DeploymentStatus,
  RunMode,
} from "./entities/app-deployment.entity";
import { ApplicationVersion } from "./entities/application-version.entity";
import { Application } from "./entities/application.entity";
import { ApplicationService } from "./application.service";
import { ExecutorService } from "../executor/executor.service";
import {
  CreateDeploymentDto,
  DeploymentHeartbeatDto,
} from "./dto/app-deployment.dto";

@Injectable()
export class AppDeploymentService {
  private readonly logger = new Logger(AppDeploymentService.name);

  constructor(
    @InjectRepository(AppDeployment)
    private readonly repo: Repository<AppDeployment>,
    @InjectRepository(ApplicationVersion)
    private readonly versionRepo: Repository<ApplicationVersion>,
    private readonly appService: ApplicationService,
    private readonly executorService: ExecutorService,
    private readonly configService: ConfigService,
  ) {}

  /** Build auth headers for executor requests */
  private getExecutorHeaders(): Record<string, string> {
    const token = this.configService.get<string>("executor.sharedToken") ?? "";
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  async findAll(
    applicationId?: string,
    page = 1,
    limit = 20,
  ): Promise<{ data: AppDeployment[]; total: number }> {
    const where: import("typeorm").FindOptionsWhere<AppDeployment> = {};
    if (applicationId) where.applicationId = applicationId;
    const [data, total] = await this.repo.findAndCount({
      where,
      order: { createdAt: "DESC" },
      relations: ["application"],
      skip: (page - 1) * limit,
      take: limit,
    });
    return { data, total };
  }

  /** Internal: get all deployment records for an app without pagination */
  async findAllByApp(applicationId: string): Promise<AppDeployment[]> {
    return this.repo.find({
      where: { applicationId },
      order: { createdAt: "DESC" },
      relations: ["application"],
    });
  }

  async findById(id: string): Promise<AppDeployment> {
    const d = await this.repo.findOne({
      where: { id },
      relations: ["application"],
    });
    if (!d) throw new NotFoundException(`Deployment ${id} not found`);
    return d;
  }

  /**
   * Find all RUNNING deployments for a given application.
   * Used by webhook to trigger rolling upgrades.
   */
  async findRunningByApp(applicationId: string): Promise<AppDeployment[]> {
    return this.repo.find({
      where: { applicationId, status: DeploymentStatus.RUNNING },
      order: { createdAt: "DESC" },
    });
  }

  async getVersionHistory(applicationId: string) {
    const versions = await this.versionRepo.find({
      where: { applicationId },
      order: { createdAt: "DESC" },
    });
    const legacyVersions =
      await this.getDeploymentVersionFallback(applicationId);

    if (versions.length === 0) {
      return legacyVersions;
    }

    const deployCount = await this.buildDeployCountMap(applicationId);
    const snapshotKeys = new Set(versions.map((v) => v.version));
    const snapshotHistory = versions.map((v) => ({
      id: v.id,
      deploymentId: v.sourceDeploymentId,
      sourceDeploymentId: v.sourceDeploymentId,
      version: v.version,
      commit: v.gitCommit,
      status: v.status,
      deployedAt: v.createdAt,
      createdAt: v.createdAt,
      executorAddress: null,
      deployCount: deployCount.get(v.version) ?? 1,
      snapshot: v.snapshot,
    }));

    return [
      ...snapshotHistory,
      ...legacyVersions.filter((v) => !snapshotKeys.has(v.version)),
    ].sort((a, b) => {
      const at = a.createdAt ?? a.deployedAt;
      const bt = b.createdAt ?? b.deployedAt;
      return (
        (bt ? new Date(bt).getTime() : 0) - (at ? new Date(at).getTime() : 0)
      );
    });
  }

  async rollbackApplication(appId: string, targetId: string) {
    const app = await this.appService.findById(appId);
    const version = await this.versionRepo.findOne({ where: { id: targetId } });
    if (version) {
      if (version.applicationId !== appId) {
        throw new BadRequestException(
          "The specified version does not belong to this application",
        );
      }
      if (!version.version) {
        throw new BadRequestException(
          "The specified version has no version number",
        );
      }
      if (version.status !== "released") {
        throw new BadRequestException(
          "Only released application versions can be rolled back",
        );
      }

      const snapshot = version.snapshot ?? {};
      const updateDto: Record<string, any> = {
        version: version.version,
        runtime: app.runtime,
      };
      if (typeof version.gitCommit === "string")
        updateDto.gitCommit = version.gitCommit;
      if (typeof snapshot.gitBranch === "string")
        updateDto.gitBranch = snapshot.gitBranch;
      if (typeof snapshot.packageUrl === "string")
        updateDto.packageUrl = snapshot.packageUrl;
      if (typeof snapshot.runtime === "string")
        updateDto.runtime = snapshot.runtime;
      if (snapshot.env && typeof snapshot.env === "object")
        updateDto.env = snapshot.env as Record<string, string>;
      if (typeof snapshot.entrypoint === "string")
        updateDto.entrypoint = snapshot.entrypoint;
      if (snapshot.manifest && typeof snapshot.manifest === "object")
        updateDto.manifest = snapshot.manifest as Record<string, any>;

      const updatedApp = await this.appService.update(appId, updateDto);
      const result = await this.upgradeRunningDeployments(appId);
      return {
        ...result,
        rolledBackTo: version.version,
        versionId: version.id,
        updatedApp,
      };
    }

    const deployments = await this.findAllByApp(appId);
    const target = deployments.find((d) => d.id === targetId);
    if (!target) {
      throw new BadRequestException(
        "The specified deployment does not belong to this application",
      );
    }
    if (!target.deployedVersion) {
      throw new BadRequestException(
        "The specified deployment has no deployed version",
      );
    }

    const updateDto: Record<string, any> = { version: target.deployedVersion };
    if (typeof target.deployedCommit === "string")
      updateDto.gitCommit = target.deployedCommit;

    const updatedApp = await this.appService.update(appId, updateDto);
    const result = await this.upgradeRunningDeployments(appId);
    return {
      ...result,
      rolledBackTo: target.deployedVersion,
      versionId: null,
      updatedApp,
    };
  }

  /**
   * Create a new deployment: record it in DB then push deploy command to executor.
   * Guards against duplicate in-flight deployments for the same application.
   */
  async deploy(
    applicationId: string,
    dto: CreateDeploymentDto,
  ): Promise<AppDeployment> {
    const app = await this.appService.findById(applicationId);

    // Duplicate-deployment guard: reject if a PENDING or DEPLOYING record already exists
    // for this application (regardless of executor). This prevents double-clicking the
    // deploy button or concurrent webhook retries from spawning two real processes.
    const inFlight = await this.repo.findOne({
      where: [
        { applicationId, status: DeploymentStatus.PENDING },
        { applicationId, status: DeploymentStatus.DEPLOYING },
      ],
    });
    if (inFlight) {
      throw new BadRequestException(
        `Application ${app.name} already has an in-progress deployment (id=${inFlight.id}, status=${inFlight.status}). ` +
          `Wait for it to finish or cancel it first.`,
      );
    }

    // Auto-select the least-loaded executor when none is specified
    const executor = dto.executorId
      ? await this.executorService.findOne(dto.executorId)
      : await this.executorService.selectLeastLoaded();

    const deployment = this.repo.create({
      applicationId,
      executorId: executor.id,
      executorAddress: executor.address,
      runMode: dto.runMode ?? RunMode.DAEMON,
      env: dto.env ?? app.env,
      startCommand: dto.startCommand ?? app.entrypoint ?? null,
      status: DeploymentStatus.PENDING,
    });
    const saved = await this.repo.save(deployment);

    // Asynchronously push deploy command to executor
    this.pushDeployToExecutor(saved, app).catch((err) => {
      this.logger.error(`Failed to push deploy to executor: ${err.message}`);
    });

    return saved;
  }

  /**
   * Trigger upgrade on an existing deployment (git pull + restart).
   */
  async upgrade(deploymentId: string): Promise<AppDeployment> {
    const deployment = await this.findById(deploymentId);
    const app = await this.appService.findById(deployment.applicationId);

    deployment.status = DeploymentStatus.UPGRADING;
    deployment.statusMessage = "Upgrade triggered";
    await this.repo.save(deployment);

    this.pushDeployToExecutor(deployment, app, true).catch((err) => {
      this.logger.error(`Upgrade push failed: ${err.message}`);
    });

    return deployment;
  }

  /**
   * Stop a running deployment.
   */
  async stop(deploymentId: string): Promise<AppDeployment> {
    const deployment = await this.findById(deploymentId);

    try {
      const url = this.executorService.getExecutorUrl(
        deployment.executorAddress,
        `api/app-stop`,
      );
      await axios.post(
        url,
        { deploymentId: deployment.id },
        { timeout: 10_000, headers: this.getExecutorHeaders() },
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Stop signal failed (executor may be offline): ${msg}`);
    }

    deployment.status = DeploymentStatus.STOPPED;
    deployment.pid = null;
    return this.repo.save(deployment);
  }

  /**
   * Handle heartbeat from executor reporting app process status.
   */
  async handleHeartbeat(dto: DeploymentHeartbeatDto): Promise<void> {
    const deployment = await this.repo.findOne({
      where: { id: dto.deploymentId },
    });
    if (!deployment) {
      this.logger.warn(`Heartbeat for unknown deployment ${dto.deploymentId}`);
      return;
    }

    const statusMap: Record<string, DeploymentStatus> = {
      running: DeploymentStatus.RUNNING,
      stopped: DeploymentStatus.STOPPED,
      failed: DeploymentStatus.FAILED,
    };
    if (dto.status && statusMap[dto.status]) {
      deployment.status = statusMap[dto.status];
    } else if (dto.status) {
      this.logger.warn(
        `Heartbeat received unknown status "${dto.status}" for ${dto.deploymentId}`,
      );
    }

    if (dto.pid !== undefined) deployment.pid = dto.pid;
    if (dto.message) deployment.statusMessage = dto.message;
    deployment.lastHeartbeat = new Date();

    await this.repo.save(deployment);

    if (deployment.status === DeploymentStatus.RUNNING) {
      await this.markVersionSnapshotStatus(deployment, "released");
    } else if (deployment.status === DeploymentStatus.FAILED) {
      await this.markVersionSnapshotStatus(deployment, "failed");
    }
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * Validate that an executor address looks like "host:port" to prevent SSRF.
   * Allows IPv4, IPv6 brackets, and hostnames.
   */
  private validateExecutorAddress(address: string): void {
    // Must match host:port where port is numeric 1-65535
    const re = /^(\[?[a-zA-Z0-9._:-]+\]?):([0-9]{1,5})$/;
    const m = address.match(re);
    if (!m) {
      throw new BadRequestException(
        `Invalid executor address format: "${address}"`,
      );
    }
    const port = parseInt(m[2], 10);
    if (port < 1 || port > 65535) {
      throw new BadRequestException(
        `Executor address port out of range: ${port}`,
      );
    }
  }

  private async pushDeployToExecutor(
    deployment: AppDeployment,
    app: Application,
    upgrade = false,
  ): Promise<void> {
    deployment.status = DeploymentStatus.DEPLOYING;
    deployment.statusMessage = upgrade
      ? "Pulling latest commit..."
      : "Cloning repository...";
    await this.repo.save(deployment);

    // SSRF guard: validate address format before making any outbound request
    try {
      this.validateExecutorAddress(deployment.executorAddress);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      deployment.status = DeploymentStatus.FAILED;
      deployment.statusMessage = msg;
      await this.repo.save(deployment);
      return;
    }

    const url = this.executorService.getExecutorUrl(
      deployment.executorAddress,
      "api/deploy",
    );

    const payload = {
      deploymentId: deployment.id,
      applicationId: app.id,
      appName: app.name,
      gitRepo: app.gitRepo || null,
      gitBranch: app.gitBranch || "main",
      gitCommit: app.gitCommit || null,
      packageUrl: (app as any).packageUrl || null,
      version: app.version || null,
      runtime: app.runtime,
      entrypoint: deployment.startCommand || app.entrypoint,
      runMode: deployment.runMode,
      env: { ...(app.env ?? {}), ...(deployment.env ?? {}) },
      upgrade,
    };

    // Retry up to 3 times with exponential back-off (1s, 2s, 4s)
    const MAX_ATTEMPTS = 3;
    let lastError: string | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await axios.post(url, payload, {
          timeout: 30_000,
          headers: this.getExecutorHeaders(),
        });
        // Success
        deployment.status = DeploymentStatus.DEPLOYING;
        deployment.statusMessage = "Deploy command sent to executor";
        deployment.deployedCommit = app.gitCommit || null;
        deployment.deployedVersion = app.version || null;
        deployment.deployedAt = new Date();
        await this.repo.save(deployment);
        await this.saveVersionSnapshot(deployment, app, "deploying");
        return;
      } catch (err: unknown) {
        lastError = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Deploy push attempt ${attempt}/${MAX_ATTEMPTS} failed for ${deployment.id}: ${lastError}`,
        );
        if (attempt < MAX_ATTEMPTS) {
          // Exponential back-off: 1000ms, 2000ms
          await new Promise((r) =>
            setTimeout(r, 1000 * Math.pow(2, attempt - 1)),
          );
        }
      }
    }

    // All attempts exhausted
    deployment.status = DeploymentStatus.FAILED;
    deployment.statusMessage = `Failed to reach executor after ${MAX_ATTEMPTS} attempts: ${lastError}`;
    this.logger.error(
      `Deploy push failed for ${deployment.id} after ${MAX_ATTEMPTS} attempts: ${lastError}`,
    );
    await this.repo.save(deployment);
  }

  private buildSnapshot(app: Application): Record<string, any> {
    return {
      id: app.id,
      name: app.name,
      description: app.description,
      version: app.version,
      runtime: app.runtime,
      status: app.status,
      gitRepo: app.gitRepo,
      gitBranch: app.gitBranch,
      gitCommit: app.gitCommit,
      packageUrl: app.packageUrl,
      manifest: app.manifest,
      env: app.env,
      entrypoint: app.entrypoint,
    };
  }

  private async saveVersionSnapshot(
    deployment: AppDeployment,
    app: Application,
    status: string,
  ): Promise<void> {
    if (!app.version) return;
    const existing = await this.versionRepo.findOne({
      where: {
        applicationId: app.id,
        version: app.version,
        gitCommit: app.gitCommit ?? null,
        sourceDeploymentId: deployment.id,
      },
    });
    if (existing) return;

    await this.versionRepo.save(
      this.versionRepo.create({
        applicationId: app.id,
        version: app.version,
        gitCommit: app.gitCommit ?? null,
        sourceDeploymentId: deployment.id,
        status,
        snapshot: this.buildSnapshot(app),
        description: `Deployment ${deployment.id}`,
      }),
    );
  }

  private async markVersionSnapshotStatus(
    deployment: AppDeployment,
    status: string,
  ): Promise<void> {
    if (!deployment.deployedVersion) return;
    const version = await this.versionRepo.findOne({
      where: {
        applicationId: deployment.applicationId,
        version: deployment.deployedVersion,
        gitCommit: deployment.deployedCommit ?? null,
        sourceDeploymentId: deployment.id,
      },
    });
    if (!version || version.status === status) return;

    version.status = status;
    await this.versionRepo.save(version);
  }

  private async buildDeployCountMap(
    applicationId: string,
  ): Promise<Map<string, number>> {
    const deployments = await this.findAllByApp(applicationId);
    const countMap = new Map<string, number>();
    for (const d of deployments) {
      if (!d.deployedVersion) continue;
      countMap.set(
        d.deployedVersion,
        (countMap.get(d.deployedVersion) ?? 0) + 1,
      );
    }
    return countMap;
  }

  private async getDeploymentVersionFallback(applicationId: string) {
    const deployments = await this.findAllByApp(applicationId);
    const seen = new Set<string>();
    const countMap = new Map<string, number>();
    for (const d of deployments) {
      const key = d.deployedVersion ?? "__unknown__";
      countMap.set(key, (countMap.get(key) ?? 0) + 1);
    }

    const versionHistory: Array<{
      id: string | null;
      deploymentId: string;
      sourceDeploymentId: string;
      version: string | null;
      commit: string | null;
      status: string;
      deployedAt: Date | null;
      createdAt: Date | null;
      executorAddress: string;
      deployCount: number;
      snapshot: Record<string, any> | null;
    }> = [];

    for (const d of deployments) {
      const key = d.deployedVersion ?? "__unknown__";
      if (!seen.has(key)) {
        seen.add(key);
        versionHistory.push({
          id: null,
          deploymentId: d.id,
          sourceDeploymentId: d.id,
          version: d.deployedVersion,
          commit: d.deployedCommit,
          status: d.status,
          deployedAt: d.deployedAt,
          createdAt: d.deployedAt,
          executorAddress: d.executorAddress,
          deployCount: countMap.get(key) ?? 1,
          snapshot: null,
        });
      }
    }
    return versionHistory;
  }

  private async upgradeRunningDeployments(appId: string) {
    const running = await this.findRunningByApp(appId);
    const results = await Promise.allSettled(
      running.map((d) => this.upgrade(d.id)),
    );
    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    return {
      ok: true,
      total: running.length,
      succeeded,
      failed: running.length - succeeded,
    };
  }

  /** Scan every 2 minutes for deployments stuck in 'deploying' > 10 minutes and mark them failed */
  @Cron("0 */2 * * * *")
  async detectStuckDeployments(): Promise<void> {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const stuck = await this.repo.find({
      where: {
        status: DeploymentStatus.DEPLOYING,
        createdAt: LessThan(tenMinutesAgo),
      },
    });
    if (stuck.length === 0) return;
    for (const d of stuck) {
      d.status = DeploymentStatus.FAILED;
      d.statusMessage = "[System] Deployment timed out after 10 minutes";
      await this.repo.save(d);
      await this.markVersionSnapshotStatus(d, "failed");
      this.logger.warn(
        `Stuck deployment marked FAILED: id=${d.id}, app=${d.applicationId}`,
      );
    }
  }
}
