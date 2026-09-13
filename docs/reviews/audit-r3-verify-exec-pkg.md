# 执行器/契约 P1 复核（2026-09-14）

- 复核对象：`docs/reviews/audit-r2-executors-infra.md` 与 `docs/reviews/audit-r2-packages-contracts.md` 的**全部 P0/P1 级发现**（executors 侧无 P0，P1 为 E-01~E-04；packages 侧无 P0，P1 为 PK-01~PK-05），共 9 条。
- 基线：分支 `develop`，HEAD `0ef3bbe`。复核方式：逐条打开报告引用的 file:line 并读取前后 ≥30 行上下文，另对关键结论做了 admin 侧反查（E-01 的 pull 队列语义与回调终态化、E-02 的 admin 派发载荷与 DTO 语义、E-03 的 M3 fail-fast、PK-01 的迁移全量 grep、PK-05 的 getQueueDepth catch 分支）。
- 本文件为唯一新增产物，未修改任何现有文件，未执行 git 操作。

---

## 一、复核总表

| 编号 | 原严重度 | 结论 | 一句话理由 |
|---|---|---|---|
| E-01 | P1 | **确认** | 双端 429→failed 回调证据、admin RPOP 取走即出队、failed 回调即终态化，三点全部实证；仅「必然出现」措辞偏重（实为高峰期高概率竞态）。 |
| E-02 | P1 | **确认** | timeout=0 三种语义（node 不限时 / python 300s 默认杀 / 越界 node 400 vs python clamp 1s）全部实证，且 admin 实体默认 timeout=0 使**默认创建路径**即触发。 |
| E-03 | P1 | **确认** | compose:106 裸端口、:131 默认口令属实；补充影响边界（M3 fail-fast 使零 .env 部署无法启动），风险实质不变。 |
| E-04 | P1（列于【P1】标题下） | **建议改级 P2** | 三处 SSRF 缺口 + 首跳 Bearer 全部证据确凿，但全部位于 verifyToken 之后、URL 由 admin 下发——报告正文自己写明「故定 P2 纵深而非 P1」，与 P1 归类自相矛盾。 |
| PK-01 | P1 | **确认** | InitialSchema:19/:31 枚举缺值、64 个迁移 0 处 ALTER TYPE、DTO 接受 cover_early、scheduler:928 写 cancelled、metrics:186 读 cancelled、单测全 mock、e2e 0 命中，全链实证。 |
| PK-02 | P1 | **确认** | 空 schema 实测 **14 个**（名单与报告逐一吻合）；PartialType 导入源、nest-cli 无插件、api-types.ts:2907、tasks.ts:352、forbidNonWhitelisted 全部属实。 |
| PK-03 | P1 | **部分确认** | register/heartbeat example-only、pull 无 requestBody 三项属实；但「CallbackItemDto.properties=0」**证伪**——实测 9 个属性 + required + failureReason 枚举 + maxLength。 |
| PK-04 | P1 | **确认** | dev 依赖缺 respx（http/ai/notify）、pytest-httpx 幽灵依赖、CI continue-on-error（ci.yml:539）全部属实；仅 conftest.py 行号 3→4 一行之差。 |
| PK-05 | P1 | **确认** | Redis 不可达 → healthy=true 的结论与工具文案矛盾均属实；机制描述有一处勘误（queue 是全 null 对象而非空对象，判定分支相同）；现有测试固化了该错误行为。 |

统计：确认 7 条（E-01/E-02/E-03/PK-01/PK-02/PK-04/PK-05），部分确认 1 条（PK-03），证伪 0 条，建议改级 1 条（E-04 → P2）。

---

## 二、逐条详述

### E-01 pull 派发的容量竞态把「暂时没槽位」变成「任务永久失败」 —— 确认

**报告声称**：pull 循环空槽检查与 admin 领取之间存在窗口，被拉取的执行可能被 429 拒绝并补发 failed 回调，admin 把执行记为失败，任务不重试。位置 `apps/executor-node/src/pull.ts:41-59`、`apps/executor-python/routers/execute.py:740-741` + `apps/executor-python/scheduler.py:240-244`。

