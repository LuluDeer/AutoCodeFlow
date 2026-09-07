import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Optional,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, LessThan, In } from "typeorm";
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
import { assertSafeExecutorUrl } from "../../common/utils/safe-http.util";
import {
  CreateDeploymentDto,
  DeploymentHeartbeatDto,
} from "./dto/app-deployment.dto";
import {
  AppReleaseRow,
  ReleaseTriggerType,
  RELEASE_OPERATOR_MISSING_REASON,
} from "./dto/app-release.dto";
// FEAT-07: deployment.completed 出站事件（总线 @Global；Optional 注入先例 task.service）
import {
  DOMAIN_EVENTS,
  DeploymentCompletedEventPayload,
} from "../../common/events/domain-events";
import { DomainEventBus } from "../../common/services/domain-event-bus.service";

/** R5: name of the partial unique index created by migration
 *  1789000000000-AddAppDeploymentsInFlightUniqueIndex (applicationId is
 *  unique among rows with status pending/deploying). */
const IN_FLIGHT_UNIQUE_INDEX = "uq_app_deployments_application_in_flight";

/** DEP-01：/releases 分页参数（默认 50，上限 200，防全表拖库）。 */
export const RELEASES_DEFAULT_PAGE_SIZE = 50;
export const RELEASES_MAX_PAGE_SIZE = 200;

/** DEP-01：统一列表的排序键（毫秒时间戳）：有部署取该版本最近一次部署完成时刻
 *  （deployedAt，缺则行 createdAt），无部署取版本行 createdAt。纯函数便于测试。 */
