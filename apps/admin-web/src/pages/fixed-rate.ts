/**
 * F-28（DEEP_REVIEW 0ef3bbe）：fixed_rate 触发器输入框的「分钟」显示/回读纯逻辑。
 *
 * 表单值 fixedRate 的单位是**秒**，UI 以「分钟」呈现（min=60/step=60）。
 * 原 parser 用 `t('taskForm.field.fixedRate.minuteUnit')` 的**翻译文本**做
 * String.replace 反解数字——文案一变（英文 "minutes"）或语序变化即解析成 NaN，
 * 属"解析依赖 i18n 文案"的坏味道。现改为与语言无关的数字抽取：只保留数字与
 * 小数点，其余字符（空格、单位、千分位分隔符）一律丢弃。
 */

/**
 * F-2（本轮审计）：后端 `CreateTaskDto.TASK_FIXED_RATE_MAX_SECONDS = 2_147_483`
 * 的**前端镜像**（admin-api create-task.dto.ts 同名常量：fixedRate 是 int4 秒
 * 列，且周期 ×1000 喂给 Node 定时器 / Redis PEXPIRE 受 int32 毫秒上限约束，
 * 2147483s×1000 恰在 2^31-1 之内）。前端不再让「填 99999 分钟」直达后端吃
 * 英文裸 400——超限在输入侧钳制（InputNumber max）并即时校验提示。
 */
export const TASK_FIXED_RATE_MAX_SECONDS = 2_147_483;

/**
 * 分钟口径上限：表单以「分钟」呈现而表单值单位是秒，2147483s ÷ 60 =
 * 35791.38 min，向下取整得 35791 分钟（35791×60 = 2_147_460s ≤ 后端上限，
 * 收紧 23s 换取整分钟边界）。InputNumber 的 max 钳制与超限提示共用该口径；
 * 校验阈值仍用 TASK_FIXED_RATE_MAX_SECONDS（存量行回填值不因钳制口径误报）。
 */
export const TASK_FIXED_RATE_MAX_MINUTES = Math.floor(TASK_FIXED_RATE_MAX_SECONDS / 60);

/**
 * 秒 → 展示用分钟数。
 *
 * F-6（本轮审计）：原实现无条件向下取整——输入 5.5 分钟（330s）显示
 * 「5 分钟」，用户以为小数被吞了。现改为：整分钟保持整数（300s → 5），
 * 有余秒向下取到**一位小数**（330s → 5.5、359s → 5.9）。floor 语义保留：
 * 展示值永不夸大实际间隔。
 */
export function fixedRateToMinutesLabel(seconds: number): number {
  const n = Number(seconds) / 60;
  if (Number.isInteger(n)) return n;
  return Math.floor(n * 10) / 10;
}

/**
 * 输入框文本 → 秒（<1 分钟/非法/空一律回落到最小档 60s）。
 * 抽取所有数字与小数点后按分钟解析，不依赖任何翻译文本。
 *
 * FIX（上轮审计）：秒不是 60 整数倍时（90s/45s/100s），仅按展示文本回读会把
 * 90s 悄悄改成 60s——用户只是聚焦后失焦（未改一个字符）。修正：回读结果与
 * 当前表单值落在**同一展示分钟档**（`fixedRateToMinutesLabel` 同值）时原样
 * 保留精确秒值——判定依据是"用户没有真正改动"，跨档（用户确实改了）才采纳
 * 解析结果。F-6 把展示固化到一位小数后，同档判定必须跟着走展示口径：
 * 100s 显示「1.6 分钟」，回读解析出 1.6×60=96s≠100s，只有按展示分钟数比对
 * 才能拦住失焦回读的静默改写。
 *
 * FIX（本轮 F-7）：原实现 `[^\d.]` 把负号静默剥掉，「-5 分钟」变成 +300s。
 * 现识别负号并**保留符号**返回负值，由表单校验层（fixedRate.negative 词条）
 * 拦截提示——不静默取正。
 *
 * 入参 `currentSeconds` 缺省时行为与修正前一致（纯文本 → 秒）。
 */
export function parseFixedRateSeconds(
  value: unknown,
  currentSeconds?: number | null,
): number {
  const raw = String(value ?? '').trim();
  // F-7：识别负号（仅前导 '-' 视为负值意图）——不再静默吞符号。
  const negative = raw.startsWith('-');
  const minutes = Number(raw.replace(/[^\d.]/g, ''));
  if (!Number.isFinite(minutes) || minutes <= 0) return negative ? -60 : 60;
  // 后端 fixedRate 是 @IsInt（int4 秒列）：小数分钟四舍五入到最近秒。
  const parsed = Math.round(minutes * 60);
  if (negative) return -parsed;
  const current = Number(currentSeconds);
  if (
    Number.isFinite(current) &&
    current > 0 &&
    // 同一"展示分钟档"（一位小数口径）→ 用户没改，保留精确秒值。
    fixedRateToMinutesLabel(current) === fixedRateToMinutesLabel(parsed)
  ) {
    return current;
  }
  return parsed;
}
