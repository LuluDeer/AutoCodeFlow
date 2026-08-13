import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  OnModuleInit,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { ModuleRef } from "@nestjs/core";
import { Repository } from "typeorm";
import { Application, ApplicationStatus } from "./entities/application.entity";
import {
  CreateApplicationDto,
  UpdateApplicationDto,
} from "./dto/application.dto";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { AiService } from "../ai/ai.service";

@Injectable()
export class ApplicationService implements OnModuleInit {
  private logger = new Logger(ApplicationService.name);

  constructor(
    @InjectRepository(Application)
    private readonly repo: Repository<Application>,
    private readonly moduleRef: ModuleRef,
    private readonly aiService: AiService,
  ) {}

  private _taskService: import("../task/task.service").TaskService | null =
    null;

  async onModuleInit() {
    // Lazy-resolve TaskService to avoid circular dependency with TaskModule
    try {
      const { TaskService } = await import("../task/task.service");
      this._taskService = this.moduleRef.get(TaskService, { strict: false });
    } catch (_e: unknown) {
      this.logger.warn(
        "TaskService not available — manifest auto-registration disabled",
      );
    }
  }

  async findAll(): Promise<Application[]> {
    return this.repo.find({ order: { createdAt: "DESC" } });
  }

  async findById(id: string): Promise<Application> {
    const app = await this.repo.findOne({ where: { id } });
    if (!app) throw new NotFoundException(`Application ${id} not found`);
    return app;
  }

  async findByName(name: string): Promise<Application | null> {
    return this.repo.findOne({ where: { name } });
  }

  /**
   * Like findByName but also loads the webhookSecret column (excluded by default via select:false).
   * Use only when HMAC signature validation is needed — never expose the secret in API responses.
   */
  async findByNameWithSecret(name: string): Promise<Application | null> {
    return this.repo
      .createQueryBuilder("app")
      .addSelect("app.webhookSecret")
      .where("app.name = :name", { name })
      .getOne();
  }

  async create(dto: CreateApplicationDto): Promise<Application> {
    const existing = await this.findByName(dto.name);
    if (existing) {
      throw new ConflictException(`Application "${dto.name}" already exists`);
    }

    const app = this.repo.create({
      ...dto,
      status: dto.gitRepo
        ? ApplicationStatus.DEPLOYING
        : ApplicationStatus.ACTIVE,
    });
    const saved = await this.repo.save(app);
    this.logger.log(`Application created: ${saved.name} (${saved.id})`);

    // If gitRepo is provided, trigger async deployment
    if (dto.gitRepo) {
      this.deployFromGit(
        saved.id,
        dto.gitRepo,
        dto.gitBranch || "main",
        dto.gitCommit,
      ).catch((err) => {
        this.logger.error(
          `Deployment failed for ${saved.name}: ${err.message}`,
        );
      });
    }

    return saved;
  }

  async update(id: string, dto: UpdateApplicationDto): Promise<Application> {
    const app = await this.findById(id);
    Object.assign(app, dto);
    return this.repo.save(app);
  }

  async remove(id: string): Promise<void> {
    const app = await this.findById(id);
    await this.repo.remove(app);
    this.logger.log(`Application removed: ${app.name}`);
  }

  /**
   * AI health analysis for an application.
   * Aggregates execution stats across all tasks belonging to this app,
   * then calls the AI service to produce a health assessment.
   */
  async analyzeHealth(appId: string): Promise<{
    appId: string;
    appName: string;
    analysis: string;
    stats: {
      totalTasks: number;
      avgSuccessRate: number;
      avgDuration: number;
      criticalTasks: string[];
    };
  }> {
    const app = await this.findById(appId);

    // Gather task-level stats via TaskService
    let tasks: Array<{ id: string; name: string }> = [];
    if (this._taskService) {
      const result = await this._taskService.findAll({
        applicationId: appId,
        page: 1,
        pageSize: 100,
      } as any);
      tasks = (result.list || result) as Array<{ id: string; name: string }>;
    }

    // Gather stats for each task concurrently
    const statsResults = await Promise.allSettled(
      tasks.map((t) =>
        this._taskService
          ? this._taskService.getExecutionStats(t.id)
          : Promise.resolve({ successRate: 100, avgDuration: 0, totalRuns: 0 }),
      ),
    );

    const statsArray = statsResults
      .map((r, i) =>
        r.status === "fulfilled"
          ? { ...r.value, taskId: tasks[i].id, taskName: tasks[i].name }
          : null,
      )
      .filter(Boolean) as Array<{
      taskId: string;
      taskName: string;
      successRate: number;
      avgDuration: number;
      totalRuns: number;
    }>;

    const avgSuccessRate =
      statsArray.length > 0
        ? Math.round(
            (statsArray.reduce((sum, s) => sum + s.successRate, 0) /
              statsArray.length) *
              10,
          ) / 10
        : 100;
    const avgDuration =
      statsArray.length > 0
        ? Math.round(
            statsArray.reduce((sum, s) => sum + s.avgDuration, 0) /
              statsArray.length,
          )
        : 0;
    const criticalTasks = statsArray
      .filter((s) => s.successRate < 50 && s.totalRuns > 3)
      .map((s) => s.taskName);

    const analysis = await this.aiService.analyzeAppHealth(app.name, {
      totalTasks: tasks.length,
      avgSuccessRate,
      avgDurationMs: avgDuration,
      criticalTasks,
      perTask: statsArray.map((s) => ({
        name: s.taskName,
        successRate: s.successRate,
        avgDuration: s.avgDuration,
        totalRuns: s.totalRuns,
      })),
    });

    return {
      appId: app.id,
      appName: app.name,
      analysis:
        analysis || "AI analysis not available (AI provider not configured).",
      stats: {
        totalTasks: tasks.length,
        avgSuccessRate,
        avgDuration,
        criticalTasks,
      },
    };
  }

