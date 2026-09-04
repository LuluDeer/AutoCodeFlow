# 架构与基础设施审查报告

**审查时间**: 2025-07
**审查范围**: main.ts, app.module.ts, 全局配置, 中间件, Redis, 整体安全配置

---

## 总体评分

| 维度 | 评分 |
|------|------|
| 安全配置 | 中 |
| 可靠性 | 中高 |
| 可维护性 | 高 |

---

## 问题列表

### ARCH-001 [Medium] CORS 允许所有私有/LAN 来源，无需配置

**文件**: `apps/admin-api/src/main.ts`, 行 95-108
**函数**: `isLanOrigin()`, `app.enableCors()`

**问题描述**:
```typescript
function isLanOrigin(origin: string): boolean {
  // 自动放行 localhost / 127.x / 10.x / 192.168.x / 172.16-31.x
  ...
}
```
所有私有网络来源（内网 IP）都被自动允许，无需出现在 `CORS_ORIGINS` 白名单中。在内网环境中，任何主机都可以发起跨域请求访问 API，这在多租户或共享内网环境下存在 CSRF 风险。

**关联模块**: `app.enableCors()` 全局影响所有路由

**修复建议**:
- 如果内网访问确实是预期需求，应添加一个 `ALLOW_LAN_ORIGINS=true` 环境变量，明确需要配置才启用该行为
- 生产环境中建议关闭此自动放行逻辑，要求所有来源（包括内网）显式白名单

---

### ARCH-002 [Medium] 上传文件以静态方式服务，无身份验证

**文件**: `apps/admin-api/src/main.ts`, 行 136-137
**代码**:
```typescript
const uploadsPath = path.join(process.cwd(), 'uploads');
app.use('/uploads', express.static(uploadsPath));
```

**问题描述**:
上传的应用包（`.zip` 文件）通过 `/uploads/packages/...` 路径以静态文件方式公开服务，不需要任何身份验证。任何知道文件名的人都可以下载应用包（含潜在敏感代码/配置）。

**关联模块**: `application.controller.ts upload()` 方法写入此目录; executor 节点通过 `packageUrl` 下载

**修复建议**:
- 为 `/uploads` 路由添加 JWT 或共享 token 验证中间件
- 或者使用随机化的、不可预测的文件名（UUID 前缀而非仅时间戳）
- 考虑使用签名 URL（如 S3 presigned URL）而非直接静态文件服务

---

### ARCH-003 [Low] ValidationPipe `forbidNonWhitelisted` 在某些 multipart 路由可能被绕过

**文件**: `apps/admin-api/src/main.ts`, 行 143-151
**问题描述**:
全局 `ValidationPipe` 配置了 `forbidNonWhitelisted: true`，这是好的。但 `FileInterceptor` 处理的 multipart 请求，`@Body("name")` 和 `@Body("runtime")` 是原始字符串提取而非 DTO，不会经过 class-validator 验证，因此 `forbidNonWhitelisted` 对这些字段无效。

**关联函数**: `application.controller.ts#upload()`

**修复建议**:
- 对 multipart 请求的文本字段也使用 DTO + `@Body() dto: UploadAppDto` 形式
- 至少对 `name` 字段增加长度校验和字符白名单校验

---

### ARCH-004 [Low] 全局 Throttle 限制偏宽松

**文件**: `apps/admin-api/src/app.module.ts`, 行 97-99
```typescript
ThrottlerModule.forRoot({
  throttlers: [{ ttl: 60_000, limit: 100 }],
}),
```

**问题描述**:
全局限流为每分钟 100 次请求，对于管理台 API 偏高。敏感操作（用户创建、配置修改）没有单独的更严格限速。登录接口有单独的 `@Throttle({ default: { ttl: 60_000, limit: 20 } })` 但默认值为 20（注释说 dev 用 20，prod 应该用 5）。

