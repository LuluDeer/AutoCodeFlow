import { Logger } from "@nestjs/common";
import type { Repository } from "typeorm";

import { Task } from "./entities/task.entity";
import { TaskVersion } from "./entities/task-version.entity";
import { TaskStatus } from "./entities/task.entity";
import { AppError } from "../../common/errors/app-error";
import { In } from "typeorm";

import { UserRole } from "../users/entities/user.entity";
// T2-B4 收尾：23505 判据与约束名读取的**唯一事实源**（收尾前有三份副本）。
import {
  isUniqueViolation,
  uniqueConstraintName,
} from "./task-unique-violation.util";

/**
 * T2-B4 第四刀（收官刀）：**任务版本快照** + **依赖图校验**协作者。
 *
 * ## 这一刀搬了什么（7 个符号）
 *
 * | 成员 | 改前 `task.service.ts` 行号 | 耦合形式（扫描器实测） |
 * |---|---|---|
 * | `saveVersion` | `:5375-5513`（139 行） | **① 直调 ×13**（全 public API：`task.service.spec.ts:6173` 等 + `task.state-write-guards.spec.ts:1084` + `task.service.export-import.spec.ts:159`） |
 * | `rollbackToVersion` | `:5535-5622`（88 行） | **① 直调 ×15**（全 public API） |
 * | `VERSION_ROLLBACK_COLUMNS` | `:592-661`（70 行） | 白名单常量（**与上面两个方法强耦合** ⇒ 同行搬） |
 * | `detectCycle` | `:1777-1832`（56 行） | 0 |
 * | `checkCircularDependency` | `:1682-1704`（23 行） | 0 |
 * | `assertDependencyValuesExist` | `:1714-1744`（31 行） | 0 |
 * | `renameDependencyAlias` | `:1857-1913`（57 行） | 0 |
 *
 * ## ⚠️ 为什么 `VERSION_ROLLBACK_COLUMNS` 必须与两个方法**同行搬**
 *
 * 既有 spec 的**漂移钉子**（`task.state-write-guards.spec.ts:1080`）用
 * **真实 `saveVersion` 产出的快照**反查白名单覆盖率：快照新增了键而白名单没跟上
 * ⇒ 钉子变红。⇒ 白名单与「产出快照的方法」「消费快照的方法」必须**同 owner**
 * （拆开就会出现「快照在协作者、白名单在 Facade」的漂移面）。
 *
 * ## ⚠️ `rollbackToVersion` 的两个跨簇依赖 ⇒ 走注入面
 *
 * 它调 `patchTaskColumns` / `getVersion` / `assertCanWriteProjectAware`
 * （**写面与版本读面**，属别的职责）——这三个**留 Facade**，经窄签名注入。
 * 它调 `saveVersion`（同簇）⇒ 内部互调（协作者内 private/public 互调，
 * 但 `saveVersion` 在协作者里是 **public** ⇒ 需注意 self-call 守卫）。
 *
 * ## 依赖簇为什么与版本簇**同一个协作者**
 *
 * 实测：**依赖簇的 4 个方法对版本簇零调用**（`detectCycle` /
 * `checkCircularDependency` / `assertDependencyValuesExist` / `renameDependencyAlias`
 * 的 `this.*` 依赖里**没有** `saveVersion` / `rollbackToVersion` /
 * `getVersion` / `patchTaskColumns`）⇒ 两个簇**互不依赖**。
 *
 * 那为什么放一起？**职责上是两件事**（版本快照 vs 依赖图），本可拆两刀；但
 * 依赖簇只有 4 个方法 / 167 行，单独一刀的收益不抵「多一个协作者 + 多一套
 * 注入面」的复杂度 ⇒ 合在一个协作者里，**用两个清晰分区**（版本 / 依赖）表达
 * 职责边界。
 *
 * ## `triggerDependentTasks` **不在本刀**
 *
 * 它是 **Facade public**（被 task 模块当契约用）且有 **assign×2** 耦合
 * （`execution-attempt-seq.spec.ts:575`、
 * `failure-classification.consumer-e2e.spec.ts:170`）⇒ 本刀只搬它的**内部纯计算**
 * （依赖图校验那 4 个方法），扇出主体留 Facade。
 */

