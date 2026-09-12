# 如何新增一个后端模块（admin-api）

> 所属: docs/atlas/08-workflows · 最后核对: 2026-09-13 · 对应代码: apps/admin-api/src/modules/、apps/admin-api/src/app.module.ts

本文以**真实的 project 模块**（AUTH-01 落地的多租户模块）为参照范例，每一步都在其源码上核对过。全文路径均相对仓库根目录。

## 前置条件

- 本地能跑 admin-api：PostgreSQL + Redis 可用（`docker-compose.yml` 提供），`apps/admin-api/.env` 已配置（模板见 `apps/admin-api/.env.example`）
- 已读：[../01-apps/admin-api/README.md](../01-apps/admin-api/README.md)、[../03-data/README.md](../03-data/README.md)
- 若任务来自认领板：已在 `docs/PLAN-CLAIMS.md` 认领并声明文件足迹（见 [task-board/README.md](task-board/README.md)）

## 步骤

### 1. 建目录骨架

在 `apps/admin-api/src/modules/<name>/` 下建（参照 `src/modules/project/` 真实结构）：

```
modules/<name>/
├── <name>.module.ts        # 参照 project/projects.module.ts
├── <name>s.controller.ts   # 参照 project/projects.controller.ts
├── <name>s.service.ts      # 参照 project/projects.service.ts
├── <name>.dto.ts           # 参照 project/project.dto.ts（或建 dto/ 子目录，见 auth 模块）
├── <name>.entity.ts        # 主实体可放模块根（project.entity.ts 即如此）
├── entities/               # 次级实体放这里（project/entities/project-member.entity.ts）
└── __tests__/              # spec 就近放（project/__tests__/*.spec.ts）
```

两种真实范式并存，选一即可：**project 式**（DTO/主实体放模块根、次级实体放 `entities/`）与 **auth 式**（DTO 全放 `dto/`、实体放 `entities/`、策略放 `strategies/`）。

### 2. 定义实体与迁移

- 实体文件名必须能被 `src/data-source.ts` 的 glob 命中：`entities: [__dirname + "/modules/**/*.entity{.ts,.js}"]`——所以实体文件必须以 `.entity.ts` 结尾（模块根直放或子目录均可，project.entity.ts 即模块根直放的先例）。
- **新表/新列必须走迁移**（`DB_SYNCHRONIZE` 默认 false，生产强制 false）。迁移前**先登记时间戳**：`docs/PLAN-CLAIMS.md`「迁移时间戳分配表」常设段，规则 = 在盘最大 +1（截至今日最大为 `1790000000015`），撞号由 CI `check-migrations` job（`scripts/check-migrations.mjs`）拦截。
- 生成/执行：

```bash
cd apps/admin-api
npm run migration:generate -- src/migrations/<Timestamp>-<Name>   # 从实体 diff 生成
npm run migration:run                                             # 应用
npm run migration:revert                                          # 回滚（演练用）
```

迁移机制详解见 [../03-data/migrations.md](../03-data/migrations.md)。

### 3. 写 service / controller（含 RBAC）

参照 `project/projects.controller.ts` 的真实形态：

- **认证**：`JwtAuthGuard` 已通过 `app.module.ts` 的 `APP_GUARD` 全局挂载（`{ provide: APP_GUARD, useClass: JwtAuthGuard }`），controller 类上再显式 `@UseGuards(JwtAuthGuard)` 是 project 模块的写法；公开路由用 `@Public()` 豁免。
- **授权**：写面方法上加 `@UseGuards(RolesGuard)` + `@Roles(UserRole.ADMIN)`（project 的 POST/PATCH/DELETE 即此形态；读面 `@Get()` 无角色元数据 = 任何登录用户可用）。角色枚举来自 `../users/entities/user.entity.ts` 的 `UserRole`。

### 4. DTO 与 Swagger

