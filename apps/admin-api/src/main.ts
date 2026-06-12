import { NestFactory, Reflector } from "@nestjs/core";
import { ClassSerializerInterceptor, ValidationPipe } from "@nestjs/common";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import { AppModule } from "./app.module";
import { HttpExceptionFilter } from "./common/filters/http-exception.filter";
import { ResponseInterceptor } from "./common/interceptors/response.interceptor";
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
  app.use(require("express").json({ limit: "1mb" }));
  app.use(require("express").urlencoded({ limit: "1mb", extended: true }));

  // Trust proxy — required for req.ip to reflect the real client IP
  // when the app runs behind a reverse proxy (nginx, load balancer, etc.)
  app.getHttpAdapter().getInstance().set("trust proxy", 1);

  // S10: CORS — use explicit origin whitelist; '*' + credentials is rejected by browsers
  const allowedOrigins = (process.env.CORS_ORIGINS || "http://localhost:5173")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({
    origin: (origin, callback) => {
      // Allow server-to-server calls (no Origin header) and whitelisted origins
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`Origin ${origin} not allowed by CORS`));
      }
    },
    methods: "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS",
    credentials: true,
  });

  // OPS-03: Cross-service request tracing middleware is configured in AppModule

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
    new ClassSerializerInterceptor(app.get(Reflector)),
    new ResponseInterceptor(),
  );

  // Swagger Configuration
  const config = new DocumentBuilder()
    .setTitle("AutoFlow Admin API")
    .setDescription(
      `
## AutoFlow 管理后台 API 文档

AutoFlow 是一个现代化的工作流自动化平台，提供任务编排、执行管理和监控功能。

### 认证方式

- **JWT Token**: 使用 Bearer Token 认证
- **令牌获取**: 通过 \`POST /api/auth/login\` 获取访问令牌
- **令牌格式**: \`Bearer <token>\`

### API 结构

| 模块 | 路径前缀 | 功能描述 |
|------|----------|----------|
| 认证 | /api/auth | 用户登录、登出、令牌刷新 |
| 用户 | /api/users | 用户管理 |
| 任务 | /api/tasks | 任务管理、触发、执行 |
| 执行器 | /api/executors | 执行器管理、配置、监控 |
| 通知 | /api/notification | 通知渠道配置 |
| 配置 | /api/config | 系统配置管理 |
| 审计 | /api/audit | 操作审计日志 |
| 指标 | /api/metrics | 性能指标 |
| 健康 | /api/health | 系统健康检查 |

### 错误响应格式

所有错误响应遵循统一格式：

\`\`\`json
{
  "statusCode": 400,
  "message": "错误描述",
  "error": "Bad Request",
  "timestamp": "2024-01-01T12:00:00Z",
  "path": "/api/tasks"
}
\`\`\`

### 成功响应格式

所有成功响应遵循统一格式：

\`\`\`json
{
  "code": 200,
  "message": "success",
  "data": {}
}
\`\`\`

### 分页响应格式

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

### 注意事项

1. 所有接口均需要认证，除非特别说明
2. 请求参数需要符合 DTO 定义，否则会被拒绝
3. 敏感信息（如密码、密钥）会在响应中被脱敏显示
4. 生产环境中 Swagger 文档不会暴露
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
    .addServer("http://localhost:3105", "本地开发环境")
    .addServer("http://api.autocodeflow.io", "生产环境")
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
  await app.listen(port);
  console.log(`Application is running on: http://localhost:${port}`);
  console.log(`Swagger docs: http://localhost:${port}/api/docs`);
}

bootstrap();
