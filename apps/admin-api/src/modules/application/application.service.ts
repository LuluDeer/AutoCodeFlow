import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  Inject,
  forwardRef,
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

@Injectable()
export class ApplicationService implements OnModuleInit {
  private logger = new Logger(ApplicationService.name);

  constructor(
    @InjectRepository(Application)
    private readonly repo: Repository<Application>,
    private readonly moduleRef: ModuleRef,
  ) {}

  private _taskService: import('../task/task.service').TaskService | null = null;

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
        'git',
        ['clone', '--depth', '1', '--branch', gitBranch, gitRepo, tmpDir],
        { timeout: 120_000, stdio: 'pipe' },
      );
      if (cloneResult.status !== 0) {
        const errMsg = cloneResult.stderr?.toString('utf-8') || 'git clone failed';
        throw new Error(errMsg);
      }

      const revResult = spawnSync('git', ['-C', tmpDir, 'rev-parse', 'HEAD'], { encoding: 'utf-8' });
      if (revResult.status !== 0) throw new Error('git rev-parse HEAD failed');
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
        const msg = cleanErr instanceof Error ? cleanErr.message : String(cleanErr);
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
    let manifest: Record<string, any> & { tasks?: any[]; runtime?: string; entrypoint?: string; timeout?: number };

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
