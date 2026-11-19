/**
 * UI-06: 触发预览纯函数层——cron / fixed_rate 的「未来 5 次触发时刻」计算。
 *
 * 独立成文件（对齐 executor-mode.ts / task-template-prefill.ts 先例）是为了
 * 可测试性与 react-refresh（组件文件只导出组件）。
 *
 * 零新依赖决策（认领记录已论证）：admin-web 无 node-cron/cronstrue，为预览
 * 引包不值得——本文件手写轻量解析，支持后端契约的 5 字段纯数字子集
 * （星号/数字/范围/步进/逗号，含 POSIX 裸 n/step——后端写边界会等价规范化，
 * 见 parseField），超出子集或语义非法（2 月 30 日等）一律返回 null → UI
 * 渲染占位文案，绝不猜错时刻误导用户。后端运行时合法性由 node-cron.validate
 * 把关（scheduler 注册路径），前端预览是纯展示增强，非法表达式不影响提交校验链。
 *
 * 时区感知：与 scheduler.getCronOptions 同一语义——timezone 字符串经
 * Intl.DateTimeFormat 校验，非法回退服务端默认（此处=浏览器本地时区）。
 * 展示文本用 Intl.DateTimeFormat（IANA tz）渲染所选时区的时刻。
 */

// F-26（DEEP_REVIEW 0ef3bbe）：locale 单一来源，不再硬编码 zh-CN
import { currentLocale } from './locale';

/**
 * 5 字段 cron 结构正则（分 时 日 月 周）：星号、数字、范围、步进及逗号组合。
 * 结构正则只是粗筛，逐字段语义在 parseField（含裸 n/step 的 POSIX 接受）。
 * 后端 DTO 门 = 规范化后 nodeCron.validate（见 cron-expression.constraint），
 * 裸 n/step 由后端写边界等价改写——预览器接受的 ⊆ 规范化后调度器可注册的。
 */
const CRON_5FIELD_RE =
  /^(\*|[0-5]?\d)(?:\/\d+)?(?:[,-](\*|[0-5]?\d)(?:\/\d+)?)* (\*|[01]?\d|2[0-3])(?:\/\d+)?(?:[,-](\*|[01]?\d|2[0-3])(?:\/\d+)?)* (\*|[012]?\d|3[01])(?:\/\d+)?(?:[,-](\*|[012]?\d|3[01])(?:\/\d+)?)* (\*|1[0-2]|0?[1-9])(?:\/\d+)?(?:[,-](\*|1[0-2]|0?[1-9])(?:\/\d+)?)* (\*|[0-7])(?:\/\d+)?(?:[,-](\*|[0-7])(?:\/\d+)?)*$/;

const FIELD_PART_RE = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/;

/** 解析后的单字段数值集合 */
type FieldSet = Set<number>;

/**
 * 把单字段展开为数值集合（星号/n/a-b/n/step/步进/逗号，POSIX n/step=n..max
 * 语义）。越界/空集返回 null。与 admin-api parseField 语义一致。
 *
 * 裸 `n/step`（如 `12/20`）按 POSIX 语义**接受**（展开 ≡ `n-max/step`）：
 * 后端已在写边界做同一等价规范化（admin-api cron-normalize.util，落库规范
 * 式），「能预览」与「能保存」由此重新对齐；保存后回显规范式，改写建议由
 * `suggestCronStepRewrite` 提供。
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

/** 各字段上限（分 时 日 月 周），供裸 n/step 改写为显式范围用 */
const FIELD_MAXES = [59, 23, 31, 12, 7] as const;

/**
 * 裸 `n/step` 写法（如 `12/20`）的等价规范化：把每个裸 n/step 部分改写为
 * node-cron 接受的 `n-max/step`（POSIX n/step ≡ n..max/step，与展开语义
 * 严格一致，且与 admin-api cron-normalize.util 同一份规则）。其余部分
 * 原样保留。
 *
 * 返回 null 的情形：表达式结构本身不可解析（CRON_5FIELD_RE 不通过）、
 * 或不含裸 n/step（无需改写）。步进为 0 时不改写（留给解析/后端报错，
 * 不产出一个同样非法的「规范式」）。
 *
 * 消费方：TaskFormPage 提交时对 cronExpression 与维护窗口 start/end 做
 * 提交前规范化并提示（后端会做同一规范化，此处前置只为让用户立刻看到
 * 实际存储形态）。
 */