export function releaseSortTimestampMs(input: {
  deployedAt?: Date | string | null;
  latestDeploymentCreatedAt?: Date | string | null;
  versionCreatedAt?: Date | string | null;
}): number {
  const t =
    input.deployedAt ??
    input.latestDeploymentCreatedAt ??
    input.versionCreatedAt ??
    null;
  if (!t) return 0;
  const ms = new Date(t).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

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
    // FEAT-07: deployment.completed 出站事件发布（@Global 总线；@Optional 仅为
    // 既有单测装配兼容——provider 缺失 → null → 事件静默不发，先例 task.service）。
    @Optional()
    private readonly eventBus: DomainEventBus | null = null,
  ) {}

  /** Build auth headers for executor requests. Must resolve through
   *  ExecutorService.getSharedToken (DB-first) — a raw env read would send a
   *  stale credential after DB rotation and be rejected by the executor. */
  private async getExecutorHeaders(): Promise<Record<string, string>> {
    const token = await this.executorService.getSharedToken();
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
    return { data: data.map((d) => this.maskDeploymentForRead(d)), total };
  }

  /** Internal: get all deployment records for an app without pagination */
  async findAllByApp(applicationId: string): Promise<AppDeployment[]> {
    return this.repo.find({
      where: { applicationId },
      order: { createdAt: "DESC" },
      relations: ["application"],
    });
  }

  /** Internal: raw lookup (unmasked env) for deploy/upgrade send paths —
   *  masking is a read-surface concern and must never leak into what gets
   *  pushed to the executor (round-7 lesson: masking must not reach the
   *  send path). */
  async findByIdRaw(id: string): Promise<AppDeployment> {
    const d = await this.repo.findOne({
      where: { id },
      relations: ["application"],
    });
    if (!d) throw new NotFoundException(`Deployment ${id} not found`);
    return d;
  }

  async findById(id: string): Promise<AppDeployment> {
    const d = await this.repo.findOne({
      where: { id },
      relations: ["application"],
    });
    if (!d) throw new NotFoundException(`Deployment ${id} not found`);
    return this.maskDeploymentForRead(d);
  }

  /** QA1: deployment rows carry their own env snapshot plus the parent
   *  application relation — both hold the same raw secrets the application
   *  read surface masks. Mask every env occurrence (row env, nested
   *  application env) so a sibling GET cannot bypass application masking. */
  private maskDeploymentForRead(d: AppDeployment): AppDeployment {
    const masked: AppDeployment = {
      ...d,
      env: (this.appService.maskEnvForRead(d.env) ?? d.env) as Record<
        string,
        string
      > | null,
    };
    if (masked.application) {
      masked.application = this.appService.maskReadSurface(masked.application);
    }
    return masked;
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
      // QA1: buildSnapshot stores the raw application env — mask the env
      // key (shallow clone) so the version read surface cannot serve the
      // secrets the application surface hides.
      snapshot: this.maskSnapshotForRead(v.snapshot),
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

  // -----------------------------------------------------------------------
  // DEP-01: /applications/:id/releases —— 版本 × 部署统一只读追溯视图
  // -----------------------------------------------------------------------

  /**
   * 合并 application_versions（版本号/包地址/操作人列）与 app_deployments
   * （部署时间/状态/所在执行器）两个语义面：**一行 = 一个版本发布**，聚合出
   * 「这次部署用了哪个包」的一屏追溯。零 schema 变更，纯读视图；旧端点
   * GET /applications/:id/versions 与 GET /app-deployments 原样保留为过渡期
   * alias（/versions 面向快照/回滚消费且携带 deployCount 合成行，本端点面向
   * 部署追溯，两者数据同源）。
   *
   * 行来源：
   *  - 版本行（application_versions，分页主体）：packageUrl 取快照内当次部署
   *    值（历史语义，不回退应用当前 packageUrl）；deploymentStatus/deployedAt
   *    取该版本 deployedVersion 匹配的**最近一次**部署（createdAt DESC 首行，
   *    同版本多实例/多次部署各计入 deploymentCount）；**无部署的版本行也出现**
   *    （部署字段为 null）。
   *  - 合成行（synthetic=true）：有部署记录但从未保存版本快照（心跳竞态等历史
   *    数据），按 deployedVersion 聚合出最近一次部署一行，对齐 /versions 的
   *    legacy fallback 语义。仅两表皆空的应用整表为空（应用刚创建未部署，
   *    无追溯对象——不回退应用当前 packageUrl 造一行，理由同上）。
   *  - synthetic 行只参与第 1 页（聚合行天然很少，不额外分页）。
   *
   * 已知来源缺失（详见 docs/api-reference.md）：
   *  - operator：读 application_versions.createdBy 列，当前所有写入路径均未
   *    填充 → 恒 null，行上带 operatorMissingReason 标注；
   *  - triggerType：两表无 trigger 列，按部署行持久化信号推导（classifyRelease
   *    Trigger），历史升级复用既有部署行时状态信息已被覆盖，无法判定时 unknown。
   */
  async getReleases(
    applicationId: string,
    page = 1,
    pageSize = RELEASES_DEFAULT_PAGE_SIZE,
  ): Promise<{
    data: AppReleaseRow[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const safePageSize = Math.min(
      Math.max(1, Math.trunc(Number(pageSize)) || RELEASES_DEFAULT_PAGE_SIZE),
      RELEASES_MAX_PAGE_SIZE,
    );
    const safePage = Math.max(1, Math.trunc(Number(page)) || 1);

    const [versions, total] = await this.versionRepo.findAndCount({
      where: { applicationId },
      order: { createdAt: "DESC", id: "DESC" },
      skip: (safePage - 1) * safePageSize,
      take: safePageSize,
    });

    // 一次取回本分页版本关联的全部部署行（createdAt DESC → 每版本首见即最新）。
    // 行数受该应用部署总量约束，与既有 buildDeployCountMap/findAllByApp 同一
    // 读取面量级；聚合在内存完成（count + 最新行 + 触发方式推导）。
    const versionStrings = versions.map((v) => v.version);
    const deploymentsForVersions = versionStrings.length
      ? await this.repo.find({
          where: { applicationId, deployedVersion: In(versionStrings) },
          order: { createdAt: "DESC" },
        })
      : [];
    const latestByDeployment = new Map<string, AppDeployment>();
    const deployCountByDeployment = new Map<string, number>();
    for (const d of deploymentsForVersions) {
      if (!d.deployedVersion) continue;
      if (!latestByDeployment.has(d.deployedVersion)) {
        latestByDeployment.set(d.deployedVersion, d);
      }
      deployCountByDeployment.set(
        d.deployedVersion,
        (deployCountByDeployment.get(d.deployedVersion) ?? 0) + 1,
      );
    }

    // 版本行的触发方式来自其 source 部署行（快照诞生时那次 push 的载体）。
    const sourceIds = [
      ...new Set(
        versions
          .map((v) => v.sourceDeploymentId)
          .filter((x): x is string => Boolean(x)),
      ),
    ];
    const sourceDeployments = sourceIds.length
      ? await this.repo.find({ where: { id: In(sourceIds) } })
      : [];
    const sourceById = new Map(sourceDeployments.map((d) => [d.id, d]));

    const data: AppReleaseRow[] = versions.map((v) => {
      const latest = latestByDeployment.get(v.version) ?? null;
      const snapshot =
        v.snapshot && typeof v.snapshot === "object"
          ? (v.snapshot as Record<string, any>)
          : {};
      const packageUrl =
        typeof snapshot.packageUrl === "string" && snapshot.packageUrl
          ? snapshot.packageUrl
          : null;
      const triggerSource = latest ?? sourceById.get(v.sourceDeploymentId ?? "");
      const deployedAt =
        (latest?.deployedAt ?? latest?.createdAt ?? null) ?? null;
      return {
        id: v.id,
        version: v.version,
        packageUrl,
        gitCommit: v.gitCommit ?? null,
        deployedAt: deployedAt ? new Date(deployedAt).toISOString() : null,
        latestDeploymentId: latest?.id ?? null,
        deploymentStatus: latest?.status ?? null,
        deploymentCount: deployCountByDeployment.get(v.version) ?? 0,
        executorAddress: latest?.executorAddress ?? null,
        runMode: latest?.runMode ?? null,
        triggerType: this.classifyReleaseTrigger(triggerSource),
        operator: v.createdBy ?? null,
        operatorSource: "application_versions.createdBy",
        operatorMissingReason: RELEASE_OPERATOR_MISSING_REASON,
        sourceDeploymentId: v.sourceDeploymentId ?? null,
        status: v.status,
        createdAt: v.createdAt ? new Date(v.createdAt).toISOString() : null,
        synthetic: false,
      };
    });

    // synthetic 聚合行（仅第 1 页）：优先覆盖无快照行的应用（整表回退，与
    // /versions 的 legacy fallback 同语义），否则补「有部署但版本不在快照表」
    // 的孤儿 deployedVersion。
    if (safePage === 1) {
      const allDeployments = await this.repo.find({
        where: { applicationId },
        order: { createdAt: "DESC" },
      });
      const seen = new Map<string, { latest: AppDeployment; count: number }>();
      for (const d of allDeployments) {
        const key = d.deployedVersion ?? "__unknown__";
        const cur = seen.get(key);
        if (cur) cur.count += 1;
        else seen.set(key, { latest: d, count: 1 });
      }
      const snapshotVersions = new Set(
        versions.length === 0
          ? [] // 整表回退分支：无快照行可比对，全部部署聚合都出 synthetic 行
          : (
              await this.versionRepo.find({
                where: { applicationId },
                select: ["version"] as never,
              })
            ).map((v) => v.version),
      );
      for (const [key, { latest, count }] of seen) {
        if (versions.length > 0) {
          if (key === "__unknown__") continue;
          if (snapshotVersions.has(key)) continue;
        }
        const deployedAt = latest.deployedAt ?? latest.createdAt ?? null;
        data.push({
          id: null,
          version: key === "__unknown__" ? null : key,
          packageUrl: null,
          gitCommit: latest.deployedCommit ?? null,
          deployedAt: deployedAt ? new Date(deployedAt).toISOString() : null,
          latestDeploymentId: latest.id,
          deploymentStatus: latest.status,
          deploymentCount: count,
          executorAddress: latest.executorAddress ?? null,
          runMode: latest.runMode ?? null,
          triggerType: this.classifyReleaseTrigger(latest),
          operator: null,
          operatorSource: "application_versions.createdBy",
          operatorMissingReason: RELEASE_OPERATOR_MISSING_REASON,
          sourceDeploymentId: latest.id,
          status: latest.status,
          createdAt: deployedAt ? new Date(deployedAt).toISOString() : null,
          synthetic: true,
        });
      }
    }

    // 统一视图时间序：最近部署在前，无部署的版本行按快照时刻落位。
    data.sort(
      (a, b) =>
        releaseSortTimestampMs({
          deployedAt: b.deployedAt,
          versionCreatedAt: b.createdAt,
        }) -
        releaseSortTimestampMs({
          deployedAt: a.deployedAt,
          versionCreatedAt: a.createdAt,
        }),
    );

    return { data, total, page: safePage, pageSize: safePageSize };
  }

  /** DEP-01：从部署行的持久化信号推导触发方式（无 trigger 列，零 schema 变更）。
   *  规则（按优先级）：
   *   1. statusMessage 含升级指纹（"Upgrade triggered"/"Pulling latest
   *      commit…"，upgrade() 与升级 push 路径写入）→ upgrade；
   *   2. deployedAt 已置位（pushDeployToExecutor 成功分支写入；upgrade() 复用
   *      既有行也会置位，故已被规则 1 的指纹先行拦截）→ manual；
   *   3. 其余（PENDING 未推送/失败超时/system 文案/竞态后心跳覆盖）→ unknown。
   *  已知限制：行复用升级且 push 成功后 statusMessage 被覆盖为部署文案、指纹
   *  丢失时可能误判 manual —— 持久化 trigger 列属后续轮 schema 工作。 */
  private classifyReleaseTrigger(
    deployment: AppDeployment | null | undefined,
  ): ReleaseTriggerType | null {
    if (!deployment) return null;
    const msg = deployment.statusMessage ?? "";
    if (
      msg.startsWith("Upgrade triggered") ||
      msg.startsWith("Pulling latest commit")
    ) {
      return "upgrade";
    }
    if (deployment.deployedAt) return "manual";
    return "unknown";
  }

  async rollbackApplication(appId: string, targetId: string) {
    // R1: deployment-mutating paths must read the raw env (the snapshot
    // carries the env that gets written back); bypass the read-surface
    // masking applied by appService.findById.
    const app = await this.appService.findByIdRaw(appId);
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
    // R16: legacy deployments predate version snapshots and carry no
    // packageUrl column of their own; the only related value is the parent
    // application's CURRENT packageUrl, which is not a historical artifact —
    // "restoring" it would be a no-op dressed up as a rollback. So the
    // legacy path restores version/commit only and explicitly declines the
    // packageUrl restore (exposed as packageUrlRestored=false in the
    // response below). Rollbacks that must pin a package file should target
    // a version snapshot (which stores packageUrl in its snapshot payload).
    const updatedApp = await this.appService.update(appId, updateDto);
    const result = await this.upgradeRunningDeployments(appId);
    return {
      ...result,
      rolledBackTo: target.deployedVersion,
      versionId: null,
      // R16: explicit marker — legacy rollback cannot restore packageUrl.
      packageUrlRestored: false,
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
    // R1: deploy pushes the app env to the executor — must be the raw
    // value (read-surface masking would deliver "***" to the runner).
    const app = await this.appService.findByIdRaw(applicationId);

    // Duplicate-deployment guard: reject if a PENDING, DEPLOYING or UPGRADING
    // record already exists for this application (regardless of executor).
    // This prevents double-clicking the deploy button or concurrent webhook
    // retries from spawning two real processes.
    // QA4: UPGRADING must be covered too — upgrade() keeps the row in
    // UPGRADING for the whole push (R5), and the partial unique index below
    // intentionally does NOT constrain UPGRADING rows (concurrent rolling
    // upgrades of one application must not collide on it). A deploy issued
    // while an upgrade is in flight would therefore pass the index and start
    // a second real process on the executor; the application-layer guard is
    // the only interception point for that case.
    const inFlight = await this.repo.findOne({
      where: [
        { applicationId, status: DeploymentStatus.PENDING },
        { applicationId, status: DeploymentStatus.DEPLOYING },
        { applicationId, status: DeploymentStatus.UPGRADING },
      ],
    });
    if (inFlight) {
      // QA4: 409 (not 400) — same conflict semantics and same message as the
      // unique-violation branch below, so both interception surfaces answer
      // identically.
      throw new ConflictException(
        `Application ${app.name} already has an in-progress deployment ` +
          `(id=${inFlight.id}, status=${inFlight.status}). ` +
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

    // R5: the findOne guard above is TOCTOU-racy — two concurrent deploy()
    // calls can both pass it. The partial unique index
    // uq_app_deployments_application_in_flight (migration 1789000000000) is
    // the real race-closing guard: the losing insert fails with 23505 and is
    // surfaced here as the same "already in-progress" rejection the guard
    // raises (409 instead of 400).
    let saved: AppDeployment;
    try {
      saved = await this.repo.save(deployment);
    } catch (err: unknown) {
      if (this.isInFlightUniqueViolation(err)) {
        throw new ConflictException(
          `Application ${app.name} already has an in-progress deployment. ` +
            `Wait for it to finish or cancel it first.`,
        );
      }
      throw err;
    }

    // Asynchronously push deploy command to executor
    this.pushDeployToExecutor(saved, app).catch((err) => {
      this.logger.error(`Failed to push deploy to executor: ${err.message}`);
    });

    // QA1: HTTP response is a read surface — return masked.
    return this.maskDeploymentForRead(saved);
  }

  /**
   * Trigger upgrade on an existing deployment (git pull + restart).
   */
  async upgrade(deploymentId: string): Promise<AppDeployment> {
    // R1/QA1: raw lookup — the merged env is pushed to the executor AND the
    // entity is saved back; either step persisting the masked surface would
    // destroy the stored secrets with '***'.
    const deployment = await this.findByIdRaw(deploymentId);
    // R1: upgrade pushes the merged app+deployment env to the executor —
    // must be the raw value, not the masked read surface.
    const app = await this.appService.findByIdRaw(deployment.applicationId);

    deployment.status = DeploymentStatus.UPGRADING;
    deployment.statusMessage = "Upgrade triggered";
    await this.repo.save(deployment);

    this.pushDeployToExecutor(deployment, app, true).catch((err) => {
      this.logger.error(`Upgrade push failed: ${err.message}`);
    });

    // QA1: HTTP response is a read surface — return masked (the push above
    // used the raw entity).
    return this.maskDeploymentForRead(deployment);
  }

  /**
   * Stop a running deployment.
   */
  async stop(deploymentId: string): Promise<AppDeployment> {
    // QA1: raw lookup — the entity is saved back below; persisting the
    // masked read surface would overwrite stored env secrets with '***'.
    const deployment = await this.findByIdRaw(deploymentId);

    try {
      const url = this.executorService.getExecutorUrl(
        deployment.executorAddress,
        `api/app-stop`,
      );
      // R8: stop() is an outbound admin→executor request, same exposure as
      // dispatch — run the executor SSRF policy (metadata/link-local refused)
      // before contacting the address. A refusal is logged and treated like
      // any other stop-signal failure: the row still transitions to STOPPED.
      await assertSafeExecutorUrl(url);
      await axios.post(
        url,
        { deploymentId: deployment.id },
        { timeout: 10_000, headers: await this.getExecutorHeaders() },
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Stop signal failed (executor may be offline): ${msg}`);
    }

    deployment.status = DeploymentStatus.STOPPED;
    deployment.pid = null;
    const saved = await this.repo.save(deployment);
    // QA1: mask the HTTP return; the raw entity was already persisted.
    return this.maskDeploymentForRead(saved);
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
    // FEAT-07: 部署终态落库后发布 deployment.completed（status=running 视为
    // 完成；fail-open，eventBus 为 null 时静默跳过）。
    this.emitDeploymentCompleted(deployment);
  }

  /**
   * FEAT-07: 部署终态落库后发布 deployment.completed（fail-open；载荷全为
   * 原始类型，与 domain-events.ts 设计约束一致）。
   */
  private emitDeploymentCompleted(deployment: AppDeployment): void {
    if (!this.eventBus) return;
    if (deployment.status !== DeploymentStatus.RUNNING) return;
    const payload: DeploymentCompletedEventPayload = {
      deploymentId: deployment.id,
      applicationId: deployment.applicationId,
      executorAddress: deployment.executorAddress,
      status: deployment.status,
      deployedVersion: deployment.deployedVersion ?? null,
      deployedCommit: deployment.deployedCommit ?? null,
      occurredAt: new Date().toISOString(),
    };
    try {
      this.eventBus.emit(DOMAIN_EVENTS.DEPLOYMENT_COMPLETED, payload);
    } catch {
      /* bus contract is fail-open; second fuse */
    }
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * R5: detect a Postgres unique-violation (SQLSTATE 23505) for a specific
   * constraint. TypeORM wraps the driver error in a QueryFailedError
   * (driverError / cause carry `code` and `constraint`), so walk one wrapper
   * level deep and require the constraint name — any other unique violation
   * must not be misreported.
   * (QA6: shared by the in-flight deployment guard and the version-snapshot
   * dedupe.)
   */
  private isUniqueViolationWithConstraint(
    err: unknown,
    constraint: string,
  ): boolean {
    const candidates: Array<Record<string, unknown> | unknown> = [err];
    if (err && typeof err === "object") {
      candidates.push((err as any).driverError, (err as any).cause);
    }
    for (const e of candidates) {
      if (!e || typeof e !== "object") continue;
      const anyErr = e as {
        code?: string;
        constraint?: string;
        message?: string;
      };
      if (anyErr.constraint === constraint) return true;
      if (
        anyErr.code === "23505" &&
        typeof anyErr.message === "string" &&
        anyErr.message.includes(constraint)
      ) {
        return true;
      }
    }
    return false;
  }

  private isInFlightUniqueViolation(err: unknown): boolean {
    return this.isUniqueViolationWithConstraint(err, IN_FLIGHT_UNIQUE_INDEX);
  }

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
    // R5: upgrades keep the row in UPGRADING for the whole push. Transitioning
    // to DEPLOYING here would make concurrent rolling upgrades of multiple
    // RUNNING deployments of the same application collide on the partial
    // unique index uq_app_deployments_application_in_flight. The executor's
    // heartbeat moves the row to RUNNING (or FAILED) afterwards.
    deployment.status = upgrade
      ? DeploymentStatus.UPGRADING
      : DeploymentStatus.DEPLOYING;
    deployment.statusMessage = upgrade
      ? "Pulling latest commit..."
      : "Cloning repository...";
    await this.repo.save(deployment);

    // SSRF guard: validate address format before making any outbound request.
    // R8: format-only validation was not enough — the address is
    // executor-controlled (register/heartbeat carry it), so a poisoned row
    // could point the authenticated deploy push at cloud metadata / loopback
    // while skipping the guard entirely (dispatch and package-push both run
    // assertSafeExecutorUrl). The full URL goes through the same policy; a
    // refusal takes the FAILED branch below like any other push failure.
    const url = this.executorService.getExecutorUrl(
      deployment.executorAddress,
      "api/deploy",
    );
    try {
      this.validateExecutorAddress(deployment.executorAddress);
      await assertSafeExecutorUrl(url);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      deployment.status = DeploymentStatus.FAILED;
      deployment.statusMessage = msg;
      await this.repo.save(deployment);
      return;
    }

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
          headers: await this.getExecutorHeaders(),
        });
        // Success
        deployment.status = upgrade
          ? DeploymentStatus.UPGRADING
          : DeploymentStatus.DEPLOYING;
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

    try {
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
    } catch (err: unknown) {
      // QA6: uq_application_versions_applicationId_version constrains only
      // (applicationId, version), while the findOne dedupe above keys on
      // sourceDeploymentId as well. When the same application rolls out on
      // several executors concurrently (rolling upgrade), every instance
      // passes the dedupe check but only the first INSERT wins; the losers
      // fail with 23505. That must NOT fail the push — the executor already
      // accepted the deploy and the snapshot row exists (first writer wins),
      // so swallow exactly that violation and keep the push-success semantics.
      if (
        this.isUniqueViolationWithConstraint(
          err,
          "uq_application_versions_applicationId_version",
        )
      ) {
        this.logger.warn(
          `Version snapshot for ${app.id}@${app.version} already exists ` +
            `(concurrent deployment ${deployment.id}) — skipping duplicate snapshot`,
        );
        return;
      }
      throw err;
    }
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

  /** QA1: shallow-clone a version snapshot with its env record masked. */
  private maskSnapshotForRead(
    snapshot: Record<string, any> | null,
  ): Record<string, any> | null {
    if (!snapshot || typeof snapshot !== "object") return snapshot;
    if (!("env" in snapshot)) return snapshot;
    return {
      ...snapshot,
      env: this.appService.maskEnvForRead(snapshot.env),
    };
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

  /** Scan every 2 minutes for deployments stuck in an in-progress state
   *  ('deploying'/'upgrading') with no update for > 10 minutes and mark them
   *  failed.
   *  R6: the predicate used to be createdAt-based — a legacy deployment
   *  upgraded (re-entering DEPLOYING on the SAME row) kept its original
   *  createdAt and was mis-marked FAILED by this cron 10 minutes later,
   *  polluting the version snapshot. updatedAt is refreshed both when the
   *  row enters DEPLOYING/UPGRADING (status save) and on every heartbeat
   *  save, so the semantics are now "in-progress and untouched for 10
   *  minutes". UPGRADING is included because upgrades no longer pass through
   *  DEPLOYING (R5 index compatibility) and still need the same timeout
   *  coverage.
   *  QA5: PENDING is swept on a shorter threshold (5 minutes). deploy()
   *  INSERTs the row as PENDING and pushes to the executor asynchronously —
   *  a crash between the two steps leaves the row PENDING forever, where it
   *  keeps matching the partial unique index
   *  uq_app_deployments_application_in_flight and permanently 409s every
   *  future deployment of the application. The normal PENDING window is
   *  process-internal (auto-select + push retries ≈ <100s), so 5 minutes is
   *  safely above any legitimate hold. */
  @Cron("0 */2 * * * *")
  async detectStuckDeployments(): Promise<void> {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const stuck = await this.repo.find({
      where: [
        {
          status: DeploymentStatus.PENDING,
          updatedAt: LessThan(fiveMinutesAgo),
        },
        {
          status: DeploymentStatus.DEPLOYING,
          updatedAt: LessThan(tenMinutesAgo),
        },
        {
          status: DeploymentStatus.UPGRADING,
          updatedAt: LessThan(tenMinutesAgo),
        },
      ],
    });
    if (stuck.length === 0) return;
    for (const d of stuck) {
      const pendingTimedOut = d.status === DeploymentStatus.PENDING;
      d.status = DeploymentStatus.FAILED;
      d.statusMessage = pendingTimedOut
        ? "[System] Deployment stuck in PENDING (deploy push never started, " +
          "likely a restart between insert and push) — timed out after 5 minutes"
        : "[System] Deployment timed out after 10 minutes";
      await this.repo.save(d);
      await this.markVersionSnapshotStatus(d, "failed");
      this.logger.warn(
        `Stuck deployment marked FAILED: id=${d.id}, app=${d.applicationId}, status=${d.status}`,
      );
    }
  }
}
