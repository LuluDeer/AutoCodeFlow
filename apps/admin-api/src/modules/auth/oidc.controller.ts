import { Controller, Get, Query, Res } from "@nestjs/common";
import { Response } from "express";
import { Public } from "../../common/decorators/public.decorator";
import { OidcService, OIDC_STATE_COOKIE } from "./oidc.service";

/** callback 失败 → 前端落地页错误码（不泄露内部细节）。 */
function mapCallbackError(message: string): string {
  if (message.includes("state")) return "state_invalid";
  if (message.includes("nonce")) return "nonce_invalid";
  if (message.includes("signature")) return "signature_invalid";
  if (message.includes("not linked")) return "account_not_linked";
  if (message.includes("disabled")) return "account_disabled";
  return "sso_failed";
}

/**
 * AUTH-04: OIDC SSO 端点（全部 @Public——SSO 流程发生在认证之前；
 * JwtAuthGuard 为全局 APP_GUARD，本地登录端点同形态，无需类级守卫）。
 *
 * 契约（docs/api-reference.md「OIDC SSO」段）：
 * - GET /auth/oidc/status   → { enabled }（登录页据此决定是否出 SSO 按钮）
 * - GET /auth/oidc/login    → 302 IdP authorize + Set-Cookie state（HttpOnly）
 * - GET /auth/oidc/callback → 校验/换码/验签/建号后 302 回前端落地页，
 *   token 走 URL #fragment（不进服务器日志与代理访问日志）；任何失败一律
 *   302 到落地页并带 #error=<code>（浏览器上下文不裸 500，前端统一呈现）。
 *
 * audit 注记：SSO 登录成功经 AuthService 令牌通路自然落既有会话面；
 * IdP 侧拒绝（签名/nonce/账号未绑定）只记 warn 日志，不写审计——认证前的
 * 失败没有主体身份可归因（对齐 login 枚举防护态势）。
 */
@Controller("auth/oidc")
export class OidcController {
  constructor(private readonly oidc: OidcService) {}

  @Public()
  @Get("status")
  status(): { enabled: boolean } {
    return { enabled: this.oidc.enabled };
  }

  @Public()
  @Get("login")
  async login(@Res() res: Response): Promise<void> {
    if (!this.oidc.enabled) {
      res.status(404).json({ message: "OIDC SSO is not enabled" });
      return;
    }
    try {
      const { value } = this.oidc.createStateCookieValue();
      const redirectUrl = await this.oidc.buildAuthorizeUrl(value);
      res.setHeader(
        "set-cookie",
        // HttpOnly：JS 不可读；SameSite=Lax：IdP 顶层 GET 回调可携带；
        // Path 收窄到回调端点；10 分钟时效由 payload.exp + cookie MaxAge 双保险。
        `${OIDC_STATE_COOKIE}=${value}; Path=/api/auth/oidc/callback; HttpOnly; SameSite=Lax; Max-Age=600`,
      );
      res.redirect(302, redirectUrl);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn(`[OIDC] login failed: ${message}`);
      res.status(502).json({ message: "OIDC login failed" });
    }
  }

  @Public()
  @Get("callback")
  async callback(
    @Query("code") code: string | undefined,
    @Query("state") state: string | undefined,
    @Query("error") idpError: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    // 未挂 cookie-parser（main.ts 无 cookieParser），从 header 手工提取
    const rawCookie = res.req.headers.cookie ?? "";
    const cookieValue = rawCookie
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${OIDC_STATE_COOKIE}=`))
      ?.slice(OIDC_STATE_COOKIE.length + 1);
    const clearStateCookie = () => {
      res.setHeader("set-cookie", [
        `${OIDC_STATE_COOKIE}=; Path=/api/auth/oidc/callback; HttpOnly; SameSite=Lax; Max-Age=0`,
      ]);
    };
    const fail = (errorCode: string) => {
      clearStateCookie();
      res.redirect(
        302,
        `${this.oidc.getWebRedirectUrl()}#error=${encodeURIComponent(errorCode)}`,
      );
    };
    if (idpError) {
      fail(`idp_error:${idpError}`);
      return;
    }
    if (!code || !state || !cookieValue) {
      fail("missing_code_or_state");
      return;
    }
    try {
      const result = await this.oidc.completeLogin(code, cookieValue, {
        expectedState: state,
        userAgent: res.req.headers["user-agent"] ?? null,
        ip: res.req.ip ?? null,
      });
      clearStateCookie();
      const fragment = new URLSearchParams({
        access_token: result.accessToken,
        refresh_token: result.refreshToken,
        username: result.username,
      }).toString();
      res.redirect(302, `${this.oidc.getWebRedirectUrl()}#${fragment}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // 细节只进日志，浏览器侧仅收稳定错误码
      // eslint-disable-next-line no-console
      console.warn(`[OIDC] callback failed: ${message}`);
      fail(mapCallbackError(message));
    }
  }
}
