/**
 * 任务依赖 DAG 可视化：布局由 dag-layout.ts 纯函数负责，画布的缩放/平移/
 * 高亮由 task-dag/DagCanvas 负责。编排动作用「触发 DAG 根节点」端点——
 * 只触发子图内零前驱的根节点并注入 _dagRunId，非根节点由依赖扇出自动触发。
 */
import { useMemo, useState } from 'react';
import { Alert, Empty, Typography, theme } from 'antd';
import { message } from '../utils/toast';
import PageSkeleton from './PageSkeleton';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { tasksApi, type TriggerDagRootsResult } from '../api/tasks';
import { useAllTasksForDag } from '../api/queries';
import { showApiError } from '../utils/error';
// RBAC 对齐：触发 DAG 根节点与页头「立即触发」同属写面，仅管理员可用。
import { useAuthStore, isAdminUser } from '../store/auth';
import StateError from './StateError';
import { buildDependencyGraph, type DagNode } from './dag-layout';
import DagCanvas from './task-dag/DagCanvas';
import { DagTriggerBar } from './task-dag/DagTriggerBar';
import { buildTriggerSummary, collectDagTaskIds, type TriggerSummary } from './task-dag/dagTrigger';
import { useDagLiveStatus } from './task-dag/useDagLiveStatus';
import type { LiveExecutionStatus } from './task-dag/dagLiveStatus';

const NODE_W = 176;
const NODE_H = 56;
const GAP_X = 84;
const GAP_Y = 18;
const PAD = 16;

// F-15（DEEP_REVIEW 0ef3bbe）：状态点色改由 antd token 提供（双主题自适应）。
type AntdToken = ReturnType<typeof theme.useToken>['token'];
function statusColor(n: LiveExecutionStatus | DagNode['status'] | undefined, token: AntdToken): string {
  if (!n) return token.colorTextTertiary;
  if (n === 'active' || n === 'success') return token.colorSuccess;
  if (n === 'running' || n === 'waiting') return token.colorInfo;
  if (n === 'paused' || n === 'pending' || n === 'timeout') return token.colorWarning;
  if (n === 'failed' || n === 'killed' || n === 'cancelled' || n === 'deleted') return token.colorError;
  return token.colorTextTertiary;
}

export default function TaskDependencyGraph({ taskId }: { taskId: string }) {
  const { t } = useTranslation();
  // DAG 根节点触发与页头「立即触发」同属写面，仅管理员可用。
  const isAdmin = isAdminUser(useAuthStore((s) => s.user));
  // P2-3：节点状态复用共享词表（taskList.status.*），不再渲染裸枚举。
  const STATUS_LABEL: Record<string, string> = {
    active: t('taskList.status.active'),
    paused: t('taskList.status.paused'),
    inactive: t('taskList.status.inactive'),
    failed: t('taskList.status.failed'),
    deleted: t('depGraph.status.deleted'),
  };
  const nav = useNavigate();
  const [triggering, setTriggering] = useState(false);
  const [triggerSummary, setTriggerSummary] = useState<TriggerSummary | null>(null);
  const { statuses: liveStatuses } = useDagLiveStatus(taskId);
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

  // NF-02: 待触发任务子图 = 当前任务 + 图上全部节点；后端只触发子图内零前驱的
  // 根节点，非根节点由根执行终态经依赖扇出，绝不 batchTrigger(allNodes)。
  const chainTaskIds = useMemo(() => (graph ? collectDagTaskIds(graph) : []), [graph]);

  const handleTriggerChain = async () => {
    if (triggering || chainTaskIds.length === 0) return;
    setTriggering(true);
    try {
      const result: TriggerDagRootsResult = await tasksApi.triggerDagRoots(chainTaskIds);
      setTriggerSummary(buildTriggerSummary(result));
      message.success(t('taskList.batchTriggered', { count: result.executions.length }));
    } catch (err: unknown) {
      showApiError(err, t('depGraph.chainTriggerFail'));
    } finally {
      setTriggering(false);
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
        <DagTriggerBar
          isAdmin={isAdmin}
          triggering={triggering}
          taskCount={chainTaskIds.length}
          summary={triggerSummary}
          onTrigger={() => void handleTriggerChain()}
        />
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
  const pos = new Map<string, { x: number; y: number; w: number; h: number }>();
  let maxRows = 1;
  for (const [layer, arr] of [...layers.entries()].sort((a, b) => a[0] - b[0])) {
    maxRows = Math.max(maxRows, arr.length);
    arr.forEach((n, i) => {
      pos.set(n.id, {
        x: PAD + layer * (NODE_W + GAP_X),
        y: PAD + i * (NODE_H + GAP_Y),
        w: NODE_W,
        h: NODE_H,
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
      <DagTriggerBar
        isAdmin={isAdmin}
        triggering={triggering}
        taskCount={chainTaskIds.length}
        summary={triggerSummary}
        onTrigger={() => void handleTriggerChain()}
      />
      <DagCanvas
        graph={graph}
        positions={pos}
        width={width}
        height={height}
        statusOf={(id) => liveStatuses.get(id)}
        statusLabel={(status) => STATUS_LABEL[status] ?? status}
        statusColor={statusColor}
        currentTaskId={taskId}
        onNavigate={(id) => nav(`/tasks/${id}`)}
      />
    </div>
  );
}