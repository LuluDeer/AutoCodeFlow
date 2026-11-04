/**
 * 左栏设置搜索的匹配逻辑（UI V5：「设置搜索」）。
 *
 * 搜索范围 = 分区名 + 该分区字段名（标签走既有双语表 `FIELD_LABEL_KEYS`）。
 * 原来是页面里一段 23 行的内联表达式，无法被任何东西执行；抽成纯函数后
 * 由 `pages/config/pure-logic.selftest.mjs` 逐条断言（命中顺序 / 上限 / 大小写）。
 *
 * 纯函数：分区表、字段键表、文案函数全部由调用方注入——本模块不知道
 * `SECTIONS` 长什么样，也不持有任何状态。
 */

/** 一条搜索命中：分区命中（kind=section）或字段命中（kind=field）。 */
export type SearchHit<Id extends string> = {
  kind: 'section' | 'field';
  id: string;
  section: Id;
  label: string;
};

/** 归一化搜索词（去首尾空白 + 小写）；空串 = 不显示结果。 */
export function normalizeSearchTerm(query: string): string {
  return query.trim().toLowerCase();
}

/** 命中上限：左侧栏不是结果列表，超过 12 条用户只会滚不到底。 */
export const MAX_SEARCH_RESULTS = 12;

export function searchResultsOf<Id extends string>(input: {
  query: string;
  sections: ReadonlyArray<{ id: Id; labelKey: string }>;
  sectionKeys: Record<Id, readonly string[]>;
  fieldLabelKeys: ReadonlyArray<readonly [string, string]>;
  t: (key: string) => string;
}): SearchHit<Id>[] {
  const term = normalizeSearchTerm(input.query);
  if (term === '') return [];
  const labelKeyOf = (key: string): string =>
    input.fieldLabelKeys.find(([fieldKey]) => fieldKey === key)?.[1] ?? key;
  return [
    ...input.sections
      .filter((section) => input.t(section.labelKey).toLowerCase().includes(term))
      .map((section) => ({
        kind: 'section' as const,
        id: section.id,
        section: section.id,
        label: input.t(section.labelKey),
      })),
    ...input.sections.flatMap((section) =>
      input.sectionKeys[section.id]
        .filter((key) => key.toLowerCase().includes(term) || input.t(labelKeyOf(key)).toLowerCase().includes(term))
        .map((key) => ({
          kind: 'field' as const,
          id: key,
          section: section.id,
          label: input.t(labelKeyOf(key)),
        })),
    ),
  ].slice(0, MAX_SEARCH_RESULTS);
}
