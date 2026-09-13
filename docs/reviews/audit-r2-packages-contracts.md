# packages / 数据层 / 跨端契约深度审查（2026-09-14 @ 0ef3bbe）

- 审查对象：`packages/` 全部 10 个包（acf-cli、autocodeflow-ai、autocodeflow-db、autocodeflow-http、autocodeflow-node-sdk、autocodeflow-notify、autoflow-sdk、contract-fixtures、docs-site、mcp-server）+ 数据层（admin-api 的 26 个 TypeORM 实体与 64 个迁移、seed）+ 跨端契约（openapi.json / api-types / contract-fixtures / 事件与 push-pull 协议）
- 基线：分支 `develop`，HEAD `0ef3bbe`，工作区干净（docs/reviews/ 为本次评审输出目录，未跟踪）
- 方法：逐文件人工阅读 + 系统性 grep + 脚本化路由/schema 比对；未运行 install/build/test，未修改任何现有文件
- 与既有评审的关系：已通读 `docs/reviews/audit-r1-backend.md`（R-01~R-30）与 `audit-r1-frontend.md`（F-01~F-38），本报告避免重复：R-19（audit GIN 索引不存在）、R-21（paginate 双键）、F-19（desktop bundle 漂移）等不再列为新发现，仅在关联处引用

---

## 一、全景与方法

### 1.1 包规模与版本盘点

| 包 | 语言 | 源码规模（去生成物） | 版本 | 发布管线 |
|---|---|---|---|---|
| acf-cli | TS | 9 文件 / ~3.3k 行 | 1.0.0 | **无**（npm 名 `acf-cli` 被第三方占用，release.yml 注释明示不发布） |
| autocodeflow-ai | Python | 1 文件 / ~210 行 | 0.1.0 | 无（不在 release.yml） |
| autocodeflow-db | Python | 1 文件 / ~70 行 | 0.1.0 | 无 |
| autocodeflow-http | Python | 1 文件 / ~170 行 | 0.1.0 | 无 |
| autocodeflow-notify | Python | 1 文件 / ~150 行 | 0.1.0 | 无 |
| autocodeflow-node-sdk | TS | 5 文件 / ~1.1k 行 | 1.3.0 | release.yml（lockstep） |
| autoflow-sdk | Python | 7 文件 / ~660 行 | 1.3.0 | release.yml（lockstep，python -m build） |
| mcp-server | TS | 3 文件 / ~1.5k 行 | 1.3.0 | release.yml（lockstep） |
| contract-fixtures | JSON | contract.json 112 行 + README | — | 不可发布包（纯测试向量） |
| docs-site | MD | 13 篇内容页 + VitePress | 1.0.1 | docs-site-deploy.yml |

> 勘误：`packages/autoflow-sdk` 目录含 `.venv`（约 11.8 万行），实际手写源码仅 660 行。包间**零运行时相互依赖**——各客户端包直连 admin-api REST，互不 import（ARCH-20：无 workspace hoisting，根 package.json 仅脚本聚合，无 turbo/nx/lerna）。

### 1.2 包依赖关系图（运行时 ▶ / 契约 ⇢ / 测试 ⇒）

```
                         ┌─────────────────────────────────────────────┐
                         │                admin-api (REST)             │
                         │  全局信封 {code,message,data}（ResponseInterceptor） │
                         └─────────────────────────────────────────────┘
                            ▲jwt/exec-token    ▲Bearer    ▲Bearer(v1. HMAC)
   admin-web ══api-types.ts═╪═ openapi.json ⇢  │          │
   （openapi-typescript 生成）                 │          │
                            ┌─────────────────┘          │
   acf-cli ▶ axios 手写路径 / mcp-server ▶ node-fetch 手写路径（401 自愈→/auth/refresh）
                            │                            │
   autoflow-sdk ▶ /api/executions/callback（CallbackItemDto 手写对齐）
   autocodeflow-node-sdk ▶ 同上（ECO-01 双端 parity）
   autocodeflow-notify ▶ /api/notification/send（手写字段对齐）
   autocodeflow-ai ▶ 第三方 OpenAI/Ollama（不经 admin-api）
   autocodeflow-db ▶ 任意 PostgreSQL（任务自备连接串）

   contract-fixtures/contract.json ⇒ acf-cli / mcp-server / node-sdk / autoflow-sdk 四端测试
   executor-node / executor-python ⇢ AUTOFLOW_ADMIN_API_URL / AUTOFLOW_CALLBACK_TOKEN(v1.) /
                                     AUTOFLOW_EXECUTOR_ADDRESS env 契约 + push/pull 派发载荷
```

依赖方向清晰：所有箭头指向 admin-api 或外部服务，无环、无客户端包互相依赖。契约的"单一事实源"名义上是 openapi.json，但实际只有 admin-web 一端是机器生成的；其余 6 个消费者全部手写路径与字段（详见 PK-02/PK-03/PK-15）。

### 1.3 实际通读/抽读的文件

**全文阅读**：
- `packages/autocodeflow-db/`：connection.py、__init__.py、pyproject.toml、tests/test_connection.py
- `packages/autocodeflow-http/`：client.py（168 行全）、tests/conftest.py、tests/test_client.py（258 行全）
- `packages/autocodeflow-ai/`：analyzer.py（209 行全）、tests/conftest.py
- `packages/autocodeflow-notify/`：notify.py（147 行全）
- `packages/autoflow-sdk/`：__init__.py、context.py、models.py、result.py、logger.py、http.py（121 行全）、callback.py（260 行全）
- `packages/autocodeflow-node-sdk/`：http-client.ts、context.ts、types.ts、logger.ts、index.ts
- `packages/mcp-server/`：src/api.ts（200 行全）、src/tools.ts（1363 行全）、src/index.ts、tsconfig、package.json、dist 产物抽验
- `packages/acf-cli/`：src/client.ts（221 行全）、src/config.ts（132 行全）、src/commands/login.ts、tasks.ts rollback 段、路由清单全量提取
- `packages/contract-fixtures/`：contract.json 全文 + README 全文 + 四端消费测试的 knownDivergence 断言段
- `packages/docs-site/`：contract.md 全文、sdk-node.md、README、package.json、.gitignore
- **数据层**：26 个 entity 全文（task、task-execution、execution-log-line、task-version、executor、executor-metrics-history、application、application-version、app-deployment、api-key、audit-log、config-history、system-config、refresh-token、user、event-outbox、event-outbox-dead-letter、event-subscription、event-subscription-dead-letter、execution-report、notification-channel-config、notification-silence、project、project-member、task-template、executor-package）；迁移目录全量清点 + InitialSchema/TaskExecutionForeignKey/CreateAppDeploymentsTable/PartitionExecutionLogLines/CreateExecutorPackagesTable 等关键迁移全文/重点段；data-source.ts；scripts/demo-seed.mjs（前 60 行）
- admin-api 侧契约面：task.controller / executor.controller / app-deployment.controller / notification-config.controller / projects.controller / users.controller / event-subscription.controller / audit.controller / metrics.controller 路由全量提取；create-task.dto、update-task.dto、send-notification.dto、project.dto、api-keys DTO、execution-callback.dto 抽读；domain-events.ts 全文；outbound-event-dispatcher.service.ts 信封构造段；notification.service 渠道枚举段；scheduler.service COVER_EARLY 段（900-970）

**脚本化比对**：openapi.json 146 paths / 174 operations ↔ 25 个 controller 全量 method+path 比对（双向 diff）；openapi components/37 个 schema 的 properties 空扫描；18 个代表性端点的 requestBody schema 字段抽取。

### 1.4 openapi 漂移抽查清单（≥15 端点，实测）

