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
import { ApplicationService } from "./application.service";
import { ExecutorService } from "../executor/executor.service";
import { CreateDeploymentDto, DeploymentHeartbeatDto } from "./dto/app-deployment.dto";

@Injectable()
export class AppDeploymentService {
  private readonly logger = new Logger(AppDeploymentService.name);

  constructor(
    @InjectRepository(AppDeployment)
    private readonly repo: Repository<AppDeployment>,
    private readonly appService: ApplicationService,
    private readonly executorService: ExecutorService,
    private readonly configService: ConfigService,
  ) {}

  /** Build auth headers for executor requests */
  private getExecutorHeaders(): Record<string, string> {
    const token = this.configService.get<string>("executor.sharedToken") ?? "";
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  async findAll(applicationId?: string, page = 1, limit = 20): Promise<{ data: AppDeployment[]; total: number }> {
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
    const d = await this.repo.findOne({ where: { id }, relations: ["application"] });
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

  /**
   * Create a new deployment: record it in DB then push deploy command to executor.
   */
  async deploy(applicationId: string, dto: CreateDeploymentDto): Promise<AppDeployment> {
    const app = await this.appService.findById(applicationId);

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
      await axios.post(url, { deploymentId: deployment.id }, { timeout: 10_000, headers: this.getExecutorHeaders() });
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
    const deployment = await this.repo.findOne({ where: { id: dto.deploymentId } });
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
      this.logger.warn(`Heartbeat received unknown status "${dto.status}" for ${dto.deploymentId}`);
    }

    if (dto.pid !== undefined) deployment.pid = dto.pid;
    if (dto.message) deployment.statusMessage = dto.message;
    deployment.lastHeartbeat = new Date();

    await this.repo.save(deployment);
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private async pushDeployToExecutor(
    deployment: AppDeployment,
    app: import("./entities/application.entity").Application,
    upgrade = false,
  ): Promise<void> {
    deployment.status = DeploymentStatus.DEPLOYING;
    deployment.statusMessage = upgrade ? "Pulling latest commit..." : "Cloning repository...";
    await this.repo.save(deployment);

    try {
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
        runtime: app.runtime,
        entrypoint: deployment.startCommand || app.entrypoint,
        runMode: deployment.runMode,
        env: { ...(app.env ?? {}), ...(deployment.env ?? {}) },
        upgrade,
      };

      await axios.post(url, payload, { timeout: 30_000, headers: this.getExecutorHeaders() });

      deployment.status = DeploymentStatus.DEPLOYING;
      deployment.statusMessage = "Deploy command sent to executor";
      deployment.deployedCommit = app.gitCommit || null;
      deployment.deployedVersion = app.version || null;
      deployment.deployedAt = new Date();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      deployment.status = DeploymentStatus.FAILED;
      deployment.statusMessage = `Failed to reach executor: ${msg}`;
      this.logger.error(`Deploy push failed for ${deployment.id}: ${msg}`);
    }

    await this.repo.save(deployment);
  }

  /** Scan every 2 minutes for deployments stuck in 'deploying' > 10 minutes and mark them failed */
  @Cron("0 */2 * * * *")
  async detectStuckDeployments(): Promise<void> {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const stuck = await this.repo.find({
      where: { status: DeploymentStatus.DEPLOYING, createdAt: LessThan(tenMinutesAgo) },
    });
    if (stuck.length === 0) return;
    for (const d of stuck) {
      d.status = DeploymentStatus.FAILED;
      d.statusMessage = "[System] Deployment timed out after 10 minutes";
      await this.repo.save(d);
      this.logger.warn(`Stuck deployment marked FAILED: id=${d.id}, app=${d.applicationId}`);
    }
  }
}
