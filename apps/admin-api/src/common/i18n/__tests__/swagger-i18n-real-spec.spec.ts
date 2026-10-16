/**
 * API-I18N：语言开关对**真实生成物**的覆盖。
 *
 * 存在的理由：`swagger-i18n-toggle.spec.ts` 喂的是**合成小文档**，只能证明判据
 * 逻辑对；而真实 `openapi.json` 里形态更杂（`allOf`/`$ref`/嵌套数组、重复文案、
 * `enum` 值）。一旦某类位置提取不到，开关切过去那类文案原地不动——表现为
 * 「半中半英」，且**不报任何错**。故必须对真实产物跑一遍并给出数字。
 *
 * ⚠️ 这些用例依赖 `apps/admin-api/openapi.json` 的内容（而非仅结构）。该文件是
 * **入库的生成物**，改 DTO/装饰器后必须重跑 `npm run openapi:export` +
 * `node scripts/api-i18n/inject-openapi-en.mjs`；若数字下界被突破，通常意味着
 * 「注入没跑」或「提取面漏了某类位置」——两者都是真缺陷，不要调低下界了事。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { collectEntries } from "../swagger-i18n-toggle";

const CJK = /[\u4e00-\u9fff]/;

describe("API-I18N · 真实 openapi.json 的开关覆盖", () => {
  const doc = JSON.parse(
    readFileSync(join(__dirname, "../../../../openapi.json"), "utf8"),
  );
  const entries = collectEntries(doc);

  it("提取出足量条目（说明真实文档的结构被认到了）", () => {
    // 实测：`x-i18n-en` 注入 1482 处，按「中文原文」去重后 **1220** 条
    //（重复文案共用一条英文是设计使然——映射表以中文原文为键）。
    // 下界取 1100：整类位置（如 params / responses）漏提时会立刻跌破，
    // 又不至于因文案增删而脆。
    expect(entries.length).toBeGreaterThan(1100);
  });

  it("中文侧确实含中文，英文侧**不含**中文（防中→中映射）", () => {
    const zhHasCjk = entries.filter((e) => CJK.test(e.zh)).length;
    expect(zhHasCjk).toBe(entries.length);
    const enWithCjk = entries.filter((e) => CJK.test(e.en));
    expect(enWithCjk.map((e) => e.zh.slice(0, 40))).toEqual([]);
  });

  it("每条的 zh 与 en 都非空（空串会让开关把文案抹成空白）", () => {
    const empty = entries.filter((e) => !e.zh.trim() || !e.en.trim());
    expect(empty).toEqual([]);
  });

  it("zh 无重复键（重复会让 TreeWalker 替换时行为不一致）", () => {
    const seen = new Map<string, number>();
    for (const e of entries) seen.set(e.zh, (seen.get(e.zh) ?? 0) + 1);
    const dups = [...seen.entries()].filter(([, n]) => n > 1);
    expect(dups).toEqual([]);
  });
});