**实际代码摘录**：
- `apps/executor-node/src/pull.ts:41-58`（逐行吻合）：
  ```ts
  const accepted = acceptExecution(body as ExecuteRequest, traceparent);
  if (accepted.status !== 200) {
    // 领取被拒（容量竞态/校验失败）：补发 failed 回调，admin 侧不留僵尸
    pushCallback({ executionId: task.executionId, status: 'failed', ... });
  ```
- `apps/executor-node/src/routes/execute.ts:326-329`：`acceptExecution` 容量闸 `if (current >= config.maxConcurrentTasks) { ... return { status: 429, payload: { error: 'Executor is at capacity' } }; }`。
- `apps/executor-python/routers/execute.py:740-741`（行号精确）：`if sched.get_running_count() >= settings.max_concurrent_tasks: raise ExecutionRejected(429, 'Executor is at capacity')`。
- `apps/executor-python/scheduler.py:211`（拉取前空槽检查）与 `:241-244`（`accept_execution` → `except ExecutionRejected` → `reject_pulled_execution(...)` 补发 failed 回调）。报告写 240-244，命中调用点。
- **admin 侧反查（报告列为待复核项，本次已闭环）**：`apps/admin-api/src/modules/executor/executor-pull.service.ts:93` `const raw = await client.rpop(key)` —— 取走即出队，**无可见性超时/回队机制**；`apps/admin-api/src/modules/task/task.service.ts:1894-1907` 收到 `failed` 回调即走原子终态转换 `patch.status = ExecutionStatus.FAILED`，无重试路径。竞态链完整成立。

**判定与理由**：成立。竞态窗口比报告描述的还要宽——node/python 均在长轮询**发起前**检查空槽，admin 端阻塞最长 25s（`waitMs: 25_000`）后才返回任务，此间任何 push 派发都可占走最后一个槽位。唯一措辞问题：「高峰期必然出现」偏重，实为「高峰期高概率、窗口最长达 25s+」。

**测试覆盖/缓解**：测试**固化了问题行为而非覆盖修复**——node `apps/executor-node/src/pull.spec.ts:62-83` 以 `Executor is at capacity` 载荷断言补发 failed 回调；python `apps/executor-python/tests/test_scheduler.py:380-389` 断言 400 拒绝走 `reject_pulled_execution`、`:391-397` 断言容量满跳过拉取。缓解：仅影响 pull 模式（dispatchMode=pull 显式 opt-in）；push 模式 429 走 BullMQ 重试链不受影响。无 feature flag。

**最佳修复落点**：最小改动在两侧 pull 循环——`apps/executor-node/src/pull.ts` 的 `pullOnce()`（41-58 行）对 `accepted.status === 429` 分流（不回调失败，仅 warn）；`apps/executor-python/scheduler.py` pull_task 同点（241-244）。更彻底的方案是 admin 侧按 failureReason 回队：`apps/admin-api/src/modules/task/task.service.ts` `handleCallback` 识别容量拒绝后调用 `ExecutorPullService.enqueue` 重新入队。两方案都需同步修改 `pull.spec.ts:62-83` 与 `test_scheduler.py:380-389` 的固化断言。

---

### E-02 `timeout=0`（不限时）语义两侧不一致 —— 确认

**报告声称**：node 视 0 为显式不限时（+10 年 token TTL），python 视 0 为 falsy 回落 300s 默认后杀；负值/越界 node 400、python clamp 到 1s。位置 `apps/executor-node/src/routes/execute.ts:394-399,641-648,897-899`、`apps/executor-python/routers/execute.py:1549-1552`。

**实际代码摘录**：
- `apps/executor-node/src/routes/execute.ts:397-398`（acceptExecution 内，报告区间内）：
  ```ts
  const rawTimeout = body.task.timeout;
  const timeout = rawTimeout === 0 ? 0 : (rawTimeout as number) || config.taskTimeoutSeconds;
  ```
  `:645-647`（runTask 内同款，注释「timeout=0 = 不限时（不设 kill 定时器）」）；`:897-899` `const TOKEN_TTL_UNBOUNDED_SECONDS = 315_360_000;`。
