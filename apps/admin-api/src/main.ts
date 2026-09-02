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
import { AppModule } from "./app.module";
import { HttpExceptionFilter } from "./common/filters/http-exception.filter";
import { ResponseInterceptor } from "./common/interceptors/response.interceptor";
import { TimeoutInterceptor } from "./common/interceptors/timeout.interceptor";
import {
  isOriginAllowed,
  parseAllowedOrigins,
} from "./common/utils/cors-origin.util";
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
  // SEC-02 / ARCH-001: Validate CORS whitelist in production environment.
  // The whitelist itself is fail-fast validated in configuration.ts; here we
  // additionally assert every entry is a well-formed http(s) origin.
  if (process.env.NODE_ENV === "production") {
    const origins = parseAllowedOrigins(
      process.env.CORS_ALLOWED_ORIGINS || process.env.CORS_ORIGINS,
    );
    for (const origin of origins) {
      if (!origin.startsWith("https://") && !origin.startsWith("http://")) {
        throw new Error(
          `CORS_ALLOWED_ORIGINS origin "${origin}" must start with http:// or https://`,
        );
      }
      try {
        new URL(origin);
      } catch {
        throw new Error(
          `CORS_ALLOWED_ORIGINS origin "${origin}" is not a valid URL`,
        );
      }
    }
  }

  const app = await NestFactory.create(AppModule);
  // OPS-06 / ARCH-008: expose the app instance to the fatal-signal handlers
  // below so they can trigger a graceful close instead of an abrupt exit.
  runningApp = app;

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

  // SEC-07: Set security-related HTTP headers via helmet
  app.use(
    helmet({
      // Allow SSE connections and inline scripts needed for Swagger UI in dev
      contentSecurityPolicy:
        process.env.NODE_ENV === "production" ? undefined : false,
      crossOriginEmbedderPolicy: false,
    }),
  );

  // Trust proxy — required for req.ip to reflect the real client IP
  // when the app runs behind a reverse proxy (nginx, load balancer, etc.)
  app.getHttpAdapter().getInstance().set("trust proxy", 1);

  // S10 / ARCH-001: CORS — explicit whitelist only via CORS_ALLOWED_ORIGINS
  // (falls back to legacy CORS_ORIGINS). The old isLanOrigin() auto-allow for
  // private/LAN networks (localhost / 10.x / 192.168.x / 172.16-31.x) was
  // removed: any host on a shared network could previously issue cross-site
  // requests. LAN deployments must now list their origins explicitly.
  // When no whitelist is configured, development defaults to http://localhost:*
  // and http://127.0.0.1:* only (see isOriginAllowed).
  // '*' + credentials is rejected by browsers so we use a callback instead.
  const allowedOrigins = parseAllowedOrigins(
    process.env.CORS_ALLOWED_ORIGINS || process.env.CORS_ORIGINS,
  );
  const isDevelopment = process.env.NODE_ENV !== "production";

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
  app.useGlobalInterceptors(
    new TimeoutInterceptor(app.get(Reflector)),
    new ClassSerializerInterceptor(app.get(Reflector)),
    new ResponseInterceptor(),
  );

  // Swagger Configuration — ARCH-007: production environments skip building
  // the OpenAPI document entirely (saves startup work, and hardcoded server
  // URLs can never leak via logs/debug output of the doc object).
  if (process.env.NODE_ENV !== "production") {
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

  const port = process.env.PORT || 3105;
  const logger = new Logger("Bootstrap");
  // OPS-05: graceful shutdown — lets K8s/docker stop drain in-flight requests before exit
  app.enableShutdownHooks();
  await app.listen(port);
  logger.log(`Application is running on: http://localhost:${port}`);
  if (process.env.NODE_ENV !== "production") {
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