/** 注入回调面（**窄签名**）。 */
export interface TaskVersionDeps {
  /** 任务仓库。 */
  taskRepo: Repository<Task>;
  /** 版本仓库（`saveVersion` 落快照 / `getVersion` 读版本）。 */
  versionRepo: Repository<TaskVersion>;
  /** 日志（**必须是 Facade 的实例**）。 */
  logger: Logger;
  /** 列级条件写（`rollbackToVersion` 回滚写面；**留 Facade**：属写面职责）。 */
  patchTaskColumns: (
    id: string,
    patch: Record<string, unknown>,
    expectedVersionMs?: number | null,
  ) => Promise<boolean>;
  /** 读版本行（`rollbackToVersion` 取目标版本）。 */
  getVersion: (taskId: string, versionId: string) => Promise<TaskVersion>;
  /**
   * 依赖链深度/广度上限（**留 Facade**：它是 `task.service.ts` 的**导出**，
   * 外部 import 面依赖它 ⇒ 搬走会破坏 import 面）。
   */
  maxDependencyDepth: number;
  /** 调度服务（`rollbackToVersion` 回滚后重排定时器）。 */
  schedulerService: {
    scheduleOne: (task: Task) => Promise<void>;
    stop: (taskId: string) => void;
  };
  /** 写面属主守卫（`rollbackToVersion` 的 AUTH 校验）。 */
  assertCanWriteProjectAware: (
    row: { ownerUserId: number | null; projectId?: string | null },
    user: { id: number; role: UserRole } | null | undefined,
  ) => Promise<void>;
}

/**
 * R63-A1（ADR-026 规则 4）：`rollbackToVersion` 允许从版本快照恢复的**列白名单**。
 *
 * 为什么是正向白名单，而不是「snapshot 里有什么就写什么」或整行 `save(entity)`：
 *
 * 1. **整行回写**（旧实现 `Object.assign(task, snapshot); taskRepo.save(task)`）
 *    写的是方法早期读到的快照——窗口内并发 PATCH 写下的 description /
 *    cronExpression、并发 pause 写下的 status、并发 remove 写下的
 *    status='deleted' + deletedAt 会被静默盖回（**软删行复活**）。回滚的语义是
 *    「把这一版的配置恢复回来」，不是「把这一行的时间线倒回读取那一刻」。
 * 2. 但快照恢复**确实**要覆盖一批列（不像 pause 只改 status），所以修法不是
 *    「只写一列」，而是「只写快照真的带了的列」——采纳集 = 白名单 ∩ 快照键。
 *    缺键保留现值的既有语义逐字不变（见 saveVersion 注释里的旧快照兼容说明），
 *    只是写面从「整行」收窄到「这些列」。
 * 3. **主键与框架列不在白名单里**：`version.snapshot` 带 `id` 只为可读性，
 *    把它写进 UPDATE 等于允许一次回滚改主键；createdAt / updatedAt / deletedAt
 *    是框架列，写它们会绕过乐观锁与软删语义。
 * 4. secrets / webhookSecret / status / ownerUserId 刻意**不**入快照（见
 *    saveVersion：版本端点会把 snapshot 原样回传，密文不能进版本历史），于是
 *    也不在白名单里——回滚永远不碰凭据与生命周期列。
 *
 * 维护约定：`saveVersion` 的 snapshot 键集新增一项，就必须在这里同步加一列；
 * `task.state-write-guards.spec.ts` 的「漂移钉子」会用真实 saveVersion 产出的
 * 快照反查本白名单的覆盖率，漏加即红。
 */
