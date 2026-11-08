/**
 * R195（P3-2）· 命令面板「组内只显示前 N 条」必须有**截断告知**。
 *
 * ## 缺陷的**真实边界**（R188 复核收窄过，别按旧描述理解）
 *
 * `CommandPalette` 每组只列 `MAX_PER_GROUP`（5）条且**无任何「还有更多」的提示**
 * ⇒ 可能的误解是「**这个任务不存在 / 没建过**」或「**搜不到 = 系统里没有**」。
 *
 * ⚠️ 「候选池 50 条截断」那一层**已被服务端 `q` 预过滤削弱**（`name OR description` ILIKE）
 * ⇒ 池截断只在「**真的存在 50+ 条命中**」时才发生，此时「只列 5 条」**本来就是设计意图**（Top 5）。
 * ⇒ **真正的缺陷只剩「组内截断到 5 且无任何告知」这一条**。
 *
 * ## 判据
 *
 * ① `total <= shown` ⇒ **不渲染**提示（正常态不该多一行噪音）；
 * ② `total > shown` ⇒ 渲染提示，且**同时说出「已显示多少 / 共多少 / 怎么办」**
 *    —— 只说「已截断」而不说「怎么找全」，用户仍会以为「就这么多了」。
 */
import { describe, it, expect } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import PaletteGroupTruncationHint from "../components/PaletteGroupTruncationHint";

describe("R195（P3-2）· 命令面板组内截断提示", () => {
  it("① total <= shown ⇒ 不渲染提示（没截断就不该有噪音）", () => {
    const { container } = render(<PaletteGroupTruncationHint total={5} shown={5} />);
    expect(container.textContent).toBe("");
    cleanup();
  });

  it("② total > shown ⇒ 渲染提示行（文案经 i18n，测试环境只断言「有内容」+ 词条存在）", async () => {
    // ⚠️ 本仓的测试环境里 i18n **不加载真实词条**（渲染出的是 key）⇒
    //   不断言具体文案，而是：**① 组件确实渲染出了一行**；② 词条表里**有**这条 key；
    //   ③ 词条的**插值参数**含 shown/total（否则用户看不到「共多少」）。
    const { container } = render(<PaletteGroupTruncationHint total={23} shown={5} />);
    await waitFor(() => {
      expect((container.textContent ?? "").length).toBeGreaterThan(0);
    });
    // 词条存在（zh + en 成对，且带 shown / total 两个插值参数）
    const zh = readFileSync(
      join(__dirname, "..", "locales", "zh.ts"),
      "utf8",
    );
    const en = readFileSync(
      join(__dirname, "..", "locales", "en.ts"),
      "utf8",
    );
    const zhLine = /'palette\.groupTruncated':\s*'([^']*)'/.exec(zh)?.[1] ?? "";
    const enLine = /'palette\.groupTruncated':\s*'([^']*)'/.exec(en)?.[1] ?? "";
    expect(zhLine.length).toBeGreaterThan(0);
    expect(enLine.length).toBeGreaterThan(0);
    // 两个插值参数都要在（少了任一个，用户就不知道「共多少」/「已显示多少」）
    expect(zhLine).toContain("{{shown}}");
    expect(zhLine).toContain("{{total}}");
    expect(enLine).toContain("{{shown}}");
    expect(enLine).toContain("{{total}}");
  });
});