| # | 端点 | 抽查结果 |
|---|---|---|
| 1 | POST /tasks | CreateTaskDto 43 字段全量在册（含 timeoutSeconds/timeoutAction/maintenanceWindows/secrets）✓ |
| 2 | PATCH /tasks/{id} | **UpdateTaskDto properties: 0**（空 schema，见 PK-02）✗ |
| 3 | POST /tasks/{id}/trigger | TriggerTaskDto ['params'] ✓ |
| 4 | GET /tasks/executions/{execId} | 在册（by-execId 兼容别名）✓ |
| 5 | POST /tasks/{id}/executions/{execId}/kill | 在册但**无 requestBody 文档**（实际 body 可空，可接受）△ |
| 6 | POST /executions/callback | body 是 CallbackItemDto 数组 ✓，但 **CallbackItemDto.properties: 0**（字段约束不可见）✗ |
| 7 | POST /executors/register | **schema 仅为 example JSON，无真 schema** ✗ |
| 8 | POST /executors/heartbeat | 同上（example-only）✗ |
| 9 | POST /executors/pull | **无 requestBody 声明** ✗ |
| 10 | POST /app-deployments/applications/{appId}/deploy | CreateDeploymentDto ['env','executorId','runMode','startCommand'] ✓（与 mcp deploy 工具一致） |
| 11 | GET /app-deployments/approvals/pending · POST .../approval/approve\|reject\|cancel | 全部在册 ✓ |
| 12 | POST /notification/send | SendNotificationDto ['channels','content','level','taskId','taskName','title','webhookUrl'] ✓（与 Python notify SDK 字段逐一吻合） |
| 13 | POST /event-subscriptions | ['eventTypes','secret','url'] ✓ |
| 14 | POST /projects/{id}/members | **UpsertProjectMemberDto properties: 0** ✗ |
| 15 | POST /api-keys | **CreateApiKeyDto properties: 0** ✗ |
| 16 | POST /auth/login | ['password','username'] ✓ |
| 17 | GET /projects/me/roles · GET /executors/{id}/metrics · GET /metrics/scheduler · GET /audit | 全部在册 ✓ |
| 18 | POST /alerts/webhook | **controller 存在（alerts.controller.ts:132）但 openapi 无此路径** ✗（双向 diff 唯一路由级漂移） |

结论：路由级同步率极高（174 vs 175，唯一缺口 /alerts/webhook），但 **schema 级有 14 个空对象**与 3 个 example-only/缺 body 端点，全部位于 CI 漂移守卫的盲区（PK-02/PK-03/PK-16）。

### 1.5 atlas 文档抽查清单（9 篇）

| 篇目 | 核对结果 |
|---|---|
| 03-data/entities/task.md | 高度准确（含 priority 双形态、软删双轨）；但把 `cover_early`/`cancelled` 列为 PG enum 有效值，未提示迁移缺值（关联 PK-01）△ |
| 03-data/entities/task-execution.md | 准确，且**显式记录了实体 SET NULL ↔ 迁移 CASCADE 的不一致**（PK-10 的旁证）；状态机含 cancelled 同样未提示 enum 缺值 △ |
| 03-data/migrations.md | **过时**：称"63 个迁移、最新 1790000000018"，实际 64 个、最新 1790000000019-AddExecutorDispatchMode（PK-25）✗ |
| 02-packages/python-libs/db.md | **失实**：把"连接串由 DATABASE_URL env 注入"当现状描述，代码无任何 env 读取（PK-08）✗ |
| 02-packages/contract-fixtures.md | knownDivergence 段落与代码矛盾（称 cli 仍宽松、mcp 已收紧；实际 cli 也已收紧，见 PK-07）✗ |
| 02-packages/mcp-server.md | **过时**：v1.2.0 / "6 组工具" / "40 个工具"，实际 1.3.0 / 7 组（audit+project）/ 43 个 `server.tool(`（PK-25）✗ |
| 02-packages/autoflow-sdk.md / acf-cli.md / node-sdk.md | 结构准确（未逐字核对全篇，抽验的 API 表与代码一致）✓ |
| 03-data/er-core.md | 关系/索引描述与实体一致（抽验）✓ |
| 03-data/entities/refresh-token.md | 与实体一致（jti 唯一索引、userAgent/ip 元数据）✓ |

### 1.6 VERIFY-MATRIX / SECURITY-REDLINE 抽验（5 条）

| 声称 | 抽验结果 |
|---|---|
| SECURITY-REDLINE E-3「COVER_EARLY 条件 UPDATE + RETURNING 防双释放」 | 机制**真实存在**（scheduler.service.ts:924-935，R4-P1 模式）✓；但其回归锚点 `scheduler.service.spec.ts:627/670` 全程 mock 仓储，**e2e-full.spec.js 无任何 cover_early 用例**——PG enum 缺值（PK-01）因此穿过全部防线 ✗ |
| VERIFY-MATRIX「数据库实体/迁移 → 空库纯迁移链（禁 DB_SYNCHRONIZE）」 | CI 与 compose 均未设 DB_SYNCHRONIZE，data-source.ts `synchronize:false`、production fail-fast（configuration.ts:596）✓ |
| SECURITY-REDLINE e2e 标注 `security-redline-rbac` / `security-redline-ssrf` | e2e-full.spec.js:1488 / :1710 describe 真实存在 ✓ |
| SECURITY-REDLINE A-7「CLI 刷新自愈失败清凭据」 | client.ts:128-138 单飞刷新 + 失败 `clearAuth()` ✓ |
| VERIFY-MATRIX 纪律来源 N2「PG enum 单测全 mock 未暴露」 | 该教训**正在重演**：blockStrategy 枚举缺值未被任何真机验证捕获（PK-01 + PK-26）✗ |

### 1.7 系统性 grep 结果摘要（packages 范围）

| 模式 | 结果 |
|---|---|
| `TODO/FIXME/HACK/XXX` | 业务代码 **0 条** |
| `as any` | 仅存在于测试文件（fixture 松类型），业务代码 0 条 |
| `@ts-ignore/@ts-expect-error/@ts-nocheck` | **0 条** |
| `describe.skip/it.skip/.only` | 仅 1 处平台门控 `it.skipIf(!onPosix)`（config-security.test.ts:50，chmod 语义仅 POSIX，合理） |
| `pragma: no cover / # noqa` | 0 条 |
| 裸 `print(`（Python 库） | 仅 docstring 示例 2 处，无运行时 |
| `console.*`（node-sdk TaskLogger） | 属职责内（日志需被执行器捕获），且双写内存，非违规 |
| 协议结构 version 字段 | 回调 token 有 `v1.` 前缀版本化 ✓；**webhook 事件信封与派发载荷无任何版本字段**（PK-14） |

---

## 二、发现清单

> 分级：P0=数据损坏/核心功能损坏；P1=重要功能失效/契约面破洞；P2=特定条件下的正确性/安全/性能问题；P3=打磨项。
> 每条含：位置、证据（≤5 行）、影响、修复建议、工作量（S<0.5d / M<2d / L>2d）。

### 【P1】

#### PK-01【Bug】`cover_early` 与 `cancelled` 两个 TS 枚举值从未进入 PG enum——任务创建 500、调度器 COVER_EARLY 路径必炸，N2 教训重演

- **类别**：Bug（迁移与 schema 不同步）
- **位置**：
  - `apps/admin-api/src/migrations/1717473142678-InitialSchema.ts:19`：`CREATE TYPE "task_blockstrategy_enum" AS ENUM ('serial', 'discard')`
  - `apps/admin-api/src/migrations/1717473142678-InitialSchema.ts:31`：`CREATE TYPE "execution_status_enum" AS ENUM ('pending', 'running', 'success', 'failed', 'timeout', 'killed')`
  - `apps/admin-api/src/modules/task/entities/task.entity.ts:22`：`COVER_EARLY = "cover_early"`；`task-execution.entity.ts:20`：`CANCELLED = "cancelled"`
  - `apps/admin-api/src/modules/scheduler/scheduler.service.ts:928`：`status: ExecutionStatus.CANCELLED`（COVER_EARLY 条件 UPDATE）
