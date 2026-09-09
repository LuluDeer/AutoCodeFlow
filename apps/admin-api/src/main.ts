import { NestFactory, Reflector } from "@nestjs/core";
import {
  ClassSerializerInterceptor,
  INestApplication,
  Logger,
  ValidationPipe,
} from "@nestjs/common";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import { ConfigService } from "@nestjs/config";
import helmet from "helmet";
import * as express from "express";
import * as path from "path";
// W-22 (windows-findings): some values are read at DECORATOR-EVAL time —
// notably auth.controller's @Throttle limit from process.env.LOGIN_THROTTLE_LIMIT
// (N16 documents it as env-configurable) — which runs when app.module is first
// imported, i.e. BEFORE ConfigModule's lifecycle applies the `.env` file.
// Load the env file here, before app.module enters the graph, so `.env` and a
// real process environment behave the same. (Import hoisting requires the
// module import below to be dynamic.)
import { config as loadEnvFile } from "dotenv";
loadEnvFile({ path: path.resolve(__dirname, "..", ".env") });
const importAppModule = async () => (await import("./app.module")).AppModule;
import { HttpExceptionFilter } from "./common/filters/http-exception.filter";
import { ResponseInterceptor } from "./common/interceptors/response.interceptor";
import { TimeoutInterceptor } from "./common/interceptors/timeout.interceptor";
import { isOriginAllowed } from "./common/utils/cors-origin.util";
import { installShutdownForceExitGuard } from "./common/utils/shutdown-guard.util";
import { buildHelmetOptions } from "./common/utils/security-headers.util";
import { createUploadAuthMiddleware } from "./common/middleware/upload-auth.middleware";
import { SystemConfigService } from "./modules/config/config.service";
// import { TraceMiddleware } from "./common/middleware/trace.middleware";

// OPS-06 / ARCH-008: graceful-shutdown state shared with the process-level
// unhandledRejection handler below — bootstrap() assigns it once the app exists.
let runningApp: INestApplication | null = null;
let shuttingDown = false;

/**
 * OPS-06 / ARCH-008: attempt a graceful shutdown instead of an abrupt
 * process.exit — lets enableShutdownHooks() drain in-flight requests, close
 * DB pools and flush Bull jobs. A hard 10 s timer guarantees the process still
 * exits non-zero (so the container orchestrator restarts it) if cleanup hangs.
 */
async function gracefulFatalShutdown(reason: unknown): Promise<void> {
  console.error("[FATAL]", reason);
  if (shuttingDown) return; // 递归信号（close 期间的 rejection）不重复触发
  shuttingDown = true;
  const forceExit = setTimeout(() => {
    console.error(
      "[FATAL] Graceful shutdown timed out after 10s — forcing exit(1)",
    );
    process.exit(1);
  }, 10_000);
  forceExit.unref();
  try {
    await runningApp?.close();
  } catch (closeErr) {
    console.error("[FATAL] Error during graceful shutdown:", closeErr);
  }
  process.exit(1);
}