- `apps/executor-python/routers/execute.py:1549-1552`（行号精确）：
  ```python
  timeout = _clamp_timeout_seconds(
      task.get('timeoutSeconds') or task.get('timeout_seconds') or task.get('timeout') or settings.task_timeout_seconds,
  ```
  `:418-425` `_clamp_timeout_seconds` clamp 到 `[1, 86400]`（0 若直达会变 1s 立即杀）。
- **admin 侧反查**：`apps/admin-api/src/modules/task/dto/create-task.dto.ts:117/126` 两处明文「0 = no limit」；`task.entity.ts:126` `@Column({ type: "int", default: 0 }) timeout: number;` —— **未显式设置 timeout 的任务默认落库 0**；派发载荷原样携带实体（`executor.service.ts:1302/1477/1495` `{ executionId, task, params }`），admin 自己的 dispatch HTTP 超时也是 `task.timeout || 300`（:1338）。即默认创建路径就会向双端发出 `timeout: 0`。

**判定与理由**：成立，且影响面比报告所述更大：不止「显式配了 timeout=0 的任务」，**未配置 timeout 的默认任务**也命中此分叉（node 不限时 vs python 300s 杀 + timeout 失败归类）。报告关于负值第三种语义的旁注也属实（node `:399-401` 400 拒绝；python clamp 1s）。

**测试覆盖/缓解**：两侧测试各自固化了**相反**语义，正是问题本身——node `execute.spec.ts:1082-1086`「timeout=0 → runTask receives Infinity (no kill timer)」；python `tests/test_execute.py:776-785` `test_timeout_clamped` 断言 `_clamp_timeout_seconds(0, 300) == 1`。admin DTO 文档声明 0=no limit 属「文档侧缓解」，代码无归一。无 feature flag。

**最佳修复落点**：`apps/executor-python/routers/execute.py:1549-1552`——把 or-链改为显式取值（`raw = task.get('timeoutSeconds', task.get('timeout_seconds', task.get('timeout')))`, `None → default`），`int(raw) == 0` 时走不限时分支（`_run_and_callback` 的 `asyncio.wait_for(proc.communicate(), timeout=timeout_seconds)` 需支持 `None`），回调 token TTL（:1614 附近）对 0 用 10 年上限对齐 node。同时在两侧 spec 各加一条 `timeout=0` 向量互相 pin。node 侧无需改。

---

### E-03 admin-api 宿主端口绑 0.0.0.0 + 初始管理员默认弱口令 —— 确认

**报告声称**：`docker-compose.yml:105-106` 端口未加 127.0.0.1 前缀、`:131` `INITIAL_ADMIN_PASSWORD` 缺省 `Admin@123456`，新部署可被直接接管。

**实际代码摘录**：
- `docker-compose.yml:106` `- '3105:3105'`；`:131` `INITIAL_ADMIN_PASSWORD: ${INITIAL_ADMIN_PASSWORD:-Admin@123456}`（行号精确）。
- 对照面属实：同文件 `:195-196`（minio）、`:230`（executor-python 8001）、`:282`（executor-node 8002）、`:335`（registry-pypi 8003）、`:364`（registry-npm 4873）、`:401`（otel 4317）**全部** `127.0.0.1` 前缀，仅 admin-api 3105 与 admin-web 80 例外（后者是统一入口，属有意暴露）。
- 执行器回程确认走内网：`docker-compose.yml:239/291` `ADMIN_API_URL: http://admin-api:3105` —— 宿主映射对拓扑非必需，报告论断成立。
- 种子链路：`users.service.ts:49-70` 从 `initialAdmin.password` 种子 admin 账号（bcrypt 12）。

**判定与理由**：成立（P1 维持），补两点影响边界：
1. 报告的「首次 `docker compose up -d` 且未填 .env 即可接管」场景**收窄**：compose 缺省 `NODE_ENV=production`，`apps/admin-api/src/config/configuration.ts:503-553` 的 M3 fail-fast 会因 `DB_PASSWORD`（<16 字符）/`JWT_SECRET`/`JWT_REFRESH_SECRET`/`EXECUTOR_SECRET` 缺失或弱值**直接抛错拒启**——零配置裸 up 时 admin-api 崩溃循环，登录面不存在。真实风险形态是「运维按 .env.example 填齐必填 secrets，但 INITIAL_ADMIN_PASSWORD 留缺省或占位值」——而 `.env.example:217` 恰好给的占位是 `change_me_immediately`，**且 M3 weakValues 名单（含 change_me_immediately、admin123 等）只校验 DB/JWT/EXECUTOR 四项，不含 INITIAL_ADMIN_PASSWORD**。公网可路由 + 可预测口令的组合仍然成立，P1 判断维持。
2. 该缺口与既有安全纪律（S9 loopback-only、M3 fail-fast）的不一致进一步支持修复必要性。

