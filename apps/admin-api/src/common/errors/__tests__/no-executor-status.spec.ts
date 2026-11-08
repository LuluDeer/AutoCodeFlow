/**
 * R178 · 「**暂时没有可用执行器**」必须是 **503**，不是 **500**。
 *
 * ## 为什么值得一条专门测试（这不是「数字好看法」问题，三条后果都可复核）
 *
 * `500 Internal Server Error` 的语义是「**服务端出 bug、重试也没用**」；
 * `503 Service Unavailable` 的语义是「**服务暂时不可用、稍后重试**」。
 *
 * 把这族「容量 / 可用性」错误报成 500 的代价：
 * ① **前端根本不重试**：`apps/admin-web/src/api/client.ts` 的瞬时重试集是
 *    `isTransient = !err.response || status === 502 || status === 503 || status === 504`
 *    ⇒ **500 被当成确定性故障、直接放弃；503 会自动重试一次**。
 *    也就是说：这不是「状态码更准确」的洁癖，而是**少一次用户可见的失败**。
 * ② **污染错误预算 / 告警**：`docs/observability/alerting-rules.yml` 的 5xx 占比告警
 *    按 `status_class="5xx"` 聚合 ⇒ 容量不足会伪装成「服务端故障率升高」，真 bug 被噪声淹没。
 * ③ **处置建议错位**：`http.error.500` 的文案是「服务器内部错误」（引导人**报障**），
 *    `http.error.503` 是「服务暂时不可用，请稍后重试」（引导人**等待**）。
 *
 * ## 判据
 *
 * ① 这 **5** 个「暂时容量 / 可用性」码都是 **503**；
 * ② **反向钉子**：`BROADCAST_DISPATCH_ALL_FAILED` 仍是 **500** —— 它是「全部执行器都失败了」，
 *    那是真故障，**不该**被归成「暂时不可用」（证明本改动没有「见 5xx 就改 503」地扩大化）；
 * ③ `EXECUTOR_NOT_FOUND` 仍是 **404**（资源不存在 ≠ 暂时不可用）。
 */
describe("R178：「暂时没有可用执行器」= 503（不是 500）", () => {
  /** 这 5 个码的文案各自都在说「等一会儿再试」/「暂时没有」 ⇒ 都是暂时性状况。 */
  const TRANSIENT = [
    "NO_DISPATCHABLE_EXECUTOR",
    "PINNED_EXECUTOR_AT_CAPACITY",
    "NO_BROADCAST_EXECUTOR",
    "EXECUTOR_APP_NAME_NOT_FOUND",
  ] as const;

  it("① 「暂时容量/可用性」码都是 503（可被前端自动重试一次）", async () => {
    const { ERROR_CATALOG } = await import("../error-codes");
    const got = TRANSIENT.map((code) => ({
      code,
      status: ERROR_CATALOG[code].status,
    }));
    expect(got).toEqual(TRANSIENT.map((code) => ({ code, status: 503 })));
  });

  it("② 反向钉子：BROADCAST_DISPATCH_ALL_FAILED 仍是 500（真故障，不是暂时不可用）", async () => {
    const { ERROR_CATALOG } = await import("../error-codes");
    expect(ERROR_CATALOG.BROADCAST_DISPATCH_ALL_FAILED.status).toBe(500);
  });

  it("③ 资源不存在仍是 404（不是 503）", async () => {
    const { ERROR_CATALOG } = await import("../error-codes");
    expect(ERROR_CATALOG.EXECUTOR_NOT_FOUND.status).toBe(404);
  });

  it("④ 前端的瞬时重试集确实**不含 500、含 503**（本改动真实收益的依据）", async () => {
    // 把「本改动的收益」也钉住：若哪天有人把 503 从重试集里去掉，
    // 这条会红 —— 那说明「改状态码带来的重试收益」消失了，应当被知道。
    const fs = await import("node:fs");
    const path = await import("node:path");
    const clientPath = path.resolve(
      __dirname,
      "../../../../../admin-web/src/api/client.ts",
    );
    const src = fs.readFileSync(clientPath, "utf8");
    const line = src.split("\n").find((l) => l.includes("isTransient"));
    // 找不到 ⇒ 前端重试逻辑被改名/搬走了，这条要红（下方断言会因 undefined 而失败）
    expect(typeof line).toBe("string");
    expect(line).toContain("503");
    expect(line).toContain("502");
    expect(line).not.toMatch(/status\s*===\s*500/);
  });
});
