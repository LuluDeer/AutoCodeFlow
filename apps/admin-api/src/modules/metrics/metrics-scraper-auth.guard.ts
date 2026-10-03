import {
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  Optional,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import { timingSafeEqual } from "node:crypto";
import { IS_PUBLIC_KEY } from "../../common/decorators/public.decorator";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { getEnvVar } from "../../config/env";

/**
 * 全局 JwtAuthGuard（APP_GUARD）先于控制器守卫执行——/api/metrics 标记
 * @Public() 跳过全局守卫后，本守卫的 JWT 回落若复用基类的 isPublic 判定会被
 * 无条件放行（等于裸奔）。此 Reflector 屏蔽 IS_PUBLIC，使回落路径执行真实
 * JWT 校验。2026-10-01 chaos 实跑实证：全局守卫 401 先于控制器守卫，共享
 * 令牌路径从未生效（Prometheus 配好 credentials_file 仍 401）。
 */
class NonPublicReflector extends Reflector {
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
 *   (timingSafeEqual,长度不等先短路)命中,且仅当请求是抓取端点本身
 *   (GET /api/metrics,Prometheus text exposition)时放行;其余 5 个端点
 *   (summary/trend/executors/failures/scheduler——含执行器内网地址与失败
 *   详情等业务读面)令牌不授予,回落 JWT 校验,失败仍 401——令牌错误不会
 *   比改造前更宽松(A-5:令牌是最小抓取凭据,非万能读凭据)。
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
    // @Inject 必须显式声明（2026-10-02 根因收口）：Nest reflectConstructorParams
    // 合并 self-declared deps 时用原型链敏感的 Reflect.getMetadata，会拾取基类
    // JwtAuthGuard 构造器 index[1] 的 @Inject(API_KEY_AUTH_FACADE) 覆写掉本类
    // index[1] 的类型推断 —— ConfigService 位被按 FACADE 字符串 token 解析失败，
    // @Optional 吞成 undefined（2026-10-01 chaos 实跑"注入为 undefined"的根因，
    // 主会话以 strict-clone 探针实证：Nest 报 "argument API_KEY_AUTH_FACADE at
    // index [1]"）。本类自己的 @Inject(ConfigService) 在原型链上更派生，覆盖回
    // 正确 token。Nest 侧上游问题（reflectOptionalParams 用 getOwnMetadata 而
    // self-deps 未做同样限定）待报 issue。
    @Optional()
    @Inject(ConfigService)
    configService: ConfigService | undefined,
    // 测试缝:注入 jwt 替身以断言分流(生产 DI 不提供,@Optional 保持可实例化)。
    @Optional()
    private readonly jwtDelegate?: JwtAuthGuard,
  ) {
    super(new NonPublicReflector());
    // 生产配置形状里该值嵌在 database 节下（configuration.ts database.metricsScraperToken）；
    // 顶层路径保留兼容平铺注册（旧测试缝/手工装配）。
    // process.env 兜底仅服务极简装配（旧 guard-only 测试/手工 TestingModule 无
    // ConfigModule）：@Optional 下 ConfigService 解析失败视为未配置令牌,走纯
    // JWT 路径(与改造前一致)；生产 DI 正常注入后 warn 不应出现——出现即说明
    // 装配面回归（如上游 Nest 行为变化），保留观测点。
    const raw =
      configService?.get<string>("database.metricsScraperToken") ??
      configService?.get<string>("metricsScraperToken") ??
      getEnvVar("METRICS_SCRAPER_TOKEN");
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
      method?: string;
      path?: string;
      originalUrl?: string;
    }>();
    const header = request.headers?.authorization;
    const bearer =
      typeof header === "string" && header.startsWith("Bearer ")
        ? header.slice("Bearer ".length)
        : undefined;
    if (bearer && this.safeEqual(bearer, this.scraperToken)) {
      // A-5（审计抓取面过宽）：令牌命中后只放行抓取端点本身（GET
      // /api/metrics）——其余端点（/metrics/failures 失败详情、
      // /metrics/executors 执行器内网地址等）不随令牌放行，回落 JWT：
      // 带合法 JWT 的用户不受影响，纯令牌调用方拿到 401。
      if (this.isScrapeEndpoint(request)) {
        return true;
      }
      this.logger.warn(
        "metrics scraper token used on a non-scrape endpoint — falling back to JWT auth",
      );
    } else if (bearer) {
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

  /**
   * A-5：令牌命中的放行范围判定——仅 GET <全局前缀>/metrics（抓取端点）。
   * 以「精确路径（含尾斜杠形态）」收口而非前缀匹配，避免把
   * /api/metrics/failures 一并放行；query 串不参与判定。path 缺失时
   * 以 originalUrl 兜底（剥掉 query）。
   */
  private isScrapeEndpoint(request: {
    method?: string;
    path?: string;
    originalUrl?: string;
  }): boolean {
    if ((request.method ?? "").toUpperCase() !== "GET") return false;
    const raw = (request.path ?? request.originalUrl ?? "").split("?")[0];
    return (
      raw === MetricsScraperAuthGuard.SCRAPER_PATH ||
      raw === `${MetricsScraperAuthGuard.SCRAPER_PATH}/`
    );
  }

  /** 抓取端点精确路径（main.ts setGlobalPrefix("api") + @Controller("metrics")） */
  private static readonly SCRAPER_PATH = "/api/metrics";

  /** 恒时比较:长度不等先短路(不泄漏长度差之外的任何信息)。 */
  private safeEqual(received: string, expected: string): boolean {
    const a = Buffer.from(received, "utf8");
    const b = Buffer.from(expected, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
