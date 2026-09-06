/**
 * FEAT-02: 任务依赖 DAG 布局纯函数层。
 *
 * 数据契约（对齐 admin-api triggerDependentTasks）：
 * tasks.dependencies 为 Record<别名, taskId>——**值是上游依赖的任务 ID**；
 * 完成任务 X 时，所有 dependencies 值包含 X 的任务被触发扇出。
 * 因此边方向固定：上游依赖 → 依赖方（from = dep, to = dependent）。
 *
 * 图范围 = 当前任务的双向传递闭包（上游闭包 ∪ 下游闭包 ∪ 自身），
 * 只保留两端都在闭包内的边；节点数超上限时按 BFS 距离截断并标记 truncated。
 * 渲染层（TaskDependencyGraph.tsx）只做定位绘制，全部可测逻辑集中在这里。
 */

export interface DagTaskRef {
  id: string;
  name: string;
  status: string;
}

export interface DagNode extends DagTaskRef {
  /** 纵向列号（最长路径分层；cycle=true 时全部为 0） */
  layer: number;
  isCurrent: boolean;
}

/** from = 上游依赖任务，to = 依赖方 */
export interface DagEdge {
  from: string;
  to: string;
}

export interface DagGraph {
  nodes: DagNode[];
  edges: DagEdge[];
  /** 闭包内实际存在的依赖环（admin 创建侧有 64 深度上限，但 PATCH 仍可能成环） */
  cycle: boolean;
  /** 闭包节点数超上限被截断 */
  truncated: boolean;
}

const DEFAULT_MAX_NODES = 50;

export function buildDependencyGraph(
  tasks: DagTaskRef[],
  currentId: string,
  maxNodes: number = DEFAULT_MAX_NODES,
): DagGraph | null {
  const byId = new Map<string, DagTaskRef>();
  for (const t of tasks) byId.set(t.id, t);
  const current = byId.get(currentId);
  if (!current) return null;

  // 邻接表：正向（dep → dependents）与反向（dependent → deps）
  const forward = new Map<string, string[]>();
  const backward = new Map<string, string[]>();
  const rawEdges: DagEdge[] = [];
  for (const t of tasks) {
    const deps = (t as unknown as { dependencies?: Record<string, string> | null })
      .dependencies;
    if (!deps) continue;
    for (const depId of Object.values(deps)) {
      if (depId === t.id || !byId.has(depId)) continue;
      rawEdges.push({ from: depId, to: t.id });
      forward.set(depId, [...(forward.get(depId) ?? []), t.id]);
      backward.set(t.id, [...(backward.get(t.id) ?? []), depId]);
    }
  }

  const collect = (
    start: string[],
    next: (id: string) => string[],
  ): { seen: string[]; overflow: boolean } => {
    const seenSet = new Set<string>(start);
    const order = [...start];
    let overflow = false;
    for (let i = 0; i < order.length; i++) {
      if (order.length > maxNodes) {
        overflow = true;
        break;
      }
      for (const n of next(order[i]) ?? []) {
        if (!seenSet.has(n)) {
          seenSet.add(n);
          order.push(n);
        }
      }
    }
    return { seen: order, overflow };
  };

  const up = collect([currentId], (id) => backward.get(id) ?? []);
  const down = collect([currentId], (id) => forward.get(id) ?? []);

  const inClosure = new Set<string>([...up.seen, ...down.seen]);
  const truncated = up.overflow || down.overflow || inClosure.size > maxNodes;
  const memberIds = inClosure.size > maxNodes
    ? [...inClosure].slice(0, maxNodes)
    : [...inClosure];

  const members = new Set(memberIds);
  const edges = rawEdges.filter((e) => members.has(e.from) && members.has(e.to));

  // Kahn 拓扑分层：layer(n) = 起点层 0，之后 max(layer(前驱)) + 1（最长路径）
  const indegree = new Map<string, number>();
  const out = new Map<string, string[]>();
  for (const e of edges) {
    indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
    out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
  }
  const layer = new Map<string, number>();
  const queue = memberIds.filter((id) => (indegree.get(id) ?? 0) === 0);
  for (const id of queue) layer.set(id, 0);
  let processed = 0;
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    processed++;
    for (const next of out.get(id) ?? []) {
      layer.set(next, Math.max(layer.get(next) ?? 0, (layer.get(id) ?? 0) + 1));
      const d = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  const cycle = processed < memberIds.length;

  const nodes: DagNode[] = memberIds
    .map((id) => ({
      ...byId.get(id)!,
      layer: cycle ? 0 : (layer.get(id) ?? 0),
      isCurrent: id === currentId,
    }))
    .sort((a, b) =>
      a.layer - b.layer || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    );

  return { nodes, edges, cycle, truncated };
}
