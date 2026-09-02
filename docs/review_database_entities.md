# 数据库层审查报告

**审查时间**: 2025-07
**审查范围**: 所有 TypeORM entity 文件, migrations 目录, data-source.ts, configuration.ts

---

## 问题列表

### DB-001 [Medium] task.entity.ts 缺少软删除——status=DELETED 的任务 ID 仍可被外键引用

**文件**: `apps/admin-api/src/modules/task/entities/task.entity.ts`, 行 57
**问题描述**:
Task 使用 `status = 'deleted'` 软删除（逻辑删除），而非 TypeORM 的 `@DeleteDateColumn()` 软删除机制。这导致：
- 查询时需要手动在所有地方过滤 `status != 'deleted'`，容易遗漏
- 已删除任务的 TaskExecution 记录仍然存在（FK 为 SET NULL），但 task.entity 没有索引支持 `status != DELETED` 的查询
- `findAll()` 中使用 `Not(TaskStatus.DELETED)` 正确，但其他直接使用 `taskRepo.find()` 的地方可能未过滤

**修复建议**:
- 考虑改用 TypeORM `@DeleteDateColumn() deletedAt` 配合 `@Entity({ ...softDelete: true })`，利用框架自动过滤
- 或者在 Repository 层封装一个 `findActive()` 方法统一过滤

---

### DB-002 [Medium] execution_log_lines 表无 TTL 机制，长期运行后无限膨胀

**文件**: `apps/admin-api/src/modules/task/entities/execution-log-line.entity.ts`
**问题描述**:
每次任务执行都可能写入大量日志行到 `execution_log_lines` 表。该表：
- 没有 `createdAt` 时间戳字段，无法按时间清理
- 没有定时清理任务
- 没有最大行数限制

长期运行的系统中，此表会无限增长，影响查询性能。

**修复建议**:
- 添加 `createdAt: Date` 字段，并建立索引
- 添加定时清理任务（如保留最近 30 天的日志行）
- 或在写入时限制每次执行的最大日志行数

---

### DB-003 [Medium] N+1 查询风险——getAllExecutions() 中 leftJoin 但 getRawAndEntities 后再 Map 合并

**文件**: `apps/admin-api/src/modules/task/task.service.ts`, 行 327-366
**函数**: `getAllExecutions()`

**问题描述**:
```typescript
const [rawList, total] = await Promise.all([
  qb.getRawAndEntities(),
  qb.getCount(),  // 执行了第二次相同 SQL（不含 LIMIT/OFFSET）
]);
```
`getRawAndEntities()` 和 `getCount()` 是对同一个 QueryBuilder 的两次独立执行，两次都扫描全表（带过滤条件），仅 `getCount()` 省略了 SELECT/JOIN。对于大数据量，这是两次全表扫描。

**修复建议**:
使用 `SELECT COUNT(*) OVER() AS total_count` 窗口函数在单次查询中获取总数，或接受两次查询但确保查询有适当索引覆盖。

---

### DB-004 [Low] ApplicationVersion 没有唯一索引约束 (applicationId, version)

**文件**: `apps/admin-api/src/modules/application/entities/application-version.entity.ts`, 行 12-16
**问题描述**:
```typescript
@Index(['applicationId'])
@Index(['applicationId', 'version'])  // 只是普通索引，非唯一
```
`applicationId + version` 组合没有唯一约束，理论上同一应用可以有两个相同版本号的记录（并发创建时可能发生）。

**修复建议**:
```typescript
@Index(['applicationId', 'version'], { unique: true })
```

---

### DB-005 [Low] migration 文件存在重复时间戳（1717473142685）

**文件**: `apps/admin-api/src/migrations/`
**问题描述**:
目录中存在两个时间戳相同的 migration 文件：
- `1717473142685-AddExecutorMissingColumns.ts`
- `1717473142685-CreateExecutorPackagesTable.ts`

相同时间戳的 migration 执行顺序由文件名字母排序决定，这是不确定的，可能因操作系统不同而有差异。

**修复建议**:
重命名其中一个，使用不同的时间戳（例如将第二个改为 `1717473142686-...` 并相应调整后续编号）。

---

### DB-006 [Low] User entity 缺少 username 长度限制

**文件**: `apps/admin-api/src/modules/users/entities/user.entity.ts`, 行 21
```typescript
@Column({ unique: true })
username: string;
```
**问题描述**:
`username` 字段没有显式长度限制（TypeORM 默认 varchar(255)），但 `CreateUserDto` 中也没有 `@MaxLength`。超长用户名可能影响数据库索引效率。

**修复建议**:
```typescript
@Column({ unique: true, length: 64 })
username: string;
```
配合 DTO 中添加 `@MaxLength(64)`。

---

### DB-007 [Low] system_config 表缺少 value 字段长度限制

**文件**: `apps/admin-api/src/modules/config/entities/system-config.entity.ts`
**问题描述**:
系统配置的 `value` 字段如果是普通 `varchar`，长度默认 255，但某些配置值（如 AI 提示词模板）可能超过此限制，导致静默截断。

**修复建议**:
将 `value` 字段改为 `text` 类型：
```typescript
@Column({ type: 'text', nullable: true })
value: string;
```

---

## 正面发现

- ✅ TaskExecution 使用 `@VersionColumn()` 乐观锁
- ✅ 关键查询字段均有索引（taskId, status, executorAddress, createdAt）
- ✅ 条件索引用于优化常用查询（idx_task_executions_running, where status='running'）
- ✅ User.password 字段 `@Exclude()` 防止序列化泄露
- ✅ webhookSecret `select: false` 防止普通查询泄露
- ✅ 数据库连接配置全部来自环境变量
- ✅ 连接池配置（extra.max, idleTimeoutMillis, connectionTimeoutMillis）
- ✅ migrationsRun 在非 development 环境自动执行
- ✅ 外键关系使用 ON DELETE SET NULL / CASCADE 明确定义
- ✅ 所有时间戳字段（createdAt/updatedAt）统一使用 TypeORM 装饰器
