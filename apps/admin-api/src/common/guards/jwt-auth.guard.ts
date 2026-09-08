import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuthGuard } from "@nestjs/passport";
import { IS_PUBLIC_KEY } from "../decorators/public.decorator";
import { isApiKeyUser } from "../interfaces/auth-user.interface";

/**
 * AUTH-03: bearer credentials with this prefix are dispatched to the API-Key
 * validation branch instead of passport-jwt. Every platform key starts with
 * `acf_`; JWTs are base64 segments and can never start with this prefix.
 */
export const API_KEY_PREFIX = "acf_";

/**
 * AUTH-03: DI token for the API-Key branch implementation (provided by
 * ApiKeysModule, exported into app.module's injector where the global
 * APP_GUARD is registered).
 */
export const API_KEY_AUTH_FACADE = "API_KEY_AUTH_FACADE";

/**
 * AUTH-03: JWT-only surfaces. A request authenticated with an API Key is
 * refused on these path prefixes regardless of scope — a leaked key must
 * never be able to manage credentials (including its own) or touch the
 * account/session layer. Matched against the request path AFTER stripping
 * the global `api` prefix (and query string).
 */
export const JWT_ONLY_API_KEY_PATHS: readonly string[] = [
  "api-keys",
  "auth",
  "users",
];

/** Extract the raw bearer credential from the Authorization header. */
export function extractBearerCredential(
  req: Record<string, any>,
): string | null {
  const header = req?.headers?.["authorization"];
  if (typeof header !== "string") return null;
  const [scheme, token] = header.split(" ");
  if (!scheme || scheme.toLowerCase() !== "bearer" || !token) return null;
  return token.trim();
}

/**
 * AUTH-03: normalize a request path for scope/exclusion matching — strips
 * the global `api` prefix (with or without a leading slash) and the query
 * string, so guards are independent of mount/prefix details.
 */
export function normalizeApiPath(req: Record<string, any>): string {
  const raw: string = req?.path ?? req?.url ?? "";
  const noQuery = raw.split("?")[0];
  return noQuery.replace(/^\//, "").replace(/^api\//, "");
}

/** True when the normalized path lands on a JWT-only surface. */
export function isJwtOnlyPath(normalizedPath: string): boolean {
  return JWT_ONLY_API_KEY_PATHS.some(
    (p) => normalizedPath === p || normalizedPath.startsWith(`${p}/`),
  );
}

/**
 * A-03 global auth guard (JWT), extended by AUTH-03 with an API-Key branch:
 *
 * - @Public() routes pass untouched (callbacks / machine endpoints keep
 *   their existing auth — execution callback tokens, executor tokens, HMAC
 *   webhooks — and never reach either credential branch).
 * - `Authorization: Bearer acf_...` → API-Key validation
 *   (sha256 lookup + expiry/revocation + scope enforcement, req.user =
 *   { type:'apiKey', userId, scope, ... }).
 * - anything else → the original passport-jwt flow, unchanged
 *   (SSE ?access_token= query fallback included via the strategy extractor).
 *
 * The API-Key branch logic is injected as `apiKeyAuth` (provided by
 * ApiKeysModule) so this guard keeps zero TypeORM/direct-repo coupling and
 * existing guard-only test assemblies stay green (optional parameter).
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard("jwt") {
  constructor(
    private reflector: Reflector,
    // AUTH-03: optional — absent in legacy guard unit tests / passport-only paths.
    @Optional()
    @Inject(API_KEY_AUTH_FACADE)
    private apiKeyAuth?: ApiKeyAuthFacade,
  ) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest();
    const credential = extractBearerCredential(req);
    if (
      credential &&
      credential.startsWith(API_KEY_PREFIX) &&
      this.apiKeyAuth
    ) {
      return this.apiKeyAuth.authenticate(context, credential);
    }
    return (await super.canActivate(context)) as boolean;
  }

  handleRequest(err: any, user: any) {
    if (err || !user) {
      throw err || new UnauthorizedException("Invalid or expired token");
    }
    return user;
  }
}

/**
 * AUTH-03: decoupled API-Key authentication + scope enforcement contract.
 * Implemented in api-key-auth.helper.ts (ApiKeysModule provider).
 */
export interface ApiKeyAuthFacade {
  authenticate(context: ExecutionContext, credential: string): Promise<boolean>;
}

/** Shared 403 builder — denial message carries the current scope. */
export function apiKeyScopeDenied(reason: string): ForbiddenException {
  return new ForbiddenException(reason);
}

export { isApiKeyUser };