const VERSION_ROLLBACK_COLUMNS: readonly (keyof Task)[] = [
  "name",
  "description",
  "runtime",
  "entrypoint",
  "requirements",
  "params",
  "timeout",
  "timeoutAction",
  "timeoutWarnRatio",
  "estimatedDurationSec",
  "maxRetry",
  "retryDelay",
  "retryableErrors",
  "triggerType",
  "cronExpression",
  "timezone",
  "fixedRate",
  "blockStrategy",
  "misfireStrategy",
  "priority",
  "executeMode",
  "currentVersion",
  "gitRepo",
  "gitBranch",
  "gitCommit",
  "glueSource",
  "glueLanguage",
  "runtimeVersion",
  "codeSource",
  "applicationId",
  "maintenanceWindows",
  "runbook",
  "dependencies",
  "deploymentPolicy",
  "executorAffinityTags",
  "executorAntiAffinityTags",
  "executorId",
  "executorAppName",
  "executorGroup",
  "executorTags",
  "projectId",
  "alarmEmail",
  "alarmChannels",
];
export class TaskVersioning {
  private readonly deps: TaskVersionDeps;

  constructor(deps: TaskVersionDeps) {
    this.deps = deps;
  }

  // ── 版本快照区 ────────────────────────────────────────────────────────────

  /**
   * `saveVersion` 的**公开转发面**（Facade 调它）。
   *
   * 真正的实现在 private `saveVersionImpl` —— `rollbackToVersion` 也要落一份
   * 快照，而 **public self-call** 会被 `check-collaborator-self-call` 判红
   * （且会让 Facade 上的 spy 拦不到）。
   */
  async saveVersion(
    taskId: string,
    createdBy?: string,
    description?: string,
    taskSnapshot?: Task,
  ): Promise<TaskVersion | null> {
    return this.saveVersionImpl(taskId, createdBy, description, taskSnapshot);
  }

