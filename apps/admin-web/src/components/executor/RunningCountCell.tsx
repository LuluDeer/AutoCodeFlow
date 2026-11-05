/**
 * R62（§7.17 P3 收尾）：执行器列表页「任务数」单元格的**唯一渲染点**。
 *
 * 列表页原先把 `runningTaskCount` 的**原始值**直接当「在跑数」显示——那是**已占槽位**
 * （含 E-01 pull 取件预留），不是实际在跑。于是同一个执行器：列表「1/10」、
 * 详情「0/10」（详情页 R18/R59 已换算），运维只能二选一相信。
 *
 * 本组件与详情页 `RunningMetricsCard` 共用同一套口径与判据（`utils/executor-metrics.ts`，
 * 不复制逻辑）：
 *  · 显示 `实际在跑 = runningTaskCount − reservedSlots`（下限钳 0，与详情页逐字同源）；
 *  · 矛盾态（`reserved > occupied`）由 `InconsistentMetricsTag` 提示，两页文案一致。
 *
 * 之所以外提：`pages/ExecutorListPage.tsx` 已在体量棘轮上限（基线 579 非注释行 /
 * 628 函数体），R62 的改动必须**净减**而非新增（仓库惯例：外提子域，见 R18/R59 卡片外提）。
 */
import { Typography, theme } from 'antd';
import { useTranslation } from 'react-i18next';

import type { Executor } from '../../api/executors';
import { displayedRunningCount } from '../../utils/executor-metrics';
import InconsistentMetricsTag from './InconsistentMetricsTag';

export default function RunningCountCell({ executor }: { executor: Executor }) {
  const { t } = useTranslation();
  const { token } = theme.useToken();

  const occupiedSlots = executor.runningTaskCount ?? 0;
  const running = displayedRunningCount(executor);
  const max = executor.maxConcurrentTasks;
  const label = max != null ? t('execList.tasks.both', { running, max }) : t('execList.tasks.only', { running });

  return (
    <>
      <Typography.Text strong style={{ color: running > 0 ? token.colorPrimary : undefined, whiteSpace: 'nowrap' }}>
        {label}
      </Typography.Text>
      <InconsistentMetricsTag variant="icon" occupiedSlots={occupiedSlots} reservedSlots={executor.reservedSlots} />
    </>
  );
}
