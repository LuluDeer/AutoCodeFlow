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
}

/**
 * P1-6 (contract): EventSource cannot set Authorization headers, so the
 * admin-web SSE log stream appends the JWT to the URL as `?access_token=`.
 * Query strings are logged by proxies and leak into referers, so a query
 * token is accepted ONLY on the execution log-stream route(s) and ONLY for
 * type=access tokens — every other route must keep using the bearer header.
 */
export const SSE_QUERY_TOKEN_PARAM = "access_token";

/** Path suffixes on which the `access_token` query parameter is accepted. */
const SSE_QUERY_TOKEN_PATH_SUFFIXES = ["/logs/stream"];

export function extractJwtFromRequest(req: Request): string | null {
  const headerToken = req?.headers
    ? ExtractJwt.fromAuthHeaderAsBearerToken()(req)
    : null;
  if (headerToken) return headerToken;

  // Query-token fallback: restricted to the SSE log-stream paths.
  const url = (req as any)?.originalUrl ?? (req as any)?.url ?? "";
  const path = typeof url === "string" ? url.split("?")[0] : "";
  const isStreamPath = SSE_QUERY_TOKEN_PATH_SUFFIXES.some((suffix) =>
    path.endsWith(suffix),
  );
  if (!isStreamPath) return null;

  const queryToken = (req as any)?.query?.[SSE_QUERY_TOKEN_PARAM];
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
    // SEC-001: require the 'access' type marker — tokens that omit `type`
    // are old-format or attacker-crafted and must be rejected. This also
    // guarantees a refresh token can never be smuggled in via ?access_token=.
    if (payload.type !== "access") {
      throw new UnauthorizedException("Invalid token type");
    }
    const user = await this.usersService.findById(payload.sub);
    if (!user) throw new UnauthorizedException("User not found");
    // S1: reject disabled accounts even when their JWT is still valid
    if (!user.isActive) throw new UnauthorizedException("Account is disabled");
    return user;
  }
}
