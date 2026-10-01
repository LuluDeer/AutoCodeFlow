import { ExecutionContext, Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import { timingSafeEqual } from "node:crypto";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";

/**
 * D 线可观测性（2026-10-01）：Prometheus 抓取端点的专用守卫。
 *
 * ## 要解决的问题
 * /api/metrics 原为类级 JwtAuthGuard——Prometheus 的抓取请求不带用户 JWT,
 * 监控栈一开就会被 401(alerts.yml 的 AUTOFLOW_METRICS_TARGET_DOWN 会立刻
 * 触发)。JWT 短期有效也不适合写进抓取配置。
 *
 * ## 方案:可选共享令牌(METRICS_SCRAPER_TOKEN)
 * - **未设置(默认)**:行为与改造前完全一致——走 JWT,抓取方自行解决认证
 *   (反向代理注入等,见 docs/observability README §1)。
 * - **设置后**:`Authorization: Bearer <METRICS_SCRAPER_TOKEN>` 恒时比较
 *   (timingSafeEqual,长度不等先短路)命中即放行;未命中回落 JWT 校验,
 *   失败仍 401——令牌错误不会比改造前更宽松。
 * - 部署形态:prometheus.yml 的 admin-api job 用 `authorization:
 *   credentials_file` 指向同值文件(建议以 secret/挂载文件提供,不进镜像层);
 *   .env.example 有示例。
 */
@Injectable()
export class MetricsScraperAuthGuard extends JwtAuthGuard {
  private readonly logger = new Logger(MetricsScraperAuthGuard.name);
  private readonly scraperToken: string | undefined;

  constructor(
    reflector: Reflector,
    // @Optional:极简装配(旧 guard-only 测试/手工 TestingModule)可能不提供
    // ConfigService——此时视为未配置令牌,走纯 JWT 路径(与改造前一致)。
    @Optional()
    configService: ConfigService | undefined,
    // 测试缝:注入 jwt 替身以断言分流(生产 DI 不提供,@Optional 保持可实例化)。
    @Optional()
    private readonly jwtDelegate?: JwtAuthGuard,
  ) {
    super(reflector);
    const raw = configService?.get<string>("metricsScraperToken");
    this.scraperToken = raw && raw.trim() ? raw.trim() : undefined;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.scraperToken) {
      // 测试缝优先:注入了 jwt 替身走替身;生产 DI 不提供 → super(真 JWT)。
      if (this.jwtDelegate) {
        return Boolean(await this.jwtDelegate.canActivate(context));
      }
      return Boolean(await super.canActivate(context));
    }
    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
    }>();
    const header = request.headers?.authorization;
    const bearer =
      typeof header === "string" && header.startsWith("Bearer ")
        ? header.slice("Bearer ".length)
        : undefined;
    if (bearer && this.safeEqual(bearer, this.scraperToken)) {
      return true;
    }
    if (bearer) {
      // 带了 Bearer 但不匹配:可能是令牌轮换失配——warn 一条便于对账,
      // 随后回落 JWT(可能是合法用户在浏览器里直接打开端点)。
      this.logger.warn(
        "metrics scraper token mismatch — falling back to JWT auth",
      );
    }
    if (this.jwtDelegate) {
      return Boolean(await this.jwtDelegate.canActivate(context));
    }
    return Boolean(await super.canActivate(context));
  }

  /** 恒时比较:长度不等先短路(不泄漏长度差之外的任何信息)。 */
  private safeEqual(received: string, expected: string): boolean {
    const a = Buffer.from(received, "utf8");
    const b = Buffer.from(expected, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
