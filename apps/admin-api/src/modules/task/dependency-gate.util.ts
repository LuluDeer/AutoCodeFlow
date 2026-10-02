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
 */

/**
 * R4-P3: 单次扫描的执行行数上限。原实现无 take，会把依赖任务的全量历史
 * 拉进内存；加上限后内存有界。权衡：DESC 排序下"每个依赖的最新一次执行"
 * 几乎总落在最近 N 行内；极端场景（某个高频依赖把其余依赖的最新行挤出
 * 窗口）由下方按依赖定向兜底查询补齐，判定语义不变。
 */
export const MAX_DEPENDENCY_EXECUTION_SCAN = 500;

export async function areDependenciesSatisfied(
  execRepo: Pick<Repository<TaskExecution>, "find" | "findOne">,
  dependencies: Record<string, unknown> | null | undefined,
): Promise<boolean> {
  if (!dependencies || Object.keys(dependencies).length === 0) {
    return true;
  }

  const dependencyIds = Object.values(dependencies);
  if (dependencyIds.length === 0) return true;

  const recentExecutions = await execRepo.find({
    where: { taskId: In(dependencyIds as string[]) },
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
      latestExec = await execRepo.findOne({
        where: { taskId: depId as string },
        order: { createdAt: "DESC" },
      });
      if (latestExec) {
        latestByTask.set(depId as string, latestExec);
      }
    }
    if (!latestExec || latestExec.status !== ExecutionStatus.SUCCESS) {
      return false;
    }
  }

  return true;
}
