import type { Dayjs } from 'dayjs';

/**
 * 时间范围筛选的 UI → API 换算（口径唯一事实源，测试直接对它断言）。
 *
 * 后端 since/until 是 ISO 8601 **半开区间 [since, until)**：since 含头、
 * until 不含尾。UI 用日期粒度 RangePicker（不带 showTime），换算规则：
 *   · since = 开始日 00:00:00.000（本地时区）——开始日**整天计入**；
 *   · until = 结束日 00:00:00.000（本地时区）——结束日**当天不计入**：
 *     半开区间下它恰好等价于「到前一天 23:59:59.999 止」，即选 10-24 =
 *     到 10-23 23:59:59.999 止。此口径在筛选器 Tooltip 文案里同步披露
 *     （appDetail.events.filter.timeHint），不靠用户猜。
 * toISOString() 输出绝对时刻（UTC，带 Z），后端按绝对时刻解析，与浏览器
 * 时区无关。ExecutionsPage/audit 的 startTime/endTime 同此 toISOString 惯例。
 *
 * ## 2026-10-24 挪到 utils 共享（原 ApplicationDetailPage 导出）
 *
 * audit 页（pages/audit）的时间筛选与 events 统一口径：同样日期粒度
 * RangePicker，换算走本函数后 startTime=since、endTime=until。audit 后端
 * （applyAuditFilters）是**闭区间** `createdAt <= :endTime`，与 events 的
 * 半开 `< until` 相比理论上会多含「恰好落在结束日零点整（微秒不差）」的
 * 一条记录——本地零点换算成 UTC 后是任意时刻，PG 微秒精度下恰好相等的
 * 概率≈0，用户不可感知；口径（开始日整天计入、结束日当天不计入、预设
 * 整天语义）与 events 完全一致。
 *
 * 纯函数挪出页面文件是为了让跨页共享不引入页面模块耦合：直接
 * `import { eventsRangeToSinceUntil } from '../ApplicationDetailPage'`
 * 会把整个页面模块图（含 AppDeploymentPage 等依赖）拉进 audit 的 chunk。
 * ApplicationDetailPage 保留 re-export，既有导入方（测试等）不受影响。
 */
export function eventsRangeToSinceUntil(range: [Dayjs, Dayjs]): {
  since: string;
  until: string;
} {
  return {
    since: range[0].startOf('day').toISOString(),
    until: range[1].startOf('day').toISOString(),
  };
}