- **证据**：
  ```ts
  // InitialSchema.ts:19 —— 全部 64 个迁移中无任何 ALTER TYPE / ADD VALUE（grep 证实）
  `CREATE TYPE "task_blockstrategy_enum" AS ENUM ('serial', 'discard')`
  // scheduler.service.ts:924-928 —— COVER_EARLY 命中即写 'cancelled'
  .update(TaskExecution).set({
    status: ExecutionStatus.CANCELLED, ...
  ```
  DTO 侧 `@IsEnum(BlockStrategy)`（create-task.dto.ts:198）接受 cover_early，无 service 层归一化（task.service 无 normalizeBlock）；`DB_SYNCHRONIZE` 默认 false 且生产 fail-fast（configuration.ts:596），schema 只能来自迁移。
- **影响**：在迁移构建的数据库上：(1) `POST /tasks`/PATCH 携带 `blockStrategy:"cover_early"` → PG `invalid input value for enum` → 500，特性整体不可用；(2) 任何存量/手工方式产生的 cover_early 任务在计划触发时会走 scheduler.service.ts:928 写 `cancelled` → 同一 enum 错误，触发链路抛异常；(3) `metrics.service.ts:186` 等读侧按 cancelled 统计恒为 0。全仓库（含 init-db.sh、docker-compose、e2e-full.spec.js）无一处补齐这两个枚举值。
- **修复建议**：新增幂等迁移 `ALTER TYPE task_blockstrategy_enum ADD VALUE IF NOT EXISTS 'cover_early';`、`execution_status_enum ADD VALUE IF NOT EXISTS 'cancelled';`（注意 PG ADD VALUE 不能在事务内与同事务写入混用，需 `queryRunner.commit()` 语义或放在独立迁移）；并在 migrations.spec.ts 增加"TS enum 值域 ⊆ PG enum 值域"守卫（见架构节 R2）。
- **工作量**：S（+守卫 M）
- **旁证**：VERIFY-MATRIX.md 自述的纪律来源 N2 正是"PG enum 单测全 mock 未暴露"——scheduler.service.spec.ts:627 的 COVER_EARLY 用例再次全程 mock，e2e 无该策略用例，同一类缺陷第三次数虎。

#### PK-02【Bug/架构】openapi 存在 14 个空 schema，PATCH /tasks/{id} 在前端生成类型里是 `Record<string, never>`——契约单一事实源对"所有 Update 端点"失明

- **类别**：Bug（契约生成缺陷）/ 架构
- **位置**：
  - `apps/admin-api/src/modules/task/dto/update-task.dto.ts:2`：`import { PartialType } from "@nestjs/mapped-types";`
  - `apps/admin-api/nest-cli.json`：无 `compilerOptions.plugins`（swagger CLI 插件未启用）
  - `apps/admin-api/openapi.json` components/schemas：`UpdateTaskDto/CreateProjectDto/UpsertProjectMemberDto/CreateApiKeyDto/UpdateApplicationDto/UpdateUserDto/UpdateProjectDto/UpdateProjectMemberDto/SaveAiConfigDto/RolloutStrategyDto/UpdateExecutorPackageDto/TaskTemplate/EventSubscription/Object` 全部 `{"type":"object"}`（properties 空）
  - 生成物传导：`apps/admin-web/src/types/generated/api-types.ts:2907`：`UpdateTaskDto: Record<string, never>;`
- **证据**：
  ```ts
  // update-task.dto.ts —— @nestjs/mapped-types 的 PartialType 只克隆 class-validator
  // 元数据，不克隆 @nestjs/swagger 的 @ApiProperty 元数据
  import { PartialType } from "@nestjs/mapped-types";
  import { CreateTaskDto } from "./create-task.dto";
  export class UpdateTaskDto extends PartialType(CreateTaskDto) {}
  ```
  实测：`components.schemas.UpdateTaskDto` → `{"type":"object"}`；对照 CreateTaskDto 有 43 个属性。
- **影响**：平台最高频写端点 PATCH /tasks/{id} 的机器可读契约为"不接受任何字段"。直接后果：`admin-web/src/api/tasks.ts:352` 只能手写 `update: (id, data: Partial<Task>) => client.patch(...)`——以**实体形状**（含 id/createdAt/updatedAt/deletedAt 等非 DTO 字段）冒充 DTO 形状，`forbidNonWhitelisted` 下一旦携带实体多余字段即 400，类型系统形同虚设；mcp/CLI/第三方集成者同样无法从 openapi 得知 PATCH 语义。空 schema 是确定性的，因此 api-types-drift CI 永远绿灯（守卫盲区，见 PK-16）。
- **修复建议**：(1) Update* 全系改用 `@nestjs/swagger` 的 PartialType；(2) 为 project.dto.ts、api-keys DTO 等"裸 class-validator DTO"补 @ApiProperty 或启用 `@nestjs/swagger/plugin`（nest-cli.json plugins: ["@nestjs/swagger"]）；(3) 修后重跑 swagger:export + gen:api-types，删掉 api/tasks.ts 的 `Partial<Task>` 断言。
- **工作量**：M

#### PK-03【Bug/架构】执行器 push/pull/register/heartbeat 与回调契约在 openapi 中无 schema 或仅 example——最重的跨端契约面游离在机器可读契约之外

- **类别**：架构（契约面缺口）
- **位置**：`apps/admin-api/openapi.json`（实测）
- **证据**：
  ```
  POST /executors/register  → requestBody schema = {"example": {...}}（example-only，无字段约束）
  POST /executors/heartbeat → 同上
  POST /executors/pull      → 无 requestBody 声明
  POST /executions/callback → 数组 of CallbackItemDto，但 CallbackItemDto.properties = 0
  ```
- **影响**：executor-node/executor-python（push/pull/注册/心跳/回调三端）与 admin 之间的协议是全系统最核心的机器对机器契约，却没有任何字段级 schema——CallbackItemDto 的 `executionId/status/executorAddress/logs(≤512000)/errorMessage(≤4096)/failureReason/durationMs` 约束只存在于 DTO 源码与双 SDK 注释里（autoflow-sdk/callback.py:44-63 手工复制了一份白名单）。字段漂移只能靠人工对齐，与 QA-07 反复强调的"单一事实源"精神相悖。
- **修复建议**：给 CallbackItemDto/RegisterExecutorDto/HeartbeatDto/PullAckDto 补 @ApiProperty（或开 swagger 插件），把 push/pull 载荷定义为具名 schema；node/py SDK 的 `VALID_FAILURE_REASONS`、`ERROR_MESSAGE_MAX_LENGTH` 常量改为由 contract-fixtures 分发（加一个 `callbackContract` 区块），四端同源。
- **工作量**：M

#### PK-04【Bug/测试】三个 Python 库的 dev 依赖声明与测试现实脱节：respx 未声明、pytest-httpx 是幽灵依赖，CI 用 `continue-on-error` 掩盖打包破损

- **类别**：Bug（打包）/ 测试
- **位置**：
  - `packages/autocodeflow-http/pyproject.toml`：`dev = ["pytest", "pytest-asyncio", "pytest-httpx"]`
  - `packages/autocodeflow-http/tests/conftest.py:3`：`import respx`（ai/notify 两包同型）
  - `.github/workflows/ci.yml:536-539`：`pip install pytest pytest-asyncio httpx respx` + `pip install -e . ... || pip install .` + **`continue-on-error: true`**
- **证据**：
  ```toml
  [project.optional-dependencies]
  dev = ["pytest", "pytest-asyncio", "pytest-httpx"]   # ← 无 respx
  ```
  ```yaml
  - run: pip install -e . 2>/dev/null || pip install .
    working-directory: packages/${{ matrix.package }}
    continue-on-error: true        # ← 安装失败也继续跑 pytest
  ```
