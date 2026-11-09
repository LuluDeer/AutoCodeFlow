/**
 * R151（F3）：任务详情「执行记录」Tab 的**整块 UI + 列定义**（从 `TaskDetailPage.tsx`
 * 外提；整块逐字搬移 + **新增错误态**，行为其余零变更）。
 *
 * ## 为什么外提
 *
 * `apps/admin-web/src/pages/TaskDetailPage.tsx` 在体量棘轮顶格
 * （`scripts/source-size-baseline.json`：nonCommentLines=1039 / ceiling 1039，
 * **只剩 2 行余量**）⇒ F3 的错误分支无处可放（+6 行即红）。
 * 先例：R150 `pages/application-detail/DeployToDevicesModal.tsx`、R141
 * `pages/sops/AssignSopModal.tsx`（整块 JSX 逐字搬移、props 全显式、行为零变更）。
 *
 * ## 本文件修的缺陷（F3）
 *
 * `useTaskExecutions` 的 `error` 此前被**丢弃**（页面只解构 `data` / `isLoading`）：
 * `GET /tasks/:id/executions` 失败（500 / 超时 / 网关）时 `execData` 为 undefined
 * ⇒ 执行行数组为空 ⇒ 表格渲染「暂无执行记录」。而「这个任务从没执行过」与
 * 「执行记录读不出来」是**两个方向相反的结论**：
 *
 *   · 前者会让人**立刻手动触发一次**（本页右上就有「手动触发」）⇒ 多一次真实执行；
 *   · 后者应当重试或报障。
 *
 * 同页已有正确范式：`task` 有整页错误块、`taskStats` 失败时整块不渲染（宁可缺席
 * 也不撒谎）。唯独这个查询既无错误分支、又有明确的空态文案 ⇒ 三处口径不一致。
 *
 * 本文件把三态分开（复用全站既有 `components/StateError`，**不自造**错误块）：
 *
 *   · 读取中（`execLoading`）⇒ 表格自带的 loading 指示（未动）；
 *   · 读取失败（`execError`）⇒ **错误块 + 重试**（`onRetry` ⇒ `refetch` 本查询），
 *     且**不渲染**「暂无执行记录」——此刻那句文案是一个**假事实**；
 *   · 读取成功且为空 ⇒ 「暂无执行记录」（真空态，**保留**，逐字未改）。
 *
 * ## 已加载的执行行在错误态怎么处理（理由）
 *
 * 错误态**整段替换**表格（不再渲染旧行）。React Query 在 error 之后仍保留上一次
 * 成功的 `data`，但「这批行是上一次读到的」这件事**界面上没有任何标注**——页面
 * 唯一的行级时间戳是「开始时间」，不是「读取时间」⇒ 旧行与错误块并排会被读成
 * 当前事实。错误块 + 一个重试按钮已构成完整的可恢复路径；重试成功后表格原样回来
 * （RQ 缓存里旧数据仍在，秒回）。
 *
 * ## 依赖边界（重要）
 *
 * 本模块**不持有任何 state、不发任何请求**：取数在页面里完成，数据与交互回调
 * 全部经 props 显式传入（与 `pages/task-detail/version-view-models.tsx`「依赖全显式
 * 参数」同一形态，也照 R150 `DeployToDevicesModal.tsx` 的 props 口径）。
 */
