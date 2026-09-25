import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  OnModuleInit,
  Optional,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { ModuleRef } from "@nestjs/core";
import { Repository, IsNull, Or, In } from "typeorm";
import { Application, ApplicationStatus } from "./entities/application.entity";
// NETOPT-8③: 删除应用时 best-effort 通知执行器清理 apps/<appId>
import { AppDeployment } from "./entities/app-deployment.entity";
import { UserRole } from "../users/entities/user.entity";
import {
  CreateApplicationDto,
  UpdateApplicationDto,
} from "./dto/application.dto";
// AUTH-01: 默认项目 uuid（"default" 过滤映射目标，与迁移 1790000000008
// 回填值共享同一常量出处 project.entity.ts）。
import { DEFAULT_PROJECT_ID } from "../project/project.entity";
import { spawn } from "child_process";
import { assertSafeGitRepoUrl } from "../../common/utils/safe-http.util";
// NETOPT-8③: 执行器通知走 assertAndPinExecutorUrl 同一安全通道（先例
// app-deployment.service.stop()——SSRF 复核 + 连接 pin 到已校验 IP）。
import {
  assertAndPinExecutorUrl,
  pinnedAxiosConfig,
} from "../../common/utils/safe-http.util";
import axios from "axios";
// NETOPT-8③: 扇出需要执行器地址拼 URL 与共享凭据（DB-first）。@Optional
// 注入（既有单测装配未提供时为 null → 扇出整体跳过），类型上仅为消除
// executor.service → application.entity 与本文件的无环引用。
import { ExecutorService } from "../executor/executor.service";
// A2-B: 属主校验的运行时证据落点
import { recordOwnershipAssertion } from "../../common/guards/ownership-assertion.store";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { AiService } from "../ai/ai.service";
// D3-B-P1-2: 应用 CRUD/部署触发审计落证（@Optional 同 executor.service——
// 既有单测装配未提供时降级为仅日志，主链不因审计故障中断）。
import { AuditService } from "../audit/audit.service";
// 上传即产生版本：upload 路径落 application_versions 快照。@Optional 注入
// （既有单测装配未提供 repo 时跳过快照，不阻断上传主链）。
import { ApplicationVersion } from "./entities/application-version.entity";

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
    // NETOPT-8③: 删除应用时 best-effort 通知执行器清理 apps/<appId>。
    // @Optional 同 executor.service applicationRepo 先例——既有单测装配未
    // 提供时为 null，扇出整体跳过（删除主链不受影响）。**必须是参数表最后
    // 两个**，不破坏既有位置装配。
    @Optional()
    @InjectRepository(AppDeployment)
    private readonly deploymentRepo: Repository<AppDeployment> | null = null,
    @Optional()
    private readonly executorService: ExecutorService | null = null,
    // D3-B-P1-2: 审计落证（@Optional 同上——存量 spec 未提供时降级）。
    @Optional()
    private readonly audit: AuditService | null = null,
    // 上传即产生版本（方案 A）：落 application_versions 快照。@Optional
    // 同上——存量 spec 未提供 repo 时跳过快照，不阻断上传主链。
    @Optional()
    @InjectRepository(ApplicationVersion)
    private readonly versionRepo: Repository<ApplicationVersion> | null = null,
  ) {}

  private _taskService: import("../task/task.service").TaskService | null =
    null;

  // AUTH-02: 项目级角色判定（lazy 解析，理由同 TaskService——避免与
  // ProjectsModule 形成模块环；解析不到时整体旁路，写面判定保持既有行为）。
  private _projectAccess:
    import("../project/project-access.service").ProjectAccessService | null =
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
    try {
      const { ProjectAccessService } =
        await import("../project/project-access.service");
      this._projectAccess = this.moduleRef.get(ProjectAccessService, {
        strict: false,
      });
    } catch {
      this._projectAccess = null;
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

  /**
   * NF-03（任务级 RBAC 预研）：写面属主守卫。语义与 task.service.assertCanWrite
   * 一致（ADMIN 全量 / 属主自己 / NULL 无主仅 ADMIN）。user 为 null（API-Key
   * 主体等）按非 ADMIN。
   */
  assertCanWrite(
    row: { ownerUserId: number | null },
    user: { id: number; role: UserRole } | null | undefined,
  ): void {
    // A2-B: 先落证再判定（同 task.service.assertCanWrite）。
    recordOwnershipAssertion("application", "write");
    if (user?.role === UserRole.ADMIN) return;
    if (row.ownerUserId === null) {
      throw new ForbiddenException(
        "This application has no owner (legacy row); only admins can modify it",
      );
    }
    if (row.ownerUserId !== user?.id) {
      throw new ForbiddenException("You do not own this application");
    }
  }

  /**
   * AUTH-02: NF-03 属主守卫之上叠加项目角色放行（只增放行、不收紧）。
   * 项目 editor/admin 可改该项目内的应用（含他人创建行与无主存量行）；
   * viewer/非成员维持属主守卫原判定。ProjectAccessService 缺席时与
   * assertCanWrite 完全等价。
   */
  async assertCanWriteProjectAware(
    row: { ownerUserId: number | null; projectId?: string | null },
    user: { id: number; role: UserRole } | null | undefined,
  ): Promise<void> {
    try {
      this.assertCanWrite(row, user);
      return;
    } catch (e: unknown) {
      if (!(e instanceof ForbiddenException)) throw e;
      if (!this._projectAccess || !user?.id) throw e;
      const allowed = await this._projectAccess.hasProjectRole(
        user.id,
        row.projectId ?? null,
        "editor",
      );
      if (!allowed) throw e;
    }
  }

  /** D3-B-P1-2: best-effort 审计落证（fail-open，审计故障不阻断主链）。 */
  private async writeAudit(payload: {
    userId?: number;
    action: string;
    resourceId: string;
    detail?: Record<string, unknown>;
  }): Promise<void> {
    if (!this.audit) return;
    try {
      await this.audit.log({
        userId: payload.userId,
        action: payload.action,
        resource: "application",
        resourceId: payload.resourceId,
        detail: payload.detail as Record<string, any>,
      });
    } catch (err: unknown) {
      this.logger.warn(
        `Audit write failed for ${payload.action}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  /**
   * 上传即产生版本（zip 上传路径）：把上传落地后的应用状态写入
   * application_versions，使「上传新包」也在版本历史/回滚中可见——此前只有
   * git 部署路径（AppDeploymentService.saveVersionSnapshot）落版本行，zip 上传
   * 完全不留痕，用户上传新包后无法从版本历史回滚。
   *
   * sourceDeploymentId 置 null（区别于部署产生的版本行）。dedupe 键
   * (applicationId, version)：同一版本号重复上传视为同一次发布，避免唯一索引
   * 23505；best-effort——快照失败只 warn，绝不阻断上传主链。
   *
   * status 取 **"released"**（不是 "uploaded"）：回滚面（本文件 rollbackApplication
   * 的 released 守卫、rollbackDeploymentToPrevious 的 released 过滤、前端
   * ApplicationDetailPage 的 rollbackDisabled 判据）历来只认 "released"。上传的包
   * 本身就是一个可回滚的发布态——用户上传 1.0.0 再上传 1.0.1 后，1.0.0 必须能一键
   * 回退。若这里写 "uploaded"，zip 上传出来的每一个旧版本在版本历史里都会显示
   * 「仅已发布版本可回滚」且按钮永久禁用（这正是本次用户报障）。故与部署路径
   * （saveVersionSnapshot(..., "released")）统一取 released 语义。
   */
  async recordUploadVersion(
    app: Application,
    user?: { id: number } | null,
  ): Promise<void> {
    if (!this.versionRepo) return;
    if (!app.version) return;
    try {
      const existing = await this.versionRepo.findOne({
        where: {
          applicationId: app.id,
          version: app.version,
          // TypeORM 1.x：where 里的 null 字面量会抛错（不再编译成 IS NULL）。
          // 上传路径的 sourceDeploymentId 恒为 NULL，必须显式 IsNull()。
          sourceDeploymentId: IsNull(),
        },
      });
      if (existing) return;
      await this.versionRepo.save(
        this.versionRepo.create({
          applicationId: app.id,
          version: app.version,
          gitCommit: app.gitCommit ?? null,
          sourceDeploymentId: null,
          // 上传即可回滚（详见方法头注）：与部署路径同取 released 语义，
          // 否则 zip 上传的版本会被回滚守卫判为「仅已发布版本可回滚」。
          status: "released",
          snapshot: {
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
          },
          createdBy: user?.id != null ? String(user.id) : null,
          description: "Package upload",
        }),
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // 并发上传同一版本号时唯一索引 (applicationId, version) 会让后者 23505，
      // 首个写入者已落行——静默即可，不阻断上传。
      this.logger.warn(
        `recordUploadVersion: failed to snapshot ${app.id}@${app.version}: ${msg}`,
      );
    }
  }

  async create(
    dto: CreateApplicationDto,
    user?: { id: number } | null,
  ): Promise<Application> {
    const existing = await this.findByName(dto.name);
    if (existing) {
      throw new ConflictException(`Application "${dto.name}" already exists`);
    }

    const app = this.repo.create({
      ...dto,
      status: dto.gitRepo
        ? ApplicationStatus.DEPLOYING
        : ApplicationStatus.ACTIVE,
      // NF-03: 创建即落 owner（含 ADMIN 创建——可追溯，为 AUTH-02 读面预铺）
      ownerUserId: user?.id ?? null,
    });
    const saved = await this.repo.save(app);
    this.logger.log(`Application created: ${saved.name} (${saved.id})`);
    // D3-B-P1-2: 创建落证（applicationId + 操作人）。
    await this.writeAudit({
      userId: user?.id,
      action: "application.create",
      resourceId: saved.id,
      detail: { name: saved.name },
    });

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

  async update(
    id: string,
    dto: UpdateApplicationDto,
    user?: { id: number; role: UserRole } | null,
    opts?: { systemBypass?: boolean },
  ): Promise<Application> {
    // NF-03: 写面属主守卫（先取原始行再校验，避免脱敏面误判）。
    // systemBypass：机器面（发版 webhook HMAC 已鉴权）更新版本号不走
    // 用户属主语义——webhook 是 @Public CI 通道，无 AuthUser 可言。
    if (!opts?.systemBypass) {
      const owned = await this.findByIdRaw(id);
      // AUTH-02: 项目 editor/admin 亦可改（只增放行）
      await this.assertCanWriteProjectAware(owned, user);
    }
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
    // D3-B-P1-2: 更新落证（systemBypass=CI webhook 无操作人，userId 留空）。
    if (!opts?.systemBypass) {
      await this.writeAudit({
        userId: user?.id,
        action: "application.update",
        resourceId: id,
      });
    }
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

  /**
   * P0（UX-AUDIT-2026-09-21 §P0-3）：删除前的**影响面预览**。
   *
   * 此前确认框只说"删除后无法恢复"，而实际后果远不止删掉这一条记录：
   *   ① 部署行被 `AppDeployment` 的 onDelete: CASCADE 静默删除（回滚点消失）；
   *   ② 本地打包 zip 被物理 unlink（不可恢复）；
   *   ③ **引用它的任务不会消失**，只是 applicationId 被 `onDelete: "SET NULL"`
   *      置空——任务照旧按 cron 调度，但代码来源已断，此后每次执行都失败，
   *      而排查入口（应用详情页）已经不存在了。
   *
   * ③ 是用户完全无从知晓的那一条，也是本接口存在的理由：让确认框能如实列出
   * "N 个任务将失去代码来源"。
   */
  async describeRemovalImpact(id: string): Promise<{
    applicationName: string;
    tasksLosingSource: number;
    deploymentCount: number;
    packageFileWillBeDeleted: boolean;
  }> {
    const app = await this.findById(id);
    const deployments = await this.findDeploymentsForRemovalFanout(id);
    // 任务数走 TaskService（弱引用，无 ORM 关系可直接 count）；TaskService 未
    // 接线时保守返回 0 而不是抛错——预览失败不该让"删除"整条路走不通。
    let tasksLosingSource = 0;
    if (this._taskService) {
      try {
        const result = await this._taskService.findAll({
          applicationId: id,
        } as never);
        const items = (result?.items ?? result) as unknown[];
        tasksLosingSource = Array.isArray(items) ? items.length : 0;
      } catch (err: unknown) {
        this.logger.warn(
          `Removal impact: task count unavailable for application ${id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return {
      applicationName: app.name,
      tasksLosingSource,
      deploymentCount: deployments.length,
      // 只对"本地托管的包"为真——远程/用户自带 URL 不会被 unlink
      packageFileWillBeDeleted: Boolean(
        app.packageUrl && this.resolveLocalPackagePath(app.packageUrl),
      ),
    };
  }

  async remove(
    id: string,
    user?: { id: number; role: UserRole } | null,
  ): Promise<void> {
    const app = await this.findById(id);
    // NF-03: 写面属主守卫（同 update）+ AUTH-02 项目角色放行
    await this.assertCanWriteProjectAware(app, user);
    // NETOPT-8③: repo.remove 之前先取部署行——AppDeployment 对应用是
    // @ManyToOne(onDelete: CASCADE)，应用行一删部署行静默级联消失，此后
    // 既查不到执行器集合，/app-stop 通路也不可达。
    const deployments = await this.findDeploymentsForRemovalFanout(id);
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
    // D3-B-P1-2: 删除落证（applicationId + 操作人 + 名称）。
    await this.writeAudit({
      userId: user?.id,
      action: "application.delete",
      resourceId: id,
      detail: { name: app.name },
    });
    // NETOPT-8③: DB 删除完成后 best-effort 并行扇出（先 stop 后 uninstall）。
    // 任何失败只 warn，绝不外抛——删除应用不得因执行器不可达而失败。
    await this.fanOutAppRemovalToExecutors(app.id, deployments);
  }

  /**
   * NETOPT-8③: 单次执行器清理通知的超时（5s，处在任务要求的 5-10s 区间下
   * 沿——扇出最多 stop×N + 1 次 uninstall，收紧超时让删除接口不被慢执行器
   * 拖太久）。
   */
  private static readonly EXECUTOR_REMOVAL_NOTIFY_TIMEOUT_MS = 5_000;

  /**
   * NETOPT-8③: 取该应用的部署行（id + executorAddress 两列）。deploymentRepo
   * 缺席（既有单测装配）或查询失败时返回空集——扇出跳过但删除主链照常。
   */
  private async findDeploymentsForRemovalFanout(
    appId: string,
  ): Promise<{ id: string; executorAddress: string | null }[]> {
    if (!this.deploymentRepo) return [];
    try {
      return await this.deploymentRepo.find({
        where: { applicationId: appId },
        select: { id: true, executorAddress: true },
      });
    } catch (err: unknown) {
      this.logger.warn(
        `NETOPT-8③: 查询应用 ${appId} 的部署行失败，跳过执行器清理通知: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return [];
    }
  }

  /**
   * NETOPT-8③: 对每台有部署的执行器（按地址去重）并行扇出清理通知。
   * Promise.allSettled + 单台内部全兜底 ⇒ 整体绝不外抛。
   */
  private async fanOutAppRemovalToExecutors(
    appId: string,
    deployments: { id: string; executorAddress: string | null }[],
  ): Promise<void> {
    const byAddress = new Map<string, string[]>();
    for (const d of deployments) {
      if (!d.executorAddress) continue;
      const ids = byAddress.get(d.executorAddress) ?? [];
      ids.push(d.id);
      byAddress.set(d.executorAddress, ids);
    }
    if (byAddress.size === 0) return;
    if (!this.executorService) {
      this.logger.warn(
        `NETOPT-8③: ExecutorService 缺席，跳过应用 ${appId} 的执行器清理通知`,
      );
      return;
    }
    await Promise.allSettled(
      [...byAddress.entries()].map(([address, deploymentIds]) =>
        this.uninstallAppOnExecutor(appId, address, deploymentIds),
      ),
    );
  }

  /**
   * NETOPT-8③: 单台执行器的清理通知：先逐 deploymentId POST /app-stop
   * （既有端点，旧执行器也支持），再 POST /app-uninstall（新端点——旧版
   * 执行器 404 属预期，按 best-effort 失败处理只 warn 继续）。任何失败
   * 绝不外抛。
   *
   * ARCH-33（ADR-016）：pull 执行器（NAT 内）改为把整批命令投进 pull 命令
   * 队列——LPUSH 入队 + RPOP 出队是 FIFO，故按「先 stop 后 uninstall」的
   * 顺序逐条入队即还原了 push 路径的时序（先停全部 daemon，再删目录）。
   */
  private async uninstallAppOnExecutor(
    appId: string,
    address: string,
    deploymentIds: string[],
  ): Promise<void> {
    const executorService = this.executorService;
    if (!executorService) return;

    // ARCH-33: 先判一次传输方式——整批命令要么全走 pull，要么全走 push，
    // 不允许一台执行器上两条路径混发（否则 stop 走队列、uninstall 走 HTTP，
    // 时序就乱了）。resolveExecutorTransport 是纯读判定，不会产生副作用。
    const transport = await executorService
      .resolveExecutorTransport({ address })
      .catch(() => ({ mode: "push" as const, executor: null }));
    if (transport.mode === "pull" && transport.executor) {
      const executorId = transport.executor.id;
      try {
        for (const deploymentId of deploymentIds) {
          await executorService.enqueueExecutorCommand(executorId, "app-stop", {
            deploymentId,
          });
        }
        await executorService.enqueueExecutorCommand(
          executorId,
          "app-uninstall",
          {
            appId,
          },
        );
        this.logger.log(
          `NETOPT-8③/ARCH-33: 应用 ${appId} 的清理命令已入队（executor=${address}，` +
            `stop×${deploymentIds.length} + uninstall×1，pull 通道）`,
        );
      } catch (err: unknown) {
        this.logger.warn(
          `NETOPT-8③/ARCH-33: 清理命令入队失败（best-effort 继续），executor=${address}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      return;
    }

    for (const deploymentId of deploymentIds) {
      try {
        const url = executorService.getExecutorUrl(address, "api/app-stop");
        const pinned = await assertAndPinExecutorUrl(url);
        await axios.post(
          url,
          { deploymentId },
          {
            timeout: ApplicationService.EXECUTOR_REMOVAL_NOTIFY_TIMEOUT_MS,
            headers: await this.getExecutorAuthHeaders(executorService),
            maxRedirects: 0,
            ...pinnedAxiosConfig(pinned),
          },
        );
      } catch (err: unknown) {
        this.logger.warn(
          `NETOPT-8③: app-stop 通知失败（best-effort 继续），executor=${address} deployment=${deploymentId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    try {
      const url = executorService.getExecutorUrl(address, "api/app-uninstall");
      const pinned = await assertAndPinExecutorUrl(url);
      await axios.post(
        url,
        { appId },
        {
          timeout: ApplicationService.EXECUTOR_REMOVAL_NOTIFY_TIMEOUT_MS,
          headers: await this.getExecutorAuthHeaders(executorService),
          maxRedirects: 0,
          ...pinnedAxiosConfig(pinned),
        },
      );
    } catch (err: unknown) {
      this.logger.warn(
        `NETOPT-8③: app-uninstall 通知失败（旧版执行器可能不支持该端点，best-effort 忽略），executor=${address}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** NETOPT-8③: executor 请求头（Bearer 共享令牌，DB-first 解析失败降级无头） */
  private async getExecutorAuthHeaders(
    executorService: ExecutorService,
  ): Promise<Record<string, string>> {
    try {
      const token = await executorService.getSharedToken();
      return token ? { Authorization: `Bearer ${token}` } : {};
    } catch {
      return {};
    }
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
      // R-21（DEFERRED-CROSS-SCOPE）: paginate 双键保留（list/items 并存），
      // 此处读 canonical items（范围外 packages/acf-cli 仍读 list，故不收敛）。
      tasks = (result.items || result) as Array<{ id: string; name: string }>;
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
    // D3-B-P1-2: git 部署触发落证（applicationId + git 元信息）。
    await this.writeAudit({
      action: "application.deploy",
      resourceId: id,
      detail: { gitRepo, gitBranch, gitCommit: gitCommit ?? null },
    });

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
