import {
  extractBearerCredential,
  isJwtOnlyPath,
  normalizeApiPath,
  API_KEY_PREFIX,
  JWT_ONLY_API_KEY_PATHS,
} from "../jwt-auth.guard";
import { looksLikeApiKey } from "../../../modules/api-keys/api-key.util";

/** AUTH-03: 分流辅助纯函数——头解析 / 路径归一化 / JWT-only 面。 */
describe("AUTH-03 guard 纯函数", () => {
  it("extractBearerCredential：标准/大小写/缺头/非 Bearer", () => {
    expect(
      extractBearerCredential({ headers: { authorization: "Bearer acf_x" } }),
    ).toBe("acf_x");
    expect(
      extractBearerCredential({ headers: { authorization: "bearer acf_x" } }),
    ).toBe("acf_x");
    expect(
      extractBearerCredential({ headers: { authorization: "Basic abc" } }),
    ).toBeNull();
    expect(extractBearerCredential({ headers: {} })).toBeNull();
    expect(
      extractBearerCredential({ headers: { authorization: "Bearer" } }),
    ).toBeNull();
  });

  it("normalizeApiPath：剥离全局 api 前缀、查询串、首斜杠", () => {
    expect(normalizeApiPath({ path: "/api/tasks/1/trigger" })).toBe(
      "tasks/1/trigger",
    );
    expect(normalizeApiPath({ path: "/api-keys?x=1" })).toBe("api-keys");
    expect(normalizeApiPath({ path: "tasks" })).toBe("tasks");
  });

  it("isJwtOnlyPath：api-keys/auth/users 前缀命中，业务路径不误伤", () => {
    for (const p of JWT_ONLY_API_KEY_PATHS) {
      expect(isJwtOnlyPath(p)).toBe(true);
      expect(isJwtOnlyPath(`${p}/deep`)).toBe(true);
    }
    expect(isJwtOnlyPath("tasks")).toBe(false);
    expect(isJwtOnlyPath("task-templates")).toBe(false);
    expect(isJwtOnlyPath("users-legacy-x")).toBe(false);
  });

  /**
   * CASE-01（审计 P2，2026-10-17）：大小写不得绕过 JWT-only 面。
   *
   * Express 的路由匹配默认大小写不敏感（`caseSensitive: false`），所以
   * `POST /api/API-KEYS` 会命中 `@Controller("api-keys")` 的处理器。而
   * normalizeApiPath 此前按原样返回 `API-KEYS`，与全小写白名单比对必然
   * 不匹配 → 被判为「非 JWT-only 面」→ **持 API Key 即可打 api-keys /
   * auth / users / config**（AUTH-03 明确要隔离的面，API Key 权限更低
   * 且更易泄漏）。
   */
  it("CASE-01：大写/混合大小写路径归一后仍命中 JWT-only 面（不得绕过）", () => {
    for (const raw of [
      "/api/API-KEYS",
      "/api/Api-Keys",
      "/API/api-keys",
      "/api-keys",
    ]) {
      const normalized = normalizeApiPath({ path: raw });
      expect({ raw, normalized }).toEqual({
        raw,
        normalized: "api-keys",
      });
      expect({ raw, jwtOnly: isJwtOnlyPath(normalized) }).toEqual({
        raw,
        jwtOnly: true,
      });
    }
    for (const p of JWT_ONLY_API_KEY_PATHS) {
      expect(isJwtOnlyPath(normalizeApiPath({ path: `/api/${p.toUpperCase()}` })))
        .toBe(true);
      expect(
        isJwtOnlyPath(normalizeApiPath({ path: `/api/${p.toUpperCase()}/x/1` })),
      ).toBe(true);
    }
  });

  it("CASE-01：业务路径大写后仍**不**被误判为 JWT-only（反证）", () => {
    expect(isJwtOnlyPath(normalizeApiPath({ path: "/api/TASKS" }))).toBe(false);
    expect(isJwtOnlyPath(normalizeApiPath({ path: "/api/USERS-LEGACY-X" })))
      .toBe(false);
    expect(isJwtOnlyPath(normalizeApiPath({ path: "/api/AUDIT" }))).toBe(false);
  });

  it("acf_ 前缀常量与 util 前缀一致，JWT 形态不会误判为 API Key", () => {
    expect(API_KEY_PREFIX).toBe("acf_");
    expect(looksLikeApiKey("acf_abc")).toBe(true);
    expect(looksLikeApiKey("eyJhbGciOiJIUzI1NiJ9.xxx")).toBe(false);
  });

  /**
   * SEC-KEY-CFG（本轮审计）：任何 `manage` scope 的 API Key 都曾能改系统配置。
   * api-key-scope.util 的矩阵是 method×path 的（`manage` 直接放行所有写），
   * 而 RolesGuard 补偿不了——ApiKeyUser 没有 role 字段，
   * requiredRoles.includes(undefined) 恒为 false。所以唯一的闸口就是本表。
   */
  it("SEC-KEY-CFG：config 属 JWT-only，API Key 不得改写系统配置", () => {
    expect(isJwtOnlyPath("config")).toBe(true);
    // 具体可达的敏感写面
    expect(isJwtOnlyPath("config")).toBe(true);
    expect(isJwtOnlyPath("config/executor-shared-token/generate")).toBe(true);
    expect(isJwtOnlyPath("config/history/12/rollback")).toBe(true);
    expect(isJwtOnlyPath("config/ai.openaiBaseUrl")).toBe(true);
  });

  it("SEC-KEY-CFG：凭据与账户三条面同样是 JWT-only", () => {
    for (const p of ["api-keys", "auth", "users"]) {
      expect(isJwtOnlyPath(p)).toBe(true);
    }
  });
});
