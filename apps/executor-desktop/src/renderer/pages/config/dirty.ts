/**
 * 设置页「有没有未保存改动」的全部派生判定（V4-4 X-02 改动清单 / B-03 分区圆点）。
 *
 * 全部是纯函数：入参只有 `form` / `savedForm` 两个纯对象 + 分区键表，没有
 * state / DOM / 时钟，故可被 `pages/config/pure-logic.selftest.mjs` 直接执行。
 * 单一真值源仍是页面里的 `form` / `savedForm`（本模块只读，不持有任何状态）。
 */

/** 配置值等价：两个掩码视图按 JSON 结构比较（数组/对象逐项，顺序敏感）。 */
export function sameConfigValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** 任一分区键在 form 与基线之间不同（跨域差分的唯一判据）。 */
export function anyFieldDiffer(
  form: Record<string, unknown>,
  savedForm: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return keys.some((key) => !sameConfigValue(form[key], savedForm[key]));
}

/** 改动清单：字段 → i18n label 键（顺序 = fieldLabelKeys 的顺序，未改动的不出现）。 */
export function changedEntriesOf(
  form: Record<string, unknown>,
  savedForm: Record<string, unknown>,
  fieldLabelKeys: ReadonlyArray<readonly [string, string]>,
): { key: string; labelKey: string }[] {
  return fieldLabelKeys
    .filter(([key]) => !sameConfigValue(form[key], savedForm[key]))
    .map(([key, labelKey]) => ({ key, labelKey }));
}

/** 哪些分区有未保存改动（驱动 nav 上的 cfg-nav-dirty 圆点）。 */
export function dirtySectionsOf<Id extends string>(
  form: Record<string, unknown>,
  savedForm: Record<string, unknown>,
  sections: ReadonlyArray<{ id: Id }>,
  sectionKeys: Record<Id, readonly string[]>,
): Set<Id> {
  return new Set(
    sections
      .filter((section) => anyFieldDiffer(form, savedForm, sectionKeys[section.id]))
      .map((section) => section.id),
  );
}
