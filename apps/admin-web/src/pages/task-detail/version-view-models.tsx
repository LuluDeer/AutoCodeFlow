/**
 * 「版本历史」抽屉的**视图模型**（版本列表列定义 + diff 键值行）——纯声明，无 state、
 * 无 effect、无请求。
 *
 * ## 为什么单独一个文件（与四子域 hook 的边界是刻意分开的）
 *
 * R6「TaskDetailPage 四子域 hook」收官时明确**未搬**这两块，理由记在
 * `useTaskVersionRollback.ts` 头注「刻意未搬的两块」：hook 只管**数据与请求**，
 * 而 `versionColumns` / `diffRows` 是**视图模型**（`t` / `isAdmin` /
 * `setRollbackTarget` 拼 JSX）。把它们塞进那个 hook，要么让 hook 反向依赖页面
 * 上下文（伪拆分），要么把页面 state 抄进 hook（两处真相）⇒ 都不可接受。
 *
 * 它们的正确去处是仓内**已有先例** `pages/task-list-columns.tsx`
 * （`buildTaskListColumns(deps)`）：**视图模型外提成纯函数 + 依赖全部显式参数**。
 * 本文件照同一形态做，不引入第二种形态。
 *
 * ## 依赖边界（重要）
 *
 * 搬迁前 `versionColumns` 是页面主函数体里的一段闭包，捕获了 `t` / `isAdmin` /
 * `setRollbackTarget` 三个页面值（**实测就这三个**）。搬出后它们变成
 * `VersionColumnsDeps` 的显式参数：本模块**不 import 任何页面 state、不持有任何
 * 自己的 state**，`buildVersionColumns(deps)` 每次调用返回一份新的列数组
 * （与搬迁前「每次渲染重建 `versionColumns`」逐字一致，不是 memo 化改造）。
 * 依赖里没有 `token`：版本列从不消费主题令牌（`token` 的真实消费点是 diff 卡片的
 * **内联** columns，不在本轮范围内，见下条）。
 *
 * ## `diffRows` 只有 3 行，为什么也放这里
 *
 * 单独看它是「null → 空数组 / 有值 → 逐键映射」的琐碎派生，收益≈0。但它与
 * `versionColumns` 同属**同一个抽屉的同一种东西**（视图模型），且它的形状
 * （`{ key, old, new }`）正是 diff 表 `dataSource` 的契约 —— 把行模型留在页面、
 * 列模型放这里，会让「diff 表长什么样」重新劈成两处。故两者同文件、同一刀。
 *
 * ⚠️ **如实留痕（本轴剩余的一块）**：diff 卡片的 `Table columns={[...]}` 仍是页面
 * JSX 里的内联数组（3 列，含 `token.colorSuccess` 与页内局部 `formatDiffValue`）。
 * 本轮任务书只点了 `versionColumns` / `diffRows` 两个名字，故**不动**它；它同样
 * 是视图模型，属同一条债轴的下一刀（搬它要连带 `formatDiffValue`，是独立判断）。
 *
 * ## 契约由既有测试钉住（本轮零 spec 改动）
 *
 * `__tests__/task-detail-version-history.test.tsx`（列表四列渲染 / 每行
 * `version-rollback-<v>` 入口 / diff 键值表内容 / 回滚确认链）与
 * `__tests__/antd-deprecation-clean.test.tsx`（抽屉 `size` 形态）走真实渲染，
 * 不读本文件的文本 ⇒ 搬迁后仍有效。
 */
import {
  Button,
  Space,
  Tooltip,
  Typography,
} from 'antd';
import type { TaskVersion, VersionDiff } from '../../api/tasks';
import { formatDateTime, formatRelativeTime } from '../../utils/timeFormat';

const { Text } = Typography;

/**
 * 列定义所需的全部外部依赖——**全部显式传入**，本模块不捕获任何页面 state。
 *
 * 每一项都对应搬迁前闭包里用到的那个变量；没有多传，也没有少传。
 */
export type VersionColumnsDeps = {
  /** i18n 取词函数（与搬迁前页面内的 `t` 是同一个值）。 */
  t: (k: string, opts?: Record<string, unknown>) => string;
  /** 当前用户是否管理员（决定「回滚到此版本」是否可用）。 */
  isAdmin: boolean;
  /** 点行内「回滚」时设置确认弹窗目标（页面的 `useTaskVersionRollback` 返回值）。 */
  setRollbackTarget: (target: TaskVersion) => void;
};

/**
 * diff 表的一行：一个配置键 + 旧值/新值。
 *
 * `rowKey="key"` 与 `dataIndex` 的 `key`/`old`/`new` 是页面 `<Table>` 侧的既有契约，
 * 形状与搬迁前逐字一致。
 */
export type VersionDiffRow = {
  key: string;
  old: unknown;
  new: unknown;
};

/**
 * 构造版本历史列表的列数组（版本号 / 时间 / 创建者 / 操作）。
 *
 * 纯函数：只依赖传入的 `deps`，不读模块级可变状态、不发请求、不改任何入参。
 * 列定义本身（标题、`dataIndex`、宽度、`render` 的每一行）**逐字未改**。
 */
export function buildVersionColumns(deps: VersionColumnsDeps) {
  const { t, isAdmin, setRollbackTarget } = deps;
  // A5：版本历史 Drawer 的列表列（版本号/时间/创建者/操作）。
  return [
    {
      title: t('taskDetail.version.col.version'),
      dataIndex: 'version',
      width: 130,
      render: (v: string, r: TaskVersion) => (
        <Space size={4}>
          <Text code>{v}</Text>
          {r.gitCommit && (
            <Tooltip title={`${t('taskDetail.version.gitCommit')}: ${r.gitCommit}`}>
              <Text type="secondary" style={{ fontSize: 11, fontFamily: 'monospace' }}>
                {r.gitCommit.slice(0, 7)}
              </Text>
            </Tooltip>
          )}
        </Space>
      ),
    },
    {
      title: t('taskDetail.version.col.time'),
      dataIndex: 'createdAt',
      width: 150,
      render: (v: string) => v ? (
        <Tooltip title={formatDateTime(v)}>
          <Text style={{ fontSize: 12 }}>{formatRelativeTime(v, t)}</Text>
        </Tooltip>
      ) : '-',
    },
    {
      title: t('taskDetail.version.col.creator'),
      dataIndex: 'createdBy',
      width: 110,
      ellipsis: true,
      render: (v: string | null) => v || <Text type="secondary">-</Text>,
    },
    {
      title: t('taskDetail.version.col.action'),
      key: 'actions',
      width: 150,
      render: (_: unknown, r: TaskVersion) => (
        <Tooltip title={isAdmin ? undefined : t('taskList.adminOnly')}>
          <Button
            size="small"
            data-testid={`version-rollback-${r.version}`}
            disabled={!isAdmin}
            onClick={() => setRollbackTarget(r)}
          >
            {t('taskDetail.version.rollback')}
          </Button>
        </Tooltip>
      ),
    },
  ];
}

/**
 * 构造 diff 键值行：`null`（未对比/已清理）⇒ 空数组，否则逐键映射为
 * `{ key, old, new }`。
 *
 * 空数组不是「加载中」的占位，而是「没有差异/没有对比结果」——页面据此渲染
 * `Empty`（`diffRows.length === 0`），与搬迁前同一判据。
 */
export function buildDiffRows(versionDiff: VersionDiff | null): VersionDiffRow[] {
  // A5：diff 键值行。
  return versionDiff
    ? Object.entries(versionDiff).map(([key, d]) => ({ key, old: d.old, new: d.new }))
    : [];
}
