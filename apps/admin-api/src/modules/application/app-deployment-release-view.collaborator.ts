import type { Logger } from "@nestjs/common";
import type { Repository } from "typeorm";
import { In } from "typeorm";
import { AppError } from "../../common/errors/app-error";
import { ErrorCode } from "../../common/errors/error-codes";
import type { AppDeployment } from "./entities/app-deployment.entity";
import type { ApplicationVersion } from "./entities/application-version.entity";
import {
  type AppDeploymentEvent,
  AppDeploymentEventType,
} from "./entities/app-deployment-event.entity";
import type { ApplicationService } from "./application.service";
import type { ExecutorService } from "../executor/executor.service";
import {
  AppReleaseRow,
  AppReleaseDevice,
  ReleaseTriggerType,
  RELEASE_OPERATOR_MISSING_REASON,
} from "./dto/app-release.dto";

/**
 * T1-B5a：**版本 × 部署只读追溯视图**（DEP-01）协作者。
 *
 * ## 边界：只搬「读视图拼装」，零写、零事务、零可变状态
 *
 * 收 11 个成员，全部服务于两条**只读**追溯面：
 *   · `getVersionHistory`（/applications/:id/versions）
 *   · `getReleases`（/applications/:id/releases）
 * 及其复用 helper：设备徽标聚合、触发方式推导、版本恢复映射与三重守卫、
 * 部署计数与 legacy 回退、快照 env 掩码。
 *
 * **本簇内不存在任何实例级可变状态**（已实测：只有局部 Map；唯一的实例
 * Map `rolloutBatches` 属编排簇，不在此列）。也**无 S3 / 缓存字段依赖**
 * ⇒ 不需要「按引用共享」纪律，与 scheduler / rolloutBatches 那类
 * 「状态机本体」有本质区别。
 *
 * ## 为什么这 11 个成员可以整段搬走（耦合形式实测）
 *
 * spec 侧**只有 ① 直调**，dangerous=0（逐个实测：spyOn / 赋值覆写 /
 * 括号访问 / 索引断言全为 0）。其中 `getVersionHistory` / `getReleases` /
 * `buildVersionRestoreDto` / `assertVersionRestorable` 仍被 controller 或
 * Facade 的写面方法调用 ⇒ **Facade 保留同名转发方法**。
 *
 * ## 只读性是一条不变量（不是描述）
 *
 * 本类只调用 `repo.find/findAndCount/findOne`、`versionRepo.find`、
 * `deploymentEventRepo.count/getRawMany`、`executorService.getAppVersionFacts`
 * 与 `appService.maskEnvForRead` —— **没有任何 save/update/delete/insert、
 * 没有 transaction**。变异测试（让只读簇写库）会断言这一点并转红，见
 * `__tests__/app-deployment-release-view.collaborator.spec.ts`。
 */

/** 计入「该版本累计部署次数」的事件类型（R4 §4.1A）。 */
const DEPLOY_COUNTED_EVENT_TYPES: string[] = [
  AppDeploymentEventType.DEPLOY_CREATED,
  AppDeploymentEventType.REDEPLOY_REUSED,
  AppDeploymentEventType.UPGRADE,
];

/** DEP-01：/releases 分页参数（默认 50，上限 200，防全表拖库）。 */
export const RELEASES_DEFAULT_PAGE_SIZE = 50;
export const RELEASES_MAX_PAGE_SIZE = 200;

/** A-6：/releases 第 1 页 synthetic 聚合的部署行扫描限幅。 */
export const RELEASES_SYNTHETIC_SCAN_PAGE_SIZE = 1000;
export const RELEASES_SYNTHETIC_SCAN_MAX_ROWS = 5000;

/** DEP-01：统一列表的排序键（毫秒时间戳）。纯函数便于测试。 */
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

/** 设备级版本事实（`ExecutorService.getAppVersionFacts` 的行形状）。 */
export type AppVersionFact = Awaited<
  ReturnType<ExecutorService["getAppVersionFacts"]>
>[number];