**修复建议**:
- 生产环境登录限制应更严格（5次/分钟），通过 `LOGIN_THROTTLE_LIMIT` 环境变量已部分实现，但文档需提示
- 对用户管理、配置修改等敏感 CRUD 操作增加独立限流装饰器

---

### ARCH-005 [Medium] Redis 连接无 TLS 配置选项

**文件**: `apps/admin-api/src/app.module.ts`, 行 125-152; `apps/admin-api/src/common/services/redis-lock.service.ts`, 行 18-29

**问题描述**:
BullMQ 和 RedisLockService 的 Redis 连接均只配置了 host/port/password，没有 TLS/SSL 支持。在生产环境中 Redis 通常需要加密传输。

**关联模块**: `RedisLockService`, `BullModule`

**修复建议**:
```typescript
// 支持 TLS 配置
tls: cfg.get('redis.tls') === 'true' ? {} : undefined,
```

---

### ARCH-006 [Low] 生产环境 synchronize: false 依赖 NODE_ENV，而非显式配置

**文件**: `apps/admin-api/src/app.module.ts`, 行 113
```typescript
synchronize: cfg.get('app.nodeEnv') === 'development',
```

**问题描述**:
数据库 `synchronize` 仅在 `NODE_ENV=development` 时开启。如果 `NODE_ENV` 未设置或配置错误，默认值为 `'development'`（Joi schema 中），这意味着意外配置可能在生产中开启 synchronize，导致不受控的 schema 修改。

**修复建议**:
- 改为显式环境变量 `DB_SYNCHRONIZE=false` 并默认为 false
- 或在 Joi 验证中将 `NODE_ENV` 设为 required

---

### ARCH-007 [Info] Swagger 文档包含生产服务器 URL

**文件**: `apps/admin-api/src/main.ts`, 行 254-255
```typescript
.addServer('http://api.autocodeflow.io', 'Production')
```

**问题描述**:
Swagger 文档虽然在生产环境不暴露 UI，但文档构建仍会被执行并消耗资源。更重要的是，生产服务器 URL 硬编码在代码中（使用 HTTP 而非 HTTPS），若 swagger doc 对象被日志或调试输出泄露，会暴露生产端点。

**修复建议**:
- 生产环境完全跳过 Swagger document 构建（条件编译）
- 生产 URL 使用 HTTPS

---

### ARCH-008 [Medium] unhandledRejection 直接 process.exit(1) 可能跳过清理钩子

**文件**: `apps/admin-api/src/main.ts`, 行 288-293

**问题描述**:
```typescript
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled promise rejection:', reason);
  process.exit(1);
});
```
直接调用 `process.exit(1)` 会绕过 NestJS 的 `enableShutdownHooks()` 设置的优雅关闭逻辑，可能导致：
- 正在执行的任务被强制终止
- 数据库连接未正常关闭
- Bull 队列中的 job 状态异常

**修复建议**:
```typescript
process.on('unhandledRejection', async (reason) => {
  console.error('[FATAL] Unhandled promise rejection:', reason);
  // 触发 NestJS 优雅关闭而非直接 exit
  await app.close();
  process.exit(1);
});
```
注意需要将 `app` 提取到 bootstrap 外部作用域。

---

## 正面发现（做得好的地方）

- ✅ Helmet 已启用（安全 HTTP 头）
- ✅ 生产环境强制 CORS_ORIGINS 配置，且拒绝 localhost
- ✅ 全局 JWT Guard + ThrottlerGuard
- ✅ ValidationPipe 配置了 `whitelist: true, forbidNonWhitelisted: true`
- ✅ ClassSerializerInterceptor 在 ResponseInterceptor 前执行，确保 @Exclude 生效
- ✅ 请求体大小限制（1MB 全局，55MB 仅回调接口）
- ✅ Swagger 仅在非生产环境暴露
- ✅ 数据库连接池配置（extra.max）
- ✅ 优雅关闭钩子启用
- ✅ Joi schema 验证所有必需环境变量
