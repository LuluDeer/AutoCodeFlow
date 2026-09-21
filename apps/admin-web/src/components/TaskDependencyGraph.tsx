/**
 * FEAT-02: 任务依赖 DAG 可视化（零新依赖——纯 CSS 定位 + SVG 连线）。
 * 布局逻辑全部在 dag-layout.ts（纯函数，单测覆盖），本组件只负责取数与绘制。
 * NF-02: 编排动作区——「从根触发整条链」（批量触发本任务+全部下游，复用
 * 既有 POST /tasks/batch/trigger；后端按 taskId 逐个 trigger，部分失败
 * 不影响其他任务）。触发顺序展示用：批量端点并行入队，真实下游触发由
 * 依赖扇出语义（上游全部 SUCCESS）兜底，无需前端排序保证。
 */
import { useMemo, useState } from 'react';
import { Button, Empty, Tag, Typography, Alert, message, theme } from 'antd';
import PageSkeleton from './PageSkeleton';
import { useNavigate } from 'react-router-dom';
import { ThunderboltOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { tasksApi } from '../api/tasks';
import { useAllTasksForDag } from '../api/queries';
import { getErrMsg } from '../utils/error';
import StateError from './StateError';
import { buildDependencyGraph, type DagNode } from './dag-layout';

const NODE_W = 176;
const NODE_H = 44;
const GAP_X = 84;
const GAP_Y = 18;
const PAD = 16;

// F-15（DEEP_REVIEW 0ef3bbe）：状态点色改由 antd token 提供（双主题自适应）。
type AntdToken = ReturnType<typeof theme.useToken>['token'];
function statusColor(n: DagNode['status'], token: AntdToken): string {
  if (n === 'active') return token.colorSuccess;
  if (n === 'paused') return token.colorWarning;
  if (n === 'deleted') return token.colorTextDisabled;
  return token.colorTextTertiary;
}

export default function TaskDependencyGraph({ taskId }: { taskId: string }) {
  const { t } = useTranslation();
  // P2-3：节点状态复用共享词表（taskList.status.*），不再渲染裸枚举。
  const STATUS_LABEL: Record<string, string> = {
    active: t('taskList.status.active'),
    paused: t('taskList.status.paused'),
    inactive: t('taskList.status.inactive'),
    failed: t('taskList.status.failed'),
    deleted: t('depGraph.status.deleted'),
  };
  // F-15（DEEP_REVIEW 0ef3bbe）：连线/节点边框/背景走 antd token，暗色主题自适应。
  const { token } = theme.useToken();
  const nav = useNavigate();
  const [chainTriggering, setChainTriggering] = useState(false);
  // 名称/状态解析需要全量任务表；useAllTasksForDag 会在后端 pageSize=100
  // 上限内分页聚合，图自身仍由 buildDependencyGraph 的节点上限保护。
  const { data, error, isLoading: loading, refetch } = useAllTasksForDag();

  const graph = useMemo(
    () =>
      buildDependencyGraph(
        (data?.items ?? []) as unknown as Parameters<typeof buildDependencyGraph>[0],
        taskId,
      ),
    [data, taskId],
  );

  // NF-02: 链式触发面 = 当前任务 + 图上全部节点（DAG 已含上下游闭包）。
  // 当前任务暂停/删除时不做前端拦截——后端 trigger 对暂停任务放行（与
  // 批量触发既有语义一致），删除任务由 404 逐项报错。
  const chainTaskIds = useMemo(
    () => (graph ? graph.nodes.map((n) => n.id) : []),
    [graph],
  );

  const handleTriggerChain = async () => {
    if (chainTriggering || chainTaskIds.length === 0) return;
    setChainTriggering(true);
    try {
      await tasksApi.batchTrigger(chainTaskIds);
      message.success(t('depGraph.chainTriggered', { count: chainTaskIds.length }));
    } catch (err: unknown) {
      message.error(getErrMsg(err, t('depGraph.chainTriggerFail')));
    } finally {
      setChainTriggering(false);
    }
  };

  // D-P2-07（设计审计）：整 Tab 加载改 PageSkeleton（table 变体），与全站首屏骨架一致
  if (loading && !data) {
    return <PageSkeleton variant="table" rows={6} />;
  }
  if (error) {
    return (
      <StateError
        error={error}
        title={t('depGraph.loadFail')}
        onRetry={() => void refetch()}
        centered
      />
    );
  }
  if (!graph) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={t('depGraph.taskMissing')}
      />
    );
  }
  if (graph.nodes.length <= 1 && graph.edges.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={t('depGraph.noDeps')}
      >
        <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 12 }}>
          {t('depGraph.noDepsHint')}
        </Typography.Text>
        {/* NF-02: 孤立任务也保留链式触发入口（=手动触发单任务） */}
        <Button
          data-testid="dag-trigger-chain"
          icon={<ThunderboltOutlined />}
          loading={chainTriggering}
          disabled={chainTriggering}
          onClick={handleTriggerChain}
        >
          {t('depGraph.triggerChain', { count: 1 })}
        </Button>
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
          title={t('depGraph.cycleAlert')}
          style={{ marginBottom: 12 }}
        />
      )}
      {graph.truncated && (
        <Alert
          type="info"
          showIcon
          title={t('depGraph.truncatedAlert', { count: graph.nodes.length })}
          style={{ marginBottom: 12 }}
        />
      )}
      {/* NF-02: 编排动作区——一键触发整条链（当前任务+全部上下游节点） */}
      <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'flex-end' }}>
        <Button
          data-testid="dag-trigger-chain"
          icon={<ThunderboltOutlined />}
          loading={chainTriggering}
          disabled={chainTriggering || chainTaskIds.length === 0}
          onClick={handleTriggerChain}
        >
          {t('depGraph.triggerChain', { count: chainTaskIds.length })}
        </Button>
      </div>
      <div style={{ overflow: 'auto', border: `1px solid ${token.colorBorderSecondary}`, borderRadius: 8 }}>
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
                  stroke={token.colorTextTertiary}
                  strokeWidth={1.5}
                  markerEnd="url(#dag-arrow)"
                />
              );
            })}
            <defs>
              <marker id="dag-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                <path d="M0,0 L8,4 L0,8 Z" fill={token.colorTextTertiary} />
              </marker>
            </defs>
          </svg>
          {graph.nodes.map((n) => {
            const p = pos.get(n.id)!;
            return (
              <div
                key={n.id}
                // D-P2-05（设计审计）：可点击节点补键盘可达——tabIndex + Enter/Space 触发
                tabIndex={n.isCurrent ? -1 : 0}
                role={n.isCurrent ? undefined : 'button'}
                aria-label={n.isCurrent ? t('depGraph.nodeCurrent') : t('depGraph.nodeNavigate')}
                onClick={() => !n.isCurrent && nav(`/tasks/${n.id}`)}
                onKeyDown={(e) => {
                  if (n.isCurrent) return;
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    nav(`/tasks/${n.id}`);
                  }
                }}
                style={{
                  position: 'absolute',
                  left: p.x,
                  top: p.y,
                  width: NODE_W,
                  height: NODE_H,
                  padding: '6px 10px',
                  borderRadius: 8,
                  border: n.isCurrent ? `2px solid ${token.colorPrimary}` : `1px solid ${token.colorBorder}`,
                  background: n.isCurrent ? token.colorPrimaryBg : token.colorBgContainer,
                  cursor: n.isCurrent ? 'default' : 'pointer',
                  overflow: 'hidden',
                  boxShadow: n.isCurrent ? '0 2px 8px rgba(34,197,94,0.25)' : undefined,
                }}
                title={n.isCurrent ? t('depGraph.nodeCurrent') : t('depGraph.nodeNavigate')}
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
                      background: statusColor(n.status, token),
                    }}
                  />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{n.name}</span>
                </div>
                <div style={{ marginTop: 2 }}>
                  <Tag
                    style={{ marginInlineEnd: 0, fontSize: 11, lineHeight: '16px' }}
                    color={n.status === 'active' ? 'green' : n.status === 'paused' ? 'orange' : 'default'}
                  >
                    {STATUS_LABEL[n.status] ?? n.status}
                  </Tag>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
        {t('depGraph.legend')}
      </Typography.Text>
    </div>
  );
}