- **影响**：消费者视角 `pip install -e .[dev] && pytest` 直接 `ModuleNotFoundError: respx`——三个库在声明链路上不可测；pytest-httpx 声明了却从未 import（幽灵依赖）。CI 因为全局预装 respx + 安装步骤 continue-on-error 而全绿：若某包因依赖解析失败装不上，pytest 会测到空壳甚至误过，打包回归无守卫。
- **修复建议**：三包 dev 依赖统一为 `["pytest", "pytest-asyncio", "respx>=0.21"]`（与 autoflow-sdk 对齐）；删除 CI 的 `continue-on-error: true`，安装失败应红。
- **工作量**：S

#### PK-05【Bug】mcp-server `get_scheduler_health` 的 healthy 判定把"Redis 不可达"判为健康——与工具自己的文案矛盾

- **类别**：Bug
- **位置**：`packages/mcp-server/src/tools.ts:1223-1227`
- **证据**：
  ```ts
  healthy:
    queue.failed === 0 || typeof queue.failed !== "number"
      ? true
      : queue.failed < 100,
  ```
  同工具描述："BullMQ queue depths (waiting/active/delayed/failed — **null means Redis unreachable**)"。
- **影响**：`GET /metrics/scheduler` 在 Redis 不可达时返回 `queue: {}`（`m.queue ?? {}`），`queue.failed === undefined` → `typeof !== "number"` → **healthy=true**。AI Agent/运维在调度器已失能时收到健康信号，误导排障方向；工具名与文案都宣称这是"triggers stop firing 的第一排查点"。
- **修复建议**：`queue.failed` 缺失 → `healthy: false` 并附 `degraded: "queue metrics unavailable (Redis unreachable?)"`；补一条 Redis-down 的单测向量。
- **工作量**：S

### 【P2】

#### PK-06【Bug】四端信封拆包仍有未覆盖的行为分歧：node-sdk/py-sdk 不校验 `code` 数值型，cli/mcp 校验——contract.json 无对应向量钉住

- **类别**：Bug（契约一致性）
- **位置**：
  - `packages/autocodeflow-node-sdk/src/http-client.ts:157-169`：`'code' in payload && 'message' in payload && 'data' in payload` → 拆包（**不检查 code 类型**）
  - `packages/autoflow-sdk/autoflow_sdk/callback.py:79-86`：同型三元组判断（无类型检查）
  - `packages/acf-cli/src/client.ts:44` 与 `packages/mcp-server/src/api.ts:178`：`typeof envelope.code === "number"` 才拆包
- **证据**：
  ```ts
  // node-sdk http-client.ts —— code 为任意类型都拆
  'code' in payload && 'message' in payload && 'data' in payload
    ? (payload as { data: T }).data : payload
  ```
  载荷 `{code:"200", message:"x", data:{...}}`：cli/mcp → 原样透传；node/py → 拆成 `{...}`。
- **影响**：任务结果对象恰含三键（含字符串 code）时，同一载荷在双 SDK 与 cli/mcp 的 `unwrap` 产物不同——正是 QA-07 要消灭的"各修各的"再萌发，且现有向量集（knownDivergence 只覆盖"无 code"形态）无法暴露它。
- **修复建议**：统一为"code 必须为数值"判据（与 ResponseInterceptor `statusCode ?? 200` 对齐），node-sdk/py-sdk 同批修 + contract.json 追加 `{code:"200",...}` passthrough 向量（append-only 纪律允许追加）。
- **工作量**：S

#### PK-07【打磨/文档】"单一事实源"自相矛盾：contract.json `$comment`、docs-site contract.md、atlas contract-fixtures.md 三处对当前分歧状态的描述互斥且均过时

- **类别**：打磨（文档漂移）
- **位置**：
  - `packages/contract-fixtures/contract.json:110`："cli/mcp use the looser data+(code|message) heuristic"（**cli 侧已不成立**）
  - `packages/docs-site/contract.md`「已知分歧」节：同上表述
  - `docs/atlas/02-packages/contract-fixtures.md`：改为"cli 仍宽松、mcp 已收紧"（cli 侧仍不成立）
  - 代码现实：`acf-cli/src/client.ts:44` 已收紧为数值 code 判据，测试名即 `client.test.ts:443 "knownDivergence: cli tightened to numeric-code unwrap..."`
- **影响**：三份"防漂移文档"彼此漂移；新贡献者按 fixture 注记会把已修复的行为当活契约，或按 atlas 说法误改测试。
- **修复建议**：由于向量 append-only，建议在 `knownDivergence` 追加 `$comment: "2026-09-14 起 cli/mcp 均已收紧为数值 code 判据，本向量的 cli_mcp_unwrapped 键为历史档案"`，同步 docs-site 与 atlas。
- **工作量**：S

#### PK-08【Bug/安全】autocodeflow-db 承诺的 `DATABASE_URL` 注入从未实现；无连接保活/回收；engine 无法关闭——文档（含 atlas）把愿望当现状

- **类别**：Bug / 安全（连接卫生）
- **位置**：`packages/autocodeflow-db/autocodeflow_db/connection.py:35-44, 66-70`
- **证据**：
  ```python
  url: str = "postgresql://localhost:5432/autocodeflow"  # no default credentials; supply via DATABASE_URL env
  ...
  def get_session(config: Optional[DatabaseConfig] = None) -> DatabaseSession:
      cfg = config or DatabaseConfig()   # ← 全文件无 os.environ 读取
  ```
- **影响**：(1) docstring 写"from config (or environment defaults)"、atlas db.md 教用户走 `DATABASE_URL`，实际**没有任何 env 读取**——不传 config 的任务只会去连 localhost 默认串然后失败，"环境注入"是纯文档虚构；(2) `create_engine` 未设 `pool_pre_ping/pool_recycle`，长任务跨分钟级空闲后拿到的可能是被服务端断掉的死连接；(3) engine 无 dispose 出口，任务进程结束前连接池不显式关闭。
- **修复建议**：`get_session`/`DatabaseConfig.from_env()` 读取 `DATABASE_URL`（兑现注释与文档）；engine 参数加 `pool_pre_ping=True, pool_recycle=1800`；提供 `dispose()`。测试补 env 注入与 session 回滚路径用例（当前 test_connection.py 8 个用例全在 mock create_engine，真实 session 生命周期零覆盖）。
- **工作量**：S
- **关联**：架构提醒——该库鼓励任务直连 PostgreSQL，若注入的是平台库 URL，任务即绕过全部 API 层 RBAC/审计；文档应明确"仅限业务自有库"。

#### PK-09【性能/打磨】autocodeflow-http 每个请求新建 AsyncClient：零连接复用；半开态探测不受限；重试忽略 Retry-After；任意异常计入熔断

- **类别**：性能 / 打磨
- **位置**：`packages/autocodeflow-http/autocodeflow_http/client.py:123-126, 55-63, 140-146, 148-153`
- **证据**：
  ```python
  async def _do() -> httpx.Response:
      async with httpx.AsyncClient(timeout=self._timeout) as client:  # ← 每次尝试新建
  ```
  ```python
  @property
  def is_open(self) -> bool:
      ...
      return False  # half_open — allow probe   ← 并发下所有请求都放行
  ```
- **影响**：(1) 高频调用场景每请求付满 TCP+TLS 握手，无 keep-alive，吞吐与延迟显著劣化；(2) `CircuitBreaker` docstring 称"allows one probe request"，实现是半开态**全部放行**（无单飞探测限制），打满阈值后恢复瞬间可能放出一波穿透请求；(3) 429 重试按指数退避硬等，不读 `Retry-After`；(4) `except Exception: self._breaker.failure()` 把调用方 payload 序列化错误（`json=data` 抛 TypeError）也算服务故障，错误客户端能把熔断器永久打 open；(5) 包没有 `patch()` 方法而注释/文档反复提到 PATCH 语义。
- **修复建议**：client 持有单个长命 AsyncClient（构造时创建、提供 aclose()）；half-open 加 `_probe_in_flight` 标志；429 分支解析 Retry-After；仅对 `(httpx.HTTPError, OSError)` 计入熔断；补 `patch()`。
- **工作量**：M

