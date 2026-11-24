/**
 * 执行记录表格列定义（纯展示工厂，零状态）。
 *
 * 沿用 TaskListPage R6 先例：列声明从页面函数体外提，依赖全部显式参数化，
 * 渲染口径与原位逐字节一致（列宽 / 文案 / 操作按钮 / 窄屏收起类不变）。
 * 页面只负责把 t、状态映射、执行器名解析、导航与终止回调传进来。
 */
import { Badge, Button, Popconfirm, Space, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { EyeOutlined, StopOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import type { TFunction } from 'i18next';

import type { TaskExecution } from '../../api/tasks';
import { triggerLabel } from '../../utils/trigger-label';
import { formatDateTime, formatDuration, formatRelativeTime } from '../../utils/timeFormat';
import { shortExecutorRowId } from '../../utils/executorRowId';

const { Text } = Typography;

type BadgeStatus = 'success' | 'processing' | 'error' | 'default' | 'warning';

export interface ExecColumnsDeps {
  t: TFunction;
  statusMap: Record<string, { badge: BadgeStatus; label: string }>;
  nameOf: (r: TaskExecution) => string | null;
  nav: (to: string) => void;
  onKill: (r: TaskExecution) => void;
  killingId: string | null;
}

export function buildExecColumns({
  t,
  statusMap,
  nameOf,
  nav,
  onKill,
  killingId,
}: ExecColumnsDeps): ColumnsType<TaskExecution> {
  // 触发方式/执行器/耗时为次要列窄屏收起（CSS 侧 .ui09-hide-mobile 双保险）；
  // scroll.x 兜底横向滚动。onHeaderCell/onCell 挂类供媒体查询隐藏次要列。
  const hideOnMobile = {
    onHeaderCell: () => ({ className: 'ui09-hide-mobile' }),
    onCell: () => ({ className: 'ui09-hide-mobile' }),
  } as const;

  return [
    {
      title: t('execs.col.task'),
      dataIndex: 'taskName',
      render: (name: string, r: TaskExecution) => (
        // F-33（DEEP_REVIEW 0ef3bbe）：原 <a onClick> 无 href，改 <Link>（键盘可达 + 真实 href）
        // UI 打磨：长任务名单行 ellipsis，不再整列换行撑高行
        <Link
          to={`/tasks/${r.taskId}`}
          title={name || r.taskId}
          style={{ fontWeight: 500, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {name || r.taskId}
        </Link>
      ),
    },
    {
      title: t('execs.col.status'),
      dataIndex: 'status',
      width: 118,
      render: (s: string) => {
        const cfg = statusMap[s] || { badge: 'default' as BadgeStatus, label: s };
        return <Badge status={cfg.badge} text={cfg.label} style={{ whiteSpace: 'nowrap' }} />;
      },
    },
    {
      title: t('execs.col.trigger'),
      dataIndex: 'triggerType',
      width: 90,
      ...hideOnMobile,
      // P1-17：走唯一事实源 triggerLabel（已知值本地化、未知值回退原 token），
      // 不再直接渲染 {v || '-'} 裸枚举。
      render: (v: string) => {
        const label = triggerLabel(v, t);
        return <Text type="secondary" style={{ fontSize: 12 }}>{label || '—'}</Text>;
      },
    },
    {
      title: t('execs.col.executor'),
      dataIndex: 'executorAddress',
      width: 210,
      ellipsis: true,
      ...hideOnMobile,
      // ADR-017 阶段 3（决策 §7）：主显可读名（员工给机器起的名字），地址降为
      // tooltip 副信息——地址仍是**诊断身份**（「到底哪台」），故不删除。
      // 解析不到名字时如实只显示地址（绝不编造），都没有则 '-'。
      render: (v: string, r: TaskExecution) => {
        const name = nameOf(r);
        const fallback = v || null;
        if (!name && !fallback) {
          return <Text type="secondary" style={{ fontSize: 12 }}>—</Text>;
        }
        // §8.3 工单 10：名字旁标注**行 id 前 8 位**（tooltip 给地址与完整 id）。
        // 同址多行时（pull 各自成行 / DHCP 复用同一 IP）名字与地址都可能相同，
        // 只有行 id 能区分「同一个地址下的两台机器」。
        const rowId = shortExecutorRowId(r.executorId);
        const tooltip = [fallback, r.executorId ? `${t('execShared.rowId')}: ${r.executorId}` : null]
          .filter(Boolean)
          .join('\n');
        return (
          <Tooltip title={tooltip}>
            <span style={{ fontSize: 12 }}>
              {name ?? fallback}
              {rowId && (
                <Text type="secondary" style={{ fontSize: 11 }}>
                  {' '}#{rowId}
                </Text>
              )}
            </span>
          </Tooltip>
        );
      },
    },
    {
      title: t('execs.col.startTime'),
      dataIndex: 'startTime',
      width: 130,
      render: (v: string) => v ? (
        <Tooltip title={formatDateTime(v)}>
          <Text style={{ fontSize: 12 }}>{formatRelativeTime(v, t)}</Text>
        </Tooltip>
      ) : '—',
    },
    {
      title: t('execs.col.duration'),
      dataIndex: 'duration',
      width: 90,
      ...hideOnMobile,
      // UI-08：时长如「32分46秒」窄列会折成两行，nowrap 保证单行可扫读
      render: (v: number) => v != null ? <Text style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{formatDuration(v, t)}</Text> : '—',
    },
    {
      title: t('execs.col.error'),
      dataIndex: 'errorMessage',
      minWidth: 160,
      ellipsis: true,
      render: (v: string) => v ? <Text type="danger" style={{ fontSize: 12, display: 'block' }} ellipsis={{ tooltip: v }}>{v}</Text> : '—',
    },
    {
      title: t('execs.col.action'),
      key: 'action',
      // 2026-10-23 实测修正（此前「终止」被裁掉一半）：操作列放**两个带图标+文字的
      // link 按钮**，宽度由内容决定而不是估一个数——
      //   中文「详情」≈66px + 间距 4 + 「终止」≈66px + 单元格左右内边距 32 = 168；
      //   英文「Details」≈82px + 4 + 「Terminate」≈90 + 32 = 208。
      // 原 width:135 在 running/waiting 行必然溢出（实测 td 1281..1416，
      // 终止按钮 1367..1433 → 右边缘被裁 17px，表现为只看得见半个字）。
      // 取 210 覆盖英文最宽形态；fixed right 保证横向滚动时常驻。
      width: 210,
      fixed: 'right' as const,
      render: (_: unknown, r: TaskExecution) => (
        <Space size={4} wrap={false}>
          <Button
            type="link" size="small" icon={<EyeOutlined />}
            onClick={() => nav(`/tasks/${r.taskId}/executions/${r.id}`)}
          >
            {t('execs.action.detail')}
          </Button>
          {(r.status === 'running' || r.status === 'waiting') && (
            // KILL-WAITING：互斥排队中的执行也走既有 killExecution——后端
            // OPEN_EXECUTION_STATUSES 已把 WAITING 列为打开态（MUTEX-01），
            // 前端此前只对 running 出按钮，排队中的执行只能等占用释放。
            <Popconfirm
              title={t('execs.killConfirm')}
              description={r.status === 'waiting' ? t('execs.killConfirmWaitingDesc') : t('execs.killConfirmRunningDesc')}
              onConfirm={() => onKill(r)}
              okText={t('execs.action.kill')} okButtonProps={{ danger: true }}
            >
              <Button
                type="link" size="small" danger
                icon={<StopOutlined />}
                loading={killingId === r.id}
              >
                {t('execs.action.kill')}
              </Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];
}
