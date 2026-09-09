import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  OnModuleInit,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { ModuleRef } from "@nestjs/core";
import { Repository, IsNull, Or, In } from "typeorm";
import { Application, ApplicationStatus } from "./entities/application.entity";
import {
  CreateApplicationDto,
  UpdateApplicationDto,
} from "./dto/application.dto";
// AUTH-01: 默认项目 uuid（"default" 过滤映射目标，与迁移 1790000000008
// 回填值共享同一常量出处 project.entity.ts）。
import { DEFAULT_PROJECT_ID } from "../project/project.entity";
import { spawn } from "child_process";
import { assertSafeGitRepoUrl } from "../../common/utils/safe-http.util";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { AiService } from "../ai/ai.service";

/**
 * R4: Promise wrapper around async child_process.spawn. Aggregates
 * stdout/stderr as utf-8 strings, enforces a wall-clock timeout (kills the
 * child and reports a non-zero status like spawnSync's timeout option did),
 * and resolves `{ status, stdout, stderr }` — the same shape the previous
 * spawnSync call sites consumed. Spawn errors (ENOENT, ...) resolve with
 * status = -1 and the error message on stderr so callers keep one failure
 * path. The event loop stays live for the whole duration.
 *
 * QA8: output aggregation is capped at 10 MB (same budget as executor-node
 * run-command.ts) and the timeout path also signals the child's whole
 * process group on POSIX, where the child is spawned detached so git's
 * helper processes (git-remote-https etc.) do not outlive the timeout.
 */