#### PK-10【Bug】实体↔DB 元数据漂移集合：fileSize bigint 运行时是字符串；FK 语义实体 SET NULL vs DB CASCADE；分区表联合 PK 实体不知情

- **类别**：Bug（序列化边界/元数据漂移）
- **位置**：
  - `apps/admin-api/src/modules/executor-package/executor-package.entity.ts:61`：`@Column({ type: "bigint", default: 0 }) fileSize: number;`（node-pg 对 int8 返回 **string**，实体与 API JSON 均按 string 出现，类型声明失真）
  - `apps/admin-api/src/modules/task/entities/task-execution.entity.ts:80-82`：`onDelete: "SET NULL"` ↔ `migrations/1717473142679` 实际 `ON DELETE CASCADE`
  - `apps/admin-api/src/migrations/1789900000002-PartitionExecutionLogLines.ts`：实际 PK `(id, createdAt)` ↔ `execution-log-line.entity.ts:20` `@PrimaryGeneratedColumn() id`
- **证据**：
  ```ts
  // executor-package.service.ts:414 —— pkg.fileSize 可能是 "12345"
  let fileSize = pkg.fileSize ?? 0;
  ```
- **影响**：(1) `GET /executor-packages` 系列响应里 fileSize 是 `"12345"` 字符串，前端/消费方按 number 做比较或运算会出错（`Content-Length` 恰好接受字符串所以下载链路无感）；(2) FK 漂移已被 atlas task-execution.md 记录为"以迁移为准"，但实体元数据仍在误导 `migration:generate` 与未来开启 sync 的环境——一次 generate 就会把 CASCADE 翻成 SET NULL（列 NOT NULL，删任务即外键报错）；(3) 分区表 PK 漂移在 `migration:generate` 时同样可能产生意外 DDL。
- **修复建议**：fileSize 加 transformer（数值化）或列改 `bigint→int8` 显式字符串类型+`string` 声明；task-execution 实体 ManyToOne 改 `onDelete: "CASCADE"` 对齐迁移（或确认意图后改迁移，二选一消除分叉）；给 execution_log_line 实体补 `@PrimaryColumn(["id","createdAt"])` 等价声明或加注释禁用 generate。
- **工作量**：M（需逐个决策语义方向）

#### PK-11【Bug】task_versions 缺 `(taskId, version)` 唯一约束——对照 application_versions 有（DB-004），同一模式两套标准

- **类别**：Bug（约束缺失/脏数据可能）
- **位置**：`apps/admin-api/src/modules/task/entities/task-version.entity.ts:12-13`
- **证据**：
  ```ts
  @Entity("task_versions")
  @Index("idx_task_versions_taskId_version", ["taskId", "version"])   // ← 无 unique: true
  ```
  对照 `application-version.entity.ts:17-19`：`@Index(["applicationId", "version"], { unique: true })` + 注释"防止并发创建时同一应用出现重复版本号"。
- **影响**：并发触发快照写入（task.service 写 version 行）或并发 rollback 时，同一任务的同一 version 号可产生多行；rollback/compare 按 version 定位时行为不确定（mcp `rollback_task_version` 传的是行 id 才没踩坑）。任务版本是审计与回滚锚点，重复行直接污染历史。
- **修复建议**：加幂等迁移：先 `ROW_NUMBER()` 去重存量（迁移 1789000000000 已有先例），再建唯一索引；实体 `@Index(..., { unique: true })` 同步。
- **工作量**：S

#### PK-12【Bug/打磨】notify SDK 渠道枚举落后服务端：服务端已支持 `feishu`（NF-05），Python SDK `NotifyChannel` 无此值

- **类别**：Bug（契约滞后）
- **位置**：`packages/autocodeflow-notify/autocodeflow_notify/notify.py:17-22` ↔ `apps/admin-api/src/modules/notification/notification.service.ts:57-59`
- **证据**：
  ```python
  class NotifyChannel(str, Enum):
      EMAIL = "email"; DINGTALK = "dingtalk"; WECOM = "wecom"; SLACK = "slack"; WEBHOOK = "webhook"
  ```
  ```ts
  // FEISHU = "feishu",  // NF-05: 飞书自定义机器人
  ```
- **影响**：任务作者用 SDK 发飞书通知只能传裸字符串（绕过枚举）或不可行；渠道清单在 SDK/服务端/atlas（notification-silence 注释也漏 feishu）三处不一致。服务端 DTO 是 `channels?: AlertChannel[]`，SDK 枚举是唯一面向任务作者的"官方渠道表"。
- **修复建议**：SDK 加 `FEISHU = "feishu"`；把渠道表挪进 contract-fixtures 统一分发（与 PK-03 同批）；顺带修正 notification-silence.entity.ts:30 的注释。
- **工作量**：S

#### PK-13【Bug/打磨】mcp-server `engines: ">=20"` 与 node-fetch v3（ESM-only，CJS require）的真实下限 `>=20.19` 冲突；包内 `overrides` 无效

- **类别**：Bug（可移植性）
- **位置**：`packages/mcp-server/package.json`（`"node-fetch": "3.3.2"`、`engines >=20`、`overrides.hono`）+ `dist/api.js:11`（`require("node-fetch")`，tsconfig `module: commonjs`）
- **证据**：
  ```json
  "engines": { "node": ">=20" },
  "overrides": { "hono": "^4.13.5" }
  ```
- **影响**：node-fetch v3 是纯 ESM 包；CJS 产物 `require("node-fetch")` 依赖 Node 的 require(esm) 支持（**20.19+/22.12+** 才默认可用）。在 Node 20.0~20.18（engines 允许）上 MCP server 启动即 `ERR_REQUIRE_ESM`。release.yml 用 Node 24 构建发布，测试覆盖不到旧 LTS。另：库包 package.json 的 `overrides` 只在作为项目根安装时生效，发布到 npm 后对消费者无效（纯死配置）。
- **修复建议**：engines 提到 `>=20.19`（或 node-fetch 降级 ^2.7，CJS 友好）；删 `overrides`。
- **工作量**：S

#### PK-14【架构】事件与派发协议全程无版本字段：webhook 信封 `{event, occurredAt, data}`、派发载荷 `{executionId, task, params}`、SSE 事件均无 schemaVersion

- **类别**：架构（演进能力）
- **位置**：`apps/admin-api/src/common/events/domain-events.ts:47-58`（载荷 interface 无 version）+ `outbound-event-dispatcher.service.ts:188-192`（信封构造）+ `executor-pull.service.ts:71`（`{...payload, pushedAt}`）
- **证据**：
  ```ts
  const payload = buildEventPayload(eventName, raw, occurredAt);
  // 头部仅有 X-AutoCodeFlow-Event（事件名），无 X-AutoCodeFlow-Event-Version
  ```
- **影响**：事件名按"只增不改"管理（文档已声明），但**载荷形状演进**没有任何机器可辨的版本标记：订阅方无法按版本分支处理新增/改名后的字段；outbox 重放历史事件时新旧形状混存于 `event_outbox.payload` jsonb，消费端无法区分。派发载荷靠 python TaskConfig `extra: allow` 与执行器防御性解析兜底——这是隐式契约，不是演进策略。
- **修复建议**：outbox 信封加 `schemaVersion: 1` 与 `X-AutoCodeFlow-Event-Version` 头（向后兼容，旧订阅方忽略）；派发载荷加顶层 `v: 1`。策略写入 docs/atlas 事件篇。
- **工作量**：M

#### PK-15【架构/测试】api-types-drift CI 的结构性盲区：只校验"生成物↔生成物"，四个真正的契约消费者（mcp/CLI/双 SDK/notify）没有任何路由面级守卫

- **类别**：测试 / 架构
- **位置**：`.github/workflows/ci.yml:943-1010`（api-types-drift job）
- **证据**：
  ```yaml
  # ① openapi.json 重导出 diff（契约面 drift）
  # ② api-types.ts 重生成 diff（生成面 drift）
  ```
