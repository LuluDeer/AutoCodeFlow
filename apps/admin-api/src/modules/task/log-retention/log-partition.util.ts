/**
 * ARCH-22: execution_log_lines 按日 RANGE 分区的共享纯函数。
 *
 * 消费方：
 * - 迁移 1789900000002（PartitionExecutionLogLines）：建分区父表 + 预建
 *   today-1 ~ today+7 的日分区；
 * - LogRetentionCleanupService：每日预建未来分区（ensureUpcomingPartitions）
 *   与超期分区 DETACH（cleanupExpiredPartitions）。
 *
 * 边界约定（文档化，docs/operations.md「分区表运维」段）：
 * - 分区按 **UTC 日历日** 切分（本文件所有日期字符串都用 toISOString 的
 *   UTC 日期部分）；DB 侧 createdAt 为无时区 timestamp（DEFAULT now()），
 *   日界附近的行归属随 DB 会话时区有几小时偏移，对 30 天保留期的清理
 *   判定无实质影响；
 * - 分区命名规范 `execution_log_lines_YYYYMMDD`（迁移与预建 job 统一生成；
 *   人工建的分区命名不同也不影响清理——detach 判定解析的是分区边界
 *   表达式 pg_get_expr(relpartbound)，命名仅是快查习惯）。
 */

/** 分区表名前缀（execution_log_lines_20260908 形态） */
export const LOG_PARTITION_NAME_PREFIX = "execution_log_lines_";

/** 日期字面量格式 YYYY-MM-DD（PG timestamp 字面量） */
export type PartitionDayLiteral = string;

/** 取 day 的 UTC 日历日 YYYY-MM-DD */
export function partitionDayLiteral(day: Date): PartitionDayLiteral {
  return day.toISOString().slice(0, 10);
}

/** YYYYMMDD 数字串（分区名用） */
export function partitionNameFor(day: Date): string {
  return `${LOG_PARTITION_NAME_PREFIX}${partitionDayLiteral(day).replace(/-/g, "")}`;
}

/** 真实日历日校验（20269999 这类非法月日拒绝） */
function isValidCalendarDay(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= daysInMonth;
}

/** 分区名 → 该分区 UTC 零点；非本规范命名或非法日期返回 null */
export function parseDayFromPartitionName(name: string): Date | null {
  const m = new RegExp(`^${LOG_PARTITION_NAME_PREFIX}(\\d{8})$`).exec(name);
  if (!m) return null;
  const y = Number(m[1].slice(0, 4));
  const mo = Number(m[1].slice(4, 6));
  const d = Number(m[1].slice(6, 8));
  if (!isValidCalendarDay(y, mo, d)) return null;
  const date = new Date(Date.UTC(y, mo - 1, d));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** day 的 UTC 日历日分区边界：[from, to) 字面量（PG FOR VALUES 用） */
export function partitionRangeFor(day: Date): {
  from: PartitionDayLiteral;
  to: PartitionDayLiteral;
} {
  const from = partitionDayLiteral(day);
  const to = partitionDayLiteral(new Date(day.getTime() + 86_400_000));
  return { from, to };
}

/**
 * 从 pg_get_expr(relpartbound, oid) 的输出解析分区上界（TO 侧）。
 * 形如 `FOR VALUES FROM ('2026-09-08 00:00:00') TO ('2026-09-09 00:00:00')`。
 * 上界按 UTC 解释（与 partitionDayLiteral 的 UTC 日历日约定一致）；
 * 解析失败返回 null（调用方视为不可判定，跳过该分区）。
 */
export function parsePartitionUpperBound(boundSql: string): Date | null {
  const m = /\bTO\s*\('([^']+)'\)/.exec(boundSql ?? "");
  if (!m) return null;
  const raw = m[1];
  // 完整时间戳形态 'YYYY-MM-DD [HH:mm:ss[.fff]]'——补齐为 UTC ISO 形态解析
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? `${raw}T00:00:00Z`
    : `${raw.replace(" ", "T")}Z`;
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d;
}
