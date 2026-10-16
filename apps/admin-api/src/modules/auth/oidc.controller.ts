import { Controller, Get, Query, Res, Logger } from "@nestjs/common";
import { ApiOkResponse } from "@nestjs/swagger";
import { Response } from "express";
import { Public } from "../../common/decorators/public.decorator";
// LANG-ERR-01：按稳定错误码分派落地页错误标识（见 mapCallbackError 头注）。
import { AppError } from "../../common/errors/app-error";
import { OidcService, OIDC_STATE_COOKIE } from "./oidc.service";
import { getEnvVar } from "../../config/env";
import { OidcStatusResponseDto } from "./dto/misc-response.dto";

/**
 * callback 失败 → 前端落地页错误码（不泄露内部细节）。
 *
 * LANG-ERR-01（后端错误码化）配套：判据已从「匹配自由文案」升级为
 * **优先按 `AppError.errorCode` 分派**。
 *
 * ## 为什么必须优先走 errorCode（这是本轮改造的要点）
 *
 * 首版按 `message.includes("state"|"nonce"|…)` 匹配**英文关键词**，于是
 * `oidc.service.ts` 的那些消息一旦中文化（本轮已全部中文化并改为错误码），
 * 就会全部静默退化成 `sso_failed` —— 用户在 SSO 落地页看到「登录失败」而
 * 不知到底是 state 过期、nonce 不匹配还是账号被禁用，运维也无从定向排查。
 * 中途补过一版「中英关键词并列」，但那是**权宜**：它把「文案」当协议，任何
 * 一次文案微调（改标点、调语序、加前缀）都会再次静默打破映射，而破坏是
 * **无声**的（只降级成 sso_failed，不报错、测试也未必覆盖）。
 *
 * `errorCode` 是**稳定标识符**而非文案：`oidc.service.ts` 现在抛的是
 * `AppError("OIDC_STATE_INVALID")` 这类码，此处直接按码查表映射。文案怎么改
 * 都不影响，且新增码时 TypeScript 的 `Record` 形状会在编译期提示补映射。
 *
 * ## 为什么保留文本回退（不是冗余，是滚动升级的安全网）
 *
 * 两侧**独立发版**：滚动升级期间，旧副本仍会抛出英文/中文自由文案
 * （它们还不知道 `AppError`）。去掉文本支会让这些请求退化为 `sso_failed`。
 * 故 `errorCode` 优先、文本并列兜底是唯一安全口径（与
 * `INTERPRETER_UNAVAILABLE_PATTERN` 及 `task.processor` 的失败分类链同款裁决）。
 */

/**
 * `oidc.service.ts` 的错误码 → 落地页错误标识。
 *
 * 值为 `null` 表示该码**有意**不给出更细的落地页原因（仍回落 `sso_failed`）。
 * 形状是 `Record<...>` 而非散落的 if 链：新增码时改文案不影响映射，且漏写
 * 映射的码会因 `satisfies` 在编译期暴露（而不是运行时静默变 sso_failed）。
 */
const OIDC_CODE_TO_PAGE_ERROR = {
  OIDC_STATE_INVALID: "state_invalid",
  OIDC_STATE_MISMATCH: "state_invalid",
  OIDC_NONCE_INVALID: "nonce_invalid",
  OIDC_SIGNATURE_INVALID: "signature_invalid",
  OIDC_KID_NOT_FOUND: "signature_invalid",
  OIDC_ALG_UNSUPPORTED: "signature_invalid",
  OIDC_ACCOUNT_NOT_LINKED: "account_not_linked",
  OIDC_ACCOUNT_DISABLED: "account_disabled",
} as const satisfies Record<string, string>;

function mapCallbackError(err: unknown): string {
  // ① 首选：稳定错误码（AppError 是本轮之后唯一的用户面抛出形态）。
  if (err instanceof AppError) {
    const mapped =
      OIDC_CODE_TO_PAGE_ERROR[
        err.errorCode as keyof typeof OIDC_CODE_TO_PAGE_ERROR
      ];
    if (mapped) return mapped;
  }
  // ② 兼容：旧副本/非 AppError 路径仍可能带显式站内码前缀
  //    （历史上文案写作 `… [oidc_state_invalid]`）。
  const message = err instanceof Error ? err.message : String(err);
  const coded = /\[oidc_([a-z_]+)\]/.exec(message);
  if (coded) return coded[1];
  // ③ 兜底：中英关键词并列（滚动升级期间的旧英文文案 + 已中文化文案）。
  if (message.includes("state") || message.includes("状态"))
    return "state_invalid";
  if (message.includes("nonce")) return "nonce_invalid";
  if (message.includes("signature") || message.includes("签名"))
    return "signature_invalid";
  if (message.includes("not linked") || message.includes("未绑定"))
    return "account_not_linked";
  if (message.includes("disabled") || message.includes("已禁用"))
    return "account_disabled";
  return "sso_failed";
}

/** W-6: 生产环境附 Secure，开发态 http://localhost 不设（浏览器会丢弃）。 */
function stateCookieFlags(): string {
  return getEnvVar("NODE_ENV") === "production"
    ? "HttpOnly; SameSite=Lax; Secure"
    : "HttpOnly; SameSite=Lax";
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
  // R-23（DEEP_REVIEW 0ef3bbe）: 改用 Nest Logger 收口——原 console.warn 游离于
  // 本仓 ARCH-27 日志纪律之外，丢失 trace-id 上下文且不进统一日志管道。
  private readonly logger = new Logger(OidcController.name);

  constructor(private readonly oidc: OidcService) {}

  @Public()
  @Get("status")
  @ApiOkResponse({ type: OidcStatusResponseDto })
  status(): { enabled: boolean } {
    return { enabled: this.oidc.enabled };
  }

  @Public()
  @Get("login")
  @ApiOkResponse({
    description: "302 重定向到 IdP 授权 URL（Res 直传）",
    schema: { type: "string" },
  })
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
        // W-6: 生产环境附 Secure（与 F-06 refresh cookie 同模式）。
        `${OIDC_STATE_COOKIE}=${value}; Path=/api/auth/oidc/callback; ${stateCookieFlags()}; Max-Age=600`,
      );
      res.redirect(302, redirectUrl);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // R-23: Nest Logger 收口（原 console.warn）
      this.logger.warn(`[OIDC] login failed: ${message}`);
      res.status(502).json({ message: "OIDC login failed" });
    }
  }

  @Public()
  @Get("callback")
  @ApiOkResponse({
    description: "302 重定向并写入会话 Cookie；失败时返回 502 JSON（Res 直传）",
    schema: { type: "string" },
  })
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
        `${OIDC_STATE_COOKIE}=; Path=/api/auth/oidc/callback; ${stateCookieFlags()}; Max-Age=0`,
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
      // R-23: Nest Logger 收口（原 console.warn）
      this.logger.warn(`[OIDC] callback failed: ${message}`);
      fail(mapCallbackError(err));
    }
  }
}