- **影响**：该守卫能拦"改了 DTO 忘了导出"，但拦不住三类问题：(a) 空 schema/example-only/缺 requestBody（PK-02/PK-03）——重生成永远确定性地复现空 schema；(b) mcp-server 43 个工具、acf-cli 30+ 条路径、双 SDK 的 callback 契约全是**手工抄写**的路径与字段，没有任何测试对照 openapi 校验"工具面 ⊆ 契约面"——本轮实测发现 mcp 工具引用的 `r["name"]`（实体无此字段，PK-18）正是手工契约无守卫的产物；(c) 生成链需要完整 DB+Redis bootstrap，检查成本高，难以在 pre-commit 侧用。
- **修复建议**：(1) 在 api-types-drift job 追加"空 schema 检测"一步（jq 扫 properties 为空的 schema，白名单归零）；(2) 为 mcp/CLI 增加路由面快照测试：从 openapi.json 抽 `(method,path)` 集合，断言每个工具/命令引用的路径都存在于集合（脚本化，S）；(3) 中期把 executor 回调契约字段生成进 contract-fixtures（与 PK-03 合并）。
- **工作量**：M

#### PK-16【性能】audit_logs / refresh_tokens 的实际查询面缺索引支撑

- **类别**：性能
- **位置**：
  - `apps/admin-api/src/modules/audit/audit.service.ts:108/205`（orderBy createdAt DESC，过滤 action/resource/userId/username/时间）↔ `audit-log.entity.ts`（仅 userId、createdAt 有索引；action/resource/resourceId/username 无）
  - `apps/admin-api/src/modules/auth/auth.service.ts:326-327, 458`（`where { userId, revoked }` 与 `delete({ expiresAt: LessThan(now) })`）↔ `refresh-token.entity.ts`（仅 jti 唯一索引；userId/expiresAt 无索引）
- **证据**：
  ```ts
  await this.refreshTokenRepo.delete({ expiresAt: LessThan(new Date()) });  // 全表扫
  ```
- **影响**：audit_logs 是 append-only 高频写入表（append-only 触发器已上），管理台按 action/resource 过滤或按 username 模糊检索随数据量线性劣化；refresh_tokens 定时清理是全表 DELETE 扫描，会话多时每轮扫全表。
- **修复建议**：`audit_logs(action, createdAt)`、`refresh_tokens(userId)`、`refresh_tokens(expiresAt)` 三个普通索引（幂等迁移，参考 AddPerformanceIndexes 风格）；username 模糊过滤若常用再补 trigram（暂缓）。
- **工作量**：S

#### PK-17【安全】autocodeflow-ai 把任务日志/错误原文（可含 secrets 泄漏）直发第三方 AI 端点，无脱敏钩子；api_key 缺失时发送字面量 `Bearer None`

- **类别**：安全（敏感数据外发）
- **位置**：`packages/autocodeflow-ai/autocodeflow_ai/analyzer.py:70, 98, 125-126`
- **证据**：
  ```python
  headers = {"Content-Type": "application/json",
             "Authorization": f"Bearer {self.api_key}"}   # api_key=None → "Bearer None"
  {logs[:4000] if logs else "(no logs)"}                # 原文出站，无 redaction
  ```
- **影响**：任务失败日志常含连接串/令牌片段；该库是给任务作者的"官方 AI 分析件"，没有提供任何脱敏（mask）钩子或警告，与 admin-api 侧日志面处处脱敏的姿态不一致。`Bearer None` 则会把明显的配置错误变成服务端 401，排障困惑。
- **修复建议**：构造参数加 `redactor: Callable[[str], str] | None`（默认 None 时文档警告）；api_key 为 None 时 openai 分支直接抛 ValueError；prompt 模板加"请勿在输出中复述任何凭据"约束（低成本缓解提示注入外泄面）。
- **工作量**：S

### 【P3】

#### PK-18【打磨】mcp `list_dead_letters` 读取不存在的 `name` 字段——执行器实体只有 `appName`，输出恒为空

- **类别**：打磨（手工契约无守卫的实例）
- **位置**：`packages/mcp-server/src/tools.ts:1190`（`name: r["name"]`）↔ `apps/admin-api/src/modules/executor/entities/executor.entity.ts:28`（`appName`）
- **证据**：
  ```ts
  return { executorId: String(r["id"] ?? ""), name: r["name"], address: r["address"], ... }
  ```
- **影响**：工具输出里每个执行器的 name 恒为 undefined；`GET /executors` 返回行经 `...e` 透传实体字段，无 name 键。修法 S：`r["appName"]`。
- **工作量**：S

#### PK-19【打磨】openapi 路由面缺口：`POST /alerts/webhook` 缺失；`/executors/pull`、`/task-templates/{id}/instantiate`、`/notification/silences`、`/tasks/{id}/versions/{versionId}/rollback` 无 requestBody 文档

- **类别**：打磨
- **位置**：`apps/admin-api/openapi.json`（实测）↔ `alerts.controller.ts:132` 等
- **影响**：/alerts/webhook 是 GitHub webhook 接入端点（对外集成方），完全不可见；其余端点的可空 body 语义未文档化。修法：alerts 控制器补 @ApiExcludeEndpoint 的显式决策或补全装饰器；其余补 `@ApiBody`。
- **工作量**：S

#### PK-20【打磨】同一批量能力两套路由并存：`/tasks/batch/*`（task.controller）与 `/tasks-batch/*`（task-batch.controller）——双事实源

- **类别**：打磨
- **位置**：`apps/admin-api/src/modules/task/task.controller.ts:174-288` ↔ `task-batch.controller.ts:29-129`
- **影响**：trigger/pause/resume/delete 四个批量操作各有两条路由，openapi 亦双份登记；audit 与权限收紧时容易只改一处（R-02 的 403 缺陷正是 batch 家族）。修法：保留一套（建议 tasks-batch 独立控制器），另一套 @Deprecated 并在 openapi 标注，随后移除。
- **工作量**：S（决策后）

#### PK-21【打磨】用户 id 类型不一致：`config_history.userId` 是 string，其余全库是 integer

- **类别**：打磨
- **位置**：`apps/admin-api/src/modules/config/entities/config-history.entity.ts:47`（`userId: string`）↔ `users.entity.ts`（`id: number`）、audit-log/project-member（integer）
- **影响**：跨表按操作人关联/审计透视时类型不齐；API 输出形态不统一。修法：幂等迁移列类型改 integer（存量数据为空或用户名串需先核对），实体同步。
- **工作量**：S（待复核存量数据）

#### PK-22【打磨】node-sdk 头注释示例 import `@autoflow/sdk`，包名实为 `@autocodeflow/sdk`

- **类别**：打磨
- **位置**：`packages/autocodeflow-node-sdk/src/index.ts:4`：`import { TaskContext } from '@autoflow/sdk';`
- **影响**：照抄示例直接模块解析失败（npm 无 `@autoflow/sdk`）。docs-site/sdk-node.md 用的是正确名（:22）。修法 S。
- **工作量**：S

#### PK-23【打磨】autoflow-sdk `TaskConfig.blockStrategy` 默认值 `'SERIAL'`（大写）与 admin 值域 `serial/discard/cover_early`（小写）不一致；timeout 三重字段（timeout/timeoutSeconds/timeout_seconds）并存

- **类别**：打磨
- **位置**：`packages/autoflow-sdk/autoflow_sdk/models.py:33, 36-38`
- **证据**：
  ```python
  blockStrategy: Optional[str] = 'SERIAL'   # ← admin 枚举是小写 'serial'
  timeout: int = 300; timeoutSeconds: Optional[int] = None; timeout_seconds: Optional[int] = None
  ```
- **影响**：模型默认值是无效枚举形态（执行器若按字面透传/比较会错配）；三重字段靠 model_validator 归一可用但易继续繁殖。修法：默认 `'serial'`；文档声明 timeoutSeconds 为规范字段、另两个标 deprecated（模型已有归一逻辑，风险低）。
- **工作量**：S