  /** `saveVersion` 的真正实现（同簇内部调用走这里）。 */
  private async saveVersionImpl(
    taskId: string,
    createdBy?: string,
    description?: string,
    taskSnapshot?: Task,
  ): Promise<TaskVersion | null> {
    const task =
      taskSnapshot ??
      (await this.deps.taskRepo.findOne({ where: { id: taskId } }));
    if (!task) {
      throw new AppError("TASK_NOT_FOUND", { taskId });
    }

    // Use MAX(version number) + 1 to avoid race condition from COUNT-based numbering
    const maxResult = await this.deps.versionRepo
      .createQueryBuilder("v")
      .select("MAX(CAST(SUBSTR(v.version, 2) AS INTEGER))", "maxNum")
      .where("v.taskId = :taskId", { taskId })
      .getRawOne();
    const versionNum = (maxResult?.maxNum ?? 0) + 1;
    const version = `v${versionNum}`;

    const snapshot: Record<string, unknown> = {
      id: task.id,
      name: task.name,
      description: task.description,
      runtime: task.runtime,
      entrypoint: task.entrypoint,
      // W-21: requirements must ride the snapshot, or a version rollback
      // would silently drop the dependency set the rolled-back task needs.
      requirements: task.requirements,
      params: task.params,
      timeout: task.timeout,
      // CORE-04: 超时策略随快照——缺省时版本回滚不得静默重置为 null（否则
      // "回滚到旧版本"会悄悄改变超时动作/预警配置）。
      timeoutAction: task.timeoutAction,
      timeoutWarnRatio: task.timeoutWarnRatio,
      // CORE-05: 预估时长随快照——否则版本回滚会把已配置的预估静默重置
      // （与上方超时策略两字段同一理由）。
      estimatedDurationSec: task.estimatedDurationSec,
      maxRetry: task.maxRetry,
      retryDelay: task.retryDelay,
      retryableErrors: task.retryableErrors,
      triggerType: task.triggerType,
      cronExpression: task.cronExpression,
      timezone: task.timezone,
      fixedRate: task.fixedRate,
      blockStrategy: task.blockStrategy,
      misfireStrategy: task.misfireStrategy,
      priority: task.priority,
      executeMode: task.executeMode,
      currentVersion: task.currentVersion,
      gitRepo: task.gitRepo,
      gitBranch: task.gitBranch,
      gitCommit: task.gitCommit,
      glueSource: task.glueSource,
      glueLanguage: task.glueLanguage,
      // python_task_multiversion（WS1 · VER-DIFF-01 同型缺口）：快照此前漏了
      // runtimeVersion / codeSource / applicationId 三个**用户可编辑**列
      // （前两者经 create-task.dto 可写，applicationId 经 update 可写）。
      //
      // 后果与 VER-DIFF-01 完全同型，且更严重——rollbackToVersion 用
      // Object.assign 应用快照，**快照缺键即保留当前值**：任务 3.7 → 改成
      // 3.12 → 回滚到"3.7 那一版"后 runtimeVersion 仍是 3.12，版本回滚静默
      // 失效（解释器语义是硬约束，这会让回滚后的任务跑在错误的 Python 上）。
      //
      // 三者必须**一起**入快照，缺一不可：applicationId 单独缺失时，回滚到
      // zip 版本会得到 codeSource='application_zip' 而无 applicationId 的
      // **自相矛盾态**——正是 assertCodeSourceConsistent 要拒的终态，且派发
      // 时拿不到 packageUrl（静默跑错代码，比报错更糟）。
      //
      // 一致性说明：codeSource 入快照后，compareVersions 会把"代码来源变更"
      // 如实显示为差异（键集合派生自快照）——这是期望行为，此前改了来源却
      // 显示"无差异"。
      runtimeVersion: task.runtimeVersion,
      codeSource: task.codeSource,
      applicationId: task.applicationId,
      // VER-DIFF-01（本轮审计）：快照此前漏了这两个**用户可编辑**的列
      // （maintenanceWindows / runbook 经 create-task.dto 可写）。而
      // compareVersions 的键集合是 `new Set([...Object.keys(v1.snapshot),
      // ...Object.keys(v2.snapshot)])` —— 完全派生自快照本身，因此**任何不在
      // 快照里的字段永远不可能出现在版本差异里**：用户改了维护窗口或 runbook，
      // 对比两个版本却显示"无差异"，误导性极强（看起来像改动没生效）。
      maintenanceWindows: task.maintenanceWindows,
      runbook: task.runbook,
      // 第二轮审计（A3 · 版本快照补键）：以下 11 个键全部是**用户可编辑**列
      // （经 create-task.dto / update-task.dto 可写），此前不在快照键集内。
      // 后果与上方 VER-DIFF-01 完全同型且 ×2：① compareVersions 的键集合
      // 完全派生自快照，漏键 ⇒ 改了依赖链/部署约束/告警配置后版本对比
      // 显示"无差异"；② rollbackToVersion 用 Object.assign（缺键保留现值）
      // ⇒ 回滚到旧版本时这些字段静默保留新值——回滚依赖链的任务仍挂着
      // 新依赖、告警配置悄悄漂移，版本回滚对这批字段集体失效。
      // 键名与 create-task.dto.ts / update-task.dto.ts 字段一致；旧快照缺键
      // 由 Object.assign 语义自然向后兼容（保留现值），无须迁移。
      dependencies: task.dependencies,
      deploymentPolicy: task.deploymentPolicy,
      executorAffinityTags: task.executorAffinityTags,
      executorAntiAffinityTags: task.executorAntiAffinityTags,
      executorId: task.executorId,
      executorAppName: task.executorAppName,
      executorGroup: task.executorGroup,
      executorTags: task.executorTags,
      projectId: task.projectId,
      alarmEmail: task.alarmEmail,
      alarmChannels: task.alarmChannels,
      // 刻意**不**纳入 secrets：它虽是实体列，但 GET /tasks/:id/versions 与
      // compare 端点会把 snapshot 原样回传，而 secrets 的脱敏
      // （maskForResponse）只挂在 task 读路径上，不覆盖版本端点。放进来等于
      // 把密文（甚至将来若改动脱敏链路则可能是明文）通过版本历史泄露出去。
      // 回滚不受影响：rollbackToVersion 用 Object.assign，快照缺键即保留原值。
    };

    // B-10（调度域审计）：并发 PATCH 的 MAX+1 竞态——两个并发保存各自算出
    // 同一个 v<N>，迁移 1790000000021 的 (taskId, version) 唯一索引让败者的
    // INSERT 撞 23505。此时任务行已保存、调度已重排（调用方的 save 都已成
    // 功），把快照插入失败裸抛成 500 会让一次已成功的编辑收到错误响应。
    // 版本快照少一条属可接受损失（主流程已成功；R1 先例：executor.service
    // register 对同型竞态同样降级），识别 23505 后 warn 并返回 null，不回
    // 500。版本保留策略（挤出一类）另行处理，不在本修复范围。
    try {
      return await this.deps.versionRepo.save(
        this.deps.versionRepo.create({
          taskId,
          version,
          gitCommit: task.gitCommit,
          snapshot,
          createdBy,
          description,
        }),
      );
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        this.deps.logger.warn(
          `saveVersion: concurrent version snapshot insert for task ${taskId} lost the race (unique violation on (taskId, version)) — skipping this snapshot, main flow unaffected`,
        );
        return null;
      }
      throw err;
    }
  }

  async rollbackToVersion(
    taskId: string,
    versionId: string,
    user?: { id: number; role: UserRole } | null,
  ): Promise<Task> {
    const version = await this.deps.getVersion(taskId, versionId);

    const task = await this.deps.taskRepo.findOne({ where: { id: taskId } });
    if (!task) {
      throw new AppError("TASK_NOT_FOUND", { taskId });
    }

    // R-03: 写面归属守卫（镜像 update 口径）。本路径直接以 repo 查询取
    // RAW 实体（无脱敏，快照亦不含 secrets），无 R-01 掩码回写问题。
    await this.deps.assertCanWriteProjectAware(task, user);

    // FEAT-RENAME：快照含 name（saveVersion 显式入快照，见其 snapshot 装配），
    // 故回滚会把任务名一起还原成那一版的样子——这是既有的快照语义，保留。
    // 但改名放开后，这条路径必须与 update() 补齐同样的两件事，否则它是绕过
    // 新约束的旁路：
    //   ① 撞 idx_tasks_name_unique（还原的名字可能已被别的任务占用）——此前
    //      裸抛 QueryFailedError → 全局过滤器给笼统 500/409，用户不知道撞了
    //      什么；update() 已有可读文案，这里必须对齐。
    //   ② 引用方的依赖显示名 key 会残留旧名——update() 会刷新，回滚同样要刷。
    const previousName = task.name;

    // R63-A1（ADR-026 规则 4）：写面从「Object.assign(snapshot) + save(task)」
    // 收窄成「正向白名单 ∩ 采纳集（快照真的带了的键）」的列级条件写。
    //
    // 旧实现的两种现形方式：
    //   ① 窗口内并发 PATCH 写的 description / cronExpression 等**快照外**的列，
    //      被整行 save 从旧快照盖回去（用户的并发编辑静默丢失）；
    //   ② 窗口内并发 remove 把行软删，整行 save 把 deletedAt 写回 NULL
    //      ——**软删行复活**（status 一起被写回 active）。
    // 语义不变的部分：快照里带的列照常覆盖（版本恢复的本意）；快照缺键保留现值
    // （旧快照向后兼容，理由见 saveVersion 的 11 键注释）。行谓词恒带
    // `deletedAt IS NULL`——命中 0 = 行已被并发软删 → 规则 3 让位（404），
    // 不按旧快照写回。
    const snapshot = version.snapshot as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const column of VERSION_ROLLBACK_COLUMNS) {
      if (!(column in snapshot)) continue;
      // undefined = 该版本没有这一列的取值 → 保留现值（null 是显式清空，照写）
      if (snapshot[column] === undefined) continue;
      patch[column] = snapshot[column];
    }
    // 当前版本号以本次应用的版本为准（快照里的 currentVersion 是"那一版当时"的值）
    patch.currentVersion = version.version;

    let applied: boolean;
    try {
      applied = await this.deps.patchTaskColumns(taskId, patch);
    } catch (err) {
      if (
        isUniqueViolation(err) &&
        uniqueConstraintName(err) === "idx_tasks_name_unique"
      ) {
        throw new AppError("TASK_ROLLBACK_NAME_TAKEN", {
          version: version.version,
          name: String(patch.name ?? task.name),
        });
      }
      throw err;
    }
    if (!applied) {
      // 规则 3：行谓词落空 = 并发 remove 已软删该行。与"顺序执行时任务已不存在"
      // 同解（404），绝不按旧快照写回（那正是软删行复活的入口）。
      throw new AppError("TASK_NOT_FOUND", { taskId });
    }
    // 回读写面结果：不把方法早期读到的快照当"本次写的结果"返回（同 pause/resume）
    const saved =
      (await this.deps.taskRepo.findOne({ where: { id: taskId } })) ??
      (Object.assign(task, patch) as Task);
    await this.saveVersionImpl(saved.id, undefined, undefined, saved);
    // 与 update() 同源：回滚若改变了任务名，同步刷新引用方的依赖别名
    if (previousName !== saved.name) {
      await this.renameDependencyAliasImpl(saved.id, previousName, saved.name);
    }
    // B-2（调度域审计）：回滚整体覆盖含 triggerType/cronExpression/fixedRate
    // 的快照——若不重排调度，已注册的定时器仍按**旧表达式**继续触发（reload
    // 只为「未注册」的任务建定时器，感知不到已注册任务的配置变化）。与
    // update() 对齐：先停旧定时器，ACTIVE 任务再按新配置重建。
    this.deps.schedulerService.stop(taskId);
    if (saved.status === TaskStatus.ACTIVE) {
      await this.deps.schedulerService.scheduleOne(saved);
    }
    return saved;
  }

  private async detectCycle(
    taskId: string,
    dependencyIds: string[],
    visited: Set<string>,
    currentPath: Set<string>,
    depth = 0,
  ): Promise<void> {
    // TASK-007: 递归深度上限——防止深层依赖链的串行 N+1 查询 DoS。
    if (depth > this.deps.maxDependencyDepth) {
      throw new AppError("TASK_DEPENDENCY_TOO_DEEP");
    }

    for (const depId of dependencyIds) {
      if (depId === taskId) {
        throw new AppError("TASK_CIRCULAR_DEPENDENCY", { taskId });
      }

      if (currentPath.has(depId)) {
        throw new AppError("TASK_CIRCULAR_DEPENDENCY", { taskId });
      }

      if (visited.has(depId)) {
        continue;
      }

      // TASK-007: 已访问节点集合上限——超宽扇出的依赖图同样拒绝，
      // 上限保证单次校验的数据库查询次数有硬性边界。
      if (visited.size > this.deps.maxDependencyDepth) {
        throw new AppError("TASK_DEPENDENCY_TOO_DEEP");
      }

      visited.add(depId);
      currentPath.add(depId);

      try {
        const depTask = await this.deps.taskRepo.findOne({
          where: { id: depId },
        });
        if (
          depTask &&
          depTask.dependencies &&
          Object.keys(depTask.dependencies).length > 0
        ) {
          // Use Object.values to get the actual dependency task IDs (not the key names)
          const childDependencies = Object.values(depTask.dependencies);
          await this.detectCycle(
            taskId,
            childDependencies,
            visited,
            currentPath,
            depth + 1,
          );
        }
      } finally {
        currentPath.delete(depId);
      }
    }
  }

  async checkCircularDependency(
    taskId: string,
    dependencies: Record<string, string>,
  ): Promise<void> {
    // FIX-1.1：dependencies 契约 = Record<显示名快照, 上游任务id>——**value
    // 才是依赖任务 id**（消费方：本环检测、checkDependencies、扇出匹配、
    // 前端 dag-layout 全部读 value）。旧契约 {taskId: taskName}（value=名字）
    // 使本方法 findOne({id: 名字}) 永远查不到 → 深层环静默放行；迁移
    // 1790000000048 已翻转存量行，写入面另有 assertDependencyValuesExist
    // 保证 value 是真实任务 id，本检测自那之后才真正生效。
    const visited = new Set<string>();
    const currentPath = new Set<string>();

    const dependencyIds = Object.values(dependencies);

    for (const depId of dependencyIds) {
      if (depId === taskId) {
        throw new AppError("TASK_CIRCULAR_DEPENDENCY", { taskId });
      }
    }

    await this.detectCycle(taskId, dependencyIds, visited, currentPath);
  }

  /**
   * FIX-1.1（依赖链契约）：dependencies 映射的每个 **value** 必须是真实存在
   * 的任务 id。value 是环检测/依赖满足/扇出匹配的语义位——存进一个名字或
   * 悬垂 id，后果是下游依赖链**静默永不触发**（checkDependencies 判不满足、
   * 扇出匹配不到完成的任务 id），用户无从察觉。写面即 400（列出坏 value），
   * 前端 buildDependenciesPayload 已保证 value=id；本方法覆盖 API/MCP/脚本
   * 等直连调用方。create 与 update（dependencies 为整体替换语义）共用。
   */
  async assertDependencyValuesExist(
    dependencies: Record<string, string>,
  ): Promise<void> {
    // F-5（服务层纵深防御）：DTO 边界的 IsDependencyValueMapConstraint 已把
    // value 收口为字符串，但本方法还有**编程式直连调用方**（MCP/脚本/自动
    // 注册，不经全局 ValidationPipe）——value=123/true 之类的非字符串进
    // In([...]) 查 uuid 列会触发 PG 42883（function uuid_eq_integer does
    // not exist）裸 500。这里前置 typeof 收口为可读 400 VALIDATION_FAILED
    // （复用通用校验码，不新增目录条目）。
    const nonStringKeys = Object.entries(dependencies)
      .filter(([, v]) => typeof v !== "string")
      .map(([k]) => k);
    if (nonStringKeys.length > 0) {
      throw new AppError("VALIDATION_FAILED", {
        detail: `dependencies 的依赖值必须是任务 id（字符串），以下键的值类型非法：${nonStringKeys.join(", ")}`,
      });
    }
    const values = [...new Set(Object.values(dependencies))];
    if (values.length === 0) return;
    const found = await this.deps.taskRepo.find({
      where: { id: In(values) },
      select: { id: true },
    });
    const foundIds = new Set(found.map((t) => t.id));
    const missing = values.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      throw new AppError("TASK_DEPENDENCY_NOT_FOUND", {
        ids: missing.join(", "),
      });
    }
  }

  /**
   * FEAT-RENAME: 任务改名后，刷新其它任务 dependencies 里指向它的**显示名 key**。
   *
   * ## 为什么需要
   *
   * `dependencies` 的契约是 `Record<显示名快照, 上游任务id>`——**value 才是
   * 依赖任务 id**（环检测 / 依赖满足 / 上游 SUCCESS 扇出全部读 value），key
   * 仅作展示别名，供 DAG 图与排查场景人读。改名后 key 会变成旧名：功能一切
   * 正常（value 没变），但依赖图上显示一个"不存在的任务名"，值班按图排查时
   * 会对不上任何一行任务。
   *
   * ## 语义边界（刻意保守）
   *
   * - 只改 **value === 被改名任务 id** 的条目；不碰其它任何依赖关系。
   * - 只改 **key 恰好等于旧名** 的条目。若某任务当初保存时 key 已经是别的
   *   形态（如同名冲突降级成 id、或用户在旧版本里手写过别名），保持原样——
   *   我们无法区分"这是旧名快照"与"用户有意写的别名"，误改等于破坏展示信息。
   * - 新名与某个**其它** key 撞车时不覆盖（`Record` 一个 key 只能有一个值，
   *   覆盖会让原依赖关系丢失）。此时保留旧 key：展示名过时是外观问题，
   *   丢依赖关系是功能问题。
   * - best-effort：任何异常只记 warn，绝不回滚或影响改名本身——改名已经
   *   落库，此处失败只意味着图上还显示旧名。
   */
  /**
   * `renameDependencyAlias` 的**公开转发面**（Facade 调它）。
   *
   * 实现放在 private `renameDependencyAliasImpl` —— `rollbackToVersion` 也要
   * 刷新依赖别名，而 **public self-call** 会被 self-call 守卫判红。
   */
  async renameDependencyAlias(
    taskId: string,
    oldName: string,
    newName: string,
  ): Promise<void> {
    await this.renameDependencyAliasImpl(taskId, oldName, newName);
  }

  /** `renameDependencyAlias` 的真正实现（同簇内部调用走这里）。 */
  private async renameDependencyAliasImpl(
    taskId: string,
    oldName: string,
    newName: string,
  ): Promise<void> {
    try {
      // 候选集：dependencies 里 value 含该 id 的任务。jsonb 无索引，用
      // 包含判定在 SQL 侧先粗筛（`@>` 语义），再在内存里精确定位 key，
      // 避免把全表任务拉进内存。
      const dependents = await this.deps.taskRepo
        .createQueryBuilder("task")
        .where("task.status != :deleted", { deleted: TaskStatus.DELETED })
        .andWhere("task.dependencies @> :probe", {
          probe: JSON.stringify({ [oldName]: taskId }),
        })
        .getMany();

      let touched = 0;
      for (const dependent of dependents) {
        const deps = dependent.dependencies;
        if (!deps || typeof deps !== "object") continue;
        // 精确定位：key === oldName 且 value === taskId
        if (deps[oldName] !== taskId) continue;
        // 新名已被另一个 key 占用 → 保留旧 key，不丢依赖关系
        if (newName !== oldName && deps[newName] !== undefined) continue;

        const next: Record<string, string> = {};
        for (const [key, value] of Object.entries(deps)) {
          next[key === oldName && value === taskId ? newName : key] = value;
        }
        // 只写 dependencies 一列——刻意**不**用 `taskRepo.save(entity)`。
        // save() 是整行 UPDATE，而这里的实体来自 QueryBuilder 取数，不含
        // `select: false` 的 webhookSecret 列：整行回写会把它清成 NULL
        // （本仓已有同型生产故障先例，见 update() 的 R-01 注释）。
        // 列级 update 既规避该风险，也不会无谓触碰 updatedAt 之外的列。
        // adr-026-exempt: 只改 dependencies 一列（依赖别名重写），与状态机/生命周期无关；
        // 值来自本次遍历读到的 deps 快照，并发改名属罕见且非破坏性（最坏是多写一次同一别名）。
        await this.deps.taskRepo.update(
          { id: dependent.id },
          { dependencies: next },
        );
        touched += 1;
      }
      if (touched > 0) {
        this.deps.logger.log(
          `FEAT-RENAME: refreshed dependency alias "${oldName}" -> "${newName}" on ${touched} dependent task(s)`,
        );
      }
    } catch (err) {
      // best-effort：改名本身已落库，此处失败只影响 DAG 上的展示名
      this.deps.logger.warn(
        `FEAT-RENAME: failed to refresh dependency alias "${oldName}" -> "${newName}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
