import { ApiKeysModule } from "../api-keys.module";
import { API_KEY_AUTH_FACADE } from "../../../common/guards/jwt-auth.guard";
import { ApiKeyAuth } from "../api-key-auth.helper";

/**
 * AUTH-03 接线回归锁（2026-10-23 真机实测抓出的 401 缺陷）。
 *
 * 现场：`acf task list` / `GET /api/tasks` 携带 `Authorization: Bearer acf_…`
 * 恒回 401「Invalid or expired token」，而同一个 key 打 `/api/api-keys` 能走到
 * JWT-only 分流（证明 key 本身有效）。根因是**模块内 guard 实例**解析不到
 * `API_KEY_AUTH_FACADE`：
 *
 *   · 全局 APP_GUARD 的 JwtAuthGuard 在 AppModule 注入器里装配 → facade 可见
 *     → 认证成功（会写 lastUsedAt）；
 *   · 但 task.controller / executor.controller 等类上另有
 *     `@UseGuards(JwtAuthGuard)`，这个实例在**各自模块**注入器里装配；本模块
 *     当时不是 @Global，facade 不可见，`@Optional()` 吞成 undefined → 跳过
 *     API Key 分支 → 回落 passport-jwt → 401。
 *
 * 这类缺陷在 helper 单测里完全看不见（`api-key-task-trigger.spec.ts` 直接 new
 * ApiKeyAuth）。故这里钉住**接线本身**：模块必须 @Global，且导出 facade。
 * 摘掉 @Global 本用例即红。
 */
describe("AUTH-03 ApiKeysModule 接线", () => {
  it("是 @Global：任意模块内的 JwtAuthGuard 实例都能解析 API_KEY_AUTH_FACADE", () => {
    expect(Reflect.getMetadata("__module:global__", ApiKeysModule)).toBe(true);
  });

  it("导出 facade token 与其实现（全局可见的前提）", () => {
    const exported: unknown[] =
      Reflect.getMetadata("exports", ApiKeysModule) ?? [];
    expect(exported).toContain(API_KEY_AUTH_FACADE);
    expect(exported).toContain(ApiKeyAuth);
  });
});
