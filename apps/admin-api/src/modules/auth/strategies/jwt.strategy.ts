import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import type { Request } from "express";
import { UsersService } from "../../users/users.service";

export interface JwtPayload {
  sub: number;
  username: string;
  type?: string;
  /** SEC-03: session id — mirrors the refresh token jti this login issued. */
  sid?: string;
  /**
   * AUTH-01（多租户 Project，第一批）：可选项目上下文 claim。保守落地——
   * sign 侧 base payload 本批不加（auth.service.generateTokens 不带
   * projectId，签发行为零变化），claim 面先立契约：项目上下文后续经
   * X-Project-Id header 注入时由该字段承接。validate() 不消费、不校验。
   */
  projectId?: string;
  /**
   * WIKI-AUTH-REVOC: 会话版本快照——签发时刻 user.sessionVersion（logout /
   * 改密时原子 +1）。validate() 与库中当前值比对，不一致 = 令牌签发后该用户
   * 已 logout / 改密 → 401（"Session has been revoked"），在途访问令牌即时
   * 失效。无 ver 的存量旧令牌（本特性部署前签发）按「到期自然失效」兼容
   * 放行，不被新逻辑立即打死。
   */
  ver?: number;
}

/**
 * A5（DEEP_REVIEW §七 A5）：SSE 凭据从「长效 access token 入 URL」改为
 * **短效一次性 ticket**。
 *
 * 背景：EventSource API 不支持自定义请求头，浏览器原生 SSE 只能通过 URL 查询串
 * 传递凭据。此前三条 SSE 长连接直接把 **access token（15min TTL）** 放进
 * `?access_token=` —— 查询串会被 nginx access log、浏览器历史、Referer 记录，
 * 等于把一枚 15 分钟有效的全权令牌写进日志（P2 已知风险，两端注释均已记录）。
 *
 * 现在：前端先 `POST /auth/sse-ticket`（常规 Authorization 头）换一枚
 * **30s TTL、type=sse_ticket** 的专用票据，再 `?ticket=` 建流。泄漏面从
 * 「15 分钟全权访问令牌」降为「30 秒内、且只能开这三条流之一的专用票据」；
 * 且 `?access_token=` 通道**整体撤销**（不再接受），从结构上关掉旧泄漏面。
 *
 * 约束（由 extractJwtFromRequest + validate 两处共同强制）：
 *   - ticket 只在三条 SSE 路径后缀上被读取（其他路由一律只认 Authorization 头）；
 *   - ticket 的 type 必须是 `sse_ticket`，access/refresh 令牌不能借道；
 *   - ticket 仍然过 usersService 的「用户存在 + 未禁用 + 会话未撤销」三重校验。
 */
export const SSE_TICKET_PARAM = "ticket";

/** SSE 票据的存活时间（秒）。 */
export const SSE_TICKET_TTL_SECONDS = 30;

/** Path suffixes on which the `ticket` query parameter is accepted. */
// UI-14 第一阶段：/metrics/stream（Dashboard 汇总流）同款回退——EventSource
// 无法设置 Authorization 头，与 /logs/stream 共享先例。
// FEAT-16：/executions/stream（执行列表终态推送流）同款回退——消费端与
// /metrics/stream 同为 admin-web EventSource，鉴权形态保持一致。
export const SSE_TICKET_PATH_SUFFIXES = [
  "/logs/stream",
  "/metrics/stream",
  "/executions/stream",
];

export function extractJwtFromRequest(req: Request): string | null {
  const headerToken = req?.headers
    ? ExtractJwt.fromAuthHeaderAsBearerToken()(req)
    : null;
  if (headerToken) return headerToken;

  // A5: SSE ticket fallback — restricted to the SSE stream paths. Note that
  // the legacy `?access_token=` channel is intentionally GONE: accepting it
  // again would reintroduce a 15-minute full-privilege token in access logs.
  const url = (req as any)?.originalUrl ?? (req as any)?.url ?? "";
  const path = typeof url === "string" ? url.split("?")[0] : "";
  const isStreamPath = SSE_TICKET_PATH_SUFFIXES.some((suffix) =>
    path.endsWith(suffix),
  );
  if (!isStreamPath) return null;

  const queryToken = (req as any)?.query?.[SSE_TICKET_PARAM];
  // 数组形态（?ticket=a&ticket=b）一律拒绝——防 HTTP 参数污染。
  return typeof queryToken === "string" && queryToken.length > 0
    ? queryToken
    : null;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    private usersService: UsersService,
  ) {
    super({
      jwtFromRequest: extractJwtFromRequest,
      ignoreExpiration: false,
      secretOrKey: configService.get<string>("jwt.secret"),
    });
  }

  async validate(payload: JwtPayload) {
    // SEC-001: require an explicit type marker — tokens that omit `type` are
    // old-format or attacker-crafted and must be rejected. A5: `sse_ticket`
    // is the only other accepted type; it is only ever *read* on the three
    // SSE stream paths (see extractJwtFromRequest), so a ticket can never be
    // replayed against a normal REST route.
    if (payload.type !== "access" && payload.type !== "sse_ticket") {
      throw new UnauthorizedException("Invalid token type");
    }
    // R-04: findByIdOrNull — a token belonging to a deleted user must 401
    // ("User not found"), never 404 via findById (presence/id disclosure).
    // With the null-returning lookup the guard below is finally live code.
    const user = await this.usersService.findByIdOrNull(payload.sub);
    if (!user) throw new UnauthorizedException("User not found");
    // S1: reject disabled accounts even when their JWT is still valid
    if (!user.isActive) throw new UnauthorizedException("Account is disabled");
    // WIKI-AUTH-REVOC: 会话版本比对——payload.ver 是签发时刻快照，库中
    // sessionVersion 在 logout / 改密时原子 +1，不一致即「令牌签发后该用户
    // 的会话已被撤销」。存量旧令牌无 ver claim（undefined）→ 跳过比对，
    // 维持「到期自然失效」的兼容语义（部署前签发的令牌零破坏）。
    if (payload.ver !== undefined && payload.ver !== user.sessionVersion) {
      throw new UnauthorizedException("Session has been revoked");
    }
    return user;
  }
}
