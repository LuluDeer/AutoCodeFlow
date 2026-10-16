import { timingSafeEqual } from "crypto";
import { ConfigService } from "@nestjs/config";
import { SystemConfigService } from "../../modules/config/config.service";
// LANG-ERR-01：执行器面的 401 也走稳定码（前端/CLI 按用户语言渲染）。
// 这两条文案是**执行器与运维**看的，不是浏览器界面——但仍走码表，理由有二：
//   ① 同一条错误在别处（`executor.controller` 等）也出现过，共用码可避免同一
//      失败在不同端点有不同措辞；
//   ② 运维用 admin-web 的 API Key / 执行器管理页排查时，看到的是前端渲染结果——
//      码化之后它跟随界面语言，而硬编码中文永远跟不上。
import { AppError } from "../errors/app-error";

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
    throw new AppError("EXECUTOR_SHARED_TOKEN_UNCONFIGURED");
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
    // 复用既有码：文案与旧实现逐字一致（「执行器令牌无效」/ "Invalid executor token"），
    // 故 executor.controller 等处的既有用例与断言不受影响。
    throw new AppError("INVALID_EXECUTOR_TOKEN");
  }
}