export function suggestCronStepRewrite(expr: string): string | null {
  const trimmed = (expr ?? '').trim().replace(/\s+/g, ' ');
  if (!trimmed || !CRON_5FIELD_RE.test(trimmed)) return null;
  const fields = trimmed.split(' ');
  let changed = false;
  const rewritten = fields.map((field, i) =>
    field
      .split(',')
      .map((part) => {
        const m = /^(\d+)\/(\d+)$/.exec(part);
        if (!m || parseInt(m[2], 10) < 1) return part;
        changed = true;
        return `${m[1]}-${FIELD_MAXES[i]}/${m[2]}`;
      })
      .join(','),
  );
  return changed ? rewritten.join(' ') : null;
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
 * F-5（本轮审计）：timezone 警示的**两态**判别——空串与非法 IANA 不再同态。
 *
 *  - 'unspecified'：未填/空白。用户没表达意图，调度回落服务端进程时区，
 *    文案安抚「按服务端时区执行，预览可能不准」即可；
 *  - 'invalid'：填了但不是合法 IANA（手滑/格式错）。用户**有**意图但解析
 *    失败，应给出可操作的修正指引（「请填写有效 IANA 时区」），而非笼统的
 *    "未指定"。
 *
 * previewNeedsTimezoneWarning 保持既有布尔语义（二者都需降级警示——列表/
 * 详情 tooltip 消费面不动）；TriggerPreview（表单内可就地修正的场景）按
 * kind 选词。
 */
export type TimezoneWarningKind = 'none' | 'unspecified' | 'invalid';

export function timezoneWarningKind(timezone?: string | null): TimezoneWarningKind {
  const trimmed = timezone?.trim();
  if (!trimmed) return 'unspecified';
  return validateTimezone(trimmed) !== null ? 'none' : 'invalid';
}

/**
 * P1-3（UX-AUDIT-2026-09-21）：cron 预览在「时区未指定/非法」时是否必须降级为警示态。
 *
 * 证据链：本文件 `nextCronFireTimes` 在 tz 为空时用**浏览器本地时区**推算
 * （`offsetMinutes` 的 `if (!tz) return -getTimezoneOffset()`）；而后端
 * `scheduler.service` 在 tz 为空时用**服务端进程时区**。两者在跨时区部署下
 * 可能相差数小时——典型场景：UTC 笔记本给 Asia/Shanghai 服务器配 `0 8 * * *`，
 * 预览自信地显示「08:00」，实际触发差 8 小时，且**正好错在"用户以为对上了"的
 * 方向**（最危险的一类错误）。
 *
 * 旧实现的错：组件把浏览器本地时区标成 `服务器默认时区（浏览器本地）` 并照常
 * 渲染 5 个时刻——用户无从察觉这不是调度器真正使用的时区。
 *
 * 故：本函数为 true 时，组件**不得**自信渲染时刻，而改显「由服务端时区决定，
 * 可能不准」的警示 Alert。空串与非法 IANA 都算"未解析"（二者都拿不到确定时区；
 * 两态的文案区分见 timezoneWarningKind）。
 */
export function previewNeedsTimezoneWarning(timezone?: string | null): boolean {
  return timezoneWarningKind(timezone) !== 'none';
}

/**
 * fixed_rate 预览：每 intervalSeconds 秒一次。
 *
 * FIX-FIXEDRATE-PREVIEW：真实调度按 **lastTriggerTime + k·interval** 的等差链
 * 触发（锚点是上一次触发时刻），而不是「打开页面的此刻」。旧实现以 now 为锚
 * （now + i·interval），每次打开预览都显示一串"整齐的"未来时刻，但与任务真实
 * 相位无关——用户对着预览等触发，时刻永远对不上。因此：
 *  - 传入 lastTriggerTime（任务详情/列表场景可得）时，按锚点链推算，跳过
 *    已经过去的节拍（取严格晚于 now 的前 count 个）；
 *  - 未传（新建表单预览——任务尚无历史触发）才退回 now 锚链，并在 UI 注明
 *    「以下为按当前时刻的估算」。
 * interval 非法（<1 或非有限数）返回 []；lastTriggerTime 非法/缺省按未传处理。
 */
export function nextFixedRateFireTimes(
  intervalSeconds: number,
  count: number,
  now: Date = new Date(),
  lastTriggerTime?: Date | string | number | null,
): Date[] {
  const s = Number(intervalSeconds);
  if (!Number.isFinite(s) || s < 1) return [];
  const nowMs = now.getTime();
  const intervalMs = s * 1000;

  const anchor = lastTriggerTime != null ? new Date(lastTriggerTime).getTime() : NaN;
  if (Number.isFinite(anchor)) {
    // 锚点链：第 k 拍 = anchor + k·interval。取严格晚于 now 的前 count 拍；
    // k 从 1 起（anchor 本身是"上次已触发"，不是下次）。
    let k = Math.floor((nowMs - anchor) / intervalMs) + 1;
    if (k < 1) k = 1;
    const out: Date[] = [];
    for (let i = 0; i < count; i++) {
      out.push(new Date(anchor + intervalMs * (k + i)));
    }
    return out;
  }

  // 未传锚点（新建表单预览）：退回 now 锚链（旧行为，UI 需注明是估算）。
  const out: Date[] = [];
  for (let i = 1; i <= count; i++) {
    out.push(new Date(nowMs + intervalMs * i));
  }
  return out;
}

/**
 * P1-1（UX-AUDIT-2026-09-21）：任务列表「下次执行」列的真实时刻。
 *
 * 该列此前只渲染一个静态徽章（「Cron 计划中」/「定时运行中」），而列题是
 * 「下次执行」、tooltip 更写着「下次 Cron 触发时间」——**承诺了时刻却从不给出
 * 时刻**。于是用户无法回答"这任务下次什么时候跑、它到底还在不在跑"。
 *
 * 本函数复用详情页已在用的计算链（nextCronFireTimes / nextFixedRateFireTimes），
 * 只取最近一次；无法计算（表达式非法、已暂停、手动触发）一律返回 null，由调用
 * 方决定展示什么——**绝不猜一个假时刻**（猜错比不显示更误导）。
 *
 * @returns 下一次触发时刻；无法确定时 null
 */
export function nextRunAt(
  task: {
    status?: string | null;
    triggerType?: string | null;
    cronExpression?: string | null;
    fixedRate?: number | null;
    timezone?: string | null;
    lastTriggerTime?: string | Date | null;
  },
  now: Date = new Date(),
): Date | null {
  // 只有 active 的任务才真的在调度（暂停/失败的任务不会自己跑起来）
  if (task.status !== 'active') return null;

  if (task.triggerType === 'cron' && task.cronExpression) {
    const [next] = nextCronFireTimes(task.cronExpression, 1, now, task.timezone);
    return next ?? null;
  }
  if (task.triggerType === 'fixed_rate' && task.fixedRate) {
    // FIX-FIXEDRATE-PREVIEW：真实相位锚在 lastTriggerTime（上一次触发时刻），
    // 而非「此刻」——否则列表里的下次执行时刻永远对不上实际触发。
    const [next] = nextFixedRateFireTimes(task.fixedRate, 1, now, task.lastTriggerTime);
    return next ?? null;
  }
  // manual / 依赖触发：没有可预测的下次时刻——返回 null 而不是编一个
  return null;
}

/* ════════════════════════════════════════════════════════════════════════════
 * R282 / FEAT-06 读面：维护窗口命中判定（**与 admin-api 同语义的复刻**）
 * ════════════════════════════════════════════════════════════════════════════
 *
 * 缺陷现场：调度器在维护窗口命中时 `return null`——**不建执行行、不推进
 * lastTriggerTime、不补跑**（scheduler.service.ts:2804-2816）。而 `nextRunAt`
 * 只问「下一拍 cron 何时到」，入参里根本没有 maintenanceWindows ⇒ 列表列与
 * 详情 Tag 一直在渲染**一次不会发生的执行**。
 *
 * 这里的判据**不是**「把 start/end 解析成时:分再比大小」——那只对「同日窗口且
 * start<end」成立，跨午夜、周级、月级窗口全错。后端是「**最近触达比较**」：
 *
 *     startFire = lastWindowCronFireBefore(start, at, 回看, tz)
 *     if (!startFire) continue                        ← start 回看内无触达 ⇒ 窗口关闭
 *     endFire   = lastWindowCronFireBefore(end, at, 回看, tz)
 *     if (endFire && endFire >= startFire) continue   ← 已关窗（半开 [start,end)，平局归关窗）
 *     return w                                        ← 开窗
 *
 * 三处最容易写反、且都在本文件被显式钉住的地方：
 *   ① **`endFire === null` 是开窗**，不是关窗（后端 `:395` 的 `endFire &&` 短路）；
 *   ② **恰在 end 触达的那一分钟已关窗**（半开区间，`>=` 而非 `>`）；
 *   ③ 比较的是 **instant**，不是壁钟时:分——跨午夜窗口靠它自然成立。
 *
 * ## 时区（D3）
 *
 * 后端按 `task.timezone` 评估（scheduler.service.ts:2807），**未填/非法时降级
 * 服务端本地时区**；浏览器本地时区不一定是同一个。此时前端算出的结论可能与
 * 后端相反，而「跳过」是**负面断言**（会让用户以为任务不会跑）⇒ 不猜，走
 * `unknown-window` 分支显式说明「无法判定」（沿用 R278 纪律：未知 ≠ 是/否）。
 * 判据复用 `previewNeedsTimezoneWarning`（timezoneWarningKind 的两态在这里不需要
 * 区分：两种都需要降级）。
 *
 * ## 性能（D2，红线）
 *
 * 照抄后端的「逐 instant 回扫 7×24×60 分钟 × formatToParts」在列表页会卡死：
 * 实测 20 个带窗口任务 = 127ms（日级窗口）/ 962ms（周级窗口最坏）。而回扫的
 * 目的只有一个——找「最近一次触达」。
 *
 * `lastWindowFireBefore` 因此改成**按壁钟日回扫**：每次 `formatToParts` 得到
 * 「该 instant 在目标时区的日期 + 时:分」，于是同一天内的所有壁钟分钟不必再逐
 * 分钟 format，直接按 cron 的 (时,分) 命中集构造候选、由近及远取第一个
 * **instant ≤ 起点** 的（DST 重复壁钟分钟由此取后触达，与后端「最近」一致）。
 * 一天的 formatToParts 从 1440 次降到 1 次（本地路径 0 次）。
 *
 * 回看上限按**窗口 cron 自身的最小周期**收紧，但**永不超过后端 7 天**（超过即
 * 可能算出后端算不出的触达 ⇒ 结论漂移）：
 *   · dom/month/dow 全为 `*`（日级/日内窗口、最常见形态）⇒ 3 天。3 天足以覆盖
 *     跨午夜窗口（≤1 天）与 DST 单次跳变（±1 天）的所有「最近触达」场景；
 *   · 其余（周级/月级/受限于具体日期）⇒ 后端同值 7 天，逐日回扫仅 7~8 次 format。
 * 改后实测：20 个带窗口任务全量 = **个位数毫秒**（spec 里钉 < 50ms）。
 */

/** 单条维护窗口（与 api/tasks.ts 的 MaintenanceWindow / 后端 DTO 同形） */
export interface NextRunMaintenanceWindow {
  start: string;
  end: string;
  description?: string | null;
}

/**
 * 「下次执行」的判别式结果（D4/D5）。
 *
 * `nextRunAt` 的 `null` 已被三种语义占用（非 active / 表达式非法 / manual），
 * **不能再让 null 承担「窗口内」**——那正是当前缺陷的同类错误：用一个值表达多
 * 种含义。故新增本类型，`nextRunAt` 签名与语义一字不动。
 */
export type NextRunOutcome =
  /** 正常：未来某刻会跑（渲染既有文案，**零视觉变化**） */
  | { kind: 'at'; at: Date }
  /** 会到点，但那一刻落在维护窗口内 ⇒ 调度器会跳过（不建执行记录） */
  | { kind: 'skipped-by-window'; at: Date; window: NextRunMaintenanceWindow }
  /** 任务没配时区/时区非法 ⇒ 前后端时区可能不同，无法判定，**不猜** */
  | { kind: 'unknown-window'; at: Date }
  /** 暂停 / 手动 / 表达式非法（既有 null 语义，占位文案不变） */
  | { kind: 'none' };

/** 扫描预算与常量（推导见文件头「性能」段；二者都**永不超过后端 7 天**） */
const DAY_LOOKBACK_DAILY = 3;
const DAY_LOOKBACK_BACKEND = 7;
const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;

/** 壁钟字段（cron 匹配的最小信息面，与后端 WallClockParts 同形）。 */
interface WallStamp {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
}

/** as-UTC 毫秒 → 壁钟字段（「as-UTC」= 该毫秒数按 UTC 读出的年月日时分）。 */
function wallFields(asUtcMs: number): WallStamp {
  const d = new Date(asUtcMs);
  return {
    y: d.getUTCFullYear(),
    mo: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    mi: d.getUTCMinutes(),
  };
}

/**
 * 该 cron 的触达是否会落在「每天同一批时刻」（月/日/周全 `*`）——只有这种形态
 * 才允许把回扫收紧到 3 天：它**必然每天触达**，最近一次触达不可能超过 1 天前。
 */
function firesEveryDay(parsed: ParsedCron): boolean {
  return parsed.domAll && parsed.dowAll && parsed.month.size === 12;
}

/** 回扫天数：日级 3 天（跨午夜 ≤1 天 + DST 单跳 ±1 天），其余沿用后端 7 天。 */
function windowLookbackDays(parsed: ParsedCron): number {
  return firesEveryDay(parsed) ? DAY_LOOKBACK_DAILY : DAY_LOOKBACK_BACKEND;
}

/* ── 时区壁钟工具（复用 validateTimezone，不再写第四份 cron 解析器） ───────── */

/** 时区格式化器缓存：构造 Intl.DateTimeFormat 远比格式化贵，列表页会复用。 */
const ZONE_FMT_CACHE = new Map<string, Intl.DateTimeFormat>();
const ZONE_FMT_CACHE_MAX = 32;

function zoneFormatter(tz: string): Intl.DateTimeFormat {
  const hit = ZONE_FMT_CACHE.get(tz);
  if (hit) return hit;
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  if (ZONE_FMT_CACHE.size >= ZONE_FMT_CACHE_MAX) ZONE_FMT_CACHE.clear();
  ZONE_FMT_CACHE.set(tz, fmt);
  return fmt;
}

/** instant → 目标时区壁钟。`tz` 已由 validateTimezone 校验过（null 不走这里）。 */
function zoneWallClock(d: Date, tz: string): WallStamp & { asUtcMs: number } {
  const parts = zoneFormatter(tz).formatToParts(d);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '0';
  const y = Number(get('year'));
  const mo = Number(get('month'));
  const dOfMonth = Number(get('day'));
  // hourCycle h23 在部分 ICU 版本把午夜给成 "24"——取模归零
  const h = Number(get('hour')) % 24;
  const mi = Number(get('minute'));
  const s = Number(get('second'));
  return { y, mo, d: dOfMonth, h, mi, asUtcMs: Date.UTC(y, mo - 1, dOfMonth, h, mi, s) };
}

/** 本地路径（tz 未填/非法）：浏览器本地时区 = 后端「降级服务端本地」的同位语。 */
function localWallClock(d: Date): WallStamp & { asUtcMs: number } {
  const y = d.getFullYear();
  const mo = d.getMonth() + 1;
  const dOfMonth = d.getDate();
  const h = d.getHours();
  const mi = d.getMinutes();
  return { y, mo, d: dOfMonth, h, mi, asUtcMs: Date.UTC(y, mo - 1, dOfMonth, h, mi, d.getSeconds()) };
}

/** 该 instant 在目标时区相对 UTC 的偏移（毫秒）。 */
function zoneOffsetAt(ms: number, tz: string): number {
  return zoneWallClock(new Date(ms), tz).asUtcMs - ms;
}

/**
 * 扫描窗口内的**偏移样本**：DST 一年两次跳变，采样覆盖窗口两端即可拿到全部
 * 可能偏移（不必逐分钟问）。一次调用最多 `2×(days+2)` 次 formatToParts。
 */
function collectZoneOffsets(startMs: number, days: number, tz: string): number[] {
  const set = new Set<number>();
  for (let i = 0; i <= days + 1; i++) {
    const base = startMs - i * MS_PER_DAY;
    set.add(zoneOffsetAt(base, tz));
    set.add(zoneOffsetAt(base + MS_PER_DAY / 2, tz));
  }
  return [...set];
}

/**
 * 壁钟候选 → 真实 instant（可能两个：秋季回拨时同一壁钟分钟出现两次）。
 *
 * 回读校验是**语义必需**而非保险：DST 春季跳变时被跳过的壁钟分钟没有对应
 * instant（Date 构造器会顺移），后端逐 instant 回扫天然不命中——这里若不复核
 * 就会凭空造出一次"触达"，把已关窗误判成开窗。
 * 返回按 instant **由晚到早**排序（后端「最近触达」取的正是最晚那个）。
 */
function instantsForWall(
  asUtcMs: number,
  tz: string | null,
  offsets: number[],
): number[] {
  const f = wallFields(asUtcMs);
  const out: number[] = [];
  const accept = (t: number): void => {
    if (!Number.isFinite(t) || out.includes(t)) return;
    const w = tz ? zoneWallClock(new Date(t), tz) : localWallClock(new Date(t));
    if (w.y === f.y && w.mo === f.mo && w.d === f.d && w.h === f.h && w.mi === f.mi) {
      out.push(t);
    }
  };
  if (tz) {
    for (const off of offsets) accept(asUtcMs - off);
  } else {
    // 本地路径：先按本地日期构造，再补 ±1h 覆盖秋季回拨的两次出现。
    const base = new Date(f.y, f.mo - 1, f.d, f.h, f.mi).getTime();
    accept(base);
    accept(base + MS_PER_HOUR);
    accept(base - MS_PER_HOUR);
  }
  return out.sort((a, b) => b - a);
}

/** 该壁钟日是否满足 cron 的月/日/周条件（周几按壁钟日算，故按日缓存一次）。 */
function dayMatches(parsed: ParsedCron, f: WallStamp): boolean {
  if (!parsed.month.has(f.mo)) return false;
  const dow = new Date(Date.UTC(f.y, f.mo - 1, f.d)).getUTCDay();
  const domHit = parsed.dayOfMonth.has(f.d);
  const dowHit = parsed.dayOfWeek.has(dow);
  if (parsed.domAll && parsed.dowAll) return true;
  if (parsed.domAll) return dowHit;
  if (parsed.dowAll) return domHit;
  return domHit || dowHit;
}

/** 升序数值数组（Set → number[]），供「由晚到早」双重遍历。 */
const asc = (s: Set<number>): number[] => [...s].sort((a, b) => a - b);

/**
 * 等价于后端 `lastWindowCronFireBefore`：`expr` 在 `(before - 7天, before]` 内的
 * 最近一次触达（分钟粒度、秒截断）。表达式非法 / 超出回看 ⇒ null。
 *
 * 与后端的**唯一**差异是扫描粒度（按壁钟日而非逐分钟 instant），结论在同一
 * 时区下逐条相同——对拍见 `__tests__/maintenance-window-parity.test.ts`。
 * 7 天硬下限（`floorMs`）必须保留：日粒度会让回扫面比后端宽一天，若不夹这个
 * 边界，前端就可能找到后端找不到的触达 ⇒ 已关窗被判成开窗。
 */
export function lastWindowCronFireBefore(
  expr: string,
  before: Date,
  timezone?: string | null,
): Date | null {
  const parsed = parseCronExpression(expr);
  if (!parsed) return null;
  const tz = validateTimezone(timezone);
  // 起点截断到「真实 instant 的整分钟」——与后端分区路径 :334 同一口径
  const startMs = Math.floor(before.getTime() / 60_000) * 60_000;
  const startWall = tz ? zoneWallClock(new Date(startMs), tz) : localWallClock(new Date(startMs));
  const days = windowLookbackDays(parsed);
  const offsets = tz ? collectZoneOffsets(startMs, days, tz) : [];
  const floorMs = startMs - DAY_LOOKBACK_BACKEND * MS_PER_DAY;
  const hours = asc(parsed.hour);
  const minutes = asc(parsed.minute);
  // 起点所在壁钟日 00:00（as-UTC 表示与真实日历日同余，取模即日界）
  const dayStart = startWall.asUtcMs - (startWall.asUtcMs % MS_PER_DAY);

  for (let i = 0; i <= days; i++) {
    const dayMs = dayStart - i * MS_PER_DAY;
    if (dayMs + MS_PER_DAY <= floorMs) break;
    if (!dayMatches(parsed, wallFields(dayMs))) continue;
    for (let hi = hours.length - 1; hi >= 0; hi--) {
      for (let mi = minutes.length - 1; mi >= 0; mi--) {
        const wallMs = dayMs + hours[hi] * MS_PER_HOUR + minutes[mi] * 60_000;
        for (const instantMs of instantsForWall(wallMs, tz, offsets)) {
          if (instantMs > startMs) continue;
          if (instantMs <= floorMs) return null;
          return new Date(instantMs);
        }
      }
    }
  }
  return null;
}

/**
 * 复刻 `findActiveMaintenanceWindow`：并集语义，短路返回第一条开窗的。
 * `at` 为**判定时刻**（既是「未来下次执行」也是「现在」——后端 enqueue 传的是
 * 触发瞬间，前端传的是算出的下次时刻，语义完全一致）。
 */
export function findActiveMaintenanceWindowPreview(
  windows: NextRunMaintenanceWindow[] | null | undefined,
  at: Date,
  timezone?: string | null,
): NextRunMaintenanceWindow | null {
  if (!Array.isArray(windows)) return null;
  for (const w of windows) {
    if (!w || typeof w.start !== 'string' || typeof w.end !== 'string') continue;
    const startFire = lastWindowCronFireBefore(w.start, at, timezone);
    if (!startFire) continue;
    const endFire = lastWindowCronFireBefore(w.end, at, timezone);
    // 半开 [start, end)：end 触达 ≥ start 触达即已关窗（含同刻平局）。
    // ⚠️ endFire === null 是**开窗**（后端 :395 的 `endFire &&` 短路）。
    if (endFire && endFire.getTime() >= startFire.getTime()) continue;
    return w;
  }
  return null;
}

/**
 * R282：列表/详情「下次执行」的**判别式**计算——`nextRunAt` + 维护窗口判定。
 *
 * 分支优先级（顺序本身是语义，改动即回归）：
 *   ① `nextRunAt` 返回 null ⇒ `none`（暂停/手动/非法表达式，既有占位不变）
 *   ② 未配置窗口（null / [] / 全为非法条目）⇒ `at`（**零行为变化**，与
 *      `nextRunAt` 逐毫秒相同——spec 用 toEqual 钉住）
 *   ③ 时区未填/非法 ⇒ `unknown-window`（前后端时区可能不同，不猜）
 *   ④ 命中窗口 ⇒ `skipped-by-window`（带窗口本体，供 UI 说出**原因**）
 *   ⑤ 否则 ⇒ `at`
 *
 * 注意 ③ 与 ④ 的先后：时区不明时**即便**按浏览器时区算出来是「在窗口内」也不
 * 报 skipped——那个结论可能正好反了，而负面断言的代价是用户不去排查。
 */
export function nextRunOutcome(
  task: {
    status?: string | null;
    triggerType?: string | null;
    cronExpression?: string | null;
    fixedRate?: number | null;
    timezone?: string | null;
    lastTriggerTime?: string | Date | null;
    maintenanceWindows?: NextRunMaintenanceWindow[] | null;
  },
  now: Date = new Date(),
): NextRunOutcome {
  const at = nextRunAt(task, now);
  if (!at) return { kind: 'none' };
  const windows = task.maintenanceWindows;
  if (!Array.isArray(windows) || windows.length === 0) return { kind: 'at', at };
  if (previewNeedsTimezoneWarning(task.timezone)) return { kind: 'unknown-window', at };
  const hit = findActiveMaintenanceWindowPreview(windows, at, task.timezone);
  return hit ? { kind: 'skipped-by-window', at, window: hit } : { kind: 'at', at };
}

/**
 * 维护窗口边界 → 紧凑展示文本（R282 的文案槽位，不是判据）。
 *
 * brief §四 要求文案形如「跳过（维护窗口 02:30–04:00）」——用户看到的是**时刻**，
 * 不是 cron。但窗口 cron 可以带步进/范围/列表，那类形态无法压成一个时刻。
 * 故：分与时都是**单点**时给 `HH:MM`；其余原样回 cron 表达式，**绝不猜**一个
 * "代表性时刻"（与 describeMaintenanceWindow 同策：宁缺勿错）。
 */
export function formatWindowEdge(expr: string): string {
  const parsed = parseCronExpression(expr);
  if (!parsed || parsed.minute.size !== 1 || parsed.hour.size !== 1) return expr;
  const h = [...parsed.hour][0];
  const m = [...parsed.minute][0];
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
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
    return new Intl.DateTimeFormat(currentLocale(), {
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
