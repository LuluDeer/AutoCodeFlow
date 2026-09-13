import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { verifyExecutorToken } from "../../common/utils/verify-executor-token.util";
import { SystemConfigService } from "../config/config.service";

/**
 * WIKI-PKG-GUARD: dedicated shared-token guard for machine-to-machine
 * callback routes (executor-packages push-result).
 *
 * Previously the push-result handler inlined `verifyExecutorToken(...)`
 * (wiki page-29 extensibility note: "push-result 为独立的机器回调入口，后续
 * 可替换为专用的共享令牌守卫"). This guard moves that check into the Nest
 * guard pipeline without forking the verification logic: it delegates to the
 * very same `verify-executor-token.util`, so the acceptance semantics and the
 * thrown `UnauthorizedException` responses (message payloads included) are
 * byte-for-byte identical to the inline call it replaces.
 *
 * Wiring contract (do not drift):
 * - the route keeps `@Public()` and an empty `@Roles()` so JwtAuthGuard and
 *   RolesGuard behave exactly as before (machine callers carry no req.user);
 * - the DOWNLOAD endpoint's dual-credential logic (shared token OR admin
 *   access JWT) is intentionally NOT covered by this guard and stays inline
 *   in the controller.
 */
@Injectable()
export class ExecutorSharedTokenGuard implements CanActivate {
  constructor(
    private readonly configService: ConfigService,
    private readonly systemConfigService: SystemConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{ headers?: {} }>();
    // Express lowercases header keys, so this is the same value the handler's
    // former `@Headers("authorization")` parameter received.
    const authorization = request.headers?.["authorization"] as
      | string
      | undefined;
    // Delegates entirely to the shared util: whatever it throws (401 with its
    // exact message) propagates unchanged; success means the token matched.
    await verifyExecutorToken(
      authorization,
      this.configService,
      this.systemConfigService,
    );
    return true;
  }
}
