# users 模块 — 用户管理

> 所属: docs/atlas/01-apps/admin-api/modules · 最后核对: 2026-09-13 · 对应代码: apps/admin-api/src/modules/users

## 职责

用户账号 CRUD、初始管理员种子、密码强度校验与哈希、登录失败计数/账号锁定（供 auth 模块调用）。`User` 实体同时承载 TOTP 2FA 字段与全局角色（`UserRole.ADMIN | USER`）。

## 目录结构与关键文件

```
modules/users/
├── users.module.ts       装配：TypeOrmModule.forFeature([User])；export UsersService
├── users.controller.ts   @Controller("users")，@ApiTags("Users")
├── users.service.ts      CRUD + 种子 + 锁定计数（OnModuleInit 种子逻辑）
├── entities/user.entity.ts   User 实体（users 表）+ UserRole 枚举
└── dto/                  create-user.dto.ts、update-user.dto.ts
```

`User` 实体关键字段：`username`（唯一，length 128）、`email`（唯一）、`password`（`@Exclude()`，bcrypt cost 12）、`role`（PG enum）、`isActive`、`loginFailCount`、`lockedUntil`、`totpSecret`（`@Exclude()`）、`totpEnabled`。

## 路由（controller 前缀 `users`）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/users` | JWT + `@Roles(ADMIN)` | 创建用户（校验密码强度） |
| GET | `/users` | JWT + `@Roles(ADMIN)` | 分页列表（M-4：仅管理员可枚举账号与锁定状态） |
| GET | `/users/:id` | JWT | 非管理员只能看自己（`ForbiddenException`，不泄露存在性） |
| PATCH | `/users/:id` | JWT | 管理员改任意人；非管理员改自己且**不能改 role**、改密码必须带 `currentPassword` |
| DELETE | `/users/:id` | JWT + `@Roles(ADMIN)` | 删除用户 |

所有写路由都通过 `AuditService` 记 `user.create/update/delete`。

## 关键机制

### 登录失败与锁定（auth 模块的底层）

```
登录失败（auth.service 调用）
  → recordLoginFailure(id, {maxFail:5, lockMinutes:15})
      UPDATE ... SET "loginFailCount"="loginFailCount"+1 RETURNING  ← 原子取回新值
      达到 5 → 条件 UPDATE 置 lockedUntil（仅当当前无锁或锁已过期，不续期）
登录时发现锁已过期
  → clearExpiredLock(id)：单条条件 UPDATE 同时清零计数与锁（R10）
登录成功
  → resetLoginFailure(id)：清零计数 + lockedUntil=NULL
```

### 管理员种子（onModuleInit）

```
users 表为空 且 INITIAL_ADMIN_PASSWORD 已配置
  → 创建 username="admin"、email=INITIAL_ADMIN_EMAIL（默认 admin@autoflow.local）、
    role=ADMIN 的账号（bcrypt cost 12）
未配置 INITIAL_ADMIN_PASSWORD → 跳过并 warn
唯一约束冲突（PG 23505，多副本并发种子竞态）→ 核对已有用户后降级为跳过（ARCH-31）
```

### 密码强度（validatePasswordStrength）

至少 8 位、含大写、含数字、含特殊字符；update 路径先 `delete updateUserDto.currentPassword`（R19：验证字段不能透传落库/回显）。

## 与其他模块的关系

- **被 [auth.md](auth.md) 依赖**：登录、TOTP、锁定计数全部经 `UsersService`（`findByUsername`/`recordLoginFailure`/`saveUser` 等）。
- **被全局 RBAC 依赖**：`UserRole` 枚举与 `user.role` 是 `RolesGuard`（common/guards）判定 `@Roles()` 的数据来源；全局守卫链见 [../README.md](../README.md)。
- **依赖 [audit.md](audit.md)**：CRUD 写审计。
- **被 [project.md](project.md) 引用**：项目成员表 `project_members.userId` 指向用户 id（无 FK，逻辑关联）。

## 常见改动场景

- **加一个用户字段**：改 `entities/user.entity.ts` → `npm run migration:generate` 生成迁移（见 [../README.md](../README.md) 迁移命令）→ 若要出现在响应中注意 `@Exclude()` 与 `ClassSerializerInterceptor` 的关系；敏感字段务必加 `@Exclude()`。
- **加管理员专用接口**：controller 方法加 `@UseGuards(RolesGuard)` + `@Roles(UserRole.ADMIN)`（全局 JwtAuthGuard 已兜底，无需重复挂）。
- **改密码策略**：只改 `validatePasswordStrength`（create 与 update 共用），但注意旧密码不会重新校验强度。
- **调整锁定策略**：阈值/时长由 `auth.service` 的 `MAX_FAIL=5 / LOCK_MINUTES=15` 常量传入，不在本模块。

## 相关文档

- 认证：[auth.md](auth.md)；审计：[audit.md](audit.md)
- 项目成员（另一种角色体系）：[project.md](project.md)
- 安全模型：[../../04-flows/security-model.md](../../../04-flows/security-model.md)
