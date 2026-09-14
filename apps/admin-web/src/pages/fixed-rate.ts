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
 */
export function parseFixedRateSeconds(value: unknown): number {
  const minutes = Number(String(value ?? '').replace(/[^\d.]/g, ''));
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60 : 60;
}
