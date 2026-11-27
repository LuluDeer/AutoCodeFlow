import type { DagGraph } from '../dag-layout';

/** 触发 DAG 根节点的结果摘要（已剔除执行明细，供 UI 直接展示）。 */
export interface TriggerSummary {
  dagRunId: string;
  rootCount: number;
  skippedCount: number;
  executionCount: number;
}

export function buildTriggerSummary(result: {
  dagRunId: string;
  rootTaskIds: string[];
  skippedDependentTaskIds: string[];
  executions: unknown[];
}): TriggerSummary {
  return {
    dagRunId: result.dagRunId,
    rootCount: result.rootTaskIds.length,
    skippedCount: result.skippedDependentTaskIds.length,
    executionCount: result.executions.length,
  };
}

/** 待触发的任务子图 ID（全部图节点；后端只触发其中的根节点）。 */
export function collectDagTaskIds(graph: DagGraph): string[] {
  return graph.nodes.map((node) => node.id);
}
