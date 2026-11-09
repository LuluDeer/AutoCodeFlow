/**
 * R59（§7.17 P3）：详情页「当前运行任务」卡片的**唯一展示口径**（从
 * `ExecutorDetailPage` 外提，便于把一组强相关的口径判断放在一处）。
 *
 * ## 这个卡片要同时说清三件事
 *
 * 1. **实际在跑**（`runningCount`）= 已占槽位 − 取件预留（E-01-RPT：pull 执行器
 *    在长轮询前先预留一个槽位，`runningTaskCount` 诚实包含它）；
 * 2. **合理预留**：`0 < reserved <= occupied` 时解释差额，避免运维把
 *    「0/10 但服务端占用 1」当成新的不一致；
 * 3. **计数自相矛盾**：`reserved > occupied`（R16/R17 实证可达）时显式提示
 *    「已按 0 显示」——R18 的钳制本身是无声的，只留一个 `0` 会让「确实空闲」
 *    与「后端两个计数打架」在像素上无法区分。
 *
 * 判据与换算全部来自 `utils/executor-metrics.ts` 的纯函数（同一套归一化），
 * 故「提示出现」与「数字被钳」严格同源，不会出现「钳了但没提示」。
 *
 * 边界（刻意）：本组件**只做展示**。不改任何落库字段，也不参与派发/容量判断
 * （派发闸门只读 `runningTaskCount`）。
 */
import { Card, Progress, Statistic, Tooltip, Typography, theme } from 'antd';
import { InfoCircleOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';

import { hasMeaningfulReservation, resolveRunningCount } from '../../utils/executor-metrics';
// R62：提示的渲染收敛到共享组件（列表页复用同一判据与同一文案）。
import InconsistentMetricsTag from './InconsistentMetricsTag';

const { Text } = Typography;

/** F-15（DEEP_REVIEW 0ef3bbe）：语义色改由 antd token 提供（双主题自适应）。 */
type AntdToken = ReturnType<typeof theme.useToken>['token'];
function usageColor(token: AntdToken, value: number, warn = 60, danger = 80): string {
  if (value >= danger) return token.colorError;
  if (value >= warn) return token.colorWarning;
  return token.colorSuccess;
}

export interface RunningMetricsCardProps {
  /** 已占槽位（含取件预留）= 服务端派发闸门读的那个数。 */
  occupiedSlots: number;
  /** 执行器上报的预留槽位数（null/undefined = 旧版执行器未上报）。 */
  reservedSlots: number | null | undefined;
  /** 活性上报的运行中 executionId 数（null/undefined = 旧版未上报）。 */
  reportedCount: number | null | undefined;
  /** 并发上限（0 = 未配置/不限，不渲染进度条与满载提示）。 */
  maxConcurrent: number;
  /** 原始 `maxConcurrentTasks`（用于 `/ ∞` 后缀，未配置时显示 ∞）。 */
  maxConcurrentTasks: number | null | undefined;
}

export default function RunningMetricsCard({
  occupiedSlots,
  reservedSlots,
  reportedCount,
  maxConcurrent,
  maxConcurrentTasks,
}: RunningMetricsCardProps) {
  const { t } = useTranslation();
  const { token } = theme.useToken();

  // 展示口径：已占槽位 − 预留，下限钳 0（旧版执行器 reservedSlots=null 时等于已占）。
  const runningCount = resolveRunningCount(occupiedSlots, reservedSlots);
  // 进度条用**实际运行数**——与标题口径一致，空闲时归零，不出现「0/10 但进度条 10%」。
  const runningPercent = maxConcurrent > 0 ? Math.min(100, Math.round((runningCount / maxConcurrent) * 100)) : 0;
  // 满载语义（occupiedSlots 达到上限即饱和）：用户需把「目标执行器饱和」与
  // 「根本没有可用执行器」区分开。
  const isSaturated = maxConcurrent > 0 && occupiedSlots >= maxConcurrent;

  return (
    <Card style={{ height: '100%' }}>
      <Statistic title={t('executorDetail.currentRunning')} value={runningCount} suffix={`/ ${maxConcurrentTasks ?? '∞'}`} />
      {maxConcurrent > 0 && (
        <>
          <Progress percent={runningPercent} strokeColor={usageColor(token, runningPercent, 70, 90)} style={{ marginTop: 8 }} />
          {isSaturated && (
            <Text type="warning" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
              {t('executorDetail.saturated')}
            </Text>
          )}
        </>
      )}
      {/* R59/R62：计数自相矛盾（reserved > occupied）时必须显式说明，否则
          `runningCount` 的 0 与「确实空闲」在像素上无法区分。渲染与判据都在
          `InconsistentMetricsTag`（列表页用同一个组件 ⇒ 两页措辞不可能漂移）。 */}
      <InconsistentMetricsTag occupiedSlots={occupiedSlots} reservedSlots={reservedSlots} />
      {/* E-01-RPT：预留差额的可观测性——仅在上报了预留且 `0 < reserved <= occupied`
          时解释（不一致态已由上一条提示接管，此处再解释会自相矛盾）。 */}
      {hasMeaningfulReservation(occupiedSlots, reservedSlots) && (
        <Tooltip title={t('executorDetail.reserved.tip')}>
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
            {t('executorDetail.reserved.note', { reserved: reservedSlots, occupied: occupiedSlots })} <InfoCircleOutlined aria-hidden="true" />
          </Text>
        </Tooltip>
      )}
      {reportedCount != null && reportedCount !== runningCount && (
        <Text type="warning" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
          {t('executorDetail.inconsistent', { reported: reportedCount, running: runningCount })}
        </Text>
      )}
    </Card>
  );
}
