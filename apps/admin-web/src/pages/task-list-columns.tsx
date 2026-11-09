/**
 * 任务列表**列定义**（TaskListPage 的表格列，纯声明）。
 *
 * ## 为什么搬出来
 *
 * 原本这 234 行 `columns` 数组内联在 `TaskListPage.tsx` 的主函数体里，是一段
 * **纯声明**（无 effect、无 state、无条件分支），却把主函数撑到 1,120 行——拆分的
 * 收益不在「逻辑变好」，而在「列契约从此有独立的名字和位置」。
 *
 * ## 依赖边界（重要）
 *
 * 这段声明此前**闭包捕获**了页面的 `t` / `nav` / `isAdmin` / `togglingId` /
 * `cloningId` / `token` 与 5 个 handler。搬出文件后一律改成**显式参数**
 * （见 `TaskListColumnsDeps`）：本模块**不 import 任何页面 state**，也**不**持有
 * 任何自己的 state——它是一个纯函数，`buildTaskListColumns(deps)` 每次调用返回一份
 * 新的列数组（与搬迁前「每次渲染重建 columns」的行为逐字一致）。
 *
 * 列定义本身（标题、`key`、`dataIndex`、宽度、`render` 的每一行）**逐字未改**——
 * 这次拆分只搬位置，不改语义。契约由既有测试钉住：
 * `src/__tests__/task-list-columns.test.tsx`（列键集合 + 显隐过滤）、
 * `task-list-deep.test.tsx`（列宽/scroll.x 契约）、
 * `task-list-keyset-paging.test.tsx`（分页态下列不变）。
 */
import {
  Button,
  Tag,
  Space,
  Typography,
  Badge,
  Popconfirm,
  Tooltip,
  Switch,
} from 'antd';
import {
  CopyOutlined, DeleteOutlined, EyeOutlined, EditOutlined, ThunderboltOutlined,
} from '@ant-design/icons';
import { Link } from 'react-router-dom';
import type { Task } from '../api/tasks';
import { priorityTag } from '../utils/priority';
import { runtimeLabel } from '../utils/runtime-label';
import { nextRunAt, formatFireTime, previewNeedsTimezoneWarning } from '../utils/trigger-preview';
import { formatDateTime, formatRelativeTime } from '../utils/timeFormat';
import { describeCron } from '../utils/cron-desc';

const { Text } = Typography;

/**
 * 状态 → 徽章/文案/颜色映射（与 `TaskListPage` 的 `STATUS_CONFIG(t)` 同形）。
 *
 * 形状与搬迁前逐字一致（`badge` 的取值域就是 antd `Badge` 的 `status` 取值域）。
 */
type StatusConfig = Record<string, {
  badge: 'success' | 'processing' | 'error' | 'default' | 'warning';
  label: string;
  color: string;
}>;

/** 触发类型 → 标签文案（`TaskListPage` 的 `TRIGGER_LABEL(t)` 的返回值形状）。 */
type TriggerLabelMap = Record<string, string>;

/**
 * 列定义所需的全部外部依赖——**全部显式传入**，本模块不捕获任何页面 state。
 *
 * 每一项都对应搬迁前 `columns` 闭包里用到的那个变量；没有多传，也没有少传。
 */
export type TaskListColumnsDeps = {
  /** i18n 取词函数（与搬迁前页面内的 `t` 是同一个值）。 */
  t: (k: string, opts?: Record<string, unknown>) => string;
  /** `STATUS_CONFIG(t)` 的结果。 */
  statusConfig: StatusConfig;
  /** `TRIGGER_LABEL(t)` 的结果。 */
  triggerLabel: TriggerLabelMap;
  /** 触发类型 → 标签颜色。 */
  triggerColor: Record<string, string>;
  /** 路由跳转（`useNavigate()` 的返回值）。 */
  nav: (to: string) => void;
  /** 当前用户是否管理员（决定编辑/克隆/触发/删除四个操作是否可用）。 */
  isAdmin: boolean;
  /** 正在切换启用态的任务 id（`null` = 无）。 */
  togglingId: string | null;
  /** 正在克隆的任务 id（`null` = 无）。 */
  cloningId: string | null;
  /** antd 主色（`theme.useToken().token.colorPrimary`）。 */
  colorPrimary: string;
  /** 暂停任务。 */
  onPause: (id: string) => Promise<void>;
  /** 恢复任务。 */
  onResume: (id: string) => Promise<void>;
  /** 打开触发弹窗。 */
  onTrigger: (id: string, name: string, defaultParams?: Record<string, unknown>) => void;
  /** 克隆任务。 */
  onClone: (task: Task) => Promise<void>;
  /** 删除任务。 */
  onDelete: (id: string) => Promise<void>;
};