- DTO 用 `class-validator` 装饰器 + `@nestjs/swagger` 的 `@ApiProperty`（真实范例：`src/modules/auth/dto/login.dto.ts`，`@ApiProperty({ example: "admin" })` + `@MaxLength(128)`）。
- Swagger UI 仅非生产环境暴露（`src/main.ts` SEC-06，路径 `/api/docs`）。

### 5. 注册进 app.module

在 `src/app.module.ts`：import 模块类，加入 `@Module({ imports: [...] })` 数组末尾（真实先例：`ProjectsModule`、`ApiKeysModule`、`RuntimeModule` 都带一行来源注释）。需要新 env 的话**三处同批**：`src/config/configuration.ts` + `app.module.ts` 的 Joi `validationSchema` + `apps/admin-api/.env.example`（SEC-09/FEAT-19 等多轮先例，Joi 漏注册会被 ARCH-27 审计口径盯上）。

### 6. 导出 openapi.json 并同步前端类型

`openapi.json` 的**唯一写入方**是 e2e spec `test/openapi-export.e2e-spec.ts`（ARCH-23 裁定，勿用其他路径导出，需 DB+Redis）：

```bash
cd apps/admin-api && npm run swagger:export   # 重新导出 openapi.json（需 DB+Redis）
cd ../../apps/admin-web && npm run gen:api-types   # 重新生成 src/types/generated/api-types.ts
```

两者产物必须同 commit 提交，否则 CI `api-types-drift` job（`.github/workflows/ci.yml`）双红。

### 7. 测试

- 单测放 `modules/<name>/__tests__/*.spec.ts`（jest，`testRegex: .*\.spec\.ts$`）。
- 覆盖率门槛（`apps/admin-api/package.json`）：branches 75 / functions 69 / lines 84 / statements 84，**只增不减**是多轮纪律。

```bash
cd apps/admin-api
npm test          # 全量
npm run typecheck # tsc --noEmit
npm run lint
```

## 验收清单

- [ ] 模块注册进 `app.module.ts`，启动无 DI 报错（`npm run start:dev` 冒烟）
- [ ] 实体文件名匹配 `*.entity.ts`，`npm run migration:run` 成功；迁移时间戳已在认领板分配表登记
- [ ] 写面有 `@Roles(...)` 收口，读面/写面策略与 project 模块同形态
- [ ] DTO 有 `@ApiProperty`，`npm run swagger:export` 后 `openapi.json` 含新端点
- [ ] `apps/admin-web` 已 `npm run gen:api-types`，CI `api-types-drift` 绿
- [ ] `__tests__/` 有 spec，`npm test` / `npm run typecheck` / `npm run lint` 全绿
- [ ] 新 env（如有）三处同批登记
- [ ] 认领板对应行改 `done` + commit hash

## 常见坑

- **迁移撞号**：不登记分配表直接建文件，CI `check-migrations` 拦截；并行会话同时领任务时先查板。
- **openapi 双写入路径**：曾因 `scripts/export-openapi.ts`（ts-node）与 Jest 路径枚举反射不一致导致 drift 双红——只用 `npm run swagger:export`（委托 Jest spec），ts-node 路径仅留档勿运行。
- **新 env 只改 configuration.ts**：Joi schema 未注册时测试/生产校验口径漂移，务必三处同批。
- **实体放错位置**：不放 `modules/**` 下或文件名不以 `.entity.ts` 结尾，CLI 迁移路径加载不到元数据（`data-source.ts` 头注的 AUTH-01 教训）。

## 相关文档

- [../01-apps/admin-api/modules/project.md](../01-apps/admin-api/modules/project.md) · [../01-apps/admin-api/modules/auth.md](../01-apps/admin-api/modules/auth.md)
- [../03-data/migrations.md](../03-data/migrations.md) · [../05-interfaces/rest-api.md](../05-interfaces/rest-api.md)
- [add-new-web-page.md](add-new-web-page.md)（消费端）· [task-board/README.md](task-board/README.md)
- 仓库根 `docs/feature-dev-workflow.md`（既有流程文档）
