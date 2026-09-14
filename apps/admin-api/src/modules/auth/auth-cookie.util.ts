// F-06（DEEP_REVIEW 0ef3bbe）：refresh token 迁移到 HttpOnly Cookie。
//
// 设计：
//  - refresh token（30 天长效）由前端 localStorage 迁出，改由后端在登录 /
//    TOTP 第二步 / 刷新成功时下发为 HttpOnly Cookie；JS 无法读取，XSS 不再
//    能直接窃取长效会话。
//  - access token 仍经响应体下发，前端只放在内存（zustand 非持久化段），
//    页面刷新后由 /auth/refresh 凭 Cookie 静默换新。
//
// CSRF 取舍（显式记录）：
//  - 本 Cookie 采用 SameSite=Strict：跨站请求一律不携带该 Cookie，从机制上
//    消除了跨站表单/图片等触发 /auth/refresh、/auth/logout 的 CSRF 面。
//  - 状态变更接口（logout/totp/*/sessions）另由 JwtAuthGuard 保护，access
//    token 在 Authorization 头里、不在 Cookie 里，跨站脚本读不到也带不走，
//    故无需额外 CSRF token。SameSite=Strict 即为本项目选定的 CSRF 缓解方案。
//  - Cookie 作用域收紧到 /api/auth（Path），其余业务接口不携带该 Cookie。
//
// 不引入 cookie-parser：本服务只在 auth 控制器读/写这一枚 Cookie，手写最小
// 解析避免新增运行时依赖。
import type { Request, Response } from "express";
import { getEnvVar } from "../../config/env";

export const REFRESH_COOKIE_NAME = "acf_refresh";

/** Cookie 作用域：仅 auth 路由读取，避免随业务接口外发。 */
const COOKIE_PATH = "/api/auth";

function isProduction(): boolean {
  return getEnvVar("NODE_ENV") === "production";
}

/**
 * 下发/轮换 refresh token Cookie。
 * @returns 是否真的写了 Cookie（res 缺失时为 false——单测裸调用控制器不传
 *          res，此时静默跳过，不影响既有单元测试）。
 */
export function setRefreshCookie(
  res: Response | undefined,
  refreshToken: string,
): boolean {
  if (!res || typeof res.cookie !== "function") return false;
  res.cookie(REFRESH_COOKIE_NAME, refreshToken, {
    httpOnly: true,
    // 生产环境强制 HTTPS 才携带；开发态 http://localhost 下不设 Secure，
    // 否则浏览器直接丢弃 Cookie 导致本地登录无法刷新。
    secure: isProduction(),
    // SameSite=Strict 规避 CSRF（见文件头注释）。
    sameSite: "strict",
    path: COOKIE_PATH,
    maxAge: 30 * 24 * 60 * 60 * 1000, // 与 refresh token 30d 有效期对齐
  });
  return true;
}

/** 登出时显式清除 refresh Cookie。 */
export function clearRefreshCookie(res: Response | undefined): boolean {
  if (!res || typeof res.clearCookie !== "function") return false;
  res.clearCookie(REFRESH_COOKIE_NAME, { path: COOKIE_PATH });
  return true;
}

/**
 * 从请求中读取 refresh token：优先 HttpOnly Cookie（F-06 主路径），
 * 缺失时回退到请求体（既有 e2e / curl / 程序调用仍可显式传 refreshToken，
 * 属向后兼容桥接，前端正式链路走 Cookie）。
 */
export function readRefreshToken(
  req: Request | undefined,
  bodyToken?: string,
): string | null {
  const raw = (req?.headers?.cookie as string | undefined) ?? "";
  if (raw) {
    for (const pair of raw.split(";")) {
      const idx = pair.indexOf("=");
      if (idx === -1) continue;
      const name = pair.slice(0, idx).trim();
      if (name === REFRESH_COOKIE_NAME) {
        const value = pair.slice(idx + 1).trim();
        if (value) return decodeURIComponent(value);
      }
    }
  }
  return typeof bodyToken === "string" && bodyToken.length > 0 ? bodyToken : null;
}
