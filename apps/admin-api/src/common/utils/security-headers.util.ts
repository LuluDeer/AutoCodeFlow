/**
 * SEC-08: security-headers.util — helmet 的生产/开发差异化配置工厂。
 *
 * 背景（SEC-08 前 main.ts 现状）：helmet 已启用，但
 * `contentSecurityPolicy: nodeEnv === "production" ? undefined : false` ——
 * 生产传 `undefined` 等于使用 helmet 默认值（default-src 'self' 的基线 CSP），
 * 但该值是「未配置」而非「显式收紧决策」，且没有 HSTS / Referrer-Policy 的
 * 显式裁定；开发传 `false` 关闭 CSP 以便 Swagger UI 内联脚本可用（合理，
 * 保留）。SEC-08 裁定：生产 CSP 显式收紧并逐指令写明理由；HSTS/
 * Referrer-Policy 全环境由 helmet 默认接住（开发不额外放宽）。
 *
 * 部署形态侦察（CSP 收紧的依据，2026-09-08）：
 * 1. admin-web 是独立 Vite 构建产物，由 admin-web 容器内置 nginx 托管
 *   （apps/admin-web/Dockerfile → nginx:alpine），**与 admin-api 不同源**
 *   （compose 中 admin-web:80 / admin-api:3105 两个独立端口）；
 *   nginx.conf 已带基线 CSP 与 Referrer-Policy。admin-api 的响应头只
 *   覆盖 API 响应，浏览器页面 CSP 由 nginx 层负责——两层策略按各自
 *   资产形态独立维护（nginx CSP 含 script-src 'unsafe-inline'
 *   'unsafe-eval'，因 Vite 开发形态与 index.html 的主题预置内联脚本，
 *   该项属 admin-web 侧决策，本任务零触碰 admin-web）。
 * 2. admin-api 生产 Swagger 已关闭（main.ts ARCH-007：nodeEnv !==
 *   "production" 才 setup），生产响应无 HTML 文档、纯 JSON API——
 *   CSP 不会破坏任何页面资产，可以收紧到最严形态。
 * 3. SSE（执行日志流 /api/tasks/:id/executions/:execId/logs/stream 与
 *   /metrics/stream）是**同源 GET 连接**：CSP 的 connect-src 覆盖的是
 *   fetch/XHR/EventSource 的目标地址，EventSource 指向自身 origin 时
 *   `connect-src 'self'` 即放行，无需额外白名单。
 * 4. 生产响应均为 application/json；非生产（Swagger UI）时 CSP 关闭
 *   （现状保留），故 CSP 内不需要为 Swagger 的 CDN 资产留口。
 */

/** helmet 的 ContentSecurityPolicyOptions 类型过于嵌套，工厂返回结构化
 * 对象供 main.ts 直接展开进 helmet()，同时便于单测对指令逐条断言。
 * 返回类型对齐 helmet 的 HelmetOptions（ReferrerPolicyToken 等 union 类型），
 * 保证 main.ts 直传 helmet() 无需类型断言。 */
import type { HelmetOptions } from "helmet";

interface ProductionCspDirectives {
  [directive: string]: readonly string[];
}

/**
 * 生产 CSP 指令集（每条一行的理由见值后注释，helmet 4+/11+ 同构）。
 * helmet 会在序列化时自动补 default-src 的 fallback 语义。
 */
export const PRODUCTION_CSP_DIRECTIVES: ProductionCspDirectives = {
  // 一切未显式声明的资源类型回退到 'self' —— API 响应不加载任何子资源。
  "default-src": ["'self'"],
  // 生产无 HTML 页面（Swagger 已关），不存在脚本执行面；'unsafe-inline'
  // 不放行，杜绝任何注入的行内脚本在响应上下文中执行。
  "script-src": ["'self'"],
  // 不加载任何 object/embed/applet 嵌套内容（历史遗留攻击面，默认关死）。
  "object-src": ["'none'"],
  // 禁止 <frame>/<iframe> 嵌套本 API —— 点击劫持面为空，从源头拒绝。
  "frame-ancestors": ["'none'"],
  // 阻断 <base> 注入改写相对 URL（API 不产出 HTML，纵深防御零成本）。
  "base-uri": ["'self'"],
  // 表单提交不发生在纯 API 上，禁止以 FORM 动作外发（防被利用做跳板）。
  "form-action": ["'self'"],
  // 升级明文 http 子资源请求为 https（生产均在 TLS 前置反代之后）。
  "upgrade-insecure-requests": [],
};

/**
 * 生产 helmet 配置对象。
 * - contentSecurityPolicy: useDefaults=false + 显式指令集——不继承 helmet
 *   默认表，指令面完全由本文件裁定（可测、可审计）。
 * - hsts: maxAge 半年（15768000s）+ includeSubDomains。**不 preload**：
 *   进 preload 列表是全局不可回退承诺，域名回收/子域实验期会误伤，
 *   官方建议先跑满 maxAge 再评估，不在配置里替运维做决定。
 * - referrerPolicy: same-origin —— 完整 URL 仅在同源请求携带，跨域只发
 *   origin（对第三方 SSO/webhook 调试回源最小暴露）。
 * - crossOriginEmbedderPolicy 保持 false（与 main.ts 现状一致：COEP
 *   require-corp 会拒绝无 CORP 头的跨源子资源，API 无嵌入资产，无收益）。
 */
export function buildHelmetOptions(isProduction: boolean): HelmetOptions {
  if (isProduction) {
    return {
      contentSecurityPolicy: {
        useDefaults: false,
        directives: PRODUCTION_CSP_DIRECTIVES,
      },
      hsts: {
        maxAge: 15768000, // 半年 —— 浏览器在这段时间内强制 https 访问本 host
        includeSubDomains: true, // 子域一视同仁，防子域降级
        preload: false, // 不进 HSTS preload 名单（见上方理由）
      },
      referrerPolicy: { policy: "same-origin" },
      crossOriginEmbedderPolicy: false,
    };
  }
  // 非生产（开发/测试）：CSP 关闭（Swagger UI 内联脚本/CDN 资产可用），
  // 其余头保持 helmet 默认（HSTS 在 helmet 默认下仅 https 时有意义）。
  return {
    contentSecurityPolicy: false,
    hsts: false,
    referrerPolicy: { policy: "same-origin" },
    crossOriginEmbedderPolicy: false,
  };
}