  async deployFromGit(
    id: string,
    gitRepo: string,
    gitBranch: string,
    gitCommit?: string,
  ): Promise<void> {
    const app = await this.findById(id);
    app.status = ApplicationStatus.DEPLOYING;
    app.gitRepo = gitRepo;
    app.gitBranch = gitBranch;
    if (gitCommit) app.gitCommit = gitCommit;
    await this.repo.save(app);

    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "autocodeflow-deploy-"),
    );
    try {
      // SEC: validate branch name and repo URL to prevent command injection
      if (!/^[a-zA-Z0-9._/\-]+$/.test(gitBranch)) {
        throw new Error(`Invalid git branch name: ${gitBranch}`);
      }
      if (!/^(https?:\/\/|git@|ssh:\/\/)[\w.\-/:@]+(\.git)?$/.test(gitRepo)) {
        throw new Error(`Invalid git repository URL: ${gitRepo}`);
      }

      this.logger.log(`Cloning ${gitRepo}@${gitBranch} into ${tmpDir}`);
      // SEC: spawnSync with array args — no shell expansion, no injection risk
      const cloneResult = spawnSync(
        "git",
        ["clone", "--depth", "1", "--branch", gitBranch, gitRepo, tmpDir],
        { timeout: 120_000, stdio: "pipe" },
      );
      if (cloneResult.status !== 0) {
        const errMsg =
          cloneResult.stderr?.toString("utf-8") || "git clone failed";
        throw new Error(errMsg);
      }

      const revResult = spawnSync("git", ["-C", tmpDir, "rev-parse", "HEAD"], {
        encoding: "utf-8",
      });
      if (revResult.status !== 0) throw new Error("git rev-parse HEAD failed");
      app.gitCommit = (revResult.stdout as string).trim();

      // Parse manifest.json and auto-register tasks
      const manifestPath = path.join(tmpDir, "manifest.json");
      if (fs.existsSync(manifestPath)) {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
        app.manifest = manifest;
        app.runtime = manifest.runtime || app.runtime;
        app.entrypoint = manifest.entrypoint || app.entrypoint;

        if (
          manifest.tasks &&
          Array.isArray(manifest.tasks) &&
          this._taskService
        ) {
          this.logger.log(
            `Auto-registering ${manifest.tasks.length} tasks from manifest.json`,
          );
          for (const taskDef of manifest.tasks) {
            try {
              await this._taskService.create({
                name: taskDef.name || taskDef.id,
                id: taskDef.id,
                description: taskDef.description,
                cron: taskDef.cron,
                runtime: taskDef.runtime || manifest.runtime,
                entrypoint: taskDef.entrypoint || manifest.entrypoint,
                timeout: taskDef.timeout || manifest.timeout,
                requirements: taskDef.requirements,
                env: taskDef.env,
                applicationId: app.id,
                glueSource: taskDef.glueSource,
                glueLanguage: taskDef.glueLanguage,
              } as any);
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              if (msg.includes("already exists")) {
                this.logger.warn(
                  `Task "${taskDef.id || taskDef.name}" already exists, skipping`,
                );
              } else {
                this.logger.error(
                  `Failed to register task "${taskDef.name}": ${msg}`,
                );
              }
            }
          }
        }
      }

      app.status = ApplicationStatus.ACTIVE;
      await this.repo.save(app);
      this.logger.log(`Application ${app.name} deployed successfully`);
    } catch (err: unknown) {
      app.status = ApplicationStatus.FAILED;
      await this.repo.save(app);
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Deployment failed for ${app.name}: ${msg}`);
      throw err;
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true });
      } catch (cleanErr: unknown) {
        const msg =
          cleanErr instanceof Error ? cleanErr.message : String(cleanErr);
        this.logger.warn(`Failed to clean up temp dir ${tmpDir}: ${msg}`);
      }
    }
  }

  /**
   * Parse manifest.json from a file path or raw JSON and sync task registrations.
   */
  async syncTasksFromManifest(
    appId: string,
    manifestPath?: string,
  ): Promise<number> {
    const app = await this.findById(appId);
    let manifest: Record<string, any> & {
      tasks?: any[];
      runtime?: string;
      entrypoint?: string;
      timeout?: number;
    };

    if (manifestPath && fs.existsSync(manifestPath)) {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    } else if (app.manifest) {
      manifest = app.manifest;
    } else {
      return 0;
    }

    if (
      !manifest.tasks ||
      !Array.isArray(manifest.tasks) ||
      !this._taskService
    ) {
      return 0;
    }

    let count = 0;
    for (const taskDef of manifest.tasks) {
      try {
        await this._taskService.create({
          name: taskDef.name || taskDef.id,
          id: taskDef.id,
          description: taskDef.description,
          cron: taskDef.cron,
          runtime: taskDef.runtime || manifest.runtime,
          entrypoint: taskDef.entrypoint || manifest.entrypoint,
          timeout: taskDef.timeout || manifest.timeout,
          requirements: taskDef.requirements,
          env: taskDef.env,
          applicationId: app.id,
        } as any);
        count++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("already exists")) {
          this.logger.warn(
            `Task "${taskDef.id || taskDef.name}" already exists, skipping`,
          );
        } else {
          this.logger.error(`Failed to register task: ${msg}`);
        }
      }
    }
    return count;
  }
}