/** 协作者依赖（全部最小面）。 */
export interface AppDeploymentReleaseViewDeps {
  /** 部署行仓库（**只读**）。 */
  repo: Repository<AppDeployment>;
  /** 版本快照仓库（**只读**）。 */
  versionRepo: Repository<ApplicationVersion>;
  /** 部署事件仓库（可缺席 ⇒ 部署计数回退行计数口径）。 */
  deploymentEventRepo: Repository<AppDeploymentEvent> | null;
  /** 应用服务（只用到 maskEnvForRead）。 */
  appService: Pick<ApplicationService, "maskEnvForRead">;
  /** 执行器服务（只用到 getAppVersionFacts）。 */
  executorService: Pick<ExecutorService, "getAppVersionFacts">;
  /**
   * Facade 的 `findAllByApp`（① 直调的 public 读面，留 Facade）——
   * 本类**经回调**调用，不自持实现。
   */
  findAllByApp: (applicationId: string) => Promise<AppDeployment[]>;
  /** 日志（**必须是 Facade 的实例**）。 */
  logger: Logger;
}

export class AppDeploymentReleaseView {
  private readonly repo: Repository<AppDeployment>;
  private readonly versionRepo: Repository<ApplicationVersion>;
  private readonly deploymentEventRepo: Repository<AppDeploymentEvent> | null;
  private readonly appService: Pick<ApplicationService, "maskEnvForRead">;
  private readonly executorService: Pick<ExecutorService, "getAppVersionFacts">;
  private readonly findAllByAppCallback: (
    applicationId: string,
  ) => Promise<AppDeployment[]>;
  private readonly logger: Logger;

