import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import axios from "axios";
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
  ) {}

  async findAll(applicationId?: string): Promise<AppDeployment[]> {
    const where: any = {};
    if (applicationId) where.applicationId = applicationId;
    return this.repo.find({ where, order: { createdAt: "DESC" }, relations: ["application"] });
  }

  async findById(id: string): Promise<AppDeployment> {
    const d = await this.repo.findOne({ where: { id }, relations: ["application"] });
    if (!d) throw new NotFoundException(`Deployment ${id} not found`);
    return d;
  }

  /**
   * Create a new deployment: record it in DB then push deploy command to executor.
   */
  async deploy(applicationId: string, dto: CreateDeploymentDto): Promise<AppDeployment> {
    const app = await this.appService.findById(applicationId);
    const executor = await this.executorService.findOne(dto.executorId);

    if (!app.gitRepo) {
      throw new BadRequestException("Application has no gitRepo configured");
    }

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
      await axios.post(url, { deploymentId: deployment.id }, { timeout: 10_000 });
    } catch (err: any) {
      this.logger.warn(`Stop signal failed (executor may be offline): ${err.message}`);
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

    if (dto.status === "running") {
      deployment.status = DeploymentStatus.RUNNING;
    } else if (dto.status === "stopped") {
      deployment.status = DeploymentStatus.STOPPED;
    } else if (dto.status === "failed") {
      deployment.status = DeploymentStatus.FAILED;
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
    app: any,
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
        gitRepo: app.gitRepo,
        gitBranch: app.gitBranch || "main",
        gitCommit: app.gitCommit || null,
        runtime: app.runtime,
        entrypoint: deployment.startCommand || app.entrypoint,
        runMode: deployment.runMode,
        env: { ...(app.env ?? {}), ...(deployment.env ?? {}) },
        upgrade,
      };

      await axios.post(url, payload, { timeout: 30_000 });

      deployment.status = DeploymentStatus.DEPLOYING;
      deployment.statusMessage = "Deploy command sent to executor";
      deployment.deployedCommit = app.gitCommit || null;
      deployment.deployedVersion = app.version || null;
      deployment.deployedAt = new Date();
    } catch (err: any) {
      deployment.status = DeploymentStatus.FAILED;
      deployment.statusMessage = `Failed to reach executor: ${err.message}`;
      this.logger.error(`Deploy push failed for ${deployment.id}: ${err.message}`);
    }

    await this.repo.save(deployment);
  }
}
