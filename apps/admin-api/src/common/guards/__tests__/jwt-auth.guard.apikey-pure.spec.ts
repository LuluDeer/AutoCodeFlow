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
    expect(extractBearerCredential({ headers: { authorization: "Bearer acf_x" } })).toBe("acf_x");
    expect(extractBearerCredential({ headers: { authorization: "bearer acf_x" } })).toBe("acf_x");
    expect(extractBearerCredential({ headers: { authorization: "Basic abc" } })).toBeNull();
    expect(extractBearerCredential({ headers: {} })).toBeNull();
    expect(extractBearerCredential({ headers: { authorization: "Bearer" } })).toBeNull();
  });

  it("normalizeApiPath：剥离全局 api 前缀、查询串、首斜杠", () => {
    expect(normalizeApiPath({ path: "/api/tasks/1/trigger" })).toBe("tasks/1/trigger");
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

  it("acf_ 前缀常量与 util 前缀一致，JWT 形态不会误判为 API Key", () => {
    expect(API_KEY_PREFIX).toBe("acf_");
    expect(looksLikeApiKey("acf_abc")).toBe(true);
    expect(looksLikeApiKey("eyJhbGciOiJIUzI1NiJ9.xxx")).toBe(false);
  });
});
