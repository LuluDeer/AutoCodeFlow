# User 实体（users 表）— 平台用户与登录安全状态

> 所属: docs/atlas/03-data/entities · 最后核对: 2026-09-13 · 对应代码: apps/admin-api/src/modules/users/entities/user.entity.ts

## 所属模块与源文件

- 模块：[users 模块](../../01-apps/admin-api/modules/users.md)（`apps/admin-api/src/modules/users/`）
- 源文件：`apps/admin-api/src/modules/users/entities/user.entity.ts`
- 同文件导出：`UserRole` 枚举（`ADMIN = "admin"` / `USER = "user"`）

## 表名

`users`（`@Entity("users")`，InitialSchema 迁移 `1717473142678` 建表）

## 字段表

主键 `id: number`（`@PrimaryGeneratedColumn()`，SERIAL 自增——是全库少数 int 主键实体之一）。

| 列名 | 类型 | 说明 |
|---|---|---|
| `username` | varchar(128) NOT NULL，**unique** | 登录名；DB-006 显式长度约束（避免默认 varchar(255) 影响唯一索引效率），DTO 侧 `@Length(3, 128)` |
| `email` | varchar NOT NULL，**unique** | 邮箱（无显式长度，默认 255） |
| `password` | varchar NOT NULL | bcrypt 哈希；`@Exclude()` 不序列化到 API 响应 |
| `role` | PG enum `user_role_enum`（`admin`/`user`），default `'user'` | 全局角色；InitialSchema 建枚举类型 |
| `isActive` | boolean，default `true` | 停用开关 |
| `loginFailCount` | int，default `0` | SEC-05：连续登录失败计数（账号锁定输入，迁移 `1717473142681-AccountLockout`） |
| `lockedUntil` | timestamp nullable | SEC-05：锁定截止时刻（迁移 `1717473142681`；注意是 **timestamp** 非 timestamptz） |
| `totpSecret` | varchar(64) nullable，`@Exclude()` | SEC-03：TOTP Base32 密钥；setup 后 enable 前处于「暂存未启用态」（迁移 `1789800000001-AddUserTotpAndSessionMeta`） |
| `totpEnabled` | boolean，default `false` | SEC-03：用户级 2FA opt-in 开关（`false` 保持登录路径不变） |
| `sessionVersion` | int，default `0` | WIKI-AUTH-REVOC：用户级会话版本（迁移 `1790000000017-AddUserSessionVersion`）——logout（`AuthService.revokeAllForUser`）与改密（`UsersService.update` 携带 password 时）原子 +1；access token 签发时快照进 `ver` claim，`jwt.strategy.validate()` 比对失配即 401（"Session has been revoked"），在途访问令牌即时失效 |
| `createdAt` / `updatedAt` | timestamp | `@CreateDateColumn` / `@UpdateDateColumn` |

## 索引与约束

| 索引/约束 | 定义 | 说明 |
|---|---|---|
| `username` | 列级 `unique` | 登录名唯一 |
| `email` | 列级 `unique` | 邮箱唯一 |
| PG enum 类型 | `user_role_enum`（`'admin'`,`'user'`） | InitialSchema 创建；扩值需 `ALTER TYPE` 迁移 |

实体装饰器层面无 `@Index`（唯一性走列约束）。

## 关系

- **被引用（弱引用，无 FK）**：
  - [refresh-token](refresh-token.md).`userId`（int，无 DB FK，仅有索引）；
  - [api-key](api-key.md).`userId`（int，无 FK）；
  - [project-member](project-member.md).`userId`（int，无 FK，仅索引）；
  - [event-subscription](event-subscription.md).`userId`（int nullable，无 FK）；
  - [config-history](config-history.md).`userId`（varchar 字符串，无 FK）；
  - `tasks.ownerUserId` / `applications.ownerUserId`（NF-03，int nullable，无 FK）；
  - [audit-log](audit-log.md).`userId`（append-only 弱引用）。
- **自身不引用任何表**（User 是被引用方）。

## 生命周期与写入方

- **创建**：`UsersService.create`（管理员建号，密码 bcrypt 哈希）；初始 admin 用户由环境变量 seed（[auth 模块](../../01-apps/admin-api/modules/auth.md)）。
- **更新**：
  - `AuthService`（登录路径写 `loginFailCount` / `lockedUntil`——失败 +1、成功清零；TOTP setup/enable/disable 写 `totpSecret` / `totpEnabled`）；
  - `UsersService`（资料/角色/停用）。
- **删除**：`UsersService.remove`（用户删除后上述弱引用 id 悬垂——按「悬垂 id = 非本人 → 403 方向安全」语义处理）。
- **只读消费方**：admin-web 用户管理页、[project 模块](../../01-apps/admin-api/modules/project.md)成员视图（`ProjectMemberView`）。

## 常见改动场景

1. **加字段**：实体 + 迁移（参考幂等模板 `1789800000001-AddUserTotpAndSessionMeta`：`ADD COLUMN IF NOT EXISTS`）+ 若涉敏感值需同步 `@Exclude()` 与读面脱敏。
2. **加全局角色**：`UserRole` 枚举加值 + 迁移 `ALTER TYPE user_role_enum ADD VALUE`；同时排查守卫里硬编码 `admin` 的判断面（[安全模型](../../04-flows/security-model.md)）。
3. **改锁定策略**：`loginFailCount` / `lockedUntil` 的阈值与时长在 `AuthService` 登录逻辑内，需同步其 spec 测试。
4. 相关流程：[安全模型](../../04-flows/security-model.md)。
