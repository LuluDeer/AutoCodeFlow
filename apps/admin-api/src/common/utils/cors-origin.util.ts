/**
 * ARCH-001: CORS origin 白名单工具。
 *
 * 旧实现（main.ts isLanOrigin）自动放行所有私有/LAN 网段
 * （localhost / 127.x / 10.x / 192.168.x / 172.16-31.x），
 * 内网任意主机都可以跨域调用 API，在共享内网/多租户环境下存在 CSRF 风险。
 *
 * 现改为"显式白名单"模型：
 * - 允许的 origin 通过 CORS_ALLOWED_ORIGINS（逗号分隔）显式配置；
 *   兼容旧的 CORS_ORIGINS 作为回退（见 configuration.ts）。
 * - 未配置白名单时，仅开发环境默认放行 http://localhost:* 与 http://127.0.0.1:*（任意端口）；
 * - 生产环境必须显式配置白名单（见 main.ts 启动前校验与 configuration.ts fail-fast），
 *   私有网段不再被自动放行；内网部署请将对应 origin 显式加入白名单并在部署文档说明。
 */

import { Logger } from "@nestjs/common";

import { AppError } from "../errors/app-error";
import { ErrorCode } from "../errors/error-codes";

// 开发默认：仅本机来源（scheme + 主机 + 可选端口），不包含 0.0.0.0/::1 等。
const DEV_DEFAULT_ORIGIN_PATTERN =
  /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

/** 解析逗号分隔的白名单环境变量：去空格、去空项 */
export function parseAllowedOrigins(raw: string | undefined | null): string[] {
  return (raw ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

/**
 * 判断跨域来源是否放行：
 * 1. origin 精确出现在显式白名单中；
 * 2. （仅开发环境且未配置白名单时）默认放行本机任意端口 —— 显式配置优先于默认值。
 */
export function isOriginAllowed(
  origin: string,
  allowedOrigins: string[],
  isDevelopment: boolean,
): boolean {
  if (allowedOrigins.includes(origin)) {
    return true;
  }
  if (
    isDevelopment &&
    allowedOrigins.length === 0 &&
    DEV_DEFAULT_ORIGIN_PATTERN.test(origin)
  ) {
    return true;
  }
  return false;
}

/**
 * F-40（UIUX 审计 P1-1）：构造 enableCors 的 origin 校验回调（main.ts 使用）。
 *
 * 拒绝形态从裸 `new Error(...)` 改为带稳定码的 AppError：裸 Error 经 cors
 * 中间件 next(err) 冒泡到 HttpExceptionFilter 会被兜成 **500「服务器内部错误」
 * （errorCode:null）**，与真实服务器故障不可区分；AppError 是 HttpException
 * 子类，filter 按主路径渲染为规范 403 + `CORS_ORIGIN_NOT_ALLOWED` 错误封套
 * （params.origin 透出被拒来源，进统一错误体与服务端日志）。
 *
 * 第二参恒传 false：抛错路径下 cors 包直接 next(err)，该值无实际语义，写 false
 * 只为显式表达"未放行"（对照放行分支的 true）。
 */
export function corsOriginValidator(
  allowedOrigins: string[],
  isDevelopment: boolean,
): (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => void {
  return (origin, callback) => {
    // Allow server-to-server calls (no Origin header)
    if (!origin) {
      callback(null, true);
      return;
    }
    if (isOriginAllowed(origin, allowedOrigins, isDevelopment)) {
      callback(null, true);
      return;
    }
    Logger.warn(
      `Origin ${origin} not allowed by CORS (403 CORS_ORIGIN_NOT_ALLOWED)`,
      "CORS",
    );
    callback(new AppError(ErrorCode.CORS_ORIGIN_NOT_ALLOWED, { origin }), false);
  };
}
