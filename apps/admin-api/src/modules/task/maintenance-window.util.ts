/**
 * FEAT-06: 任务级维护窗口（maintenanceWindows）——纯匹配逻辑，零状态。
 *
 * 数据形态（tasks.maintenanceWindows jsonb，可空）：
 *   [{ start: "30 2 * * *", end: "0 4 * * *", description?: string }]
 * start/end 均为 5 字段 cron（分 时 日 月 周）。
 *
 * 窗口语义（有意保持简单，报告/文档同步说明）：
 * - "最近触达"判定：窗口开启 ⇔ start cron 的最近一次触达时刻（≤ now）
 *   晚于 end cron 的最近一次触达时刻。即 start 触达时刻开窗、end 触达
 *   时刻关窗，半开区间 [start, end)：恰在 end 触达分钟视为已关窗。
 * - 跨午夜窗口天然成立（start 23:30 / end 01:00 → 开到次日 01:00），但
 *   这是"最近触达比较"的自然推论而非专门支持；start/end 写反不会报错，
 *   会得到"从 start 开到次日 end"的长窗口——文档明确提示按同日窗口配置。
 * - start/end 触达周期受回看上限约束（LOOKBACK 7 天）：触发周期超过 7 天
 *   的 cron 找不到"最近触达"，窗口视为关闭。
 * - 时区：调用方把任务自身的 `task.timezone`（IANA 名）传入，窗口 cron 按
 *   该分区壁钟评估（与调度主 cron 的 timezone 语义一致）；未传/空/非法时
 *   保持既有行为——按服务端本地时间评估。实现只用 stdlib：instant→分区壁钟
 *   用 Intl.DateTimeFormat({timeZone}).formatToParts 提取（逐分钟对 instant
 *   回扫，天然 DST 正确——被夏令时跳过的壁钟分钟不存在对应 instant、不会
 *   误命中；重复的壁钟分钟对应两个 instant、取后触达者，即"最近触达"）。
 * - 非法/无法解析的 cron 字段：窗口条目保守跳过（视为未配置），绝不因
 *   窗口配置错误而整体停跳——DTO 边界已拦截非法值，这里只是防御。
 *
 * 校验复用：项目内无 cron-parser / cronstrue 依赖（grep 确认），cron 合法性
 * 校验复用 node-cron 的 validate——与 scheduler.service.ts 注册任务主 cron
 * 是同一实现，行为永不漂移；零新增依赖。
 */
import * as nodeCron from "node-cron";

/** 单条维护窗口：start/end 均为 5 字段 cron（分 时 日 月 周） */
export interface TaskMaintenanceWindow {
  /** 窗口开启 cron：最近一次触达（≤ now）晚于 end 最近触达时开窗 */
  start: string;
  /** 窗口关闭 cron：最近一次触达（≤ now）不早于 start 最近触达即关窗 */
  end: string;
  /** 可选说明（展示/日志用），如"周五发布冻结" */
  description?: string;
}

/** 实体/DTO 共享的窗口数组类型（jsonb 列，null = 未配置） */
export type TaskMaintenanceWindows = TaskMaintenanceWindow[];

/** 关窗判定用的回看上限（分钟）：7×24×60。覆盖周级 cron。 */
export const MAINTENANCE_WINDOW_LOOKBACK_MINUTES = 7 * 24 * 60;

/**
 * 5 字段 cron 结构正则（分 时 日 月 周）：星号、n、a-b、星号加步进、
 * a-b 加步进及逗号组合。与 CreateTaskDto.cronExpression 的 @Matches
 * 同一口径——窗口 cron 与调度主 cron 的"结构合法性"必须一致；运行时
 * 语义（如 2 月 30 日）由 node-cron.validate 在匹配侧兜底
 * （parseWindowCron 内部调用）。DTO（maintenance-window.dto.ts）与
 * util 共用本常量，两端永不漂移。
 */
export const CRON_5FIELD_RE =
  /^(\*|([0-5]?\d))(\/(\d+))? (\*|([01]?\d|2[0-3]))(\/(\d+))? (\*|([012]?\d|3[01]))(\/(\d+))? (\*|(1[0-2]|0?[1-9]))(\/(\d+))? (\*|[0-7])(\/(\d+))?$/;

/** 解析后的 5 字段 cron（数值集合，供分钟匹配） */
interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  /** 原始字段是否为纯 `*`（POSIX cron 的 dom/dow OR 规则据此判定） */
  domAll: boolean;
  dowAll: boolean;
}

const FIELD_PART_RE = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/;

/**
 * 把单字段展开为数值集合。支持星号、n、a-b、星号加步进、a-b 加步进、
 * n 加步进（n/step = n..max 步进 step，POSIX 语义）及逗号组合。
 * 越界/空集返回 null。
 */