/**
 * 构造任务列表的列数组。
 *
 * 纯函数：只依赖传入的 `deps`，不读模块级可变状态、不发请求、不改任何入参。
 */
export function buildTaskListColumns(deps: TaskListColumnsDeps) {
  const {
    t,
    statusConfig,
    triggerLabel,
    triggerColor,
    nav,
    isAdmin,
    togglingId,
    cloningId,
    colorPrimary,
    onPause,
    onResume,
    onTrigger,
    onClone,
    onDelete,
  } = deps;

  // UI-09：375px 可用性——关键列=名称/状态/启用/操作（值班首查项），其余次要列
  // responsive: ['md'] 在窄屏收起（CSS 侧 .ui09-hide-mobile 双保险）；
  // scroll.x 兜底横向滚动。onHeaderCell/onCell 挂类供媒体查询隐藏次要列。
  const hideOnMobile = {
    onHeaderCell: () => ({ className: 'ui09-hide-mobile' }),
    onCell: () => ({ className: 'ui09-hide-mobile' }),
  } as const;
  return [
    {
      title: t('taskList.col.name'),
      key: 'name',
      // 2026-10-27：删掉列头 sorter。它是**纯客户端**排序（只比较当前 dataSource），
      // 而本表是**服务端分页 + 游标（keyset）分页**——排出来的只是当页 20 行，
      // 用户以为按名称全局排序、翻页后顺序又变，属主动误导。
      // 后端确实支持 sortBy=name/sortOrder（list-tasks-query.dto.ts +
      // task.service 的 TASK_SORT_WHITELIST），但 assertCursorCompatibleWithQuery
      // 对 cursor+sortBy **直接 400**：服务端排序与游标分页在当前契约里互斥。
      // 要真正按名称排序需先在产品层二选一（取消游标分页 / 后端支持 cursor+sortBy），
      // 已登记 docs/OPEN-DECISIONS.md D6。
      render: (_: unknown, r: Task) => (
        // UI 打磨：名称/描述单行 ellipsis——此前双行均不断行，长描述把行高
        // 撑得忽高忽低；div minWidth:0 让弹性列内的省略号真正生效
        <div style={{ minWidth: 0 }}>
          {/* F-33（DEEP_REVIEW 0ef3bbe）：原 <a onClick> 无 href，改 <Link>（键盘可达 + 真实 href） */}
          <Link
            to={`/tasks/${r.id}`}
            title={r.name}
            style={{ fontWeight: 500, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {r.name}
          </Link>
          {r.description && (
            <Text type="secondary" style={{ fontSize: 12, display: 'block' }} ellipsis={{ tooltip: r.description }}>
              {r.description}
            </Text>
          )}
        </div>
      ),
    },
    {
      title: t('taskList.col.status'),
      // COLSET-01：显式 key（原仅 dataIndex）——列显隐过滤按 key 匹配，渲染不变
      key: 'status',
      dataIndex: 'status',
      width: 90,
      render: (s: string) => {
        const cfg = statusConfig[s] || { badge: 'default', label: s, color: 'default' };
        return <Badge status={cfg.badge} text={cfg.label} />;
      },
    },
    {
      title: t('taskList.col.trigger'),
      key: 'trigger',
      dataIndex: 'triggerType',
      width: 100,
      ...hideOnMobile,
      render: (v: string) => (
        <Tag color={triggerColor[v] || 'default'}>{triggerLabel[v] || v}</Tag>
      ),
    },
    {
      title: t('taskList.col.priority'),
      key: 'priority',
      width: 80,
      ...hideOnMobile,
      render: (_: unknown, r: Task) => {
        const t2 = priorityTag(r.priority, t);
        return <Tag color={t2.color}>{t2.label}</Tag>;
      },
    },
    {
      title: t('taskList.col.schedule'),
      key: 'schedule',
      width: 190,
      ...hideOnMobile,
      render: (_: unknown, r: Task) => {
        if (r.triggerType === 'cron' && r.cronExpression) {
          // CRON-DESC-01：裸表达式下补一行人类可读描述，用户不必心算
          const desc = describeCron(r.cronExpression, t);
          return (
            <div style={{ minWidth: 0 }}>
              <Text code style={{ fontSize: 12 }}>{r.cronExpression}</Text>
              {desc && (
                <Text type="secondary" style={{ fontSize: 11, display: 'block', whiteSpace: 'nowrap' }}>
                  {desc}
                </Text>
              )}
            </div>
          );
        }
        if (r.triggerType === 'fixed_rate' && r.fixedRate) {
          const secs = r.fixedRate;
          if (secs < 60) return <Text type="secondary" style={{ fontSize: 12 }}>{t('taskList.schedule.sec', { sec: secs })}</Text>;
          const mins = Math.floor(secs / 60);
          const rem = secs % 60;
          const label = rem > 0 ? t('taskList.schedule.minSec', { min: mins, sec: rem }) : t('taskList.schedule.min', { min: mins });
          // D-P1-1（设计审计）：≥60s 时 label 已是本地化的「N 分钟」/「N 分 M 秒」，
          // 不再外层套「每 {{sec}} 秒」模板——否则渲染出「每 2 分钟 秒」。
          return <Text type="secondary" style={{ fontSize: 12 }}>{label}</Text>;
        }
        return <Text type="secondary" style={{ fontSize: 12 }}>{t('taskList.nextRun.none')}</Text>;
      },
    },
    {
      title: t('taskList.col.nextRun'),
      key: 'nextRun',
      width: 170,
      ...hideOnMobile,
      render: (_: unknown, r: Task) => {
        // P1-1（UX-AUDIT-2026-09-21）：本列此前只渲染静态徽章（「Cron 计划中」
        // /「定时运行中」），而列题是「下次执行」、tooltip 写着「下次 Cron 触发
        // 时间」——承诺了时刻却从不给出时刻。用户因此无法回答"这任务下次什么
        // 时候跑、它到底还在不在跑"，静默不执行在上百个任务里根本发现不了。
        // 现按真实表达式算出最近一次触发时刻（复用详情页同一套纯函数）。
        if (r.status !== 'active') {
          return <Text type="secondary" style={{ fontSize: 12 }}>{t('taskList.nextRun.none')}</Text>;
        }
        const next = nextRunAt(r);
        if (next) {
          // 遗留 P1-3：tz 为空/非法时浏览器本地推算 ≠ 服务端进程时区，
          // tooltip 追加服务端时区注记（沿用 trigger-preview 警示文案）。
          const tzUnresolved = previewNeedsTimezoneWarning(r.timezone);
          return (
            <Tooltip
              title={tzUnresolved
                ? t('taskList.nextRun.cronTooltip') + '\n' + t('triggerPreview.tzUnresolved')
                : t('taskList.nextRun.cronTooltip')}
            >
              <Text style={{ fontSize: 12 }}>{formatFireTime(next, r.timezone)}</Text>
            </Tooltip>
          );
        }
        // 表达式存在但算不出（非法/超子集）——如实说"无法预估"，不编假时刻
        if (r.triggerType === 'cron' || r.triggerType === 'fixed_rate') {
          return (
            <Tooltip title={t('taskList.nextRun.unpredictableTooltip')}>
              <Text type="secondary" style={{ fontSize: 12 }}>{t('taskList.nextRun.unpredictable')}</Text>
            </Tooltip>
          );
        }
        return <Text type="secondary" style={{ fontSize: 12 }}>{t('taskList.nextRun.manual')}</Text>;
      },
    },
    {
      // P1-2（UX-AUDIT-2026-09-21）：上次触发时刻。该列在 DB 里一直存在、
      // 后端也一直返回并支持排序，但界面从不显示——于是"任务其实早就不跑了"
      // 这种最该被发现的静默故障反而最不可见。
      title: t('taskList.col.lastRun'),
      key: 'lastRun',
      width: 150,
      ...hideOnMobile,
      render: (_: unknown, r: Task) => {
        if (!r.lastTriggerTime) {
          return (
            <Tooltip title={t('taskList.lastRun.neverTooltip')}>
              <Text type="secondary" style={{ fontSize: 12 }}>{t('taskList.lastRun.never')}</Text>
            </Tooltip>
          );
        }
        // 此前是不带 locale 的裸 toLocaleString()——跟随**浏览器** locale，
        // 英文浏览器跑中文界面时显示 MM/DD/YYYY，与界面语言割裂。统一走
        // formatDateTime（locale 跟随 i18n），与相对时间文案同源。
        return (
          <Tooltip title={formatDateTime(r.lastTriggerTime)}>
            <Text style={{ fontSize: 12 }}>{formatRelativeTime(r.lastTriggerTime, t)}</Text>
          </Tooltip>
        );
      },
    },
    {
      title: t('taskList.col.runtime'),
      key: 'runtime',
      dataIndex: 'runtime',
      width: 96,
      ...hideOnMobile,
      render: (v: string) => v ? <Tag>{runtimeLabel(v, t)}</Tag> : '-',
    },
    {
      title: t('taskList.col.enabled'),
      key: 'toggle',
      width: 90,
      render: (_: unknown, r: Task) => (
        <Switch
          size="small"
          checked={r.status === 'active'}
          loading={togglingId === r.id}
          onChange={checked => checked ? onResume(r.id) : onPause(r.id)}
          disabled={r.status === 'failed' || r.status === 'inactive' || (!!togglingId && togglingId !== r.id)}
        />
      ),
    },
    {
      title: t('taskList.col.actions'),
      key: 'actions',
      // UI 打磨：5 个图标按钮实测 ~200px（移动端 .ant-btn-icon-only 还有
      // 40px 触控兜底），160 会裁按钮；fixed right 保证横向滚动时操作常驻
      width: 210,
      fixed: 'right' as const,
      render: (_: unknown, r: Task) => (
        <Space size={2}>
          {/* A11Y-ICON-01：纯图标按钮补中文 aria-label——此前读屏只能念出
              antd 图标自带的 aria-label（eye/edit/copy/thunderbolt/delete），
              中文界面下出现英文图标名，且与 Tooltip 文案不一致 */}
          <Tooltip title={t('taskList.action.detail')}>
            <Button type="text" size="small" icon={<EyeOutlined />} aria-label={t('taskList.action.detail')} onClick={() => nav(`/tasks/${r.id}`)} />
          </Tooltip>
          <Tooltip title={isAdmin ? t('taskList.action.edit') : t('taskList.adminOnly')}>
            <Button type="text" size="small" icon={<EditOutlined />} aria-label={isAdmin ? t('taskList.action.edit') : t('taskList.adminOnly')} disabled={!isAdmin} onClick={() => nav(`/tasks/${r.id}/edit`)} />
          </Tooltip>
          <Tooltip title={isAdmin ? t('taskList.action.clone') : t('taskList.adminOnly')}>
            <Button
              type="text" size="small" icon={<CopyOutlined />}
              aria-label={isAdmin ? t('taskList.action.clone') : t('taskList.adminOnly')}
              loading={cloningId === r.id}
              disabled={!isAdmin}
              onClick={() => onClone(r)}
            />
          </Tooltip>
          <Tooltip title={isAdmin ? t('taskList.action.trigger') : t('taskList.adminOnly')}>
            <Button
              type="text" size="small" icon={<ThunderboltOutlined />}
              aria-label={isAdmin ? t('taskList.action.trigger') : t('taskList.adminOnly')}
              disabled={!isAdmin}
              onClick={() => onTrigger(r.id, r.name, r.params)}
              style={{ color: colorPrimary }}
            />
          </Tooltip>
          <Popconfirm
            title={t('taskList.deleteConfirm')}
            description={t('taskList.deleteForceTerminateDesc')}
            onConfirm={() => onDelete(r.id)}
            okText={t('taskList.ok')} okButtonProps={{ danger: true }}
          >
            <Tooltip title={isAdmin ? t('taskList.action.delete') : t('taskList.adminOnly')}>
              <Button type="text" size="small" icon={<DeleteOutlined />} danger aria-label={isAdmin ? t('taskList.action.delete') : t('taskList.adminOnly')} disabled={!isAdmin} />
            </Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ];
}
