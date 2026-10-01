import { ExecutionContext, Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import { timingSafeEqual } from "node:crypto";
import { IS_PUBLIC_KEY } from "../../common/decorators/public.decorator";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";

/**
 * 全局 JwtAuthGuard（APP_GUARD）先于控制器守卫执行——/api/metrics 标记
 * @Public() 跳过全局守卫后，本守卫的 JWT 回落若复用基类的 isPublic 判定会被
 * 无条件放行（等于裸奔）。此 Reflector 屏蔽 IS_PUBLIC，使回落路径执行真实
 * JWT 校验。2026-10-01 chaos 实跑实证：全局守卫 401 先于控制器守卫，共享
 * 令牌路径从未生效（Prometheus 配好 credentials_file 仍 401）。
 */
class NonPublicReflector extends Reflector {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getAllAndOverride(metadataKey: any, targets: any): any {
    if (metadataKey === IS_PUBLIC_KEY) return undefined;
    return super.getAllAndOverride(metadataKey, targets);
  }
}

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
    // 保留注入位以兼容 DI/测试缝签名；基类改用屏蔽 IS_PUBLIC 的实例（见
    // NonPublicReflector），注入的 reflector 不再透传。
    _reflector: Reflector,
    // @Optional:极简装配(旧 guard-only 测试/手工 TestingModule)可能不提供
    // ConfigService——此时视为未配置令牌,走纯 JWT 路径(与改造前一致)。
    @Optional()
    configService: ConfigService | undefined,
    // 测试缝:注入 jwt 替身以断言分流(生产 DI 不提供,@Optional 保持可实例化)。
    @Optional()
    private readonly jwtDelegate?: JwtAuthGuard,
  ) {
    super(new NonPublicReflector());
    // 生产配置形状里该值嵌在 database 节下（configuration.ts database.metricsScraperToken）；
    // 顶层路径保留兼容平铺注册（旧测试缝/手工装配）。只读顶层会恒取不到 —— 抓取
    // 令牌路径永不生效（2026-10-01 chaos 实跑实证：配了 credentials_file 仍 401）。
    // process.env 兜底：chaos 实跑观测到 ConfigService 路径语义正确、env 在 PID1
    // environ 中、工厂产物含键，但守卫运行时仍取不到 —— 兜底保证抓取认证可用，
    // warn 用于暴露取值断点位置（勿删）。
    const raw =
      configService?.get<string>("database.metricsScraperToken") ??
      configService?.get<string>("metricsScraperToken") ??
      process.env.METRICS_SCRAPER_TOKEN;
    if (!configService) {
      this.logger.warn(
        "ConfigService unavailable in MetricsScraperAuthGuard — METRICS_SCRAPER_TOKEN read from process.env directly",
      );
    }
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
