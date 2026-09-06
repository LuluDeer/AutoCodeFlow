/**
 * FEAT-02: 任务依赖 DAG 可视化（零新依赖——纯 CSS 定位 + SVG 连线）。
 * 布局逻辑全部在 dag-layout.ts（纯函数，单测覆盖），本组件只负责取数与绘制。
 */
import { useMemo } from 'react';
import { Empty, Spin, Tag, Typography, Alert } from 'antd';
import { useNavigate } from 'react-router-dom';
import { useRequest } from 'ahooks';
import { tasksApi } from '../api/tasks';
import { buildDependencyGraph, type DagNode } from './dag-layout';

const NODE_W = 176;
const NODE_H = 44;
const GAP_X = 84;
const GAP_Y = 18;
const PAD = 16;

const STATUS_COLOR: Record<string, string> = {
  active: '#52c41a',
  paused: '#faad14',
  deleted: '#bfbfbf',
};

export default function TaskDependencyGraph({ taskId }: { taskId: string }) {
  const nav = useNavigate();
  // 名称/状态解析需要全量任务表；分页上限即闭包上限（500 足够，超出由
  // truncated 提示）。
  const { data, loading } = useRequest(
    () => tasksApi.list({ page: 1, pageSize: 500 }),
    { cacheKey: 'dag-all-tasks' },
  );

  const graph = useMemo(
    () =>
      buildDependencyGraph(
        (data?.items ?? []) as unknown as Parameters<typeof buildDependencyGraph>[0],
        taskId,
      ),
    [data, taskId],
  );

  if (loading && !data) {
    return <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>;
  }
  if (!graph) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="任务不存在或已删除，无法构建依赖图"
      />
    );
  }
  if (graph.nodes.length <= 1 && graph.edges.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="该任务没有依赖其他任务，也没有任务依赖它"
      >
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          在任务表单的「依赖任务」中声明依赖后，这里会展示上下游 DAG
        </Typography.Text>
      </Empty>
    );
  }

  // 列 = layer，行 = 同层排序序号
  const layers = new Map<number, DagNode[]>();
  for (const n of graph.nodes) {
    const arr = layers.get(n.layer) ?? [];
    arr.push(n);
    layers.set(n.layer, arr);
  }
  const pos = new Map<string, { x: number; y: number }>();
  let maxRows = 1;
  for (const [layer, arr] of [...layers.entries()].sort((a, b) => a[0] - b[0])) {
    maxRows = Math.max(maxRows, arr.length);
    arr.forEach((n, i) => {
      pos.set(n.id, {
        x: PAD + layer * (NODE_W + GAP_X),
        y: PAD + i * (NODE_H + GAP_Y),
      });
    });
  }
  const width = PAD * 2 + (Math.max(...layers.keys(), 0) + 1) * NODE_W + Math.max(...layers.keys(), 0) * GAP_X;
  const height = PAD * 2 + maxRows * NODE_H + (maxRows - 1) * GAP_Y;

  return (
    <div>
      {graph.cycle && (
        <Alert
          type="warning"
          showIcon
          message="依赖关系中存在环路——依赖触发不会执行环上的任务，请到任务表单修正"
          style={{ marginBottom: 12 }}
        />
      )}
      {graph.truncated && (
        <Alert
          type="info"
          showIcon
          message={`依赖链较长，仅展示前 ${graph.nodes.length} 个节点`}
          style={{ marginBottom: 12 }}
        />
      )}
      <div style={{ overflow: 'auto', border: '1px solid #f0f0f0', borderRadius: 8 }}>
        <div style={{ position: 'relative', width, height, minWidth: '100%' }}>
          <svg width={width} height={height} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
            {graph.edges.map((e) => {
              const a = pos.get(e.from);
              const b = pos.get(e.to);
              if (!a || !b) return null;
              const x1 = a.x + NODE_W;
              const y1 = a.y + NODE_H / 2;
              const x2 = b.x;
              const y2 = b.y + NODE_H / 2;
              const mx = (x1 + x2) / 2;
              return (
                <path
                  key={`${e.from}->${e.to}`}
                  d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`}
                  fill="none"
                  stroke="#8c8c8c"
                  strokeWidth={1.5}
                  markerEnd="url(#dag-arrow)"
                />
              );
            })}
            <defs>
              <marker id="dag-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                <path d="M0,0 L8,4 L0,8 Z" fill="#8c8c8c" />
              </marker>
            </defs>
          </svg>
          {graph.nodes.map((n) => {
            const p = pos.get(n.id)!;
            return (
              <div
                key={n.id}
                onClick={() => !n.isCurrent && nav(`/tasks/${n.id}`)}
                style={{
                  position: 'absolute',
                  left: p.x,
                  top: p.y,
                  width: NODE_W,
                  height: NODE_H,
                  padding: '6px 10px',
                  borderRadius: 8,
                  border: n.isCurrent ? '2px solid #1677ff' : '1px solid #d9d9d9',
                  background: n.isCurrent ? '#e6f4ff' : '#fff',
                  cursor: n.isCurrent ? 'default' : 'pointer',
                  overflow: 'hidden',
                  boxShadow: n.isCurrent ? '0 2px 8px rgba(22,119,255,0.25)' : undefined,
                }}
                title={n.isCurrent ? '当前任务' : '点击跳转到该任务'}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 13,
                    fontWeight: n.isCurrent ? 600 : 400,
                    whiteSpace: 'nowrap',
                    textOverflow: 'ellipsis',
                    overflow: 'hidden',
                  }}
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      flexShrink: 0,
                      background: STATUS_COLOR[n.status] ?? '#8c8c8c',
                    }}
                  />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{n.name}</span>
                </div>
                <div style={{ marginTop: 2 }}>
                  <Tag
                    style={{ marginInlineEnd: 0, fontSize: 11, lineHeight: '16px' }}
                    color={n.status === 'active' ? 'green' : n.status === 'paused' ? 'orange' : 'default'}
                  >
                    {n.status}
                  </Tag>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
        左侧为上游依赖，右侧为下游触发链；箭头方向 = 执行完成后的触发方向。圆点颜色 = 任务状态（绿=启用，橙=暂停）。
      </Typography.Text>
    </div>
  );
}
