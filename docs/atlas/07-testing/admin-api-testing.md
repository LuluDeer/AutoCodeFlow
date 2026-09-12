# admin-api 测试
> 所属: docs/atlas/07-testing · 最后核对: 2026-09-13 · 对应代码: apps/admin-api/package.json（jest 内联配置）、apps/admin-api/src/**/__tests__/、apps/admin-api/test/

## 怎么跑

```bash
cd apps/admin-api
npm test                        # 全量单测（jest，rootDir=src）
npm run test:cov                # 带 coverage（输出到 ../coverage/）
npm run test:watch              # watch 模式
npm run test:e2e -- --runInBand # 集成 e2e（需真 PG + Redis，必须 --runInBand）
npm run test:e2e -- -t "OpenAPI export"   # 等价根目录 npm run swagger:export
```

根目录快捷方式：`npm run test:api`。CI 侧形态见 [deployment-and-ci](../06-infra/deployment-and-ci.md) 的 `admin-api-test` job。

### e2e 需要的环境变量（ci.yml admin-api-test env 块核实）

`DB_HOST/DB_PORT/DB_USERNAME/DB_PASSWORD/DB_DATABASE`、`REDIS_HOST/REDIS_PORT`、`JWT_SECRET/JWT_REFRESH_SECRET/EXECUTOR_SECRET`、`INITIAL_ADMIN_USERNAME/INITIAL_ADMIN_PASSWORD`（admin seed 依赖，e2e 登录用 admin/admin123）、`AI_PROVIDER=disabled`。

## Jest 配置（在 package.json 的 "jest" 键内，无独立配置文件）

- `rootDir: "src"`，`testRegex: ".*\\.spec\\.ts$"`，ts-jest 转换，testEnvironment=node。
- `coverageDirectory: "../coverage"`；CI 跑 `npm test -- --coverage` 触发门槛校验。
- `collectCoverageFrom` 排除（装配/生灭层，靠 e2e 兜底而非单测）：`main.ts`、`app.module.ts`、`data-source.ts`、`config/configuration.ts`、`common/filters/http-exception.filter.ts`、`common/utils/shutdown-guard.util.ts`、`migrations/**`。
- `coverageThreshold.global`：**branches 75 / functions 69 / lines 84 / statements 84**（%）——低于即红，防倒退地板。
- e2e 用独立配置 `test/jest-e2e.json`：`testRegex: ".e2e-spec.ts$"`、`testTimeout: 30000`、`moduleNameMapper` 把 `src/*` 映射回源码。

## 组织结构

单测共 **147 个 `*.spec.ts`**，按模块就近放在 `src/**/__tests__/`（少量在 `src/config/`、`src/common/utils/` 源码同级）。规模分布（2026-09-13 find 核实）：

| 目录 | 数量 | 目录 | 数量 |
|---|---|---|---|
| modules/task | 24 | modules/notification | 8 |
| src/migrations | 16 | modules/executor | 7 |
| modules/application | 11 | modules/auth、api-keys | 各 6 |
| common/utils | 9（另有 2 个同级） | metrics、config | 各 5（config 含 2 个同级） |
| common/guards | 5 | scheduler、audit | 各 4 |
| task-template / project / event-subscriptions / ai | 各 3 | common/services、common/tracing | 3 / 2 |
| users、executor-package | 各 2 | runtime、task/log-storage | 各 1 |

集成 e2e 在 `test/` 下 4 个：

| spec | 内容 |
|---|---|
| `auth.e2e-spec.ts` | 登录/刷新/token 生命周期真链路 |
| `executors.e2e-spec.ts` | 执行器注册、心跳、身份面 |
| `tasks.e2e-spec.ts` | 任务创建→触发→执行→回调全链 |
| `openapi-export.e2e-spec.ts` | OpenAPI 导出（`swagger:export` 借 `-t "OpenAPI export"` 驱动） |

