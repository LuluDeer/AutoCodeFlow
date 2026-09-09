import { timingSafeEqual } from "crypto";
import { UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SystemConfigService } from "../../modules/config/config.service";

/**
 * Resolve the shared executor token for verification and outbound requests.
 * Checks (in order):
 * 1. The DB-persisted shared token (key: executor.sharedToken) managed via the
 *    system-config API so it can be rotated without restarting the server.
 * 2. Falls back to the environment/config-file value (executor.sharedToken from
 *    ConfigService) for backward compatibility.
 * Returns null when neither is configured; verification below fails closed.
 */
export async function getExecutorSharedToken(
  configService: ConfigService,
  systemConfigService: SystemConfigService,
): Promise<string | null> {
  // 1. Try DB-stored token first
  let dbToken: string | null = null;
  try {
    const cfg = await systemConfigService.findOne("executor.sharedToken");
    dbToken = cfg?.value ?? null;
  } catch {
    // key not found in DB — fall through to env/config
  }

  const envToken = configService.get<string>("executor.sharedToken") ?? "";
  return dbToken ?? (envToken.length > 0 ? envToken : null);
}

export async function verifyExecutorToken(
  authHeader: string | undefined,
  configService: ConfigService,
  systemConfigService: SystemConfigService,
): Promise<void> {
  const effectiveToken = await getExecutorSharedToken(
    configService,
    systemConfigService,
  );

  if (!effectiveToken) {
    throw new UnauthorizedException(
      "Executor shared token is not configured; refusing unauthenticated executor access",
    );
  }

  const provided = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7)
    : authHeader;
  const providedBuf = Buffer.from(provided ?? "");
  const tokenBuf = Buffer.from(effectiveToken);
  if (
    !provided ||
    providedBuf.length !== tokenBuf.length ||
    !timingSafeEqual(providedBuf, tokenBuf)
  ) {
    throw new UnauthorizedException("Invalid executor token");
  }
}
