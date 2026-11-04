import { Logger } from "@nestjs/common";
import { AppError } from "../../common/errors/app-error";
import { ErrorCode } from "../../common/errors/error-codes";
import { validateRegisterIdentityFields } from "./executor-register-validate.util";
import {
  normalizeDeployedApps,
  MAX_DEPLOYED_APPS,
  type DeployedAppReport,
} from "./deployed-apps.util";
import {
  normalizeInterpreters,
  type ExecutorInterpreter,
} from "./interpreter-match.util";
import { normalizeInstalledPackages } from "./deployed-apps.util";
import type { InstalledPackageReport } from "./deployed-apps.util";

/**
 * T1-B3d：`register` 的**上报值校验与归一**协作者。
 *
 * ## 边界：只搬「什么值合法」，**裁决与副作用全部留 Facade**
 *
 * 本类只做三件**纯判定**的事：
 *   ① 入站身份字段校验（`appName` 必填 + `validateRegisterIdentityFields`）；
 *   ② 容量（`maxConcurrentTasks`）的取值域校验 —— 非法 ⇒ **视同未上报**（不落库）；
 *   ③ 三个清单字段（`interpreters` / `installedPackages` / `deployedApps`）的
 *      **三态归一**：缺省 / 非法 / 合法（含 `[]`）。
 *
 * **留在 Facade 的（本类一概不碰）**：
 *   · 身份解析与同址多行裁决（R32-C5/C6 的 fail-closed 409）；
 *   · **接管判定与接管写库**（判定读到 OFFLINE、写库时行已被点亮 ⇒ 覆盖别人的行
 *     ⇒ 判定与写必须**同 owner**）；
 *   · 新行创建、凭据/令牌下发、通知、事件；
 *   · `adopted` 登记、列级 patch（`pickOwnedColumns` + `REGISTER_OWNED_COLUMNS`
 *     —— **与 heartbeat 共用**，两个调用点必须同 owner）；
 *   · 两处 `repo.update`、`applyReportedAppVersions`（事务在它内部）。
 *
 * ## ⚠️ 依赖注入纪律：**禁止 import Facade**
 *
 * 本类是**普通 TS 类**（非 Nest provider）⇒ 需要 Facade 成员时一律**构造注入**，
 * **绝不** `import { ExecutorService }` 反向引用 Facade —— 那会构成
 * Facade↔协作者**循环 import**（且打穿「谁依赖谁」这条边界）。
 *
 * `ExecutorService.isAdoptableMaxConcurrentTasks` 有 **3 处**用量（register /
 * heartbeat / 另一路径）⇒ **留 Facade**，经 `deps` 注入。
 */

/** 注册上报的字段子集（只取本类校验/归一用到的那些）。 */
export interface ExecutorRegisterReportInput {
  appName?: string;
  address?: string;
  type?: string;
  capabilities?: string[] | null;
  runtime?: string[] | null;
  tags?: string[] | null;
  description?: string | null;
  groupName?: string | null;
  maxConcurrentTasks?: number;
  maxConcurrent?: number;
  interpreters?: ExecutorInterpreter[] | null;
  installedPackages?: InstalledPackageReport[] | null;
  deployedApps?: DeployedAppReport[] | null;
}

/** 归一结果（三态字段的 `null` 含义见各字段注释）。 */
export interface ExecutorRegisterReportResult {
  /** 容量：合法值；缺省或非法 ⇒ `undefined`（**视同未上报**）。 */
  maxConcurrentTasks: number | undefined;
  /** `interpreters`：缺省或非法 ⇒ `null`（不动 DB）；合法 ⇒ 数组（可空数组）。 */
  normalizedInterpreters: ExecutorInterpreter[] | null;
  /** `installedPackages`：同上三态。 */
  normalizedInstalledPackages: InstalledPackageReport[] | null;
  /** `deployedApps`：同上三态。 */
  normalizedDeployedApps: DeployedAppReport[] | null;
}

/** 协作者依赖（全部最小面）。 */
export interface ExecutorRegisterReportDeps {
  /** 日志（**必须是 Facade 的实例**——既有 spec spy 的是它）。 */
  logger: Logger;
  /** Facade 的 private static（3 处用量 ⇒ 留 Facade 注入）。 */
  isAdoptableMaxConcurrentTasks: (value: unknown) => boolean;
}

export class ExecutorRegisterReport {
  private readonly logger: Logger;
  private readonly deps: ExecutorRegisterReportDeps;

  constructor(deps: ExecutorRegisterReportDeps) {
    this.logger = deps.logger;
    this.deps = deps;
  }

