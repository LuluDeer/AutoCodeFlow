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