async function bootstrap() {
  // SEC-02 / ARCH-001 / ARCH-27: production CORS 白名单校验（显式配置、
  // 禁 localhost、合法 http(s) URL）已统一收编到 configuration.ts 的
  // fail-fast 块 —— 在 ConfigModule 初始化（NestFactory.create 内）抛出，
  // 仍早于 app.listen，bootstrap().catch 会以非零码退出。此处不再直读
  // process.env 重复实现同一校验。

  // W-22: dynamic require so app.module (and its controllers' @Throttle
  // decorators reading process.env at class-definition time) evaluates AFTER
  // loadEnvFile() above has populated process.env from `.env`.
  const app = await NestFactory.create(await importAppModule());
  // OPS-06 / ARCH-008: expose the app instance to the fatal-signal handlers
  // below so they can trigger a graceful close instead of an abrupt exit.
  runningApp = app;

  // ARCH-27: 配置统一经 ConfigService 读取 —— 以下 bootstrap 逻辑
  // （helmet/trust-proxy/CORS/swagger/port）全部改用 configuration.ts
  // 注册的配置节，不再直读 process.env。
  const configService = app.get(ConfigService);

  // P2: the execution callback batch legitimately exceeds the 1 MB global
  // cap (100 items × up to 512 KB of logs each) — parse that route with a
  // dedicated larger limit first; body-parser skips already-parsed bodies.
  app.use(
    "/api/executions/callback",
    express.json({
      limit: "55mb",
      verify: (req: express.Request & { rawBody?: Buffer }, _res, buf) => {
        req.rawBody = Buffer.from(buf);
      },
    }),
  );

  // S-11: cap JSON body size to 1 MB to prevent oversized-payload DoS
  app.use(
    express.json({
      limit: "1mb",
      verify: (req: express.Request & { rawBody?: Buffer }, _res, buf) => {
        req.rawBody = Buffer.from(buf);
      },
    }),
  );
  app.use(express.urlencoded({ limit: "1mb", extended: true }));

  // SEC-08: security headers via helmet — production CSP explicitly tightened
  // (per-directive rationale in security-headers.util.ts), dev keeps CSP off
  // for Swagger UI inline scripts. Deployment-shape basis (surveyed 2026-09-08):
  // admin-web is a separate nginx-hosted Vite artifact (different origin from
  // this API), production Swagger is disabled (ARCH-007 below), SSE streams are
  // same-origin so `connect-src 'self'` covers them — a strict API-side CSP
  // breaks nothing. HSTS/Referrer-Policy are pinned explicitly for production.
  const isProductionEnv =
    configService.get<string>("app.nodeEnv") === "production";
  app.use(helmet(buildHelmetOptions(isProductionEnv)));

  // F-6: trust proxy is OPT-IN. Unconditional `trust proxy = 1` made req.ip
  // (throttler tracker, audit IP) follow the client-supplied X-Forwarded-For
  // chain when admin-api is reached directly, letting an attacker rotate the
  // rate-limit key per request. Enable TRUST_PROXY=true only when a trusted
  // reverse proxy (nginx / load balancer) actually fronts this instance and
  // overwrites XFF.
  if (configService.get<boolean>("app.trustProxy")) {
    app.getHttpAdapter().getInstance().set("trust proxy", 1);
  }

  // S10 / ARCH-001: CORS — explicit whitelist only via CORS_ALLOWED_ORIGINS
  // (falls back to legacy CORS_ORIGINS). The old isLanOrigin() auto-allow for
  // private/LAN networks (localhost / 10.x / 192.168.x / 172.16-31.x) was
  // removed: any host on a shared network could previously issue cross-site
  // requests. LAN deployments must now list their origins explicitly.
  // When no whitelist is configured, development defaults to http://localhost:*
  // and http://127.0.0.1:* only (see isOriginAllowed).
  // '*' + credentials is rejected by browsers so we use a callback instead.
  // ARCH-27: 白名单取自 configuration.ts cors.allowedOrigins（同一份
  // fail-fast 校验结果），生产 URL 合法性校验也在配置层完成。
  const allowedOrigins = configService.get<string[]>("cors.allowedOrigins");
  const isDevelopment =
    configService.get<string>("app.nodeEnv") !== "production";

  app.enableCors({
    origin: (origin, callback) => {
      // Allow server-to-server calls (no Origin header)
      if (!origin) {
        callback(null, true);
        return;
      }
      if (isOriginAllowed(origin, allowedOrigins, isDevelopment)) {
        callback(null, true);
      } else {
        callback(new Error(`Origin ${origin} not allowed by CORS`));
      }
    },
    methods: "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS",
    credentials: true,
  });

  // OPS-03: Cross-service request tracing middleware is configured in AppModule

  // ARCH-002: Serve uploaded packages as static files — behind authentication.
  // Previously /uploads was fully public: anyone knowing the filename could
  // download application packages (potentially sensitive code/config).
  // Now every request must present either:
  //  - an admin user JWT (same jwt.secret / type=access rules as JwtStrategy), or
  //  - the executor shared token (verifyExecutorToken), so executor-node can
  //    still fetch `packageUrl` machine-to-machine.
  // Public download whitelist: PUBLIC_UPLOAD_PREFIXES in
  // common/middleware/upload-auth.middleware.ts is intentionally EMPTY today —
  // no consumer of /uploads is anonymous by design. If a genuinely public
  // sub-path is needed later (e.g. webhook-delivered receipts), add its prefix
  // there rather than re-opening the whole directory.
  const uploadsPath = path.join(process.cwd(), "uploads");
  app.use(
    "/uploads",
    createUploadAuthMiddleware(
      app.get(ConfigService),
      app.get(SystemConfigService),
    ),
    express.static(uploadsPath),
  );

  // Global prefix
  app.setGlobalPrefix("api");

  // Global pipes
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      // N13: reject requests that contain extra fields not declared in the DTO
      // so callers get a 400 instead of silent field stripping
      forbidNonWhitelisted: true,
    }),
  );

  // Global filters
  app.useGlobalFilters(new HttpExceptionFilter());

  // Global interceptors
  // ClassSerializerInterceptor must come before ResponseInterceptor so that
  // @Exclude() fields are stripped before the response wrapper runs.
  // ARCH-27: TimeoutInterceptor reads app.requestTimeoutMs via ConfigService
  // (no more module-load-time process.env read).
  app.useGlobalInterceptors(
    new TimeoutInterceptor(app.get(Reflector), app.get(ConfigService)),
    new ClassSerializerInterceptor(app.get(Reflector)),
    new ResponseInterceptor(),
  );

  // ARCH-007: production environments skip building
  // the OpenAPI document entirely (saves startup work, and hardcoded server
  // URLs can never leak via logs/debug output of the doc object).
  if (configService.get<string>("app.nodeEnv") !== "production") {
    const config = new DocumentBuilder()
      .setTitle("AutoFlow Admin API")
      .setDescription(
        `
## AutoFlow Admin API Documentation

AutoFlow is a modern workflow automation platform providing task orchestration, execution management, and monitoring.

### Authentication

- **JWT Token**: Bearer Token authentication
- **Obtain token**: via \`POST /api/auth/login\`
- **Token format**: \`Bearer <token>\`

### API Structure

| Module | Path prefix | Description |
|--------|-------------|-------------|
| Auth | /api/auth | Login, logout, token refresh |
| Users | /api/users | User management |
| Tasks | /api/tasks | Task management, triggering, execution |
| Executors | /api/executors | Executor management, config, monitoring |
| Notification | /api/notification | Notification channel config |
| Config | /api/config | System configuration |
| Audit | /api/audit | Audit logs |
| Metrics | /api/metrics | Performance metrics |
| Health | /api/health | Health checks |

### Error Response Format

\`\`\`json
{
  "statusCode": 400,
  "message": "Error description",
  "error": "Bad Request",
  "timestamp": "2024-01-01T12:00:00Z",
  "path": "/api/tasks"
}
\`\`\`

### Success Response Format

\`\`\`json
{
  "code": 200,
  "message": "success",
  "data": {}
}
\`\`\`

### Paginated Response Format

\`\`\`json
{
  "code": 200,
  "message": "success",
  "data": {
    "items": [],
    "total": 100,
    "page": 1,
    "limit": 20
  }
}
\`\`\`

### Notes

1. All endpoints require authentication unless explicitly marked as public
2. Request parameters must conform to DTO definitions
3. Sensitive fields (passwords, secrets) are redacted in responses
4. Swagger docs are not exposed in production
    `,
      )
      .setVersion("1.0.0")
      .setContact(
        "AutoFlow Team",
        "https://github.com/autocodeflow",
        "support@autocodeflow.io",
      )
      .setLicense(
        "MIT License",
        "https://github.com/autocodeflow/autocodeflow/blob/main/LICENSE",
      )
      .addBearerAuth(
        { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        "JWT",
      )
      .addSecurityRequirements("JWT")
      .addServer("http://localhost:3105", "Local development")
      .build();

    const document = SwaggerModule.createDocument(app, config, {
      deepScanRoutes: true,
    });

    // SEC-06: only expose Swagger UI in non-production environments
    SwaggerModule.setup("api/docs", app, document, {
      swaggerOptions: {
        persistAuthorization: true,
        tagsSorter: "alpha",
        operationsSorter: "method",
        defaultModelsExpandDepth: -1,
      },
      customSiteTitle: "AutoFlow Admin API",
    });
  }

  // ARCH-27: 端口取自 configuration.ts app.port（PORT 经 Joi 校验）。
  const port = configService.get<number>("app.port") ?? 3105;
  const logger = new Logger("Bootstrap");
  // OPS-05: graceful shutdown — lets K8s/docker stop drain in-flight requests before exit
  app.enableShutdownHooks();
  // OPS-P3b: 信号停机兜底——enableShutdownHooks 的正常路径会等 worker.close()
  // 排空 in-flight job，极端时挂死到 K8s SIGKILL。收到 SIGTERM/SIGINT/SIGBREAK
  // 后 arm 一个 15s 强制 exit(1) 定时器（unref，正常排空完成不阻止退出），
  // 与 fatal 路径 gracefulFatalShutdown 的 10s 硬超时互补。
  installShutdownForceExitGuard();
  // R-08 (windows-findings): on Windows taskkill cannot deliver SIGTERM to a
  // console app; Ctrl+Break surfaces as SIGBREAK. Route it through the same
  // shutdown hooks so a manually stopped admin-api drains cleanly.
  // No-op on POSIX (the event never fires there).
  process.on("SIGBREAK", () => {
    void app.close();
  });
  await app.listen(port);
  logger.log(`Application is running on: http://localhost:${port}`);
  if (configService.get<string>("app.nodeEnv") !== "production") {
    logger.log(`Swagger docs: http://localhost:${port}/api/docs`);
  }
}