**测试覆盖/缓解**：`configuration.spec.ts:321-328` 测 M3 但不含 admin 口令维度；`users.service.spec.ts:97` 附近有种子测试、无弱口令拒绝路径。部分缓解：M3 fail-fast 间接拦住了完全零配置场景（非针对本问题设计）。

**最佳修复落点**：① `docker-compose.yml:106` 改 `- '127.0.0.1:3105:3105'`（与全文件其余端口一致，一行修复）；② `:131` 去掉缺省值（`${INITIAL_ADMIN_PASSWORD:?set in .env}`）；③ 兜底在 `apps/admin-api/src/config/configuration.ts` M3 块（503 行起）追加 `INITIAL_ADMIN_PASSWORD` 弱值/长度校验（users.service.ts:54 已有「未设置即跳过种子」行为，与强校验兼容）。

---

### E-04 SSRF 闸三处缺口：deploy/update-package 无私网拦截 + 首跳附带共享密钥 —— 证据确认，建议改级 P2

**报告声称**：三处缺口（deploy/update-package 校验只有 scheme、下载链对首跳无条件附带 EXECUTOR_SECRET Bearer、execute.ts 私网正则缺 169.254/IPv6/十进制）。**注意：该发现列于报告【P1】标题之下，但其正文自述「触发前提是 admin 侧权限（packageUrl 由 admin 下发），故定 P2 纵深而非 P1」——归类与正文自相矛盾。**

**实际代码摘录**（全部核实）：
- `apps/executor-node/src/lib/download.ts:107-110`（行号精确）：
  ```ts
  const headers: Record<string, string> = {};
  if (sendAuth && config.token) {
    headers['Authorization'] = `Bearer ${config.token}`;
  }
  ```
  跨跳剥离确认在 `:134` `const nextSendAuth = sendAuth && nextUrl.hostname === new URL(url).hostname;`——首跳无条件、跨跳剥离，与报告描述一致。
- `apps/executor-node/src/routes/deploy.ts:250-260` `validatePackageUrl` 仅校验 scheme；`:433-435` gitRepo 仅校验 scheme/option 字符，无私网正则（对照 execute.ts:372-376 的 `privateIpPattern`，确实存在双侧不对称）。
- `apps/executor-node/src/routes/update-package.ts:69-79` 同款 scheme-only 校验。
- execute.ts 正则确实缺 `169.254.0.0/16`、IPv6 与非点分形态（`execute.ts:376`）。
- python 对照属实：`apps/executor-python/routers/execute.py:1499-1528` 有 S7 守卫且带 `settings.allow_private_network` 开关——node 侧连这个开关都没有。

**判定与理由**：证据全部成立。但三条链（deploy/update-package/download）均挂于 `main.ts:48-49` 的 `verifyToken` 之后，URL 由持 admin 凭据的下发方提供，属纵深防御问题而非权限边界失效。按两份报告各自的分级定义（P1=权限边界失效/任务丢失；P2=特定条件下的安全问题），**应定 P2**——这也是报告正文自己的结论，只是目录归类错了。另注：`download.spec.ts:77-128` 明确断言首跳发送 `Bearer test-shared-token`，说明「首跳带密钥」是**测试固化的有意行为**（信任 admin 下发 URL 的设计假设），修复时需连测试一起改。

**测试覆盖/缓解**：`download.spec.ts:77-128` 固化首跳 Bearer + 跨跳剥离；`deploy.spec.ts:115` 仅测 scheme 拒绝；无私网用例。缓解：verifyToken 门槛 + admin 侧 `assertSafeExecutorUrl`（管的是执行器回程地址，不覆盖 packageUrl）。