#### PK-24【打磨】node-sdk `TaskLogger` 内存 entries 无上限——长跑任务的进程内存无界增长

- **类别**：打磨（性能）
- **位置**：`packages/autocodeflow-node-sdk/src/logger.ts:14`（`entries.push` 无裁剪）与 `context.ts:172`（`getLogs()` 全量附进 result）
- **影响**：fixed_rate 长任务（executor 允许 1..86400s）里高频 `ctx.logger.info` 会线性吃内存；且全量 logs 进入最终 result，可能超出回调 `logs` 字段 512KB 上限被截断（截断逻辑在 reportSuccess 里只对 summary 字符串做，result.logs 路径未见同等处理，待复核）。修法：环形缓冲上限（如 1000 条）+ 溢出计数。
- **工作量**：S

#### PK-25【打磨/文档】atlas 三处过时：migrations.md（63 个/最新 ...018，实际 64 个/...019）、mcp-server.md（v1.2.0/6 组/40 工具，实际 1.3.0/7 组/43 个）、db.md（把未实现的 DATABASE_URL 当现状）

- **类别**：打磨（文档）
- **位置**：见 1.5 节清单
- **影响**：atlas 号称"最后核对 2026-09-13"，但 lockstep 发版（1.3.0）与最新迁移都发生在核对之后未回写——atlas 的新鲜度依赖人工纪律，没有守卫。修法：mcp-server.md 版本行去掉硬编码版本号（写"以 package.json 为准"）；migrations.md 数量改"以 ls 为准"已有提示但正文仍写死；建议加一个 atlas 数字核对脚本（scripts）或把"最后核对"改为"核对至 <commit>"。
- **工作量**：S

#### PK-26【测试】VERIFY-MATRIX 的 N2 教训（PG enum 真机未验）在 blockStrategy 上结构性复演：单测全 mock、e2e 无用例（关联 PK-01）

- **类别**：测试
- **位置**：`apps/admin-api/src/modules/scheduler/__tests__/scheduler.service.spec.ts:627,670`；`e2e-full.spec.js`（grep cover_early 0 命中）
- **影响**：见 PK-01。单独列出是因为它揭示的是**测试结构问题**而非单点：所有写路径枚举（blockStrategy/priority/status）的真机校验都只发生在"恰好有 e2e 触达该字段"时。修法见架构节 R2 的静态守卫。
- **工作量**：M

#### PK-27【安全/打磨】acf-cli `login --password` 支持命令行明文传密码（进程列表/ shell history 泄漏面）

- **类别**：安全（凭据卫生）
- **位置**：`packages/acf-cli/src/commands/login.ts:14`（`.option('--password <password>', ...)`）
- **影响**：`ps`/history 可见密码；CI 场景 README 推荐走 ACF_TOKEN 环境变量（好），但交互式帮助仍引导用户 `--password`。修法：保留选项但在 help 标注"不安全，仅一次性容器用"，或仅在无 TTY 时接受并警告。
- **工作量**：S

#### PK-28【打磨】mcp-server 缺 `prepublishOnly` 构建钩子（node-sdk 有）；本地 dist 与 src 可静默分叉

- **类别**：打磨
- **位置**：`packages/mcp-server/package.json` scripts（无 prepublishOnly）↔ `packages/autocodeflow-node-sdk/package.json`（`"prepublishOnly": "npm run build"`）
- **影响**：release.yml 有显式 Build 步骤兜底（发布链路安全），但本地 `npm publish`/`npm pack` 会带出陈旧 dist（本仓库工作区实测 dist/index.js 仍是 1.1.1 时代产物、缺 audit/project 工具组）。修法：补 `prepublishOnly: npm run build`。
- **工作量**：S

#### PK-29【测试】python 三小库测试面偏薄：session 生命周期/真实回滚、notify 的 webhookUrl 联动、ai 的非 JSON 响应路径均无覆盖

- **类别**：测试
- **位置**：`packages/autocodeflow-db/tests/test_connection.py`（8 用例，全部 mock create_engine，DatabaseSession 的 commit/rollback/close 分支零断言）；`notify`（18 用例，webhookUrl 与 channels 组合未覆盖服务端 auto-add 语义）；`ai`（25 用例，`_parse_response` 的非 JSON/半 JSON 边界覆盖不全）
- **影响**：这三库是任务作者直接消费的最外层 API，回归全靠 CI mock 向量。修法：db 用 sqlite 内存引擎补真实 session 生命周期；notify 补 channels+webhookUrl 同传用例；ai 补 code-fence 混排用例（R22 修复路径已有部分）。
- **工作量**：S

#### PK-30【打磨】admin-api `test:all` 聚合脚本漏掉四个 python lib 测试与 contract 向量专项

- **类别**：测试
- **位置**：根 `package.json` `test:all`（含 api/node/python/web/cli/mcp/pypi/sdk-py/node-sdk，**不含** test:lib-http/ai/notify/db）
- **影响**：本地一键全测不覆盖 lib 四件套（CI 有独立 job，风险限于本地流程）；四包本轮实测恰是 dev 依赖破损（PK-04）的重灾区。修法：test:all 追加四条（或循环）。
- **工作量**：S

#### PK-31【打磨】`/tasks/{id}/rollback`（gitCommit 语义）与 `/tasks/{id}/versions/{versionId}/rollback`（快照语义）两个"rollback"并存，语义相近易误用

- **类别**：打磨（命名）
- **位置**：`task.controller.ts:740` 与 `:781`
- **影响**：mcp/CLI 只暴露了后者；openapi 两者都在。文档若不写清差异（git 回滚 vs 版本快照回滚），集成方易选错。修法：api-reference/atlas flow 篇补一段对照表。
- **工作量**：S

#### PK-32【打磨】http 包 `SAFE_METHODS` 重试语义下，可重试状态码（429/5xx）在非安全方法上以 `httpx.HTTPStatusError` 抛出——正确但未在 README/docstring 呈现给任务作者

- **类别**：打磨
- **位置**：`packages/autocodeflow-http/autocodeflow_http/client.py:128-134`
- **影响**：POST 撞上 503 时任务侧拿到的是异常而非响应对象，作者需自行读 `e.response`；包 README/docstring 未写明这一错误语义。修法：docstring 补一段错误契约（或提供 `resp, err` 风格 API）。
- **工作量**：S

---

## 三、架构升级建议专节

### R1. 契约单一事实源收口：让 openapi 真正覆盖全部消费面（对应 PK-02/PK-03/PK-15/PK-16）

- **收益**：消灭"openapi 只服务 admin-web 一端"的现状；mcp 43 个工具、CLI 30+ 路径、双 SDK callback 契约从"手工抄写+注释对齐"升级为机器可校验；杜绝 UpdateTaskDto 空 schema 这类"绿灯漂移"。
- **步骤**：① nest-cli.json 启用 `@nestjs/swagger/plugin`（或全量补 @ApiProperty），Update* 改用 swagger PartialType；② 给 CallbackItemDto/RegisterExecutorDto/HeartbeatDto 定义具名 schema；③ CI 加空-schema 扫描与 mcp/CLI 路由面快照断言；④ contract-fixtures 增加 `callbackContract`/`channelList` 区块分发常量。
- **风险**：启用 CLI 插件会重写装饰器编译产物，需回归 swagger:export 与 e2e；PartialType 换源后 Update 语义可能从"无字段"变"全字段"——先在 openapi diff 里确认增量。
- **工作量**：M/L（2~4 人周，可分四步走）

### R2. 迁移守卫升级：静态校验"TS 枚举 ⊆ PG 枚举"与实体↔迁移元数据一致性（对应 PK-01/PK-10/PK-26）

