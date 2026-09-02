# 认证与授权安全审查报告

**审查时间**: 2025-07
**审查范围**: auth.service.ts, auth.controller.ts, jwt.strategy.ts, refresh-token.entity.ts, jwt-auth.guard.ts, roles.guard.ts, verify-executor-token.util.ts, users.service.ts

---

## 问题列表

### SEC-001 [Medium] JWT 策略对 `type` 字段的检查存在逻辑漏洞

**文件**: `apps/admin-api/src/modules/auth/strategies/jwt.strategy.ts`, 行 26-28
**函数**: `validate()`

**问题描述**:
```typescript
if (payload.type && payload.type !== 'access') {
  throw new UnauthorizedException('Invalid token type');
}
```
这个判断的条件是 `payload.type &&`，即：**如果 payload 没有 `type` 字段，则跳过类型检查**。这意味着旧版本签发的不带 `type` 字段的 JWT（或通过其他方式构造的无 `type` 字段的 token）可以通过验证，用于访问受保护的 API。

**修复建议**:
```typescript
// 要求 type 字段必须为 'access'
if (payload.type !== 'access') {
  throw new UnauthorizedException('Invalid token type');
}
```

---

### SEC-002 [Medium] refreshToken() 当 jti 为空时跳过 revocation 检查

**文件**: `apps/admin-api/src/modules/auth/auth.service.ts`, 行 82-92
**函数**: `refreshToken()`

**问题描述**:
```typescript
if (payload.jti) {
  // 检查 revocation
  const record = await this.refreshTokenRepo.findOne(...);
  if (!record || record.revoked) { throw ... }
  record.revoked = true;
  await this.refreshTokenRepo.save(record);
}
// 如果 jti 为空，直接跳过 revocation，仍然签发新 token
```
如果 refresh token 的 payload 没有 `jti` 字段（旧版 token 或手动构造），revocation 数据库检查会被完全跳过，token 轮换防护失效。

**修复建议**:
```typescript
if (!payload.jti) {
  throw new UnauthorizedException('Refresh token missing jti claim');
}
```

---

### SEC-003 [Medium] 账号锁定检查顺序：先验证密码再检查锁定，存在时序窗口

**文件**: `apps/admin-api/src/modules/auth/auth.service.ts`, 行 29-65
**函数**: `login()`

**问题描述**:
当前流程：
1. 查找用户
2. 比对密码（bcrypt.compare，较慢）
3. 密码错误 → 记录失败次数
4. 密码正确 → 检查 `lockedUntil`

问题在于：锁定状态检查在密码验证**之后**。如果账号已经被锁定但攻击者知道正确密码，他们仍然会通过密码验证步骤（消耗 bcrypt 计算时间），再被 `lockedUntil` 拒绝。这没有明显安全问题，但不符合最佳实践（应先检查锁定）。

更严重的是：**活跃的锁定状态不阻止失败计数递增**。即锁定期间继续尝试仍会推进 `loginFailCount`，可能在锁定解除后仍继续触发锁定，但也可能导致锁定时间被延长（取决于实现）。

**修复建议**:
```typescript
// 先检查锁定状态，再进行密码验证
if (user && user.lockedUntil && user.lockedUntil > new Date()) {
  throw new UnauthorizedException(`Account locked...`);
}
const passwordOk = user != null && await bcrypt.compare(...);
```

---

### SEC-004 [Low] login 接口审计日志不记录登录结果（成功/失败）

**文件**: `apps/admin-api/src/modules/auth/auth.controller.ts`, 行 62-75
**函数**: `login()`

**问题描述**:
登录审计日志在 `this.authService.login(loginDto)` 成功后才记录，不区分成功/失败。失败的登录尝试（用户名存在但密码错误）不会被记录到审计日志，只有 `loginFailCount` 被更新。安全审计时无法从审计日志中追溯暴力破解尝试的完整历史。

**修复建议**:
在 catch 块中也记录失败的登录尝试，包括失败原因（但不包含密码）。

---

### SEC-005 [Low] UpdateUserDto 缺少 @IsStrongPassword 约束

**文件**: `apps/admin-api/src/modules/users/dto/update-user.dto.ts`

**问题描述**:
`CreateUserDto` 有 `@IsStrongPassword()` 约束，但 `UpdateUserDto` 如果允许更新密码字段，可能没有同等约束（需要确认 UpdateUserDto 内容）。如果允许通过 PATCH 将密码更新为弱密码，则 CreateUserDto 的强密码要求形同虚设。

**修复建议**:
确保 UpdateUserDto 的 password 字段也应用与 CreateUserDto 相同的 `@IsStrongPassword()` 约束。

---

### SEC-006 [Low] executor token 共享密钥通过 DB 和环境变量两条路径，一致性未保证

**文件**: `apps/admin-api/src/common/utils/verify-executor-token.util.ts`
**函数**: `verifyExecutorToken()`

**问题描述**:
executor token 验证依次检查：DB 中的 `executor.sharedToken` → 环境变量 `EXECUTOR_SHARED_TOKEN` → 环境变量 `EXECUTOR_SECRET`。如果 DB 中存储了一个 token 但同时环境变量中也有值，优先使用 DB 值，环境变量值被忽略。这意味着轮换 DB 中的 token 不需要同步更新环境变量，反之亦然——但文档和运维人员可能不清楚这个优先级关系，导致误操作。

**修复建议**:
明确文档化优先级，并在启动时日志记录当前使用的 token 来源（不记录 token 值）。

---

## 正面发现

- ✅ bcrypt 密码哈希，且有 MaxLength(128) 防止 bcrypt DoS
- ✅ @IsStrongPassword 约束 CreateUserDto（含大小写数字特殊字符要求）
- ✅ 账号锁定机制：5 次失败后锁定 15 分钟
- ✅ Refresh token 轮换（每次使用后立即 revoke）
- ✅ 使用独立的 refreshSecret 签发 refresh token（与 access token secret 分离）
- ✅ JWT 包含 jti（UUID）用于精确 revocation
- ✅ 每日清理过期 refresh token（防止表膨胀）
- ✅ 登录 throttle（20次/分钟默认，可配置）
- ✅ 用户密码字段 @Exclude() 防止序列化时泄露
- ✅ isActive 检查：禁用账号的 JWT 请求会被拒绝（JWT strategy 实时验证）
- ✅ logout 撤销该用户所有 refresh token
- ✅ timingSafeEqual 防止 webhook 签名时序攻击
