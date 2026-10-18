# 测试数据工厂

测试数据工厂提供可复用的测试数据生成函数，避免在测试中重复构造对象。

## 安装

工厂使用 `@faker-js/faker` 生成随机测试数据，已作为 devDependency 安装。

## 使用方法

### 基本用法

```typescript
import { buildUser, buildTask, buildSuccessExecution } from '../../../test/factories';
import { UserRole } from '../modules/users/entities/user.entity';

describe('MyService', () => {
  it('should process user data', () => {
    // 快速生成一个用户
    const user = buildUser({ role: UserRole.ADMIN });
    
    expect(user.role).toBe(UserRole.ADMIN);
    expect(user.username).toBeTruthy();
  });
});
```

### 可用工厂

#### User 工厂

```typescript
// 基本构造
const user = buildUser();
const users = buildUsers(5);

// 快捷函数
const admin = buildAdminUser();
const lockedUser = buildLockedUser();
const totpUser = buildTotpUser();

// 自定义覆盖
const customUser = buildUser({
  username: 'testuser',
  email: 'test@example.com',
  role: UserRole.ADMIN,
});
```

#### Task 工厂

```typescript
// 基本构造
const task = buildTask({ name: 'my-task' });
const tasks = buildTasks(5);

// 快捷函数
const cronTask = buildCronTask();
const pythonTask = buildPythonTask();
const nodeTask = buildNodeTask();
const gitTask = buildGitTask();
const glueTask = buildGlueTask();

// 自定义覆盖
const customTask = buildTask({
  runtime: TaskRuntime.NODE,
  timeout: 600,
  maxRetry: 5,
});
```

#### TaskExecution 工厂

```typescript
// 基本构造
const execution = buildTaskExecution();
const executions = buildTaskExecutions(5);

// 快捷函数（按状态）
const success = buildSuccessExecution({ taskId: task.id });
const failed = buildFailedExecution({ taskId: task.id });
const running = buildRunningExecution();
const pending = buildPendingExecution();
const timeout = buildTimeoutExecution();
const cancelled = buildCancelledExecution();

// 重试链场景
const retryChain = buildRetryChain(
  taskId,
  3, // 尝试次数
  ExecutionStatus.SUCCESS // 最终状态
);
```

#### ApiKey 工厂

```typescript
// 基本构造
const apiKey = buildApiKey();
const apiKeys = buildApiKeys(5);

// 快捷函数
const readonlyKey = buildReadonlyApiKey();
const triggerKey = buildTriggerApiKey();
const manageKey = buildManageApiKey();
const expiredKey = buildExpiredApiKey();
const revokedKey = buildRevokedApiKey();

// 获取明文 key（用于认证测试）
const { apiKey, plaintext } = buildApiKeyWithPlaintext({
  scope: 'manage',
});
// 使用 plaintext 进行认证测试
```

## 设计原则

1. **默认值合理**：所有工厂函数都提供合理的默认值，无需传参即可使用
2. **支持覆盖**：通过 options 参数可以覆盖任何字段
3. **类型安全**：完整的 TypeScript 类型定义
4. **快捷函数**：为常见场景提供快捷函数（如 `buildAdminUser`、`buildSuccessExecution`）

## 高级用法

### 批量生成测试数据

```typescript
// 为一个任务生成多个执行记录
const task = buildTask();
const executions = [
  buildSuccessExecution({ taskId: task.id }),
  buildSuccessExecution({ taskId: task.id }),
  buildFailedExecution({ taskId: task.id }),
];

const successRate = executions.filter(
  e => e.status === ExecutionStatus.SUCCESS
).length / executions.length;
```

### 模拟复杂场景

```typescript
// 模拟任务重试场景
const task = buildTask({ maxRetry: 3 });
const retryChain = buildRetryChain(task.id, 3, ExecutionStatus.SUCCESS);

// 第一次和第二次失败，第三次成功
expect(retryChain[0].status).toBe(ExecutionStatus.FAILED);
expect(retryChain[1].status).toBe(ExecutionStatus.FAILED);
expect(retryChain[2].status).toBe(ExecutionStatus.SUCCESS);
```

## 维护指南

### 添加新工厂

1. 在 `test/factories/` 创建 `{entity}.factory.ts`
2. 导出 `build{Entity}` 和 `build{Entity}s` 函数
3. 提供常用场景的快捷函数
4. 在 `test/factories/index.ts` 中导出
5. 编写单元测试验证工厂函数

### 更新现有工厂

当实体定义变更时：

1. 更新工厂函数的 options 接口
2. 更新 build 函数中的字段赋值
3. 更新相关测试
4. 运行测试确保兼容性

## 测试

运行工厂函数的单元测试：

```bash
npm test -- test/factories/__tests__
```

## 参考

- [@faker-js/faker 文档](https://fakerjs.dev/)
- [测试数据构建器模式](https://martinfowler.com/bliki/ObjectMother.html)
