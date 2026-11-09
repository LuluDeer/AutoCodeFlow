/**
 * R178：「暂时没有可用执行器」这一族失败的 **HTTP 语义契约**。
 *
 * ## 这组用例守的是什么
 *
 * R169 审计发现：「**无可用执行器**」这一个失败语义，在 `apps/admin-api` 里
 * **横跨 409 / 500 / 503 三种 HTTP 状态**——同一个「现在派不出去、等一下就行」
 * 的容量问题，在选机路径上是 503，在派发/广播路径上却是 **500**。
 *
 * 500 的代价是实打实的：
 *   · `apps/admin-web/src/api/client.ts:474` 的瞬时重试集只有
 *     `502/503/504` ⇒ **500 不重试**，而容量不足恰恰是可重试的；
 *   · `apps/admin-web` 的文案按状态分派：`http.error.500` = 「服务器内部错误」
 *     （引导人报障），`http.error.503` = 「服务暂时不可用，请稍后重试」
 *     （引导人等待）。
 *
 * R178 的口径：**「暂时没有可用执行器」= 503 Service Unavailable**（503 的 HTTP
 * 语义正是「服务暂时不可用、稍后重试」），且**复用既有码、不造新码**。
 *
 * ## 为什么这些断言写在**码表**这一层（而不是各服务 spec 里）
 *
 * 口径若只钉在某个服务的 spec 里，下次有人**新增**一个 500 的「无可用执行器」
 * 码，或把某个 503 改回 500，**没有任何东西会红**——除非断言直接读码表。
 * 故本文件直接对 `EXECUTOR_CODES` 的 `status` 字段做**表驱动**断言：
 * 「这一族码必须是 503」是一条**关于码表本身**的不变式，与谁抛它无关。
 * 服务侧另有用例钉住「哪些点抛哪个码」（见 `executor.service.spec.ts` 与
 * `executor-package.service.spec.ts` 的既有断言）。
 *
 * ## 反证方式（与 R178 回执一致）
 *
 * 把本文件里任一 `status` 期望改回 500（或反过来把某条码改回 500）⇒
 * **本文件立刻红**；还原 ⇒ 绿。这是本轮唯一的「口径守卫」。
 */
import { EXECUTOR_CODES } from "../../../common/errors/catalog/executor";
import { ERROR_CATALOG } from "../../../common/errors/error-codes";

/**
 * 「暂时没有可用执行器」族 = 「现在派不出去，等一会儿就有空位」。
 *
 * ⚠️ 这份清单是**人工枚举**的，故配一条**反向守卫**（见本文件末尾）：
 * 码表里**任何** zh/en 表达「无可用执行器 / 达到并发上限 / 当前离线」语义的码，
 * 只要 status 不是 503，就必须显式出现在 `PERMANENT_OR_OTHER_SEMANTICS` 里并
 * 写明理由——否则红。这条反向守卫才是防「新码漏网」的真正保险。
 */
const TEMPORARILY_UNAVAILABLE_EXECUTOR_CODES = [
  // —— 派发/广播（executor.service）——
  "NO_DISPATCHABLE_EXECUTOR",
  "NO_BROADCAST_EXECUTOR",
  "EXECUTOR_APP_NAME_NOT_FOUND",
  "PINNED_EXECUTOR_AT_CAPACITY",
  "PINNED_EXECUTOR_OFFLINE",
  // —— 选机（executor.service.selectLeastLoaded）——
  "NO_AVAILABLE_EXECUTOR_FOR_SELECTION",
  "NO_EXECUTOR_MATCHING_FILTERS",
  "NO_EXECUTOR_CAPACITY_AVAILABLE",
  "NO_EXECUTOR_INTERPRETER_MISMATCH",
  // —— 执行器包推送（executor-package.service）——
  "EXECUTOR_PACKAGE_PUSH_NO_TARGETS",
  // —— 码表里的「名字担当」（当前无生产抛点，但口径必须一致）——
  "NO_AVAILABLE_EXECUTOR",
  "EXECUTOR_OFFLINE",
] as const;

/**
 * 表达「无可用执行器」语义但**刻意不是** 503 的码——每条必须写明理由。
 *
 * 判据：若某码的失败**重试永远不会成功**，它就**不该**是 503（否则调用方会
 * 无限重试）。这类码的处置是「改请求」或「改配置」，不是「等一会儿」。
 */
