/**
 * F-28（DEEP_REVIEW 0ef3bbe）：fixed_rate 触发器输入框的「分钟」显示/回读纯逻辑。
 *
 * 表单值 fixedRate 的单位是**秒**，UI 以「分钟」呈现（min=60/step=60）。
 * 原 parser 用 `t('taskForm.field.fixedRate.minuteUnit')` 的**翻译文本**做
 * String.replace 反解数字——文案一变（英文 "minutes"）或语序变化即解析成 NaN，
 * 属"解析依赖 i18n 文案"的坏味道。现改为与语言无关的数字抽取：只保留数字与
 * 小数点，其余字符（空格、单位、千分位分隔符）一律丢弃。
 */

/** 秒 → 展示用分钟数（向下取整，对齐原 formatter 语义） */
export function fixedRateToMinutesLabel(seconds: number): number {
  return Math.floor(Number(seconds) / 60);
}

/**
 * 输入框文本 → 秒（<1 分钟/非法/空一律回落到最小档 60s）。
 * 抽取所有数字与小数点后按分钟解析，不依赖任何翻译文本。
 *
 * FIX（本轮审计）：原实现在**秒不是 60 整数倍**时会静默改写用户配置——
 * 表单值单位是秒（如 90s / 45s / 100s），而输入框以分钟呈现（formatter
 * 向下取整），用户只是聚焦后失焦（未改一个字符），parser 就把展示文本
 * 「1 分钟」回读成 1×60=60s，把 90s 悄悄改成 60s；后端 PATCH 也接受，
 * 于是「界面显示 1 分钟不变、实际间隔从 90s 变 60s」。
 *
 * 修正：回读时若解析出的秒数落在当前表单值的同一分钟区间内（即
 * `floor(value/60)` 与展示分钟数一致），则**原样保留表单值**——判定依据
 * 是"用户没有真正改动"，而不是"展示文本能还原出唯一秒数"。解析出的值
 * 与表单值跨分钟（用户确实改了）时才采纳解析结果。
 *
 * 入参 `currentSeconds` 缺省时行为与修正前逐字节一致（纯文本 → 秒）。
 */
export function parseFixedRateSeconds(
  value: unknown,
  currentSeconds?: number | null,
): number {
  const minutes = Number(String(value ?? '').replace(/[^\d.]/g, ''));
  if (!Number.isFinite(minutes) || minutes <= 0) return 60;
  const parsed = minutes * 60;
  const current = Number(currentSeconds);
  if (
    Number.isFinite(current) &&
    current > 0 &&
    // 同一"展示分钟"区间 **且 展示文本没有小数/更精确的意图** → 用户没改，
    // 保留精确秒值。含小数点的输入（5.5 分钟）视作用户显式给出了更细粒度，
    // 一律采纳解析结果——否则"改 90s → 5.5 分钟"会被判成同分钟而原样退回。
    Math.floor(current / 60) === Math.floor(parsed / 60) &&
    !String(value ?? '').includes('.')
  ) {
    return current;
  }
  return parsed;
}
