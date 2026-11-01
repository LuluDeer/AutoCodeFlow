import { In, Repository } from "typeorm";
import {
  ExecutionStatus,
  TaskExecution,
} from "./entities/task-execution.entity";

/**
 * B-6（调度域审计）：依赖满足判定的单一事实源。
 *
 * 背景：该判定此前只存在于 TaskService.checkDependencies（私有）——依赖
 * 扇出（triggerDependentTasks）触发下游前用它校验。而 scheduler 的 misfire
 * 补偿（checkMisfires → enqueue(task, "misfire")）**绕过** TaskService.trigger
 * 直接入队，FIRE_ONCE 任务在依赖未满足时被补偿路径强行触发——上游刚失败
 * 且缺口超阈时，补偿会无视依赖链直接入队。
 *
 * 抽成纯函数（仓储由调用方传入，无 service 依赖 → scheduler/task 两模块
 * 各自 import 工具即可，零模块环——与 block-strategy-gate / execution-terminal
 * 同款纪律），两个消费方判定永不漂移：
 * - TaskService.checkDependencies（依赖扇出触发前）；
 * - SchedulerService.checkMisfires（misfire 补偿入队前，B-6 新增闸）。
 *
 * 语义（自原 checkDependencies 平移，逐字节不变）：
 * - dependencies 为空（null / {} / value 集为空）→ 视为无依赖，满足；
 * - 契约（FIX-1.1 / 迁移 1790000000048）：**value 才是依赖任务 id**；
 * - 全部依赖的**最新一次**执行均为 SUCCESS 才算满足；
 * - 主查询带 take 上限防全量历史入内存；某依赖的最新行被截断挤出窗口时
 *   用按依赖的定向查询（隐式 LIMIT 1）兜底。
 *
 * ## G2-风险 1（迁移 1790000000091）：`synthetic` 行不算「最新一次执行」
 *
 * 「最新一次执行」在本文件里由**两条查询**共同产出（主扫描 + 定向兜底），故
 * `synthetic = false` 在**查询层**加了两遍，而不是在调用方各加一遍过滤：
 * 本函数的两个消费方（TaskService.checkDependencies 扇出前、
 * SchedulerService.checkMisfires 补偿前）拿到的判定因此永不漂移。
 *
 * 为什么必须排除：G2 为「未声明失败边」的下游落一条 `cancelled` 合成行（只为
 * 让 `list_executions` 可见「它没跑」，见 task-execution.entity 的 synthetic
 * 注释）。若该行成为依赖的最新行，孙节点读到的就是 `cancelled` 而不是它上次
 * 的 `SUCCESS` ⇒ 默认 `acceptFailure=false` 下 **孙节点静默不触发**。合成行
 * 从未被任何进程跑过，它是结论不是尝试，对依赖判定应当**如同不存在**。
 *
 * 既有语义的保护：`synthetic` 默认 false 且迁移前不存在合成建行路径 ⇒ 真实尝试
 * 的查询结果与引入本列前**逐字节相同**（只是多一个恒真的谓词）。凡是
 * `synthetic=false` 的 `cancelled` 行，行为与本改动前完全一样（仍不满足依赖）。
 */

/**
 * R4-P3: 单次扫描的执行行数上限。原实现无 take，会把依赖任务的全量历史
 * 拉进内存；加上限后内存有界。权衡：DESC 排序下"每个依赖的最新一次执行"
 * 几乎总落在最近 N 行内；极端场景（某个高频依赖把其余依赖的最新行挤出
 * 窗口）由下方按依赖定向兜底查询补齐，判定语义不变。
 */
export const MAX_DEPENDENCY_EXECUTION_SCAN = 500;

/** G6：失败边——依赖的「最新执行是失败终态」也算满足。 */
const FAILED_TERMINAL_STATUSES: readonly string[] = [
  ExecutionStatus.FAILED,
  ExecutionStatus.TIMEOUT,
  "killed",
  "cancelled",
];

export interface DependencySatisfactionOptions {
  /**
   * G6 失败边：true 时，依赖的最新执行若是**失败终态**
   * （FAILED/TIMEOUT/KILLED/CANCELLED）也算满足。
   *
   * 只对声明了 `runOnUpstreamFailure` 的任务开启（调用方按任务行传入）——
   * 不能全局开启：那会让所有依赖任务在上游失败时被误触发。
   */
  acceptFailure?: boolean;
}

export async function areDependenciesSatisfied(
  execRepo: Pick<Repository<TaskExecution>, "find" | "findOne">,
  dependencies: Record<string, unknown> | null | undefined,
  options: DependencySatisfactionOptions = {},
): Promise<boolean> {
  if (!dependencies || Object.keys(dependencies).length === 0) {
    return true;
  }

  const dependencyIds = Object.values(dependencies);
  if (dependencyIds.length === 0) return true;

  const recentExecutions = await execRepo.find({
    // G2-风险 1：`synthetic = false` —— 为可见性合成的行（如 G2 的 cancelled 行）
    // 不参与「最新执行」语义。真实尝试（false）的行集与判定与改动前逐字节相同。
    where: { taskId: In(dependencyIds as string[]), synthetic: false },
    order: { createdAt: "DESC" },
    take: MAX_DEPENDENCY_EXECUTION_SCAN,
  });

  // Group by taskId and get the most recent execution for each
  const latestByTask = new Map<string, TaskExecution>();
  for (const exec of recentExecutions) {
    if (!latestByTask.has(exec.taskId)) {
      latestByTask.set(exec.taskId, exec);
    }
  }

  // Check if all dependencies have successful executions
  for (const depId of dependencyIds) {
    let latestExec = latestByTask.get(depId as string);
    if (!latestExec) {
      // take 截断兜底：该依赖有历史但未落在本窗口内（或从未运行过），
      // 定向补查一次；仍为空则视作依赖未满足（保持原语义）。
      // G2-风险 1：兜底查询同样带 `synthetic = false`——两条查询必须同口径，
      // 否则合成行会从这条后门重新成为「最新执行」（主扫描有、兜底没有的漂移
      // 恰好是「换个窗口就变结论」的静默不一致）。
      latestExec = await execRepo.findOne({
        where: { taskId: depId as string, synthetic: false },
        order: { createdAt: "DESC" },
      });
      if (latestExec) {
        latestByTask.set(depId as string, latestExec);
      }
    }
    if (!latestExec) return false;
    if (latestExec.status === ExecutionStatus.SUCCESS) continue;
    if (
      options.acceptFailure === true &&
      FAILED_TERMINAL_STATUSES.includes(latestExec.status as string)
    ) {
      continue;
    }
    return false;
  }

  return true;
}