  /**
   * 入站身份字段校验（**先于一切 DB 读/写**与身份解析路径）。
   *
   * 非法 ⇒ 抛 `EXECUTOR_REGISTER_FIELD_INVALID`（400）。`appName` 必填缺失在此拒绝
   * （appName 是行的身份列；controller /token 端点的 "executor" 兜底值本身合法，
   * 不触发本闸）。
   */
  assertValidIdentityFields(data: ExecutorRegisterReportInput): void {
    if (!data.appName || !data.appName.trim()) {
      throw new AppError("EXECUTOR_REGISTER_FIELD_INVALID", {
        field: "appName",
        reason: "必填（不能为空白）",
      });
    }
    const invalidField = validateRegisterIdentityFields(data);
    if (invalidField) {
      throw new AppError("EXECUTOR_REGISTER_FIELD_INVALID", invalidField);
    }
  }

  /**
   * 上报值校验与归一（容量 + 三个清单字段）。
   *
   * 容量口径（N-09 微基准发现的「注册/心跳采纳域不对称」）：
   * 心跳路径经 `isAdoptableMaxConcurrentTasks` 钳到正整数 1..10000，而
   * **register 路径此前零校验** ⇒ `maxConcurrentTasks: 0` 落库后
   *   ① `computeExecutorLoadScore` 的 `runningTaskCount / max` = 0/0 → **Infinity**；
   *   ② `selectLeastLoaded` 的容量闸 `runningTaskCount < max` → `0 < 0` 恒 false ⇒
   *      **该执行器被永久排除在派发之外**（"注册成功、永远收不到一个任务"）。
   * 故与心跳同口径：非法值视同**未上报**（不写 DB、保留既有值/列默认），
   * 而**不是**静默钳成某个值 —— 执行器自报面不可信，猜它"想报几"比不采纳更危险。
   *
   * 三态清单字段：缺省 → 不动 DB（旧执行器重注册不得把已上报的事实擦掉）；
   * 结构非法 → 整字段拒绝采纳 + warn；合法（**含 `[]`**，"已上报且池空"）→ 覆盖。
   */
  resolveRegisterReport(
    data: ExecutorRegisterReportInput,
    address: string,
  ): ExecutorRegisterReportResult {
    // ── 容量 ──
    const rawMaxConcurrent = data.maxConcurrentTasks ?? data.maxConcurrent;
    let maxConcurrentTasks: number | undefined;
    if (rawMaxConcurrent !== undefined) {
      if (this.deps.isAdoptableMaxConcurrentTasks(rawMaxConcurrent)) {
        maxConcurrentTasks = rawMaxConcurrent;
      } else {
        this.logger.warn(
          `Executor ${address} registered invalid maxConcurrentTasks=${String(
            rawMaxConcurrent,
          )} (expected integer in 1..10000); treating as not reported`,
        );
      }
    }

    // ── interpreters（三态）──
    const interpretersReported = data.interpreters !== undefined;
    const normalizedInterpreters = interpretersReported
      ? normalizeInterpreters(data.interpreters)
      : null;
    if (interpretersReported && normalizedInterpreters === null) {
      this.logger.warn(
        `Executor ${address} reported an invalid interpreters payload ` +
          `(expected an array of { version: "X.Y" | "X.Y.Z" }); keeping stored value`,
      );
    }

    // ── installedPackages（三态）──
    const installedPackagesReported = data.installedPackages !== undefined;
    const normalizedInstalledPackages = installedPackagesReported
      ? normalizeInstalledPackages(data.installedPackages)
      : null;
    if (installedPackagesReported && normalizedInstalledPackages === null) {
      this.logger.warn(
        `Executor ${address} reported an invalid installedPackages payload ` +
          `(expected an array of { name, type, version }); keeping stored value`,
      );
    }

    // ── deployedApps（三态；超限 ⇒ 拒绝，不截断）──
    const deployedAppsReported = data.deployedApps !== undefined;
    const normalizedDeployedApps = deployedAppsReported
      ? normalizeDeployedApps(data.deployedApps)
      : null;
    if (deployedAppsReported && normalizedDeployedApps === null) {
      this.logger.warn(
        `Executor ${address} reported an invalid deployedApps payload ` +
          `(expected an array of { appId, currentVersion, retainedVersions, ... }, ` +
          `<=${MAX_DEPLOYED_APPS} items); keeping stored executor_app_versions rows`,
      );
    }

    return {
      maxConcurrentTasks,
      normalizedInterpreters,
      normalizedInstalledPackages,
      normalizedDeployedApps,
    };
  }
}