function parseField(raw: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of raw.split(",")) {
    const m = FIELD_PART_RE.exec(part);
    if (!m) return null;
    const step = m[3] !== undefined ? parseInt(m[3], 10) : 1;
    if (!Number.isInteger(step) || step < 1) return null;
    let lo = min;
    let hi = max;
    if (m[1] !== "*") {
      lo = parseInt(m[1], 10);
      // 裸数字 n → 单点；n-s → 显式范围；n/step（无范围）→ POSIX n..max/step
      hi =
        m[2] !== undefined ? parseInt(m[2], 10) : m[3] !== undefined ? max : lo;
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) return null;
      if (lo < min || hi > max || lo > hi) return null;
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out.size > 0 ? out : null;
}

/**
 * 解析 5 字段 cron；同时调用 node-cron.validate 保证与调度器注册路径
 * 同一合法性口径（validate 拒绝的表达式在此同样拒绝）。缓存解析结果
 * （表达式集合小且重复触发高频复用；超容量整体清空，防失控）。
 */
const PARSE_CACHE = new Map<string, ParsedCron | null>();
const PARSE_CACHE_MAX = 256;

function parseWindowCron(expr: string): ParsedCron | null {
  if (PARSE_CACHE.has(expr)) {
    return PARSE_CACHE.get(expr) ?? null;
  }
  let parsed: ParsedCron | null = null;
  if (nodeCron.validate(expr)) {
    const fields = expr.trim().split(/\s+/);
    const minute = parseField(fields[0], 0, 59);
    const hour = parseField(fields[1], 0, 23);
    const dayOfMonth = parseField(fields[2], 1, 31);
    const month = parseField(fields[3], 1, 12);
    const dayOfWeek = parseField(fields[4], 0, 7);
    if (minute && hour && dayOfMonth && month && dayOfWeek) {
      // node-cron/POSIX：7 视同周日 0
      if (dayOfWeek.has(7)) dayOfWeek.add(0);
      parsed = {
        minute,
        hour,
        dayOfMonth,
        month,
        dayOfWeek,
        domAll: fields[2] === "*",
        dowAll: fields[4] === "*",
      };
    }
  }
  if (PARSE_CACHE.size >= PARSE_CACHE_MAX) PARSE_CACHE.clear();
  PARSE_CACHE.set(expr, parsed);
  return parsed;
}

/**
 * 单分钟匹配。日/周并存按 POSIX OR（两者均受限时命中其一即真；
 * 任一为纯 `*` 时只看受限的那个）。注意：这比"dom/dow 都受限则都不
 * 触发"的旧版 vixie 差异实现更贴近 node-cron 实际行为。
 *
 * 入参是"某时区的壁钟字段"而非 Date：本地路径从 Date 本地 getter 提取，
 * 分区路径从 Intl formatToParts 提取（见 zoneWallClockAt）——匹配逻辑只有
 * 这一份，两种路径永不漂移。
 */
function cronMatchesWallClock(
  parsed: ParsedCron,
  wall: WallClockParts,
): boolean {
  if (!parsed.minute.has(wall.minute)) return false;
  if (!parsed.hour.has(wall.hour)) return false;
  if (!parsed.month.has(wall.month)) return false;
  const domHit = parsed.dayOfMonth.has(wall.dayOfMonth);
  const dowHit = parsed.dayOfWeek.has(wall.dayOfWeek);
  if (parsed.domAll && parsed.dowAll) return true;
  if (parsed.domAll) return dowHit;
  if (parsed.dowAll) return domHit;
  return domHit || dowHit;
}

/** 本地路径：Date 本地 getter 即服务端时区壁钟（既有行为，逐字节不变）。 */
function localWallClockAt(d: Date): WallClockParts {
  return {
    minute: d.getMinutes(),
    hour: d.getHours(),
    dayOfMonth: d.getDate(),
    month: d.getMonth() + 1,
    dayOfWeek: d.getDay(),
  };
}

/** 某一瞬间在某时区的壁钟时间字段（cron 匹配的最小信息面）。 */
interface WallClockParts {
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number;
  dayOfWeek: number;
}

/** Intl weekday 缩写 → POSIX 周日=0（en-US 的 short 形态集合固定为这七个）。 */
const WEEKDAY_TO_NUMBER: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * 时区格式化器缓存（分区壁钟提取的热路径——逐分钟回扫每步一次
 * formatToParts，构造器本身昂贵必须复用）。null 缓存非法时区（探针与
 * isValidTimeZone 同一实现），避免逐分钟重复抛 RangeError。
 */
const ZONE_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat | null>();
const ZONE_FORMATTER_CACHE_MAX = 64;

function getZoneFormatter(timeZone: string): Intl.DateTimeFormat | null {
  if (ZONE_FORMATTER_CACHE.has(timeZone)) {
    return ZONE_FORMATTER_CACHE.get(timeZone) ?? null;
  }
  let fmt: Intl.DateTimeFormat | null = null;
  try {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    });
  } catch {
    fmt = null; // RangeError：非 IANA 时区 → 调用方降级服务端本地时区
  }
  if (ZONE_FORMATTER_CACHE.size >= ZONE_FORMATTER_CACHE_MAX) {
    ZONE_FORMATTER_CACHE.clear();
  }
  ZONE_FORMATTER_CACHE.set(timeZone, fmt);
  return fmt;
}

