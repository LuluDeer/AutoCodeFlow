import { Logger } from "@nestjs/common";
import { AppError } from "../../common/errors/app-error";
import { ErrorCode } from "../../common/errors/error-codes";
import { validateRegisterIdentityFields } from "./executor-register-validate.util";
import type { Executor } from "./entities/executor.entity";
import { ExecutorType } from "./entities/executor.entity";
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
  /** 执行器版本（回执/载荷面；注册时写入 executorVersion 列）。 */
  version?: string;
  /** 派发模式（pull/push 切换随重注册生效）。 */
  dispatchMode?: string;
  /** 协议版本（可选整数；缺省/非法不动 DB）。 */
  protocolVersion?: number | null;
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

  /**
   * 把**已校验/已归一**的上报值写进实体并登记采纳集（T1-B3f）。
   *
   * ## 为什么是这一段能搬、而相邻两段不能
   *
   * 本方法**纯内存**：只有 `e.x = …` 与 `adopted.add(…)`，**零 IO / 零 QB /
   * 零事务 / 零事件**，且由 Facade 在**同一位置**调用一次（前后顺序逐字不变）。
   * 而它**上方的重启恢复分支**（`await failRunningExecutionsAfterRestart`）与
   * **下方的 `pickOwnedColumns` + 两处 `repo.update`** 都是副作用/判定，留在 Facade。
   *
   * `adopted` 是「本次真的采纳了这一列」的证据集：patch 由"白名单 ∩ adopted"
   * 投影（`REGISTER_OWNED_COLUMNS` 在 Facade），所以"没上报"的列连键都不会
   * 出现在 patch 里 —— 这正是 ADR-026 规则 4 的落点。
   */
  applyReportedColumns(args: {
    executor: Executor;
    data: ExecutorRegisterReportInput;
    capabilities: string[] | undefined;
    maxConcurrentTasks: number | undefined;
    normalizedInterpreters: ExecutorInterpreter[] | null;
    normalizedInstalledPackages: InstalledPackageReport[] | null;
    incomingFingerprint: string | null;
    adopted: Set<string>;
  }): void {
    const {
      executor: e,
      data,
      capabilities,
      maxConcurrentTasks,
      normalizedInterpreters,
      normalizedInstalledPackages,
      incomingFingerprint,
      adopted,
    } = args;
    // Update mutable fields on re-registration (whitelisted per-field only)
    // 每个赋值都同步进 `adopted`：值写进 e（返回体要用），列名证明"本次采纳了
    // 这一列"（patch 只会包含它）。
    if (data.type) {
      e.type = data.type as ExecutorType;
      adopted.add("type");
    }
    if (data.appName) {
      e.appName = data.appName;
      adopted.add("appName");
    }
    if (data.version) {
      e.executorVersion = data.version;
      adopted.add("executorVersion");
    }
    if (capabilities) {
      e.capabilities = capabilities;
      adopted.add("capabilities");
    }
    if (maxConcurrentTasks !== undefined) {
      e.maxConcurrentTasks = maxConcurrentTasks;
      adopted.add("maxConcurrentTasks");
    }
    if (data.groupName !== undefined) {
      e.groupName = data.groupName;
      adopted.add("groupName");
    }
    if (data.tags !== undefined) {
      e.tags = data.tags;
      adopted.add("tags");
    }
    if (data.description !== undefined) {
      e.description = data.description;
      adopted.add("description");
    }
    // ARCH-32: pull↔push 切换随重注册生效（执行器改 EXECUTOR_PULL_MODE 后
    // 重启即触发 didRestart 路径）。
    if (data.dispatchMode === "push" || data.dispatchMode === "pull") {
      e.dispatchMode = data.dispatchMode;
      adopted.add("dispatchMode");
    }
    // python_task_multiversion：重注册采纳（仅在合法上报时覆盖；非法/缺省
    // 均不动 DB —— 非法情形上方已 warn）。
    if (normalizedInterpreters !== null) {
      e.interpreters = normalizedInterpreters;
      adopted.add("interpreters");
    }
    // R3-A（§4.3/P10）：重注册采纳已安装包清单（仅在合法上报时覆盖；含 []
    // =「已上报且没装任何执行器包」；非法/缺省均不动 DB）。
    if (normalizedInstalledPackages !== null) {
      e.installedPackages = normalizedInstalledPackages;
      adopted.add("installedPackages");
    }
    // PROTOCOL-VER（B-3/U-2）：重注册采纳协议版本（仅整数合法值覆盖；
    // 缺省/非法不动 DB，保持未上报/NULL 语义）。
    if (
      typeof data.protocolVersion === "number" &&
      Number.isInteger(data.protocolVersion)
    ) {
      e.protocolVersion = data.protocolVersion;
      adopted.add("protocolVersion");
    }
    // ARCH-36（ADR-017 阶段 2）：重注册采纳设备指纹（仅在规范化成功时覆盖；
    // 缺省/非法均不动 DB——旧执行器或采集失败的执行器不得把已存值擦成 NULL，
    // 与 interpreters 的「缺省即保留」纪律同款）。
    if (incomingFingerprint !== null) {
      e.deviceFingerprint = incomingFingerprint;
      adopted.add("deviceFingerprint");
    }
  }

}