**最佳修复落点**：把 `execute.ts:372-376` 的 `privateIpPattern`（补 169.254/IPv6/十进制形态）抽为 `apps/executor-node/src/lib/url-guard.ts` 共享 util，`deploy.ts` `validatePackageUrl`（:250）、`update-package.ts`（:69）、`download.ts` `downloadFile`（:107 之前）三处接入并复用 python 侧 `ALLOW_PRIVATE_NETWORK` 开关语义；`download.ts` 增加可选 `authHosts` 白名单（仅对 admin-api 本机地址附 Bearer），同步更新 `download.spec.ts:77-88`。

---

### PK-01 `cover_early`/`cancelled` 未进入 PG enum —— 确认

**报告声称**：InitialSchema 两个 CREATE TYPE 缺值、全部迁移无 ALTER TYPE、DTO 接受 cover_early、COVER_EARLY 命中写 cancelled 必炸、metrics 读侧恒 0、全 mock 单测 + e2e 零覆盖。

**实际代码摘录**（全部核实）：
- `apps/admin-api/src/migrations/1717473142678-InitialSchema.ts:19` `` `CREATE TYPE "task_blockstrategy_enum" AS ENUM ('serial', 'discard')` ``、`:31` `` `CREATE TYPE "execution_status_enum" AS ENUM ('pending', 'running', 'success', 'failed', 'timeout', 'killed')` ``（行号精确）。
- 迁移目录实测：64 个迁移 + 1 个 spec，`grep -r "ALTER TYPE|ADD VALUE" migrations/` **0 命中**——值域从未补齐。
- `task.entity.ts:22` `COVER_EARLY = "cover_early"`；`task-execution.entity.ts:20` `CANCELLED = "cancelled"`。
- `create-task.dto.ts:196-198` `@IsEnum(BlockStrategy) blockStrategy?: BlockStrategy;`——DTO 接受 cover_early；`task.service.ts` 无 normalizeBlock（grep 0 命中）。
- `scheduler.service.ts:924-935`：COVER_EARLY 命中即 `.set({ status: ExecutionStatus.CANCELLED, ... })` 条件 UPDATE。
- `metrics.service.ts:186` `cancelledCount: statMap[ExecutionStatus.CANCELLED] ?? 0`。
- `configuration.ts:596-599`：生产环境 `DB_SYNCHRONIZE=true` fail-fast——迁移是 schema 唯一来源，报告该前提成立。
- `scripts/check-migrations.mjs` 无任何 enum 校验（grep 0 命中）。

**判定与理由**：成立，证据链完整。影响推演可信：迁移构建库上 `POST /tasks` 带 `blockStrategy:"cover_early"` → PG 22P02 → 500；COVER_EARLY 存量任务触发时写 `cancelled` 同类报错。`scheduler.service.spec.ts:627`（「should cancel running execution when blockStrategy=COVER_EARLY」）确认全程 mock 仓储；`e2e-full.spec.js` cover_early **0 命中**；scripts/e2e-full.sh 亦无。N2「单测全 mock 未暴露」的叙事属实。

**测试覆盖/缓解**：无任何真机校验（单测 mock、e2e 缺失、check-migrations 无枚举逻辑）。无 feature flag/守卫。

**最佳修复落点**：新增迁移 `apps/admin-api/src/migrations/1790000000020-AddCoverEarlyAndCancelledEnumValues.ts`，内容两条 `ALTER TYPE ... ADD VALUE IF NOT EXISTS`（PG16 允许事务内 ADD VALUE，且本迁移不使用新值，无同事务使用限制）；守卫挂 `scripts/check-migrations.mjs` 或新增 spec 断言「TS 枚举值域 ⊆ PG enum 值域」（解析 CREATE TYPE 语句，报告架构节 R2 方案）。

---

### PK-02 openapi 14 个空 schema / UpdateTaskDto 为 `Record<string, never>` —— 确认

**报告声称**：`update-task.dto.ts:2` 用 `@nestjs/mapped-types` 的 PartialType；nest-cli.json 无 swagger 插件；openapi 14 个空 schema（含 UpdateTaskDto 等 14 个具名）；`api-types.ts:2907` `UpdateTaskDto: Record<string, never>`；前端 `tasks.ts:352` 手写 `Partial<Task>`；`forbidNonWhitelisted` 下携带实体字段即 400。