/** instant → 分区壁钟字段（stdlib 唯一事实源：formatToParts）。 */
function zoneWallClockAt(d: Date, fmt: Intl.DateTimeFormat): WallClockParts {
  const parts = fmt.formatToParts(d);
  const wall: WallClockParts = {
    minute: 0,
    hour: 0,
    dayOfMonth: 1,
    month: 1,
    dayOfWeek: 0,
  };
  for (const p of parts) {
    switch (p.type) {
      case "minute":
        wall.minute = Number(p.value);
        break;
      case "hour":
        wall.hour = Number(p.value);
        break;
      case "day":
        wall.dayOfMonth = Number(p.value);
        break;
      case "month":
        wall.month = Number(p.value);
        break;
      case "weekday":
        wall.dayOfWeek = WEEKDAY_TO_NUMBER[p.value] ?? 0;
        break;
    }
  }
  return wall;
}

/**
 * IANA 时区合法性探针：Intl.DateTimeFormat 对未知时区抛 RangeError。
 * 与调度侧 getCronOptions 的 try/catch 探针同一实现语义，DTO 写面校验
 * （timezone.constraint.ts）与窗口评估共用本函数，判定永不漂移。
 * 空串同样非法（调用方应先按"未设置"短路）。
 */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * expr 在 (before - lookbackMinutes, before] 内的最近一次触达时刻
 * （分钟粒度，秒截断）。找不到（含表达式非法）返回 null。
 * 逐分钟回扫：单次 ≤ lookback 步 × 5 个 Set 命中测试，常量级开销，
 * 仅在任务配置了维护窗口时才会走到。
 *
 * timeZone（任务自身 task.timezone，IANA 名）：传入时按该分区壁钟评估
 * （instant 逐分钟回扫 + formatToParts 提取，DST 语义见文件头注）；未传/
 * 空/非法（防御——DTO 写面已拦截非法值，存量脏数据走到这里）保持既有
 * 行为：按服务端本地时间评估。
 */
export function lastWindowCronFireBefore(
  expr: string,
  before: Date,
  lookbackMinutes: number = MAINTENANCE_WINDOW_LOOKBACK_MINUTES,
  timeZone?: string | null,
): Date | null {
  const parsed = parseWindowCron(expr);
  if (!parsed) return null;
  const zoneFmt = timeZone ? getZoneFormatter(timeZone) : null;
  const t =
    zoneFmt != null
      ? // 分区路径：instant 空间按分钟截断（真实时区偏移均为整分钟，
        // 与壁钟分钟边界重合）。每步回退一个真实 instant，再提取该时区
        // 壁钟做匹配——被 DST 跳过的壁钟分钟没有对应 instant，天然不命中。
        new Date(Math.floor(before.getTime() / 60_000) * 60_000)
      : // 本地路径：既有行为（壁钟分钟截断 + 逐分钟回扫），逐字节不变。
        new Date(
          before.getFullYear(),
          before.getMonth(),
          before.getDate(),
          before.getHours(),
          before.getMinutes(),
        );
  for (let i = 0; i <= lookbackMinutes; i++) {
    const hit = zoneFmt
      ? cronMatchesWallClock(parsed, zoneWallClockAt(t, zoneFmt))
      : cronMatchesWallClock(parsed, localWallClockAt(t));
    if (hit) return new Date(t.getTime());
    t.setTime(t.getTime() - 60_000);
  }
  return null;
}

/**
 * 调度触发前的窗口命中判定（scheduler.enqueue 唯一消费入口）。
 * 返回命中的窗口（用于日志定位），未命中/未配置/条目非法返回 null。
 * 多窗口为并集语义：任一条开启即命中（短路返回第一条）。
 * timeZone 透传给两次触达扫描（同分区壁钟下比较"最近触达"，instant 比较
 * 在同一时区语义下与壁钟先后一致）。
 */
export function findActiveMaintenanceWindow(
  windows: TaskMaintenanceWindows | null | undefined,
  now: Date = new Date(),
  timeZone?: string | null,
): TaskMaintenanceWindow | null {
  if (!Array.isArray(windows)) return null;
  for (const w of windows) {
    if (!w || typeof w.start !== "string" || typeof w.end !== "string") {
      continue;
    }
    const startFire = lastWindowCronFireBefore(
      w.start,
      now,
      MAINTENANCE_WINDOW_LOOKBACK_MINUTES,
      timeZone,
    );
    if (!startFire) continue;
    const endFire = lastWindowCronFireBefore(
      w.end,
      now,
      MAINTENANCE_WINDOW_LOOKBACK_MINUTES,
      timeZone,
    );
    // end 最近触达 ≥ start 最近触达 → 已关窗（半开区间；含同刻触达的平局）
    if (endFire && endFire.getTime() >= startFire.getTime()) continue;
    return w;
  }
  return null;
}