import {
  Badge,
  Button,
  Card,
  Empty,
  Popconfirm,
  Space,
  Table,
  Tooltip,
  Typography,
} from 'antd';
import {
  EyeOutlined,
  ReloadOutlined,
  StopOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import type { TaskExecution } from '../../api/tasks';
import { triggerLabel } from '../../utils/trigger-label';
import { formatDateTime, formatDuration, formatRelativeTime } from '../../utils/timeFormat';
import { EXECUTION_BADGE_STATUS } from '../../utils/status-color';
import ArtifactsList from '../../components/ArtifactsList';
import StateError from '../../components/StateError';

const { Text } = Typography;

/** 执行状态 → 本地化文案（页面原 `STATUS_LABEL`，随列定义一并外提）。 */
const STATUS_LABEL = (t: (k: string) => string): Record<string, string> => ({
  pending: t('taskDetail.status.pending'), running: t('taskDetail.status.running'), success: t('taskDetail.status.success'),
  failed: t('taskDetail.status.failed'), timeout: t('taskDetail.status.timeout'), killed: t('taskDetail.status.killed'), cancelled: t('taskDetail.status.cancelled'),
});

/** 执行器可读名解析（ADR-017 阶段 3；解析不到时如实回落地址，绝不编造）。 */
export type ExecutorNameResolver = (
  deployment: { executorId?: string | null; executorAddress?: string | null },
) => string | null;

export interface ExecutionsTabProps {
  /** 已取到的执行行（错误态下可能是上一次的缓存——错误态不渲染它们，见文件头注）。 */
  executions: TaskExecution[];
  /** 执行行总数（后端 total，分页用）。 */
  execTotal: number;
  /** 当前页码（1 起）。 */
  execPage: number;
  /** 切页。 */
  onExecPageChange: (page: number) => void;
  /** 取数中（表格自带 loading 指示）。 */
  execLoading: boolean;
  /** 取数错误（null/undefined = 无错误）。 */
  execError: unknown;
  /** 重试（重新拉取本查询 ⇒ `refetch`）。 */
  onRetry: () => void;
  /** 刷新（失效执行面缓存并重取）。 */
  onRefresh: () => void;
  /** 手动触发一次执行。 */
  onManualTrigger: () => void;
  /** 终止某次执行。 */
  onKill: (execId: string) => void;
  /** 正在终止的执行 id（该行按钮显示 loading）。 */
  killingId: string | null;
  /** 打开某次执行的详情页。 */
  onOpenDetail: (execId: string) => void;
  /** 执行器可读名解析。 */
  nameOf: ExecutorNameResolver;
}

/**
 * 「执行记录」Tab：刷新/手动触发两个动作 + 最近一次执行的产物列表 + 执行行表。
 *
 * 三态口径见文件头注：**读取失败 ⇒ 错误块 + 重试，绝不说「暂无执行记录」**。
 */
export default function ExecutionsTab({
  executions,
  execTotal,
  execPage,
  onExecPageChange,
  execLoading,
  execError,
  onRetry,
  onRefresh,
  onManualTrigger,
  onKill,
  killingId,
  onOpenDetail,
  nameOf,
}: ExecutionsTabProps) {
  const { t } = useTranslation();
  const statusLabels = STATUS_LABEL(t);

  // UI-09：375px 可用性——关键列=状态/开始时间/错误/操作；触发/执行器/耗时为
  // 次要列窄屏收起（CSS 侧 .ui09-hide-mobile 双保险），scroll.x 横向滚动兜底。
  const hideOnMobile = {
    onHeaderCell: () => ({ className: 'ui09-hide-mobile' }),
    onCell: () => ({ className: 'ui09-hide-mobile' }),
  } as const;
  const execColumns = [
    {
      title: t('taskDetail.col.status'), dataIndex: 'status', width: 90,
      render: (s: string) => <Badge status={EXECUTION_BADGE_STATUS[s] ?? 'default'} text={statusLabels[s] || s} />,
    },
    {
      title: t('taskDetail.col.trigger'), dataIndex: 'triggerType', width: 80,
      ...hideOnMobile,
      // UX-06：此前渲染裸枚举（cron / fixed_rate / manual）。
      render: (v: string) => <Text type="secondary" style={{ fontSize: 12 }}>{triggerLabel(v, t) || '-'}</Text>,
    },
    {
      title: t('taskDetail.col.executor'), dataIndex: 'executorAddress', width: 140, ellipsis: true,
      responsive: ['md'] as import('antd/es/_util/responsiveObserver').Breakpoint[],
      // ADR-017 阶段 3（决策 §7）：主显可读名（员工给机器起的名字），地址降为
      // tooltip 副信息——地址仍是**诊断身份**（「到底哪台」），故不删除。
      // 解析不到名字时如实只显示地址（绝不编造），都没有则 '-'。
      render: (v: string, r: TaskExecution) => {
        const name = nameOf(r);
        const fallback = v || null;
        if (!name && !fallback) return <Text type="secondary">-</Text>;
        return (
          <Tooltip title={fallback ?? name ?? ''}>
            <Text style={{ fontSize: 11, fontFamily: name ? undefined : 'monospace' }}>
              {name ?? fallback}
            </Text>
          </Tooltip>
        );
      },
    },
    {
      title: t('taskDetail.col.startTime'), dataIndex: 'startTime', width: 140,
      render: (v: string) => v ? (
        <Tooltip title={formatDateTime(v)}>
          <Text style={{ fontSize: 12 }}>{formatRelativeTime(v, t)}</Text>
        </Tooltip>
      ) : '-',
    },
    {
      title: t('taskDetail.col.duration'), dataIndex: 'duration', width: 80,
      ...hideOnMobile,
      render: (v: number) => v != null ? <Text style={{ fontSize: 12 }}>{formatDuration(v, t)}</Text> : '-',
    },
    {
      title: t('taskDetail.col.error'), dataIndex: 'errorMessage', ellipsis: true, minWidth: 330,
      render: (v: string) => v ? <Text type="danger" style={{ fontSize: 12 }}>{v}</Text> : '-',
    },
    {
      title: '', key: 'actions', width: 100,
      render: (_: unknown, r: TaskExecution) => (
        <Space size={2}>
          {r.status === 'running' && (
            <Popconfirm
              title={t('taskDetail.killConfirmTitle')}
              description={t('taskDetail.killConfirmDesc')}
              onConfirm={() => onKill(r.id)}
              okText={t('taskDetail.kill')} okButtonProps={{ danger: true }}
            >
              <Tooltip title={t('taskDetail.kill')}>
                {/* A11Y-ICON-01：纯图标按钮补 aria-label（与 Tooltip 同键，读屏可播报） */}
                <Button type="text" size="small" danger icon={<StopOutlined />} aria-label={t('taskDetail.kill')}
                  loading={killingId === r.id} />
              </Tooltip>
            </Popconfirm>
          )}
          <Button type="link" size="small" icon={<EyeOutlined />}
            onClick={() => onOpenDetail(r.id)}>{t('taskDetail.detail')}</Button>
        </Space>
      ),
    },
  ];

  return (
    <Card
      extra={
        <Space>
          <Button size="small" icon={<ReloadOutlined />} onClick={onRefresh}>{t('taskDetail.refresh')}</Button>
          <Button size="small" type="primary" icon={<ThunderboltOutlined />} onClick={onManualTrigger}>{t('taskDetail.manualTrigger')}</Button>
        </Space>
      }
    >
      {/* F3：读取失败 ⇒ 错误块 + 重试；**不渲染**「暂无执行记录」（那是假事实）。 */}
      {execError ? (
        <StateError
          error={execError}
          title={t('taskDetail.execLoadFail')}
          onRetry={onRetry}
        />
      ) : (
        <>
          {/* FEAT-05（UI 半场）：最近一次执行的产物列表；无产物时组件返回 null，整段不渲染 */}
          {executions.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <ArtifactsList execId={executions[0].id} />
            </div>
          )}
          <Table<TaskExecution>
            rowKey="id"
            columns={execColumns}
            dataSource={executions}
            loading={execLoading}
            size="small"
            // UI-09：次要列窄屏收起（CSS 媒体查询 .ui09-hide-mobile）+ 横向滚动兜底（值班手机看失败原因）
            // UI 打磨：scroll.x 与列宽合计校准——定宽列 90+80+140+140+80+100=630，
            // 加错误摘要弹性列最小宽 330 → 960（原 620 小于定宽合计，窄屏挤压折行）
            scroll={{ x: 960 }}
            pagination={{
              total: execTotal,
              pageSize: 20,
              current: execPage,
              onChange: onExecPageChange,
              showTotal: (count) => t('taskDetail.countTotal', { count }),
            }}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('taskDetail.noExecutions')} /> }}
          />
        </>
      )}
    </Card>
  );
}