共享 `test/helpers/app.helper.ts` 的 `createTestApp()`——**bootstrap 完整 AppModule**（真 PG/Redis、真迁移建表），属集成层而非 mock 单测。`--runInBand` 的原因：三个 e2e suite 并行时 admin seed 存在 `users_email_key` 竞态（ci.yml 注释原文）。

## 关键 spec 清单（守护什么）

| spec | 守护点 |
|---|---|
| `modules/task/__tests__/task.processor.spec.ts` | BullMQ 消费→派发→回调状态机核心（配合 [task-lifecycle](../04-flows/task-lifecycle.md)） |
| `modules/task/__tests__/execution-callback.controller.spec.ts` + `execution-callback-token.util.spec.ts` | 回调入口鉴权 token、幂等落库（[execution-callback](../04-flows/execution-callback.md)） |
| `modules/task/__tests__/task-owner-guard.spec.ts` | 任务属主守卫（普通用户只能改/删自己的任务，NF-03） |
| `modules/task/__tests__/task.controller.trigger-api.spec.ts` | 触发 API 语义（pinned/广播等模式入参） |
| `modules/task/__tests__/log-partition.util.spec.ts` + `log-retention-cleanup.service.spec.ts` | 日志分区与保留清理（防日志表无限膨胀） |
| `modules/executor/__tests__/executor.controller.security.spec.ts` + `executor.service.security.spec.ts` | 执行器身份/密钥面：rotate-token、reload-config 等写面防线 |
| `modules/api-keys/__tests__/api-key-auth.spec.ts` + `api-key-task-trigger.spec.ts` | API Key 认证链与 scope 限定（只能触发任务，不能进管理面） |
| `modules/application/__tests__/app-deployment.approval.spec.ts` | DEP-04 审批流：pending_approval、第二人规则、原子认领（[approval-flow](../04-flows/approval-flow.md)） |
| `modules/application/__tests__/app-deployment.rollout-multi-instance.spec.ts` | 多实例灰度批次一致性（ARCH-31 的单测面） |
| `modules/auth/__tests__/auth.service.spec.ts` + `totp.util.spec.ts` | 登录/刷新 token + TOTP 两步验证 |
| `modules/metrics/__tests__/prometheus-metrics.service.spec.ts` | `/metrics` Prometheus 指标面 |
| `src/migrations/__tests__/`（16 个） | 迁移链本身可回放、幂等（配合 CI `admin-api-migrations` job，见 [migrations](../03-data/migrations.md)） |
| `common/guards/__tests__/`（5 个） | 全局守卫（JWT/RBAC）语义 |

另：`modules/application/__tests__/deploy-fixture/` 内含 `manifest.json`，是部署链路 spec 的夹具目录。

## 失败时先看什么

1. **单测红**：先看报错 spec 所在模块文档（[01-apps/admin-api](../01-apps/admin-api/README.md)），确认是业务逻辑改动还是 DTO/装饰器改动牵动断言；同模块多个 spec 同时红通常是 service 层签名变了。
2. **coverage 红**：`npm run test:cov` 看哪类指标跌破 75/69/84/84 地板——branches 离水位最近（工作区残留 lcov 为 78.32%），新增条件分支最容易触线；通常是新代码没带测试而非旧代码回退。
3. **e2e 红**：确认 PG/Redis 在跑、`INITIAL_ADMIN_PASSWORD` 环境变量在（UsersService.onModuleInit 仅当它存在且 users 表为空时 seed admin）、用了 `--runInBand`；e2e 是全 AppModule，报错点可能离被改代码很远。
4. **契约红**：改了 DTO/控制器装饰器但没重新导出——`npm run swagger:export` + 前端 `npm run gen:api-types` 并提交两份生成物，CI `api-types-drift` job 会拦（见 [rest-api](../05-interfaces/rest-api.md)）。
5. **迁移相关红**：本地先复刻 `admin-api-migrations` 形态：空库 `npm run migration:run` 两次（第二次必须 no-op）。
