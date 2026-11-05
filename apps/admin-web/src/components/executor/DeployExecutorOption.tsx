/**
 * R64（§7.17 P3 收尾）：部署模态执行器下拉的**单行选项**（从
 * `pages/AppDeploymentPage.tsx` 外提——该页已在体量棘轮上限 919 非注释行）。
 *
 * ## 这里的数字度量什么（关键，勿与详情页混为一谈）
 *
 * `runningTaskCount` 是**已占槽位**（含 E-01 pull 取件预留），也正是服务端派发
 * 闸门读的那个数；本下拉的用途是「**挑一台还能接新部署的机器**」，判据必然是
 * 「还有没有空槽」⇒ 这里是**容量/占用**语义。
 *
 * 详情页（R18/R59）的「当前运行任务」是**实际在跑** = 已占 − 预留，回答的是
 * 「这台在跑几个任务」。两个问题不同，口径就不该强行统一：
 *
 * · 若把 `displayedRunningCount` 搬到这里，空闲 pull 执行器会显示 `0/10`，让人以为
 *   还有空槽可接新部署——而那个槽位正被长轮询预留占着 ⇒ 选它等于往满载机器派发
 *   （恰是 E-01 防超卖机制要关闭的竞态），且「已占 1」与「显示 0」会把派发闸门的
 *   真实判断藏起来；
 * · 反向也不能把详情页改成已占——那会让「确实空闲」与「预留占着」无法区分（R59 的
 *   提示就是为此而加）。
 *
 * 数据面也印证这一点：本页的数据源 `ExecutorPickerItem`（`api/executors.ts`）只有
 * id/appName/address/status/runningTaskCount/maxConcurrentTasks，**没有
 * reservedSlots 列**——想换算也算不出来。
 *
 * ## 为什么还要「消歧」
 *
 * 同一个执行器，部署下拉显示 `1/10`、详情页显示 `0/10`，用户会当成缺陷。故本组件
 * 把「已占槽位」写进可见文案的**可访问标签**（`aria-label`，读屏可读）+ Tooltip
 * 解释成因，而不是改数字。
 */
import { Badge, Progress, Tooltip, theme } from 'antd';
import { useTranslation } from 'react-i18next';

import type { ExecutorPickerItem } from '../../api/executors';

export default function DeployExecutorOption({ executor }: { executor: ExecutorPickerItem }) {
  const { t } = useTranslation();
  // F-15（DEEP_REVIEW 0ef3bbe）：次要文字/用量色走 antd token，暗色主题自适应。
  const { token } = theme.useToken();

  // R64 改名消歧：load → occupiedSlots（已占槽位，含取件预留），
  // maxLoad → capacitySlots（并发上限）。旧名 `load` 会被读成「在跑任务数」，
  // 而这正是本组件**不**度量的东西。
  const occupiedSlots = executor.runningTaskCount ?? 0;
  const capacitySlots = executor.maxConcurrentTasks ?? 10;
  const occupiedPercent = Math.min(100, Math.round((occupiedSlots / capacitySlots) * 100));

  const capacityLabel = t('appDeploy.executor.capacityAria', {
    occupied: occupiedSlots,
    capacity: capacitySlots,
  });

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0' }}>
      <Badge status={executor.status === 'online' ? 'success' : 'default'} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 500, fontSize: 13}}>{executor.appName}</div>
        <div style={{ fontSize: 11, color: token.colorTextTertiary }}>{executor.address}</div>
      </div>
      {/* aria-label 挂整句：hover-only 的 Tooltip 对读屏/触屏不可达，而**
          「这个数字是已占槽位还是实际在跑」正是最容易误会的一点。 */}
      <Tooltip title={t('appDeploy.executor.capacityTip')}>
        <div style={{ width: 80, textAlign: 'right' }} aria-label={capacityLabel}>
          <div style={{ fontSize: 11, color: token.colorTextTertiary }}>
            {t('appDeploy.executor.taskCount', { occupied: occupiedSlots, capacity: capacitySlots })}
          </div>
          <Progress
            percent={occupiedPercent}
            size="small"
            showInfo={false}
            strokeColor={occupiedPercent > 80 ? token.colorError : occupiedPercent > 60 ? token.colorWarning : token.colorSuccess}
          />
        </div>
      </Tooltip>
    </div>
  );
}
