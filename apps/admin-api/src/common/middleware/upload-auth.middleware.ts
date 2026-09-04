import { Logger } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import * as jwt from "jsonwebtoken";
import { ConfigService } from "@nestjs/config";
import { SystemConfigService } from "../../modules/config/config.service";
import { verifyExecutorToken } from "../utils/verify-executor-token.util";

/**
 * ARCH-002: /uploads 静态文件认证中间件。
 *
 * 背景：上传的应用包（uploads/packages/*.zip）之前通过 express.static 完全公开服务，
 * 任何知道文件名的人都可以下载（内容含敏感代码/配置）。此中间件在 express.static 之前
 * 对 /uploads 生效，要求以下任一凭证：
 *
 * 1. 管理台用户 JWT（Authorization: Bearer <accessToken>）—— 与 JwtStrategy 同源密钥
 *    （jwt.secret），并同样要求 payload.type === "access"（SEC-001）。注意：静态文件
 *    中间件不做 DB 查询（不校验用户是否仍存在/启用），吊销依赖 access token 的短过期
 *    时间（默认 15m），这是为避免每次文件请求都查库的取舍。
 * 2. executor shared token（Authorization: Bearer <EXECUTOR_SECRET 或系统配置中的
 *    executor.sharedToken>）—— 复用 verifyExecutorToken 单点校验，供 executor-node
 *    按 packageUrl 下载应用包时使用。
 *
 * 公开子路径白名单（PUBLIC_UPLOAD_PREFIXES）：若未来出现必须匿名下载的文件
 * （例如 webhook 回执等公开交付物），将前缀加入该常量即可；当前为空 ——
 * /uploads 下没有确认的无认证消费方，默认全部要求认证（fail closed）。
 */
export const PUBLIC_UPLOAD_PREFIXES: readonly string[] = [];

/** 判断请求路径（相对于 /uploads 挂载点）是否命中公开前缀白名单 */
export function isPublicUploadPath(
  requestPath: string,
  prefixes: readonly string[] = PUBLIC_UPLOAD_PREFIXES,
): boolean {
  const normalized = requestPath.replace(/^\/+/, "");
  return prefixes.some((prefix) => {
    const p = prefix.replace(/^\/+/, "").replace(/\/+$/, "");
    return normalized === p || normalized.startsWith(`${p}/`);
  });
}

export function createUploadAuthMiddleware(
  configService: ConfigService,
  systemConfigService: SystemConfigService,
  publicPrefixes: readonly string[] = PUBLIC_UPLOAD_PREFIXES,
) {
  const logger = new Logger("UploadAuth");

  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    // express.static 之前挂载，req.path 为相对挂载点（/uploads）的路径
    if (isPublicUploadPath(req.path ?? "", publicPrefixes)) {
      next();
      return;
    }

    const authHeader = req.headers.authorization;

    // 1) 尝试管理台用户 JWT（与 JwtStrategy 同密钥、同 type=access 约束）
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice("Bearer ".length);
      const secret = configService.get<string>("jwt.secret");
      try {
        const payload = jwt.verify(token, secret, {
          ignoreExpiration: false,
        }) as { type?: string } | string;
        if (typeof payload === "object" && payload.type === "access") {
          next();
          return;
        }
        // type 缺失/非 access（旧格式或 refresh token）→ 拒绝，与 JwtStrategy 对齐
      } catch {
        // 无效/过期 JWT → 继续尝试 executor shared token
      }
    }

    // 2) 尝试 executor shared token（机器对机器下载）
    try {
      await verifyExecutorToken(authHeader, configService, systemConfigService);
      next();
      return;
    } catch {
      // 落到 401
    }

    logger.warn(`Unauthorized /uploads access: ${req.method} ${req.path}`);
    res.status(401).json({
      statusCode: 401,
      message: "Unauthorized: uploads require a valid JWT or executor token",
      timestamp: new Date().toISOString(),
      path: req.originalUrl,
    });
  };
}
