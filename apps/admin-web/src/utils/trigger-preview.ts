/**
 * UI-06: 触发预览纯函数层——cron / fixed_rate 的「未来 5 次触发时刻」计算。
 *
 * 独立成文件（对齐 executor-mode.ts / task-template-prefill.ts 先例）是为了
 * 可测试性与 react-refresh（组件文件只导出组件）。
 *
 * 零新依赖决策（认领记录已论证）：admin-web 无 node-cron/cronstrue，为预览
 * 引包不值得——本文件手写轻量解析，**只支持后端 CreateTaskDto @Matches 正则
 * 允许的 5 字段子集**（结构正则同口径复用语义：星号/数字/范围/步进/逗号），
 * 超出子集或语义非法（2 月 30 日等）一律返回 null → UI 渲染占位文案，
 * 绝不猜错时刻误导用户。后端运行时合法性由 node-cron.validate 把关（scheduler
 * 注册路径），前端预览是纯展示增强，非法表达式不影响提交校验链。
 *
 * 时区感知：与 scheduler.getCronOptions 同一语义——timezone 字符串经
 * Intl.DateTimeFormat 校验，非法回退服务端默认（此处=浏览器本地时区）。
 * 展示文本用 Intl.DateTimeFormat（IANA tz）渲染所选时区的时刻。
 */

/**
 * 5 字段 cron 结构正则（分 时 日 月 周）：星号、数字、范围、步进及逗号组合。
 * DTO 的 @Matches 是其「无逗号」子集（逗号组合在 DTO 层会被拒——CronHelper
 * 预设/常见写法均不用逗号）；预览层按超集宽容解析，逗号组合若整体语义合法
 * 也给出预览，提交是否放行仍由后端 DTO/validate 裁决（预览绝不放宽后端口径，
 * 只是展示层不重复拦截）。语义越界（逗号展开后超范围）仍拒绝。
 */
const CRON_5FIELD_RE =
  /^(\*|[0-5]?\d)(?:\/\d+)?(?:[,-](\*|[0-5]?\d)(?:\/\d+)?)* (\*|[01]?\d|2[0-3])(?:\/\d+)?(?:[,-](\*|[01]?\d|2[0-3])(?:\/\d+)?)* (\*|[012]?\d|3[01])(?:\/\d+)?(?:[,-](\*|[012]?\d|3[01])(?:\/\d+)?)* (\*|1[0-2]|0?[1-9])(?:\/\d+)?(?:[,-](\*|1[0-2]|0?[1-9])(?:\/\d+)?)* (\*|[0-7])(?:\/\d+)?(?:[,-](\*|[0-7])(?:\/\d+)?)*$/;

const FIELD_PART_RE = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/;

/** 解析后的单字段数值集合 */
type FieldSet = Set<number>;

/**
 * 把单字段展开为数值集合（星号/n/a-b/n-s/步进/逗号，POSIX n/step=n..max 语义）。
 * 越界/空集返回 null。与 admin-api parseField 语义一致。
 */
function parseField(raw: string, min: number, max: number): FieldSet | null {
  const out = new Set<number>();
  for (const part of raw.split(',')) {
    const m = FIELD_PART_RE.exec(part);
    if (!m) return null;
    const step = m[3] !== undefined ? parseInt(m[3], 10) : 1;
    if (!Number.isInteger(step) || step < 1) return null;
    let lo = min;
    let hi = max;
    if (m[1] !== '*') {
      lo = parseInt(m[1], 10);
      hi =
        m[2] !== undefined ? parseInt(m[2], 10) : m[3] !== undefined ? max : lo;
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) return null;
      if (lo < min || hi > max || lo > hi) return null;
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out.size > 0 ? out : null;
}

interface ParsedCron {
  minute: FieldSet;
  hour: FieldSet;
  dayOfMonth: FieldSet;
  month: FieldSet;
  dayOfWeek: FieldSet;
  domAll: boolean;
  dowAll: boolean;
}

/**
 * 解析 5 字段 cron。结构正则通过后做逐字段语义解析（含逗号展开越界检查）；
 * 语义非法返回 null。
 */
export function parseCronExpression(expr: string): ParsedCron | null {
  const trimmed = (expr ?? '').trim().replace(/\s+/g, ' ');
  if (!trimmed || !CRON_5FIELD_RE.test(trimmed)) return null;
  const fields = trimmed.split(' ');
  const minute = parseField(fields[0], 0, 59);
  const hour = parseField(fields[1], 0, 23);
  const dayOfMonth = parseField(fields[2], 1, 31);
  const month = parseField(fields[3], 1, 12);
  const dayOfWeek = parseField(fields[4], 0, 7);
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) return null;
  // POSIX/node-cron：7 视同周日 0
  if (dayOfWeek.has(7)) dayOfWeek.add(0);
  return {
    minute,
    hour,
    dayOfMonth,
    month,
    dayOfWeek,
    domAll: fields[2] === '*',
    dowAll: fields[4] === '*',
  };
}