const PERMANENT_OR_OTHER_SEMANTICS: Record<string, string> = {
  PINNED_EXECUTOR_NOT_FOUND:
    "「pinned 目标行根本不存在」是永久性的（调用方给错了 executorId）——" +
    "报成 503「稍后重试」会让调用方无限重试。保持 500（R178 刻意不动，见码表注释）。",
};

describe("R178 · 「暂时没有可用执行器」的 HTTP 语义 = 503", () => {
  it.each(TEMPORARILY_UNAVAILABLE_EXECUTOR_CODES)(
    "%s ⇒ 503（Service Unavailable：服务暂时不可用、稍后重试）",
    (code) => {
      const def = EXECUTOR_CODES[code as keyof typeof EXECUTOR_CODES];
      expect(def).toBeDefined();
      expect(def.status).toBe(503);
    },
  );

  it.each(TEMPORARILY_UNAVAILABLE_EXECUTOR_CODES)(
    "%s 在合并后的总码表里同样是 503（码表分片是唯一真值源，合并点不得改写状态）",
    (code) => {
      const merged = ERROR_CATALOG[code as keyof typeof ERROR_CATALOG];
      expect(merged).toBeDefined();
      expect(merged.status).toBe(503);
    },
  );

  it("这些码都能在总码表里查到（防止枚举了不存在的码而测试空转）", () => {
    for (const code of TEMPORARILY_UNAVAILABLE_EXECUTOR_CODES) {
      expect(ERROR_CATALOG[code as keyof typeof ERROR_CATALOG]).toBeDefined();
    }
  });

  /**
   * **反向守卫**：码表里凡「表达无可用执行器语义」的码，状态不是 503 时，
   * 必须显式登记在 `PERMANENT_OR_OTHER_SEMANTICS` 里并写明理由。
   *
   * 这条才是防「新码漏网」的真正保险：上面的表驱动只钉住**已知**的码，
   * 而新增一个 500 的「无可用执行器」码时，只有这条会红。
   */
  it("反向：任何表达「无可用执行器」语义的码都必须是 503（否则须显式登记理由）", () => {
    const offenders: string[] = [];
    for (const [code, def] of Object.entries(EXECUTOR_CODES)) {
      const text = `${def.zh} ${def.en}`;
      const saysNoExecutor =
        /无可用执行器|没有可用的?执行器|没有在线执行器|没有可用于广播派发的执行器|并发上限|最大并发容量|当前离线|No available executor|No online executor|No executor available|No executor has the requested|at capacity|is offline/i.test(
          text,
        );
      if (!saysNoExecutor) continue;
      if (def.status === 503) continue;
      if (PERMANENT_OR_OTHER_SEMANTICS[code]) continue;
      offenders.push(`${code} (${def.status})`);
    }
    expect(offenders).toEqual([]);
  });

  it("登记在 PERMANENT_OR_OTHER_SEMANTICS 里的码必须**确实**不是 503（防登记漂移）", () => {
    for (const [code, reason] of Object.entries(PERMANENT_OR_OTHER_SEMANTICS)) {
      const def = EXECUTOR_CODES[code as keyof typeof EXECUTOR_CODES];
      expect(def).toBeDefined();
      expect(def.status).not.toBe(503);
      expect(reason.trim().length).toBeGreaterThan(10);
    }
  });

  it("④ 钉住收益本身：前端 `client.ts` 的瞬时重试集**含 503、不含 500**", async () => {
    // 为什么这条值得写进后端的 spec：本次改动的**实际收益**是「前端会自动重试一次」
    // （`apps/admin-web/src/api/client.ts` 的 `isTransient` 只认 502/503/504）。
    // 若哪天有人把 503 从重试集里移除，这个收益就消失了（错误会变成**不可自动恢复**的
    // 用户可见失败）⇒ 必须被显式知道，而不是等用户报障才发现。
    const fs = await import("node:fs");
    const path = await import("node:path");
    const clientPath = path.resolve(
      __dirname,
      "../../../../../admin-web/src/api/client.ts",
    );
    const src = fs.readFileSync(clientPath, "utf8");
    const line = src.split("\n").find((l) => l.includes("isTransient"));
    expect(typeof line).toBe("string"); // 找不到 ⇒ 重试逻辑被改名/搬走了
    expect(line).toContain("503");
    expect(line).toContain("502");
    expect(line).not.toMatch(/status\s*===\s*500/);
  });
});
