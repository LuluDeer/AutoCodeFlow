/**
 * R199：`list` 端点的分页参数钳制。
 *
 * ## 为什么单独成文件（而不是留在 service 里）
 *
 * ① `agent-session.service.ts` 在 `check:size-caps` 的**逐文件只减不增**基线上**顶格**
 *    （`nonCommentLines` 1099/1099）⇒ R199 要给 `list` 加 `stalled` 过滤，
 *    若不外提就**必然破顶**（外提 ⇒ 该文件**净减** ⇒ 基线还能**下调**）。
 * ② 分页钳制是**独立职责**（与「会话查询」无关）⇒ 抽出来更好读、更好测。
 *
 * ## 语义（**必须保持不变** —— 见下）
 *
 * · NaN 守卫（R3 后端遗留）：HTTP 层 `parseInt("abc")=NaN` 会穿透
 *   `Math.max/Math.min` 钳制（`Math.max(1, NaN)=NaN`），NaN 直达 `skip/take` 炸 500。
 *   ⇒ 非有限数（NaN / ±Infinity）一律**视同未传**，回落 1 / 20，**不是 400** ——
 *   400 会改变「非法深链安全回落」的契约（R2-C URL-SYNC-01 口径）。
 * · `page` 上限 **10000**（F-54，UIAUDIT 后端轮 P3-1）：对齐 NETOPT-3④ 的
 *   `PageQueryDto` 口径（与 events 先例 2ea869fc 一致）。无封顶的 page 会生成
 *   深 OFFSET + `getManyAndCount` 全量 COUNT，可钉满连接池。
 *   仍**在 clamp 内做**（不引 DTO）⇒ 保持本端点「非法值安全回落、绝不 400」的契约 ——
 *   语义是「超限视同翻到最深一页内的最后一屏」而非报错。
 * · `pageSize` ∈ [1, 100]。
 */
export function clampPagination(
  rawPage: number | undefined,
  rawPageSize: number | undefined,
): { page: number; pageSize: number } {
  const page = Math.min(
    10000,
    Math.max(
      1,
      typeof rawPage === "number" && Number.isFinite(rawPage) ? rawPage : 1,
    ),
  );
  const pageSize = Math.min(
    100,
    Math.max(
      1,
      typeof rawPageSize === "number" && Number.isFinite(rawPageSize)
        ? rawPageSize
        : 20,
    ),
  );
  return { page, pageSize };
}