**实际代码摘录**：
- `update-task.dto.ts:2` `import { PartialType } from "@nestjs/mapped-types";`（行号精确）；对照 `create-task.dto.ts` 45 处显式 `@ApiProperty*`——Create 有 schema、Update 生成空，诊断成立。
- `nest-cli.json` 全文仅 `compilerOptions.deleteOutDir`，无 `plugins`。
- **空 schema 实测 14 个**（脚本扫描 `components.schemas`，见「数字实测」节），名单与报告逐字吻合。
- `apps/admin-web/src/types/generated/api-types.ts:2907` `UpdateTaskDto: Record<string, never>;`（行号精确）。
- `apps/admin-web/src/api/tasks.ts:352-353` `update: (id: string, data: Partial<Task>) => client.patch(...)`（行号精确）。
- `apps/admin-api/src/main.ts:188-194` ValidationPipe `{ whitelist: true, forbidNonWhitelisted: true }`——「携带实体多余字段即 400」的机制属实。
- `task.controller.ts:439` PATCH /tasks/{id} 确用 UpdateTaskDto。

**判定与理由**：成立，全部证据与行号精确。api-types-drift job 只做生成物 diff、空 schema 是确定性再生，「守卫盲区」判断成立（ci.yml:943-1010，与 PK-15 引用一致）。

**测试覆盖/缓解**：无。生成链确定性复现，无任何检测点。

**最佳修复落点**：① `apps/admin-api/src/modules/task/dto/update-task.dto.ts:2`（及其余 Update*/裸 DTO）改 `import { PartialType } from "@nestjs/swagger"`；② `apps/admin-api/nest-cli.json` `compilerOptions.plugins: ["@nestjs/swagger"]` 兜住无装饰器 DTO；③ 重跑 swagger:export + gen:api-types，删除 tasks.ts:352 的 `Partial<Task>`；④ `.github/workflows/ci.yml` api-types-drift job 追加空 schema 扫描（jq 扫 properties 为空的具名 schema，白名单归零）。

---

### PK-03 执行器 push/pull/register/heartbeat 契约游离在 openapi 之外 —— 部分确认

**报告声称**：register/heartbeat 的 requestBody 仅 example、pull 无 requestBody、**CallbackItemDto.properties = 0**（1.4 节第 6 行同样断言）。

**实际代码摘录**：
- `openapi.json` 实测：`POST /executors/register` requestBody = `{"example": {...}}`（example-only）✓；`POST /executors/heartbeat` 同 ✓；`POST /executors/pull` **无 requestBody 声明** ✓。源码对照：`executor.controller.ts:104-119`（@ApiBody example-only，body 为内联 TS 类型非 DTO 类）、`:211`（heartbeat 同）、`:300-314`（pull 端点 body 内联类型、无 @ApiBody）。
- **但 CallbackItemDto 证伪**：实测 `components.schemas.CallbackItemDto` 有 **9 个属性**（executionId/status/executorAddress/exitCode/logs/errorMessage/failureReason/durationMs/artifacts），`required: ["executionId","status"]`，failureReason 带完整 enum，errorMessage `maxLength:4096`、logs `maxLength:512000`。我此前的 14 空-schema 扫描名单中也无 CallbackItemDto。报告该子项（含 1.4 表第 6 行）与事实不符——回调契约的「字段约束只存在于 DTO 源码与 SDK 注释」说法不成立。

**判定与理由**：部分确认。三个 executor 端点的契约缺口属实（修复建议仍然必要）；但核心跨端契约之一（回调）实际已有完整机器可读 schema，报告夸大了缺口范围，autoflow-sdk `callback.py` 的手工白名单是「冗余对齐」而非「无 schema 可依」。

**测试覆盖/缓解**：无 schema 级守卫（PK-15 的结构判断仍成立）。

**最佳修复落点**：`apps/admin-api/src/modules/executor/executor.controller.ts`——register（:98）与 heartbeat（:205）把内联 body 类型提为具名 DTO 类（或至少把 @ApiBody 的 schema 从 example 换成具名 properties）；pull（:300）补 `@ApiBody({ schema: { $ref: '#/components/schemas/ExecutorPullRequestDto' } })`。CallbackItemDto 无需改动。