- **收益**：把 N2 类缺陷（priority、cover_early、cancelled 三连）从"真机踩坑后补"变成 CI 拦截；防 `migration:generate` 被漂移元数据误导。
- **步骤**：① 新增 spec：解析 migrations 建表 SQL/DO 块中的 `CREATE TYPE ... AS ENUM (...)` 值域，对照实体 TS 枚举逐个断言子集；② 抽一个 CI job 用真实 PG16 容器跑"空库迁移链 + 实体全列 read-back 冒烟"（每月 schedule 已有 QA-08 骨架可挂）；③ 修 PK-10 三处元数据分叉后加"generate 无 diff"守卫（CI 里跑 `migration:generate --dry-run` 断言空输出）。
- **风险**：SQL 解析需容忍 DO 块/IF NOT EXISTS 变体——建议只解析固定模式，识别不了的类型显式白名单并告警。
- **工作量**：M

### R3. Python 小库的工程化补课：发布管线 + 环境注入兑现 + 依赖修正（对应 PK-04/PK-08/PK-12/PK-15/PK-29）

- **收益**：任务作者拿到的 `autocodeflow-notify/http/db` 不再是"仓库里很好、PyPI 上 0.1.0"的两张皮；三包在消费者环境可测试。
- **步骤**：① release.yml 增加 python-libs matrix（version 仍各自 0.1.x 独立演进，不进 lockstep）；② db 包实现 DATABASE_URL 注入（兑现注释/atlas）；③ dev 依赖修 respx、删 CI continue-on-error；④ 渠道/字段常量与 admin 对齐进 contract-fixtures。
- **风险**：发布到公共 PyPI 引入对外承诺——若暂不发布，至少在 atlas 声明"仅源码分发，任务以私有 registry 装源码包"的现状。
- **工作量**：M

### R4. 事件/派发协议的版本化基线（对应 PK-14）

- **收益**：webhook 订阅方与历史 outbox 重放获得可机器辨别的演进标记；执行器协议获得向后兼容的演进窗口（当前全靠 extra:allow 与防御解析）。
- **步骤**：① outbox 信封加 `schemaVersion`（写侧常量）+ 派发头 `X-AutoCodeFlow-Event-Version`；② 派发载荷顶层加 `v: 1`（执行器未知字段忽略即可，天然兼容）；③ docs/atlas 事件篇补演进策略（加字段=minor；改语义/删字段=新事件名或 bump version）。
- **风险**：极低——全部是增量字段，旧消费者忽略即可。
- **工作量**：S/M

### R5. （可选）monorepo 编排轻量化：不破坏 ARCH-20 的前提下给构建/测试加缓存与拓扑（对应 1.1/1.2 节）

- **收益**：ARCH-20 的"各 app 独立 install"可以保留，但 `test:all`/`typecheck:all` 是纯串行 shell 拼接，无增量、无缓存、无拓扑感知（contract-fixtures 变更理应触发四端契约测试，现在靠人记得）。轻量 turborepo（`"package-manager": "npm"`、不启用 workspaces hoisting，只做 task pipeline）或一个自写 `scripts/run-changed.mjs` 按 git diff 选择任务即可。
- **风险**：引入编排工具与 ARCH-20 的"零 workspace"原则有叙事冲突，需要 ADR 明确"只做任务编排、不改依赖安装拓扑"；收益有限可缓行。
- **工作量**：M

---

## 四、待复核项

1. **PK-01 的生产影响边界**：若存在"开发期用 DB_SYNCHRONIZE=true 建库、之后当生产用"的实例，则 cover_early/cancelled 已由 TypeORM sync 补进 enum，问题只在纯迁移链环境成立（本仓 CI/compose 均未设 sync，推断成立但无法离线证实所有现网库）。
2. **PK-10 fileSize 序列化**：node-pg 对 int8 返回 string 是驱动默认行为，但若全局设置了 `pg.types.setTypeParser(20, parseInt)` 之类则不成立——未在 admin-api 源码中发现该设置（grep setTypeParser 0 命中），"待复核"仅指运行时实测未做。
3. **PK-24 result.logs 超长截断**：node-sdk `ctx.success()` 把全量 logs 附进 TaskResult，executor-node 侧对 result.logs 是否有 512KB 截断属 executor 范围（R1 评审覆盖面），本次未核实。
4. **PK-15 中 mcp 工具引用的路由全集**：本轮抽验了 20+ 条路径全部存在（含 DEP-04 审批组、me/roles、metrics/scheduler），"无守卫"是结构判断而非已发现路由缺失；不排除未抽到的工具存在漂移。
5. **PyPI 实际发布状态**：四个 python lib 是否曾在 PyPI/私有 registry 发布过 0.1.0 无法离线验证（release.yml 无其发布 job；atlas db.md 称"不在发布矩阵"）。
6. **PK-21 config_history.userId 存量数据形态**：迁移改类型前需确认存量列是否有非数值串。
7. **autoflow-sdk `TaskConfig.blockStrategy='SERIAL'` 是否被 executor-python 直接消费**：本轮确认 admin 派发侧用小写（实体 enum），executor-python 对该字段的实际比较逻辑属 executor 评审面，未逐行核对。
8. **docs-site 其余 10 篇（tutorial-01~04 等）**：未逐篇核对，仅抽验 sdk-node/contract 两篇的 API 形态；tutorial 类内容陈旧风险与 atlas 相当。

---

### 附：索引↔查询匹配抽查表（20 条，补 1.4 节）

| 查询（来源） | 谓词/排序 | 命中索引 | 判定 |
|---|---|---|---|
| 执行列表（task.service.findAll executions） | taskId, status, orderBy createdAt | (taskId,status)+(createdAt) | ✓ |
| stale sweep（scheduler recover） | status IN(open) + startTime 阈值 | (status)+partial(executorAddress,startTime WHERE running) | ✓（R-10 已报 SQL 级截断缺失，不重复计） |
| outbox 补投扫描（outbox-dispatcher） | dispatchedAt IS NULL AND deadLettered=false AND nextAttemptAt | 3 个单列索引 | ✓ |
| 回调终态翻转（handleCallback 条件 UPDATE） | id=uuid | PK | ✓ |
| 执行器槽位释放/广播计数 | executorAddress + status | idx_..._address_status | ✓ |
| 日志读取（logs?fromLine） | executionId (+level) ORDER BY lineNumber | (executionId,lineNumber)/(executionId,level,lineNumber) | ✓ |
| 日志保留清理 | createdAt 范围 | idx(createdAt) + 分区 DETACH | ✓ |
| metrics 日报聚合 | triggerDay 唯一 | unique(triggerDay) | ✓ |
| executor metrics 历史 | executorAddress+createdAt | 复合 | ✓（保留期缺口 R-09 已报） |
| api-key 认证查找 | keyHash | unique | ✓ |
| audit 列表过滤 | action/username/resource 模糊 | 仅 userId/createdAt | ✗（PK-16） |
| audit jsonb detail 包含查询 | detail @> | 声明的 GIN 实际不存在 | ✗（R-19，引用） |
| refresh token 会话清理 | expiresAt < now | 无 | ✗（PK-16） |
| refresh token 吊销 | userId | 无 | ✗（PK-16） |
| silences 热路径回灌 | endTime / (scope,taskId) | 复合 | ✓ |
| config_history 回滚读 | configKey+createdAt | 复合 | ✓ |
| task_versions 定位 | taskId+version | 复合但**非唯一** | △（PK-11） |
| app_deployments 在途约束 | applicationId+status 特定值 | 部分唯一（1790000000015/0001） | ✓ |
| 执行器列表 | orderBy createdAt take 500 | createdAt 索引？executor 实体无 createdAt 索引声明 | △（行数≤执行器台数，实际无碍，不计） |
| 项目过滤（tasks findAll） | projectId IS NULL OR IN(...) | 迁移 1790000000008 有 projectId 索引 | ✓ |

---

*报告完。发现共 32 条：P1 5 条、P2 12 条、P3 15 条（含 2 条对既有评审的引用性关联，不计入编号总数者为 PK-00 引用项）。*