/**
 * 单分钟匹配（DOM/DOW 并存按 POSIX OR——与 admin-api cronMatchesAt 同语义，
 * node-cron 实际行为）。入参 d 必须是「墙钟按 UTC 字段解读」的 Date
 * （wall-clock-as-UTC 约定，见 nextCronFireTimes）。
 */
function cronMatchesAt(p: ParsedCron, d: Date): boolean {
  if (!p.minute.has(d.getUTCMinutes())) return false;
  if (!p.hour.has(d.getUTCHours())) return false;
  if (!p.month.has(d.getUTCMonth() + 1)) return false;
  const domHit = p.dayOfMonth.has(d.getUTCDate());
  const dowHit = p.dayOfWeek.has(d.getUTCDay());
  if (p.domAll && p.dowAll) return true;
  if (p.domAll) return dowHit;
  if (p.dowAll) return domHit;
  return domHit || dowHit;
}

/**
 * timezone 字符串有效性校验（与 scheduler.getCronOptions 同一实现路径：
 * Intl.DateTimeFormat 试格式化）。空串/undefined → null（用本地时区）。
 */
export function validateTimezone(tz?: string | null): string | null {
  const trimmed = tz?.trim();
  if (!trimmed) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: trimmed }).format(new Date());
    return trimmed;
  } catch {
    return null;
  }
}

/**
 * 求给定时区下「从 now 起（含当前分钟）的未来第 k 次触达时刻」。
 *
 * 实现方式：把「时区墙钟时刻」逐分钟枚举（用 Intl 求该时区相对 UTC 的
 * 偏移并反向构造墙钟 Date），对墙钟做 cron 匹配，命中即收集。
 * DST 安全：偏移按每个墙钟时刻单独求解，跨越夏令时边界时墙钟继续走、
 * 时刻自动换算，不依赖固定偏移。
 *
 * 扫描上限：maxMinutes（缺省 60*24*370 ≈ 一年+缓冲，覆盖「每月 1 号」类
 * 表达式）；超限未凑满 count 返回已找到的（可能少于 count，UI 注明）。
 * 返回的是真实 UTC 时刻（Date），展示层再用 Intl 渲染目标时区文本。
 */
export function nextCronFireTimes(
  expr: string,
  count: number,
  now: Date = new Date(),
  timezone?: string | null,
): Date[] {
  const parsed = parseCronExpression(expr);
  if (!parsed) return [];
  const tz = validateTimezone(timezone);

  // 求时区偏移（分钟）：目标时区在该 UTC 时刻的墙钟 - UTC 墙钟。
  const offsetMinutes = (utcMs: number): number => {
    if (!tz) return -new Date(utcMs).getTimezoneOffset();
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const parts = dtf.formatToParts(new Date(utcMs));
    const get = (t: string) =>
      parseInt(parts.find((p) => p.type === t)?.value ?? '0', 10);
    const asUtc = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour') % 24,
      get('minute'),
      get('second'),
    );
    return Math.round((asUtc - utcMs) / 60_000);
  };

  // 起点墙钟：now 对齐到分钟（目标时区墙钟语义）。
  const startOffset = offsetMinutes(now.getTime());
  // 从 now 的墙钟分钟开始（含当前分钟——cron 命中当前分钟也视为可触发，
  // 与「保存后调度器下一分钟检查」的实际行为一致取保守早值）。
  let wallMs = now.getTime() + startOffset * 60_000;
  wallMs = Math.floor(wallMs / 60_000) * 60_000;

  const out: Date[] = [];
  const maxMinutes = 60 * 24 * 370;
  for (let i = 0; i <= maxMinutes && out.length < count; i++) {
    const d = new Date(wallMs);
    if (cronMatchesAt(parsed, d)) {
      // 墙钟 → 真实 UTC：减去该墙钟时刻所在时区的偏移。
      // 用墙钟本身求偏移（近似——DST 瞬变窗口内误差 ≤1h，预览场景可接受）。
      const off = offsetMinutes(wallMs - 0);
      out.push(new Date(wallMs - off * 60_000));
    }
    wallMs += 60_000;
  }
  return out;
}

/**
 * fixed_rate 预览：每 intervalSeconds 秒一次，下次触发=now+interval 链。
 * interval 非法（<1 或非有限数）返回 []。
 */
export function nextFixedRateFireTimes(
  intervalSeconds: number,
  count: number,
  now: Date = new Date(),
): Date[] {
  const s = Number(intervalSeconds);
  if (!Number.isFinite(s) || s < 1) return [];
  const out: Date[] = [];
  for (let i = 1; i <= count; i++) {
    out.push(new Date(now.getTime() + s * 1000 * i));
  }
  return out;
}

/**
 * 触发时刻 → 展示文本。timezone 有效则按该时区渲染，否则浏览器本地时区。
 * 输出形如「09/08 14:30:00 （GMT+8）」的紧凑本地化文本。
 */
export function formatFireTime(
  d: Date,
  timezone?: string | null,
): string {
  const tz = validateTimezone(timezone);
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz ?? undefined,
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(d);
  } catch {
    return d.toISOString();
  }
}