---

### PK-04 三库 dev 依赖脱节 + CI continue-on-error 掩盖 —— 确认

**报告声称**：http 包 dev 依赖 `["pytest","pytest-asyncio","pytest-httpx"]` 无 respx，而 `tests/conftest.py:3` import respx；ai/notify 同型；pytest-httpx 从未 import（幽灵）；CI `pip install -e . 2>/dev/null || pip install .` + `continue-on-error: true`（ci.yml:536-539）。

**实际代码摘录**：
- `packages/autocodeflow-http/pyproject.toml:16` `dev = ["pytest", "pytest-asyncio", "pytest-httpx"]`（行号精确）。
- `packages/autocodeflow-http/tests/conftest.py:4` `import respx`（报告写 :3，实为第 4 行——第 1 行是 docstring，一行之差不影响结论）；`:18` `with respx.mock(...)`。ai/notify 的 conftest/tests 同样使用 respx，而 `autocodeflow-ai/pyproject.toml:16`、`autocodeflow-notify/pyproject.toml:15` 的 dev 均只有 `["pytest","pytest-asyncio"]`；db 包不用 respx（dev 声明与实际一致）。
- pytest-httpx 幽灵：`grep pytest_httpx|httpx_mock packages/autocodeflow-http/tests/` 0 命中。
- `.github/workflows/ci.yml:535-538`：`pip install pytest pytest-asyncio httpx respx`（全局预装）→ `pip install -e . 2>/dev/null || pip install .` → `continue-on-error: true`（**:539**，行号精确）。

**判定与理由**：成立。「消费者视角 `pip install -e .[dev] && pytest` 直接 ModuleNotFoundError: respx」的推演对 http/ai/notify 三包均成立；CI 绿灯依赖全局预装 respx + 安装步骤容错，「打包回归无守卫」判断准确。

**测试覆盖/缓解**：CI 的全局 `pip install respx` 恰是掩盖物而非缓解。无守卫。

**最佳修复落点**：① 三包 `pyproject.toml` dev 块统一 `["pytest", "pytest-asyncio", "respx>=0.21"]` 并删除 pytest-httpx；② `.github/workflows/ci.yml:539` 删除 `continue-on-error: true`（E-14 同源问题，一次修复两条 finding）。

---

### PK-05 mcp `get_scheduler_health` 把 Redis 不可达判为健康 —— 确认（附机制勘误）

**报告声称**：`tools.ts:1223-1227` 的 `healthy` 三元把「`queue.failed` 非数值」判为 true；Redis 不可达时 `/metrics/scheduler` 返回 `queue: {}` → healthy=true，与工具自己的文案「null means Redis unreachable」矛盾。

**实际代码摘录**：
- `packages/mcp-server/src/tools.ts:1223-1227`（行号精确）：
  ```ts
  healthy:
    queue.failed === 0 || typeof queue.failed !== "number"
      ? true
      : queue.failed < 100,
  ```
- **机制勘误**：admin 侧 `apps/admin-api/src/modules/scheduler/scheduler.service.ts:1193-1216` `getQueueDepth()` 的 catch 分支返回的是 `{ waiting: null, active: null, delayed: null, failed: null, completed: null }`——**全 null 的对象**，不是报告所说的 `queue: {}`。因此 `m.queue ?? {}` 不会触发，`queue.failed` 是 `null` 而非 `undefined`。但 `typeof null !== "number"` 同样为 true → **healthy=true 的最终结论不变**，核心缺陷（Redis 不可达被判健康、与文案矛盾）成立。
- 工具描述文案（tools.ts:1210-1212）确含「null means Redis unreachable」与「First stop when triggers stop firing」。

**判定与理由**：成立。结论层面与报告完全一致；仅中间机制描述（空对象 vs 全 null 对象）有误，不影响判定与修法。

**测试覆盖/缓解**：`packages/mcp-server/src/__tests__/tools.test.ts:820-843` 以「still works with a null queue (Redis down)」为名**固化了 healthy=true**——测试把错误行为钉成了预期。修复必须同步改此用例。

