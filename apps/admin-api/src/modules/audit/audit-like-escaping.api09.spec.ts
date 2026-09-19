/**
 * API-09（本轮体验审查）：审计搜索的两个过滤在「元字符」与「白名单」上都不对。
 *
 * 两个问题一起修，都出在 `audit.service.ts`：
 *
 * ① **LIKE 元字符未转义**（真实缺陷）。`username` 过滤直接拼
 *    `` `%${input}%` ``。而 ILIKE 里 `%` = 任意字符、`_` = 任意单字符：
 *      · 运维搜真的含下划线的用户名 `zhang_san` → 那个 `_` 变通配符，
 *        **命中 `zhangXsan` 这类无关账号**；
 *      · 搜 `%` → 命中全部行。
 *    结果集看起来"能用"，只是多了不该有的行——用户很难察觉，会据此得出错误的
 *    审计结论（"这个账号在这次操作里出现过"）。
 *
 * ② **`action` 的白名单过严**（体验缺陷）。原要求 `^[a-zA-Z0-9_.\-\s]+$`，
 *    否则 400「Invalid action parameter」。但注入风险早已由**绑定参数**消除
 *    （值从不拼进 SQL），该白名单对安全没有增量，只剩副作用：用户输入中文、
 *    `:`、`/` 这类正常搜索词直接吃 400 + 英文技术报错，而期待的是"没有匹配"。
 *
 * 修法：新增 `escapeLikePattern()`（先转义 `\`，再转义 `%` 与 `_`），
 * `action` 与 `username` 两处共用；`action` 的白名单放宽为只限长度。
 *
 * 反证：
 *  · 去掉 escapeLikePattern 的调用（改回裸插值）→ 转义类用例变红；
 *  · 把白名单加回去 → 中文/冒号类用例变红。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { escapeLikePattern } from "./audit.service";

describe("API-09 escapeLikePattern：LIKE 元字符必须按字面量处理", () => {
  it("% 被转义（否则匹配任意字符 = 搜什么都命中全部行）", () => {
    expect(escapeLikePattern("50%")).toBe("50\\%");
    expect(escapeLikePattern("%")).toBe("\\%");
  });

  it("_ 被转义（否则 zhang_san 会命中 zhangXsan）", () => {
    expect(escapeLikePattern("zhang_san")).toBe("zhang\\_san");
    expect(escapeLikePattern("_")).toBe("\\_");
  });

  it("反斜杠本身被转义（且必须**先**转义，否则会把后面新加的转义符再转一次）", () => {
    expect(escapeLikePattern("a\\b")).toBe("a\\\\b");
    // 组合：反斜杠 + 百分号 → 反斜杠成对，百分号单转义
    expect(escapeLikePattern("\\%")).toBe("\\\\\\%");
  });

  it("普通 ASCII / 中文 / 冒号斜杠**不被改动**（不误伤正常搜索词）", () => {
    for (const s of [
      "task.create",
      "task.updateGlue",
      "user delete",
      "运维操作",
      "task:update",
      "a/b",
      "zhangsan",
    ]) {
      expect(escapeLikePattern(s)).toBe(s);
    }
  });

  it("空串原样（不产生多余转义）", () => {
    expect(escapeLikePattern("")).toBe("");
  });

  it("转义后仍可安全地包进 %...%（模式串语义正确）", () => {
    // 用户搜 "zhang_san" → 期望模式是 %zhang\_san%
    expect(`%${escapeLikePattern("zhang_san")}%`).toBe("%zhang\\_san%");
    // 用户搜 "%" → 期望只匹配字面量百分号
    expect(`%${escapeLikePattern("%")}%`).toBe("%\\%%");
  });
});

describe("API-09 契约：两个过滤共用同一转义（避免只修一处）", () => {
  const rawSrc = readFileSync(join(__dirname, "audit.service.ts"), "utf-8");
  // 必须去掉注释：本文件的头注与源码注释里都**引用了**旧写法（`%${input}%`
  // 与旧白名单正则）作为反例说明。不剥注释的话，守卫会把"解释缺陷的注释"
  // 当成缺陷本身，红得毫无线索——这类"注释即违规"的误报本轮已踩过两次。
  const src = rawSrc
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("源码里不存在未转义的 `%${...}%` 裸插值", () => {
    // 允许的形态是 `%${escapeLikePattern(x)}%`（中间有函数调用）。
    const bare = [...src.matchAll(/`%\$\{[^}]+\}%`/g)]
      .map((m) => m[0])
      .filter((s) => !s.includes("escapeLikePattern("));
    expect(bare).toEqual([]);
  });

  it("有齿校验：该正则确实能匹配到被修的旧写法", () => {
    const re = /`%\$\{[^}]+\}%`/g;
    const old = "`%${options.username}%`";
    const fixed = "`%${escapeLikePattern(x)}%`";
    // 正则本身两种形态都能匹配（故上面那条必须再 filter 掉已转义的）
    expect([...old.matchAll(re)].length).toBeGreaterThanOrEqual(1);
    expect([...fixed.matchAll(re)].length).toBeGreaterThanOrEqual(1);
    // 而 filter 判据确实能把两者分开
    expect(!old.includes("escapeLikePattern(")).toBe(true);
    expect(!fixed.includes("escapeLikePattern(")).toBe(false);
  });

  it("action 与 username 两处都调用了 escapeLikePattern", () => {
    // 1 处定义 + 2 处调用（action / username）
    const calls = [...src.matchAll(/escapeLikePattern\(/g)].length;
    expect(calls).toBeGreaterThanOrEqual(3);
    // 且两处调用分别在 action 与 username 的 ILIKE 上
    expect(src).toMatch(/log\.action ILIKE :action/);
    expect(src).toMatch(/log\.username ILIKE :username/);
  });

  it("action 的旧白名单已移除（不再让中文/冒号吃 400）", () => {
    expect(src).not.toMatch(/\^\[a-zA-Z0-9_\.\\-\\s\]\+\$/);
  });

  it("长度上限仍在（放宽白名单不等于放弃 DoS 防护）", () => {
    const slices = [...src.matchAll(/\.slice\(0, 100\)/g)].length;
    expect(slices).toBeGreaterThanOrEqual(2);
  });
});