function spawnAsync(
  cmd: string,
  args: string[],
  opts: { timeout: number },
): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // QA8: detached is POSIX-only, mirroring executor-node run-command.ts.
    // On POSIX it makes the child the leader of its own process group so the
    // timeout path can kill the whole tree; no signal semantics change for
    // the direct child (child.kill() still targets the leader). On Windows
    // detached would give the child its own console window while
    // child.kill() remains a direct kill regardless — so Windows keeps the
    // previous behavior. Trade-off accepted on POSIX: a child that survives
    // the parent's own death is possible (same as executor-node); here the
    // timeout still reaps the group while the process is alive.
    const child = spawn(cmd, args, {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    // QA8: 10 MB aggregation cap (run-command.ts parity). Appending stops
    // once the cap is reached, so the captured tail may overshoot by at most
    // one chunk — a runaway clone must not balloon the admin-api heap.
    const CAP = 10 * 1024 * 1024;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const finish = (status: number, errMsg?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // Pull anything the child managed to write before exiting.
      child.stdout?.destroy?.();
      child.stderr?.destroy?.();
      resolve({
        status,
        stdout,
        stderr: errMsg ? `${errMsg}${stderr ? `\n${stderr}` : ""}` : stderr,
      });
    };

    child.stdout?.on("data", (c: Buffer) => {
      if (stdout.length < CAP) stdout += c.toString("utf-8");
    });
    child.stderr?.on("data", (c: Buffer) => {
      if (stderr.length < CAP) stderr += c.toString("utf-8");
    });
    child.on("error", (err: Error) => {
      finish(-1, err.message);
    });
    child.on("close", (code) => {
      finish(code ?? -1);
    });

    timer = setTimeout(() => {
      // Match spawnSync's timeout semantics: kill the child; the close
      // event then resolves with a non-zero status.
      child.kill();
      // QA8 (POSIX, detached): also signal the child's process group so
      // grandchildren cannot linger past the timeout. Best-effort — the
      // group may already be gone (ESRCH) or unpermitted (EPERM), in which
      // case the direct kill above is all we have.
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid);
        } catch {
          // group already gone / not permitted — direct kill above stands
        }
      }
      finish(-1, `Process timed out after ${opts.timeout}ms`);
    }, opts.timeout);
  });
}

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

  /**
   * AUTH-01: 可选 projectId 过滤——"default" 映射为默认项目（未分配 NULL
   * 行一起归入默认项目视图，Or 处理）；具体 uuid 则精确匹配。不传时行为
   * 与既往完全一致（全量列表）。
   */
  async findAll(projectId?: string): Promise<Application[]> {
    const findOptions: {
      order: { createdAt: "DESC" };
      where?: Record<string, unknown>;
    } = { order: { createdAt: "DESC" } };
    if (projectId) {
      findOptions.where =
        projectId === "default"
          ? { projectId: Or(IsNull(), In([DEFAULT_PROJECT_ID])) }
          : { projectId };
    }
    const rows = await this.repo.find(findOptions);
    return rows.map((r) => this.maskReadSurface(r));
  }

  async findById(id: string): Promise<Application> {
    const app = await this.repo.findOne({ where: { id } });
    if (!app) throw new NotFoundException(`Application ${id} not found`);
    return this.maskReadSurface(app);
  }

  /**
   * R1: internal callers (deploy/upgrade/rollback paths) need the raw
   * env so executors can pull secrets at deploy time. They go through
   * this RAW lookup to bypass the read-surface masking applied by
   * findById/findAll. The HTTP surface never reaches this method.
   */
  async findByIdRaw(id: string): Promise<Application> {
    const app = await this.repo.findOne({ where: { id } });
    if (!app) throw new NotFoundException(`Application ${id} not found`);
    return app;
  }

  /**
   * R1: the env map is operator-authored and frequently carries secrets
   * (DB URLs, API keys, signing tokens) that executors pull at deploy
   * time. The DB row keeps the raw values; the HTTP read surface masks
   * them — same posture as NotificationConfigService.maskChannel / N32
   * url-query masking so a non-admin authenticated user never sees
   * plaintext secrets. Returns a shallow clone so the stored entity is
   * not mutated (TypeORM reuses identity-mapped objects across requests).
   */
  /** R1/QA1: not private — AppDeploymentService reuses it to mask the
   *  nested application relation it returns alongside deployment rows. */
  maskReadSurface(app: Application): Application {
    if (!app.env || typeof app.env !== "object") return app;
    return { ...app, env: this.maskEnvForRead(app.env) as any };
  }

  /** QA1: mask secret-class keys of an arbitrary env record for HTTP read
   *  surfaces — shared by the application surface above and the deployment /
   *  version-snapshot surfaces (deployment.env, relations.application.env,
   *  snapshot.env) so the same secrets cannot leak through a sibling read
   *  path while this one is masked. */
  maskEnvForRead(
    env: Record<string, string> | null | undefined,
  ): Record<string, string> | null | undefined {
    if (!env || typeof env !== "object") return env;
    const masked: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
      masked[k] = ApplicationService.SECRET_FIELD_RE.test(k) ? "***" : v;
    }
    return masked;
  }

  /** Mirror of NotificationConfigService.SECRET_FIELD_RE — kept local so
   *  the application module has no cross-module coupling on a private
   *  field naming rule. */
  private static readonly SECRET_FIELD_RE = /pass|secret|token|api[_-]?key/i;

  /**
   * R1: the admin form round-trips the masked read surface, so an untouched
   * secret-class key comes back as the '***' sentinel. Writing that sentinel
   * over the saved raw value would destroy the secret — same reason
   * NotificationConfigService.updateChannel skips isMaskedEcho entries.
   * Keep the saved raw value for any incoming '***' on a secret-class key;
   * everything else passes through.
   */
  private mergeEnvPreservingMaskedEcho(
    saved: Record<string, string> | null | undefined,
    incoming: Record<string, string>,
  ): Record<string, string> {
    const merged: Record<string, string> = { ...incoming };
    for (const [k, v] of Object.entries(merged)) {
      if (
        v === "***" &&
        ApplicationService.SECRET_FIELD_RE.test(k) &&
        saved &&
        Object.prototype.hasOwnProperty.call(saved, k)
      ) {
        merged[k] = saved[k];
      }
    }
    return merged;
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
    // R1: load the RAW row, never the masked findById() result — saving a
    // masked entity back would persist '***' over the real secret env
    // values (webhook version bumps and upload upserts both flow through
    // here without touching env). The response is masked again so the
    // public webhook route can never echo raw secrets.
    const app = await this.findByIdRaw(id);
    const next: UpdateApplicationDto = dto.env
      ? {
          ...dto,
          env: this.mergeEnvPreservingMaskedEcho(app.env, dto.env),
        }
      : dto;
    Object.assign(app, next);
    const saved = await this.repo.save(app);
    return this.maskReadSurface(saved);
  }

  /**
   * R18/R9c: local upload root for application packages (uploads/packages
   * under the process working directory — the same directory the upload
   * endpoint writes into and main.ts serves statically).
   */
  private static readonly PACKAGE_UPLOAD_ROOT = path.normalize(
    path.join(process.cwd(), "uploads", "packages"),
  );

  async remove(id: string): Promise<void> {
    const app = await this.findById(id);
    await this.repo.remove(app);
    // R18/R9c: the application row may point at a locally served package
    // (uploads/packages/<file>.zip). The old remove() left that file behind,
    // accumulating orphan zips. Best-effort unlink AFTER the DB row is gone
    // (an unlink failure then only leaves a harmless orphan file; deleting
    // first would leave a live row pointing at a missing file) — but ONLY
    // for paths that resolve inside this service's own upload root (the
    // packageUrl host can be remote or user-supplied, so an unvalidated
    // unlink would allow deleting arbitrary absolute paths).
    if (app.packageUrl) {
      const toDelete = this.resolveLocalPackagePath(app.packageUrl);
      if (toDelete) {
        try {
          await fs.promises.unlink(toDelete);
          this.logger.log(`Deleted package file: ${toDelete}`);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.warn(`Failed to delete package file ${toDelete}: ${msg}`);
        }
      }
    }
    this.logger.log(`Application removed: ${app.name}`);
  }

  /**
   * R18/R9c: map a stored packageUrl to a local file path under
   * uploads/packages, or return null when the URL is remote, malformed, or
   * escapes the upload root (path-traversal / arbitrary-delete guard).
   */
  private resolveLocalPackagePath(packageUrl: string): string | null {
    try {
      const url = new URL(packageUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      const decoded = decodeURIComponent(url.pathname);
      const marker = "/uploads/packages/";
      const idx = decoded.indexOf(marker);
      if (idx === -1) return null;
      const filename = decoded.slice(idx + marker.length);
      if (!filename || filename.includes("/") || filename.includes("\\")) {
        return null;
      }
      if (filename.includes("..")) return null;
      const resolved = path.normalize(
        path.join(ApplicationService.PACKAGE_UPLOAD_ROOT, filename),
      );
      // Containment check: the resolved path must stay inside the upload root.
      if (
        resolved !== ApplicationService.PACKAGE_UPLOAD_ROOT &&
        !resolved.startsWith(ApplicationService.PACKAGE_UPLOAD_ROOT + path.sep)
      ) {
        return null;
      }
      return resolved;
    } catch {
      return null;
    }
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
    // R1: this path saves the entity back (status/git metadata/manifest) —
    // it must operate on the RAW row, otherwise the masked read surface
    // would persist '***' over the real secret env values.
    const app = await this.findByIdRaw(id);
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
      // R4: the regex above only checks the FORMAT — a well-formed
      // http://169.254.169.254/... or http://127.0.0.1:8080/... repo would
      // make `git clone` an unauthenticated-by-network SSRF first hop.
      // Reuse the safe-http classification to refuse metadata / link-local /
      // loopback / reserved hosts before the clone runs (public and private
      // LAN git servers keep working).
      await assertSafeGitRepoUrl(gitRepo);

      this.logger.log(`Cloning ${gitRepo}@${gitBranch} into ${tmpDir}`);
      // SEC: spawn with array args — no shell expansion, no injection risk.
      // R4: async (child_process spawn + Promise) instead of the blocking
      // sync spawn variant, which froze the entire NestJS event loop (every
      // request, heartbeat and BullMQ job) for up to the 120s clone timeout.
      // Error semantics are preserved: non-zero exit / timeout / spawn
      // failure surface stderr (or a generic message) as a thrown Error.
      const cloneResult = await spawnAsync(
        "git",
        ["clone", "--depth", "1", "--branch", gitBranch, gitRepo, tmpDir],
        { timeout: 120_000 },
      );
      if (cloneResult.status !== 0) {
        const errMsg = cloneResult.stderr || "git clone failed";
        throw new Error(errMsg);
      }

      const revResult = await spawnAsync(
        "git",
        ["-C", tmpDir, "rev-parse", "HEAD"],
        {
          timeout: 10_000,
        },
      );
      if (revResult.status !== 0) throw new Error("git rev-parse HEAD failed");
      app.gitCommit = (revResult.stdout || "").trim();

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