**最佳修复落点**：`packages/mcp-server/src/tools.ts:1223-1227` 改为 `healthy: typeof queue.failed === "number" ? queue.failed < 100 : false`，并在返回体加 `degraded` 说明字段；同步更新 `tools.test.ts:820-843` 的第二段断言为 `expect(out2.healthy).toBe(false)`。

---

## 三、数字实测

| 项目 | 报告声称 | 实测 | 判定 |
|---|---|---|---|
| `pull_request_target`（.github/workflows/） | 0 处 | **0 处**（仅 `pull_request` 触发器，ci.yml:6 等） | 准确 |
| `continue-on-error`（.github/workflows/） | 1 处（ci.yml:539，python-packages-test 安装步骤） | **1 处**，`.github/workflows/ci.yml:539`（python-packages-test job 内 `pip install -e . 2>/dev/null \|\| pip install .` 步骤），与报告行号一致 | 准确 |
| openapi 空 object schema | 14 个 | **14 个**：`Object, UpdateUserDto, UpdateTaskDto, SaveAiConfigDto, UpdateApplicationDto, RolloutStrategyDto, UpdateExecutorPackageDto, TaskTemplate, EventSubscription, CreateApiKeyDto, CreateProjectDto, UpdateProjectDto, UpsertProjectMemberDto, UpdateProjectMemberDto`（脚本扫描 `components/schemas` 共 37 个中 `type: object` 且 `properties` 空者），名单与 PK-02 引用逐一吻合 | 准确 |

附：迁移目录实测 64 个迁移 + `migrations.spec.ts`，`ALTER TYPE`/`ADD VALUE` 全目录 0 命中（PK-01 引用前提核实）。

---

## 四、误报与改级建议汇总

1. **E-04 建议改级 P1 → P2**（唯一改级项）：三处 SSRF 缺口与首跳 Bearer 证据全部属实，但报告把它列在【P1】标题下与正文「故定 P2 纵深而非 P1」自相矛盾；按两报告共同分级定义（P1=权限边界失效/任务丢失，P2=特定条件下的安全问题），路由在 verifyToken 之后、URL 由 admin 下发，属 P2 纵深。另注：首跳 Bearer 是被 `download.spec.ts:77-88` 固化的有意设计，修复时需连测试一起改。
2. **PK-03 部分误报**：「CallbackItemDto.properties = 0」（正文与 1.4 表两处）证伪——实测 9 属性 + required + failureReason enum + maxLength 4096/512000。register/heartbeat/pull 三个端点的缺口属实，修复建议仍应执行，但「回调契约无字段级 schema」的影响论述应删除；PK-15 中引用该子项的「空 schema/example-only 覆盖回调契约」表述需同步收窄为三个 executor 端点。
3. **PK-05 机制勘误（结论不变）**：Redis 不可达时 `/metrics/scheduler` 返回的是全 null 的 queue 对象（scheduler.service.ts:1208-1215 catch 分支），不是报告所说的 `queue: {}`；healthy=true 的结论经 `typeof null !== "number"` 分支同样成立。修法不变。
4. **E-01 措辞降格**：「高峰期必然出现」应为「高峰期高概率」——竞态窗口真实存在且较宽（空槽检查在长轮询发起前，窗口最长达 25s + 派发间隔），但属概率性事件；其余论述与 admin 侧语义（RPOP 无回队、failed 即终态）经反查全部成立，P1 维持。
5. **E-03 影响边界补充（结论不变）**：完全零 .env 的「首次 compose up」场景会先被 M3 fail-fast（configuration.ts:503-553，校验 DB_PASSWORD/JWT_SECRET/JWT_REFRESH_SECRET/EXECUTOR_SECRET）拦住而无法启动 admin-api；真实风险形态是「必填 secrets 已配置、INITIAL_ADMIN_PASSWORD 留缺省/占位」——`.env.example:217` 的占位值 `change_me_immediately` 本身也弱且不受 M3 校验（weakValues 名单不含 admin 口令维度）。P1 维持，且暴露了 M3 校验清单自身的缺口。

---

*本复核基于 HEAD 0ef3bbe 的静态代码取证；未运行任何测试/构建，未修改仓库现有文件。*