// OPS-06: ensure startup errors are logged and process exits non-zero so
// container orchestration (K8s, Docker) can detect and restart the container.
// ARCH-008: unhandledRejection no longer calls process.exit(1) directly — that
// bypassed enableShutdownHooks() and could corrupt in-flight work (DB pools,
// Bull job states). We log a fatal error, then close the app gracefully with a
// 10 s hard-timeout fallback (gracefulFatalShutdown) that still exits(1) so
// orchestration restarts the container.
process.on("unhandledRejection", (reason: unknown) => {
  // NestJS catches most errors, but background tasks or event emitters can
  // still produce unhandled rejections — treat them as fatal after cleanup.
  void gracefulFatalShutdown(
    `Unhandled promise rejection: ${reason instanceof Error ? reason.stack : reason}`,
  );
});

// ARCH-008: uncaughtException — the process is in an undefined state by
// definition (Node.js guidance: an uncaught exception is not safely
// recoverable), so we keep exiting, but still drain gracefully first via the
// same 10 s-timeout helper. Anything thrown during shutdown forces exit(1).
process.on("uncaughtException", (err: Error) => {
  void gracefulFatalShutdown(
    `Uncaught exception: ${err?.stack ?? String(err)}`,
  );
});

bootstrap().catch((err: unknown) => {
  console.error("[FATAL] Bootstrap failed:", err);
  process.exit(1);
});