  constructor(deps: AppDeploymentReleaseViewDeps) {
    this.repo = deps.repo;
    this.versionRepo = deps.versionRepo;
    this.deploymentEventRepo = deps.deploymentEventRepo;
    this.appService = deps.appService;
    this.executorService = deps.executorService;
    this.findAllByAppCallback = deps.findAllByApp;
    this.logger = deps.logger;
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

  async getReleases(
    applicationId: string,
    page = 1,
    pageSize = RELEASES_DEFAULT_PAGE_SIZE,
  ): Promise<{
    data: AppReleaseRow[];
    total: number;
    page: number;
    pageSize: number;
    /** R4（§4.7）：synthetic 扫描到达 RELEASES_SYNTHETIC_SCAN_MAX_ROWS 上限
     *  （聚合以已扫描部分为准）时 true——去静默截断。只增不改的响应字段。 */
    truncated: boolean;
    /** P8-R（部署模型评审遗留）：truncated=true 吞掉被截版本的 devices 徽标时，
     *  列出「有设备保留（currentVersion 命中或 ∈ retainedVersions）但不在
     *  本页返回行中」的版本号——「设备还留着这版」的事实不因分页截断而消失。
     *  恒为数组和 truncated=false 时空数组；版本号按本页版本行同序（createdAt
     *  DESC）回退字母序。只增不改的响应字段。 */
    retainedButTruncated: string[];
  }> {
    const safePageSize = Math.min(
      Math.max(1, Math.trunc(Number(pageSize)) || RELEASES_DEFAULT_PAGE_SIZE),
      RELEASES_MAX_PAGE_SIZE,
    );
    const safePage = Math.max(1, Math.trunc(Number(page)) || 1);
    // R4（§4.7）：synthetic 扫描只在第 1 页跑——第 2+ 页无扫描即无截断，false。
    let truncated = false;

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

    // R3-A（§4.3）：设备级版本事实（心跳上报，executor_app_versions）——
    // 每版本行聚合 devices 徽标（正在运行/本地保留该版本的设备）。一次取全
    // 应用事实、行内内存匹配；无任何设备上报（旧执行器混合窗口期）时为
    // 空数组，行上 devices 恒存在（只增不改），部署行推断字段原样保留。
    const deviceFacts =
      await this.executorService.getAppVersionFacts(applicationId);

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
      const triggerSource =
        latest ?? sourceById.get(v.sourceDeploymentId ?? "");
      const deployedAt = latest?.deployedAt ?? latest?.createdAt ?? null;
      // FEAT-20: operator 取最近一次部署行持久化列（JWT 用户名）；
      // 存量行回退版本快照 createdBy（历史恒 null）。来源随命中面标注。
      const operator = latest?.operator ?? v.createdBy ?? null;
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
        triggerType: this.resolveReleaseTrigger(triggerSource),
        operator,
        operatorSource: latest?.operator
          ? "deployments.operator"
          : "application_versions.createdBy",
        operatorMissingReason: operator ? "" : RELEASE_OPERATOR_MISSING_REASON,
        sourceDeploymentId: v.sourceDeploymentId ?? null,
        status: v.status,
        createdAt: v.createdAt ? new Date(v.createdAt).toISOString() : null,
        synthetic: false,
        devices: this.buildReleaseDevices(v.version, deviceFacts),
      };
    });

    // synthetic 聚合行（仅第 1 页）：优先覆盖无快照行的应用（整表回退，与
    // /versions 的 legacy fallback 同语义），否则补「有部署但版本不在快照表」
    // 的孤儿 deployedVersion。
    if (safePage === 1) {
      // A-6: 整表 find 改为分页流式聚合——createdAt DESC 保证「每版本首见
      // 即最新行」在流式累计下不变（后续页只给已有 key 加计数/补新 key），
      // 响应形状与语义完全不变；页大小与总行数双限幅防全表拖库。
      const seen = new Map<string, { latest: AppDeployment; count: number }>();
      for (
        let skip = 0;
        skip < RELEASES_SYNTHETIC_SCAN_MAX_ROWS;
        skip += RELEASES_SYNTHETIC_SCAN_PAGE_SIZE
      ) {
        const rows = await this.repo.find({
          where: { applicationId },
          order: { createdAt: "DESC" },
          skip,
          take: RELEASES_SYNTHETIC_SCAN_PAGE_SIZE,
        });
        for (const d of rows) {
          const key = d.deployedVersion ?? "__unknown__";
          const cur = seen.get(key);
          if (cur) cur.count += 1;
          else seen.set(key, { latest: d, count: 1 });
        }
        if (rows.length < RELEASES_SYNTHETIC_SCAN_PAGE_SIZE) break;
        // R4（§4.7）：本页扫满且已到总扫描上限——此前这里静默截断（§P8），
        // 现在显式上报 truncated=true（响应字段只增）。
        if (
          skip + RELEASES_SYNTHETIC_SCAN_PAGE_SIZE >=
          RELEASES_SYNTHETIC_SCAN_MAX_ROWS
        ) {
          truncated = true;
        }
      }
      const snapshotVersions = new Set(
        versions.length === 0
          ? [] // 整表回退分支：无快照行可比对，全部部署聚合都出 synthetic 行
          : (
              await this.versionRepo.find({
                where: { applicationId },
                select: { version: true } as never,
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
          triggerType: this.resolveReleaseTrigger(latest),
          operator: latest.operator ?? null,
          operatorSource: latest.operator
            ? "deployments.operator"
            : "application_versions.createdBy",
          operatorMissingReason: latest.operator
            ? ""
            : RELEASE_OPERATOR_MISSING_REASON,
          sourceDeploymentId: latest.id,
          status: latest.status,
          createdAt: deployedAt ? new Date(deployedAt).toISOString() : null,
          synthetic: true,
          // R3-A：synthetic 行同享设备徽标（key 是真实版本串时；__unknown__
          // 无版本可比对 → devices 恒空）。
          devices: this.buildReleaseDevices(
            key === "__unknown__" ? null : key,
            deviceFacts,
          ),
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

    return {
      data,
      total,
      page: safePage,
      pageSize: safePageSize,
      truncated,
      // P8-R：truncated=true 时被截版本的 devices 徽标整行不可见——用同一份
      // 全应用设备事实（getAppVersionFacts 本就与页无关地全量拉回）求差集，
      // 把「有设备保留但不在本页行中」的版本号显式带回，零额外查询。
      retainedButTruncated: truncated
        ? this.buildRetainedButTruncated(data, deviceFacts)
        : [],
    };
  }

  private buildReleaseDevices(
    version: string | null,
    facts: Awaited<ReturnType<ExecutorService["getAppVersionFacts"]>>,
  ): AppReleaseDevice[] {
    if (!version) return [];
    return facts
      .filter(
        (f) =>
          f.currentVersion === version || f.retainedVersions.includes(version),
      )
      .map((f) => ({
        executorId: f.executorId,
        executorName: f.executorName,
        currentVersion: f.currentVersion,
        retained: f.retainedVersions.includes(version),
        online: f.online,
        lastHeartbeat: f.lastHeartbeat,
      }));
  }

  private buildRetainedButTruncated(
    rows: AppReleaseRow[],
    facts: Awaited<ReturnType<ExecutorService["getAppVersionFacts"]>>,
  ): string[] {
    const present = new Set<string>();
    for (const r of rows) {
      if (r.version) present.add(r.version);
    }
    const missing = new Set<string>();
    for (const f of facts) {
      if (f.currentVersion && !present.has(f.currentVersion)) {
        missing.add(f.currentVersion);
      }
      for (const v of f.retainedVersions) {
        if (!present.has(v)) missing.add(v);
      }
    }
    return [...missing].sort();
  }

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

  private resolveReleaseTrigger(
    deployment: AppDeployment | null | undefined,
  ): ReleaseTriggerType | null {
    if (!deployment) return null;
    if (deployment.triggerType) {
      return deployment.triggerType as ReleaseTriggerType;
    }
    return this.classifyReleaseTrigger(deployment);
  }

  buildVersionRestoreDto(
    app: { runtime: string },
    version: {
      version: string;
      gitCommit?: string | null;
      snapshot?: Record<string, any> | null;
    },
  ): Record<string, any> | null {
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
    return updateDto;
  }

  assertVersionRestorable(
    appId: string,
    version: {
      applicationId: string;
      version: string | null;
      status: string | null;
    },
  ): void {
    if (version.applicationId !== appId) {
      throw new AppError(ErrorCode.APP_ROLLBACK_VERSION_OTHER_APP);
    }
    if (!version.version) {
      throw new AppError(ErrorCode.APP_ROLLBACK_VERSION_NO_NUMBER);
    }
    if (version.status !== "released") {
      throw new AppError(ErrorCode.APP_ROLLBACK_VERSION_NOT_RELEASED);
    }
  }

  private async buildDeployCountMap(
    applicationId: string,
  ): Promise<Map<string, number>> {
    if (this.deploymentEventRepo) {
      const eventCount = await this.deploymentEventRepo.count({
        where: { applicationId },
      });
      if (eventCount > 0) {
        const rows: Array<Record<string, unknown>> =
          await this.deploymentEventRepo
            .createQueryBuilder("e")
            .select("e.deployedVersion", "version")
            .addSelect("COUNT(*)", "count")
            .where("e.applicationId = :applicationId", { applicationId })
            .andWhere("e.eventType IN (:...types)", {
              types: DEPLOY_COUNTED_EVENT_TYPES,
            })
            .andWhere("e.deployedVersion IS NOT NULL")
            .groupBy("e.deployedVersion")
            .getRawMany();
        const countMap = new Map<string, number>();
        for (const row of rows) {
          // pg 驱动下 COUNT(*) 回 bigint 字符串（findStats 同款收口）。
          const n = Number(row.count);
          if (typeof row.version === "string" && Number.isFinite(n) && n > 0) {
            countMap.set(row.version, n);
          }
        }
        return countMap;
      }
    }
    // legacy 回退：事件表空（或测试装配缺席）→ 既有行计数语义。
    const deployments = await this.findAllByAppCallback(applicationId);
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
    const deployments = await this.findAllByAppCallback(applicationId);
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
}
