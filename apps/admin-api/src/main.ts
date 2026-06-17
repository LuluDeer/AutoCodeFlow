import { NestFactory, Reflector } from "@nestjs/core";
import { ClassSerializerInterceptor, Logger, ValidationPipe } from "@nestjs/common";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import helmet from "helmet";
import express from "express";
import { AppModule } from "./app.module";
import { HttpExceptionFilter } from "./common/filters/http-exception.filter";
import { ResponseInterceptor } from "./common/interceptors/response.interceptor";
import { TimeoutInterceptor } from "./common/interceptors/timeout.interceptor";
// import { TraceMiddleware } from "./common/middleware/trace.middleware";

async function bootstrap() {
  // SEC-02: Validate CORS origins in production environment
  if (process.env.NODE_ENV === "production") {
    const corsOrigins = process.env.CORS_ORIGINS;
    if (!corsOrigins) {
      throw new Error("CORS_ORIGINS must be set in production environment");
    }
    const origins = corsOrigins
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean);
    for (const origin of origins) {
      if (
        origin.includes("localhost") ||
        origin.includes("127.0.0.1") ||
        origin.includes("0.0.0.0")
      ) {
        throw new Error(
          `CORS_ORIGINS contains development origin "${origin}" in production. Use production domains only.`,
        );
      }
      if (!origin.startsWith("https://") && !origin.startsWith("http://")) {
        throw new Error(
          `CORS_ORIGINS origin "${origin}" must start with http:// or https://`,
        );
      }
    }
  }

  const app = await NestFactory.create(AppModule);

  // S-11: cap JSON body size to 1 MB to prevent oversized-payload DoS
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ limit: "1mb", extended: true }));

  // SEC-07: Set security-related HTTP headers via helmet
  app.use(
    helmet({
      // Allow SSE connections and inline scripts needed for Swagger UI in dev
      contentSecurityPolicy: process.env.NODE_ENV === "production" ? undefined : false,
      crossOriginEmbedderPolicy: false,
    }),
  );

  // Trust proxy — required for req.ip to reflect the real client IP
  // when the app runs behind a reverse proxy (nginx, load balancer, etc.)
  app.getHttpAdapter().getInstance().set("trust proxy", 1);

  // S10: CORS — auto-allow LAN/private origins; public origins require explicit whitelist.
  // '*' + credentials is rejected by browsers so we use a callback instead.
  const allowedOrigins = (process.env.CORS_ORIGINS || "http://localhost:5173")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  // Returns true when the origin's hostname is a private/LAN address.
  // Covers: localhost, 127.x, 10.x, 192.168.x, 172.16-31.x
  function isLanOrigin(origin: string): boolean {
    try {
      const { hostname } = new URL(origin);
      return (
        hostname === "localhost" ||
        /^127\./.test(hostname) ||
        /^10\./.test(hostname) ||
        /^192\.168\./.test(hostname) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
      );
    } catch {
      return false;
    }
  }

  app.enableCors({
    origin: (origin, callback) => {
      // Allow server-to-server calls (no Origin header)
      if (!origin) {
        callback(null, true);
        return;
      }
      // Auto-allow LAN / private-network origins — no config needed
      if (isLanOrigin(origin)) {
        callback(null, true);
        return;
      }
      // Public origins must be explicitly whitelisted via CORS_ORIGINS
      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`Origin ${origin} not allowed by CORS`));
      }
    },
    methods: "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS",
    credentials: true,
  });

  // OPS-03: Cross-service request tracing middleware is configured in AppModule

  // Serve uploaded packages as static files so executors can download them
  const uploadsPath = require('path').join(process.cwd(), 'uploads');
  app.use('/uploads', require('express').static(uploadsPath));

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

  // Swagger Configuration
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
    .addServer("http://api.autocodeflow.io", "Production")
    .build();

  const document = SwaggerModule.createDocument(app, config, {
    deepScanRoutes: true,
  });

  // SEC-06: only expose Swagger UI in non-production environments
  if (process.env.NODE_ENV !== "production") {
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
  const logger = new Logger('Bootstrap');
  // OPS-05: graceful shutdown — lets K8s/docker stop drain in-flight requests before exit
  app.enableShutdownHooks();
  await app.listen(port);
  logger.log(`Application is running on: http://localhost:${port}`);
  if (process.env.NODE_ENV !== 'production') {
    logger.log(`Swagger docs: http://localhost:${port}/api/docs`);
  }
}

// OPS-06: ensure startup errors are logged and process exits non-zero so
// container orchestration (K8s, Docker) can detect and restart the container.
process.on('unhandledRejection', (reason: unknown) => {
  // NestJS catches most errors, but background tasks or event emitters can
  // still produce unhandled rejections. Log and exit so the container restarts.
  console.error('[FATAL] Unhandled promise rejection:', reason);
  process.exit(1);
});

bootstrap().catch((err: unknown) => {
  console.error('[FATAL] Bootstrap failed:', err);
  process.exit(1);
});
