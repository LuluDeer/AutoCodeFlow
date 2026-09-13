# AutoCodeFlow 全量深度审查报告（2026-09-14 @ 0ef3bbe）

> 基线：分支 `develop`，HEAD `0ef3bbe`，工作区干净。
> 方法：三轮子代理评审——第 1 轮（后端 admin-api / 前端 admin-web+desktop）、第 2 轮（执行器+基础设施 / packages+数据层+跨端契约）、第 3 轮（对全部 P0/P1 逐条回到源码复核真伪）。
> 分级口径（四份分报告统一）：**P0**=数据损坏/核心功能损坏；**P1**=权限边界失效/重要功能失效；**P2**=特定条件下的正确性/安全/性能问题；**P3**=打磨项。
> 类别口径：Bug / 安全 / 性能 / 可靠性 / 架构 / 打磨 / 测试 / 文档。工作量：S<0.5d、M<2d、L>2d。
>
> **文档族**（本报告为权威汇总；分报告保留完整证据摘录，个别证据块存在少量文字编码毛刺，以本报告转述为准）：
> | 文件 | 范围 | 原始发现 |
> |---|---|---|
> | [audit-r1-backend.md](reviews/audit-r1-backend.md) | admin-api + 集成边界 | 30 条 |
> | [audit-r1-frontend.md](reviews/audit-r1-frontend.md) | admin-web + executor-desktop | 38 条 |
> | [audit-r2-executors-infra.md](reviews/audit-r2-executors-infra.md) | executor-node/python、registry、CI、脚本 | 45 条 |
> | [audit-r2-packages-contracts.md](reviews/audit-r2-packages-contracts.md) | 10 个 packages、DB 层、openapi/契约 | 32 条 |
> | [audit-r3-verify-fe-be.md](reviews/audit-r3-verify-fe-be.md) | 后端/前端 P0+P1 复核 | 15 条判定 |
> | [audit-r3-verify-exec-pkg.md](reviews/audit-r3-verify-exec-pkg.md) | 执行器/契约 P0+P1 复核 | 9 条判定 |

---

## 一、执行摘要

### 1.1 复核修正后的总量

原始发现 **145 条**，经第 3 轮逐条源码复核（1 条证伪、5 条改级、3 条范围修正、2 条机制勘误）后：

| 严重度 | 后端 | 前端 | 执行器/基建 | packages/契约 | 合计 |
|---|---|---|---|---|---|
| **P0** | 1（R-01） | 1（F-01） | 0 | 0 | **2** |
| **P1** | 3（R-02/03/04） | 4（F-02/03/04/06） | 3（E-01/02/03） | 5（PK-01~05） | **15** |
| **P2** | 12 | 14 | 15 | 12 | **53** |
| **P3** | 14 | 19 | 27 | 15 | **75** |
| 合计 | 30 | 38 | 45 | 32 | **145** |

### 1.2 五个最重要的结论

1. **两个 P0 都不属于"代码烂"，而属于"集成缝隙"**：R-01 是 task 侧漏抄了 application 侧已有的同型修复（团队在 application.service 里写了注释证明知道该陷阱）；F-01 是 `@monaco-editor/react` 未做 `loader.config` 导致编辑器默认从公网 CDN 加载——内网/离线私有化部署（本平台的主部署形态）下 Glue 编排整体不可用。
2. **RBAC 的"收口战役"留下了三个成建制的缺口**（R-02/R-03）：批量删除恒 403（含第二个批量控制器的 4 个端点，测试把缺陷固化成断言）、updateGlue/rollback/rollbackToVersion 三个代码/配置写面完全绕过归属守卫——任意登录用户可篡改他人任务的执行代码。守卫是 service 内手工调用，缺"缺省拒绝"机制，这类漂移还会再发生（架构方向 A2 给出根治方案）。
3. **双执行器 parity 文化很好，但残余裂缝集中在异常路径与默认值**：E-01（pull 容量竞态把"暂时没槽位"写成永久失败）、E-02（`timeout=0` 三种语义，且**默认创建的任务就是 timeout=0**，node 不限时/python 300s 杀）。
4. **数据库 enum 与 TS 枚举脱节是第三次重演的结构性问题**（PK-01）：`cover_early`/`cancelled` 两个 TS 枚举值从未进入 PG enum，64 个迁移零 `ALTER TYPE`——单测全 mock、e2e 无用例，N2 教训（VERIFY-MATRIX 自述）原样复演。需要一个静态守卫（架构方向 A8）。
5. **CI 的"绿灯"覆盖面存在系统性盲区**：python 包安装失败照跑测试（E-14/PK-04 `continue-on-error`）、8 个 HA/pull/SSO 行为自检脚本从未进 CI（E-13）、openapi 14 个空 schema 在 drift 守卫下永远绿灯（PK-02/PK-15）、executor-python 全链零 e2e（E-18）。"CI 全绿"当前不能等价于"这些保证成立"。

### 1.3 修复批次一览（详见 §八）

| 批次 | 内容 | 规模 |
|---|---|---|
| 批次 0 · 热修 | R-01、R-02、R-03、R-04、E-03、PK-01、PK-04+E-14、PK-05、F-02 | 9 项，几乎全 S |
| 批次 1 · P1 清偿 | F-01、E-02、E-01、PK-02、PK-03、F-03、F-04、F-06 | 8 项，S~M |
| 批次 2 · P2 分域 | 安全 7 / 可靠性 8 / 性能 7 / CI 4 / 一致性若干 | 53 项分 5 组 |
| 批次 3 · P3 打磨 | 每迭代抽 1~2 天批量清偿 | 75 项 |
| 架构演进 | §七 20 个方向，优先 6 个 | 季度级 |

---

## 二、P0 详述（2 条，均已复核确认）

### P0-1 · R-01【Bug/数据损坏】任务 PATCH 不带 secrets 时，`******` 掩码副本被写回数据库

- **位置**：`apps/admin-api/src/modules/task/task.service.ts:533-541`（findOne 脱敏）+ `:544-577`（update 消费脱敏实体）
- **机制**：`findOne()` 对返回实体做 `t.secrets = maskForResponse(t.secrets)`（值全部变 `"******"`）；`update()` 直接 `findOne(id)` 取回该实体，仅当本次 PATCH **携带** `secrets` 字段时才重新加密覆盖，随后 `Object.assign(t, normalized)` + `save(t)`——不携带时掩码副本**整体落库**。
- **后果链**：派发时 `buildDispatchParams` 对非 `enc:v1:` 信封的值按明文透传 → 任务凭据被字面量 `******` 不可逆覆盖，任务开始批量认证失败。任何"改个名字/改个 cron"的 PATCH 都触发。
- **直接对照证据**：`application.service.ts:371-376` 有注释 "load the RAW row, never the masked findById() result — saving a masked entity back would persist '***' over the real secret env values" 并用 `findByIdRaw` 规避——task 侧没有 `findByIdRaw`，同型修复漏做（H-3 式"半修复"的又一例）。
- **复核补充（范围扩大）**：同型破坏还存在于 **`updateGlue`（:587-591）与 `rollback`（:1252+:1258 `manager.save(Task, task)`）**——原报告仅存疑（W-2），复核确认两处均实际成立，修复必须三处同改。
- **测试覆盖**：`task.service.spec.ts` 全程降级桩装配，无任何"PATCH 不带 secrets 后库中密文不变"的行为断言——零覆盖。
- **修复**：update/updateGlue/rollback 改走 `findByIdRaw`（或保存前从 DB 重读原始 secrets 列回填）；补行为级回归测试两条（不带 secrets → 密文逐字节不变；带 secrets → 新密文生效）。**工作量 S（+测试 M）**

### P0-2 · F-01【Bug/架构】Monaco 编辑器默认走公网 CDN——内网/离线部署下 Glue 编排整体不可用

- **位置**：`apps/admin-web/src/components/GlueEditor.tsx:3`；`apps/admin-web/vite.config.ts:30-37`
- **机制**：`@monaco-editor/react` v4 未调用 `loader.config({ monaco })` 时，经 `@monaco-editor/loader` 默认从 `https://cdn.jsdelivr.net/npm/monaco-editor@*/min/vs` 动态加载 AMD 版 monaco。全仓 grep `loader.config|from 'monaco-editor'` 0 命中——`monaco-editor` 依赖（package.json:26）与 `vendor-monaco` chunk（vite.config.ts:31）都是**死配置**（chunk 里实际只有 wrapper）。
- **后果**：TaskFormPage / TaskDetailPage 的 Glue 脚本编辑器在私有化/内网部署（docker-compose、执行器走 LAN）下永远停在 loading；同时引入 CDN 供应链风险。测试还主动裁剪了该组件（`task-form-ui06.test.tsx:25` 注释"GlueEditor 重依赖裁剪"），零覆盖。
- **修复**：`import * as monaco from 'monaco-editor'; loader.config({ monaco })` + 配置 `MonacoEnvironment.getWorker`（建议 `vite-plugin-monaco-editor` 成熟方案）；让 manualChunks 真正生效或删除；离线冒烟（断网 dev+build）。**工作量 M**

---

## 三、P1 详述（15 条，均已复核确认；PK-03 部分确认已收窄）

### 后端（3 条）

**R-02【Bug】`POST /tasks/batch/delete` 对所有人恒 403——批量删除完全失效，且测试固化缺陷**
`task.controller.ts:303-324` 调 `remove(id)` 漏传 user → `assertCanWrite` 中 `user?.role === ADMIN` 与 `row.ownerUserId !== user?.id` 双双不成立 → 每条目 403，错误被 `.catch` 吞成 `{id,error}`、HTTP 仍 200。NF-03 后新建任务全有 owner，管理员与属主都无法批量删除。
**复核扩大**：同模块注册的 `task-batch.controller.ts`（`/tasks-batch/*`）**四个批量端点全部漏传 user**（trigger:56 / pause:85 / resume:114 / delete:144），缺陷面是 5 个端点。`task-batch.controller.spec.ts:121-122` 的 `toHaveBeenCalledWith("t1")` 恰好固化缺陷。
修复：全部调用透传 user + 修断言。**S**（另见 PK-20：两套批量路由本就该收敛为一套）

**R-03【安全】updateGlue / rollback / rollbackToVersion 完全绕过归属守卫**
`task.controller.ts:455-491 / 740-777 / 779-807`，controller 有 `user` 但不传 service；service 三个方法无任何 `assertCanWrite*`/`assertCanOperate`。updateGlue 等价于改写任务执行的代码、rollback 改写 gitCommit 并触发执行、rollbackToVersion 整体覆盖配置——任意登录用户（含 viewer）可篡改他人任务。守卫在相邻的 update/remove 上做了，在这三个端点上没做，属模型内不一致（ADR-013 的"明确保留缺口"仅限 trigger/pause/resume）。
**复核补充**：`task.controller.endpoints.spec.ts:284-288` 断言 updateGlue 以 3 参调用（无 user），同样固化缺口。
修复：三处 service 补 `assertCanWriteProjectAware`（rollback 另加 `assertCanOperate`）+ RBAC 矩阵测试。**S（+测试 M）**

**R-04【Bug/安全】已删除用户的有效 JWT 返回 404 而非 401——H-3 只修了一半**
`users.service.findById`（:140-144）恒抛 NotFoundException；`jwt.strategy.ts:92-93` 与 `auth.service.refreshToken`（:293-294）仍用它，其 `if (!user) throw UnauthorizedException` 是死代码。`findByIdOrNull` 已存在（H-3 修复只落了辅助方法没换调用点，docstring 还留了错误注释）。后果：已删除用户持旧 token 访问任意接口 → 404 "User #N not found"（泄漏存在性 + 数字 id）。修复：两处改 `findByIdOrNull`。**S**

### 前端（4 条）

**F-02【Bug】ParamsEditor 半受控：模板预填参数"看不见却被提交"**
`ParamsEditor.tsx:29` `useState(() => toRows(value))` 只在初始化消费 value；TaskFormPage 的模板预填是异步 effect（L281-296），`setFieldsValue` 更新了表单存储但不触发组件内部 rows——`?templateId=` 创建时模板默认参数显示为空、却随 `getFieldsValue(true)` 提交（显示与提交数据静默不一致）。触发弹窗因 `destroyOnHidden` 按挂载时序侥幸正确。修复：加同步 effect 或改全受控 + 回归测试。**S**

**F-03【Bug】任务克隆静默丢失 6 类配置字段**
`TaskListPage.tsx:167-194` 克隆 payload 对照 `Task` 类型缺：`timeoutAction`、`timeoutWarnRatio`、`maintenanceWindows`、`runbook`、`executorAffinityTags`、`executorAntiAffinityTags`。克隆配置了超时策略/发布冻结窗口/运行手册/亲和标签的任务，副本全部退回默认值且无提示。修复：payload 白名单化（复用 `task-template-extract` 思路）+ 单测锚定字段清单。**S**

**F-04【Bug】AI 调度建议「应用 Cron」是死链**
`TaskDetailPage.tsx:613` 跳转携带 `?suggestCron=`，全仓仅此 1 处出现，TaskFormPage 只读 applicationId/templateId。用户点"应用"后什么也不会发生。修复：TaskFormPage 编辑态消费该参数（`setFieldValue('cronExpression', …)` 并提示来源），或删除按钮。**S**

**F-06【安全】access + refresh token 双双持久化 localStorage；PrivateRoute 注释与实现矛盾**
`store/auth.ts:49-53` partialize 同时持久化 token（15m）与 refreshToken（**30 天**，`auth.service.ts:414-420`），存储键 `autoflow-auth` 无 HttpOnly/SameSite 保护——XSS 得手即窃取长效会话；管理台含执行器注册、共享 token 等高危面，凭据保护等级应更高。`PrivateRoute.tsx:8` 注释 "token is not persisted (short-lived)" 与实现直接矛盾。修复：access 留内存 + refresh 迁 HttpOnly Cookie（含后端配合，M）；短期至少修正注释并在威胁模型中写明取舍（S）。**M**

### 执行器/基建（3 条）

**E-01【Bug】pull 模式容量竞态把「暂时没槽位」变成「任务永久失败」**
`executor-node/src/pull.ts:41-58` 与 `executor-python/scheduler.py:241-244`：pull 循环在**长轮询发起前**检查空槽，admin 端阻塞最长 25s 才返回任务；期间一个 push 派发占走最后一个槽位，被拉取的执行被 429 拒绝 → 执行器补发 `failed` 回调 → admin 把执行记为**永久失败**（`executor-pull.service.ts:93` RPOP 取走即出队无回队；`task.service.ts:1894` failed 即终态）。高峰期高概率，窗口最长达 25s+。node `pull.spec.ts:62-83` 与 python `test_scheduler.py:380-389` 的断言**固化了问题行为**。
修复：429 与 400 分流——前者不回调失败，改 admin 侧按 failureReason 回队（`handleCallback` 识别容量拒绝后重入队），两侧同改 + 修固化断言。**M**

**E-02【Bug】`timeout=0`（不限时）三种语义分裂，且默认创建路径即触发**
node：0 = 显式不限时（`execute.ts:397-398`，回调 token 给 10 年 TTL）；python：or-链把 0 当 falsy 回落 300s 默认后杀（`execute.py:1549-1552`）；越界值 node 400 拒绝 / python clamp 到 1s——第三种语义。**复核加重**：admin 实体 `timeout` 默认 0（=no limit，`task.entity.ts:126`）且派发载荷原样携带——**未显式配置 timeout 的默认任务**就命中此分叉（node 不限时 vs python 300s 杀 + 失败归类为 timeout）。两侧测试各自固化了**相反**语义（node:1082 断言 Infinity；python:776 断言 clamp 到 1s）。
修复：python 显式处理 0（不限时 + token 10 年上限），拉齐越界策略（建议两侧都 400），两侧互 pin `timeout=0` 向量。**S**

**E-03【安全】admin-api 宿主端口绑 0.0.0.0 + 初始管理员缺省弱口令**
`docker-compose.yml:106` `- '3105:3105'` 未加 loopback 前缀（同文件其余 7 个端口全部 127.0.0.1）；`:131` `INITIAL_ADMIN_PASSWORD: ${...:-Admin@123456}`。执行器回程走内网 `http://admin-api:3105`，宿主映射对拓扑非必需。
**复核边界**：完全零 .env 的裸 up 会被 M3 fail-fast 拦住（校验 DB/JWT/EXECUTOR 四项）；真实风险形态是"必填 secrets 已配、admin 口令留缺省/占位"——而 M3 weakValues 名单**不含 INITIAL_ADMIN_PASSWORD**，`.env.example:217` 的占位 `change_me_immediately` 也弱。公网可路由 + 可预测口令的组合成立。
修复：`127.0.0.1:3105:3105` + 去缺省值（`${INITIAL_ADMIN_PASSWORD:?}`）+ M3 追加 admin 口令校验。**S**

### packages/契约（5 条）

**PK-01【Bug】`cover_early`/`cancelled` 从未进入 PG enum——任务创建 500、COVER_EARLY 路径必炸**
`InitialSchema.ts:19/:31` 两个 CREATE TYPE 缺这两个值，64 个迁移零 `ALTER TYPE`（grep 证实）；DTO `@IsEnum(BlockStrategy)` 接受 `cover_early`、service 无归一化；`scheduler.service.ts:928` COVER_EARLY 命中即写 `cancelled` → PG 22P02 异常；metrics 读侧 cancelled 恒 0。生产 `DB_SYNCHRONIZE` fail-fast（configuration.ts:596），迁移是 schema 唯一来源。单测全程 mock（scheduler.service.spec.ts:627）、e2e 零命中——N2 教训第三次重演。
修复：幂等迁移两条 `ADD VALUE IF NOT EXISTS` + 枚举守卫（见 A8）。**S（+守卫 M）**

**PK-02【Bug/架构】openapi 14 个空 schema；PATCH /tasks/{id} 在前端生成类型里是 `Record<string, never>`**
根因：`update-task.dto.ts:2` 用 `@nestjs/mapped-types` 的 PartialType（只克隆 class-validator 元数据不克隆 swagger 元数据）+ nest-cli.json 未启用 swagger 插件。14 个空 schema 名单经脚本实测逐一吻合（UpdateTaskDto/UpdateUserDto/…/Object）。传导：`api-types.ts:2907` → 前端 `tasks.ts:352` 被迫手写 `Partial<Task>`（以实体形状冒充 DTO，`forbidNonWhitelisted` 下携带实体多余字段即 400）；空 schema 是确定性再生，api-types-drift CI 永远绿灯。
修复：Update* 全系换 `@nestjs/swagger` 的 PartialType + 启用 CLI 插件 + 重导出 + 删 `Partial<Task>` 断言 + drift job 追加空 schema 扫描。**M**

**PK-03【架构】执行器 register/heartbeat/pull 契约游离在机器可读契约之外（部分确认收窄）**
实测：`POST /executors/register`、`/heartbeat` requestBody 仅 example（controller 用内联 TS 类型非 DTO）；`/executors/pull` 无 requestBody 声明。**复核证伪了原报告的 CallbackItemDto 缺口**——回调契约实测有 9 属性 + required + failureReason enum + maxLength，无需改动。
修复：三个 executor 端点 body 提为具名 DTO / 补 `@ApiBody` $ref。**M**

**PK-04【Bug/测试】三个 Python 库 dev 依赖破损 + CI `continue-on-error` 掩盖**
http/ai/notify 三包 `pyproject.toml` dev 依赖无 respx（conftest 实际 import），http 包还声明了从未 import 的 pytest-httpx（幽灵依赖）——消费者 `pip install .[dev] && pytest` 直接 `ModuleNotFoundError`。CI（ci.yml:539）`continue-on-error: true` 让安装失败照跑测试，全局预装 respx 恰是掩盖物。**与 E-14 同源，一条修复销两条。**
修复：三包 dev 统一 `["pytest","pytest-asyncio","respx>=0.21"]`、删 pytest-httpx、删 continue-on-error。**S**

**PK-05【Bug】mcp `get_scheduler_health` 把「Redis 不可达」判为健康——与工具自身文案矛盾**
`tools.ts:1223-1227`：`queue.failed === 0 || typeof queue.failed !== "number" ? true : …`。Redis 不可达时 admin 返回全 null 的 queue 对象（复核勘误：是全 null 对象而非空对象，判定分支相同）→ `typeof null !== "number"` → healthy=true。`tools.test.ts:820-843` 以 "still works with a null queue" 为名固化了错误行为。修复：缺数值 → healthy=false + `degraded` 说明字段，同步改测试。**S**

---

## 四、复核修正记录（第 3 轮）

| 类型 | 编号 | 修正内容 |
|---|---|---|
| **证伪 1 条** | F-07（原 P1） | 带缺陷的 `components/ErrorBoundary.tsx` 是**零引用死代码**；实际挂载的是 `main.tsx:38` 的 react-error-boundary + ErrorFallback（i18n 正常且有测试断言"页面出错了"）。用户永远看不到原始 key。→ 降 P3 死代码清理。 |
| **机制证伪（保留主结论）** | R-06（原 P1→P2） | "广播不占坑"成立；但"回调统一释放→每执行器减 1"被证伪——广播执行 executorAddress 恒为 null（task.processor.ts:137 仅非广播落库），`releaseExecutorSlot` 首行早退，广播计数"既不加也不减"。真实缺陷收缩为：广播负载对单播容量闸门**欠计** + ≤30s 心跳上报自愈。 |
| **部分证伪** | PK-03 | CallbackItemDto 实有完整 schema（9 属性），原报告"回调契约无字段级 schema"夸大；register/heartbeat/pull 三端点缺口属实。 |
| **部分证伪（表述）** | F-11 | 全量拉取属实；"逐行切 span 全进 DOM"仅搜索高亮路径成立，默认路径已有聚合优化——真实成本是 40 万行的字符串 join/split 内存与 CPU 峰值。 |
| **表述修正** | F-10 | DAG 全量拉取发生在 deps Tab 首次激活时（antd Tabs 懒挂载），非"进入详情页即拉"。 |
| **改级** | R-05 P1→P2 | 缺陷在（TOTP 路径缺 clearExpiredLock），但标准 UI 两段式登录必先过 /auth/login（已清过期锁），可触达面仅限绕过 login 直调 /auth/totp/verify 的非 UI 客户端。 |
| **改级** | F-05 P1→P2 | token 入 URL 属实，但后端已限 3 条 SSE 路由 + type=access + 15min TTL（jwt.strategy.ts:46-50），两端注释记录取舍——安全债应排期而非 P1。 |
| **改级** | E-04 P1→P2 | SSRF 三缺口证据全实，但均在 verifyToken 之后、URL 由 admin 下发（原报告正文自述"定 P2 纵深"，目录归类笔误）；首跳 Bearer 是被 download.spec.ts:77 固化的有意行为。 |
| **改级** | F-07 P1→P3 | 见上（死代码）。 |
| **范围扩大** | R-01 | 同型掩码回写还在 updateGlue 与 rollback（原仅存疑 W-2）。 |
| **范围扩大** | R-02 | 缺陷面从 1 个端点扩大到 5 个（TaskBatchController 四端点同病）。 |
| **范围扩大** | E-02 | 默认创建路径（timeout 缺省 0）即触发分叉。 |
| **机制勘误** | PK-05 | Redis down 返回全 null 对象而非空对象，结论不变。 |
| **措辞降格** | E-01 | "高峰期必然出现"→"高峰期高概率，窗口最长达 25s+"（其余论证与 admin 侧反查全部成立）。 |
| **数字实测全部吻合** | E-13/E-14/PK-02 | `pull_request_target`=0 ✓；`continue-on-error`=1 处（ci.yml:539）✓；openapi 空 schema=14 个且名单逐字吻合 ✓；迁移 64 个、`ALTER TYPE` 0 命中 ✓。 |

---

## 五、P2 清单（53 条，按域）

### 后端（12 条）

| 编号 | 类别 | 位置 | 摘要 | 量 |
|---|---|---|---|---|
| R-05 | Bug | auth.service.ts:132-184 | TOTP 路径缺 `clearExpiredLock`，锁过期后非 UI 客户端一次失败即再锁 15 分钟（UI 流程不可达，故降级） | S |
| R-06 | Bug | executor.service.ts:1379-1530 | 广播派发不占坑 runningTaskCount（欠计方向，30s 心跳自愈兜底） | M |
| R-07 | 安全 | app-deployment.service.ts:2176-2280 | 灰度健康探针绕过 `assertSafeExecutorUrl` 且强制 http——内网盲探 oracle，与同文件 deploy 面姿态不一致 | S |
| R-08 | 安全/性能 | main.ts:86-104 | 回调路由 55MB body 解析先于限流/鉴权，rawBody 再复制一份——未认证内存放大向量 | S |
| R-09 | 性能 | executor.service.ts:878-897 | executor_metrics_history 每执行器每天 2,880 行且全仓无清理（同类表都有 retention，唯它缺席） | S |
| R-10 | 性能 | scheduler.service.ts:605-614 | stale sweep 的 PENDING 清扫无 SQL 级 cutoff/take，恢复期数万行全量进内存 | S |
| R-11 | Bug | executor.service.ts:439-481 | 重启恢复逐行 save 无异常隔离，一次乐观锁冲突让 register/heartbeat 整体 500 → 连锁判离线 | S |
| R-12 | 架构 | 多处 | 配置收口（ARCH-27）自违：`ADMIN_API_URL`/`NPM_REGISTRY_URL`/`METRICS_STREAM_*` 等 5 个 env 绕过注册/映射，typo 静默 503 | S |
| R-13 | Bug | task.processor.ts:255-353 | `connect()/startTransaction()` 在 try 外——失败时连接泄漏且异常覆盖原始错误、污染 BullMQ 重试分类 | S |
| R-14 | 安全 | users.controller.ts:144-163 | ADMIN 可自删/删最后一名管理员；删除不吊销 refresh token | S |
| R-15 | 性能 | scheduler.service.ts:559-599 | 恢复循环串行执行 kill HTTP（3s/行），大规模宕机恢复一轮最多 5 分钟阻塞 cron tick | S |
| R-16 | Bug | task.service.ts:1861-1879 | 派发落库前的窗口内，任意持有效执行器凭据者可对未派发执行回报任意终态 | S |

### 前端（14 条）

| 编号 | 类别 | 位置 | 摘要 | 量 |
|---|---|---|---|---|
| F-05 | 安全 | 3 处 SSE hook | access token 进 URL 查询串（已限 3 路由+15min TTL；中期改短效 ticket/fetch 流） | M |
| F-08 | 架构 | hooks/ | 三套 SSE 客户端并存 + 退避函数逐字重复，token 方案改动要改三处 | M |
| F-09 | 架构 | useExecutorLive.ts:186-215 | 4 处 eslint-disable rules-of-hooks 的条件 hooks，Provider 重构即运行时炸弹 | M |
| F-10 | 性能 | api/tasks.ts:181-300 | listAllTasks 全量分页聚合（6 并发）用于依赖下拉/DAG，任务千级即请求风暴；应加轻量 `?fields=id,name` 端点 | M |
| F-11 | 性能 | ExecutionDetailPage.tsx:290-305 | "加载完整日志"最多 40 万行 join/split 内存 CPU 峰值（DOM 侧已有聚合优化，表述修正） | M-L |
| F-12 | Bug/性能 | MainLayout.tsx:187-190 | 每秒 setInterval 重渲整个壳层 + 时钟 locale 硬编码 zh-CN | S |
| F-13 | Bug | MainLayout.tsx:177-184 | profile 拉取 effect 依赖含 `user`，若响应无 role 即无限请求循环（当前契约不触发） | S |
| F-14 | i18n | ThemeProviders.tsx:70-75 | ConfigProvider locale 恒 zhCN，英文界面下 antd 内建文案不跟随 | S |
| F-15 | 打磨 | 全站 ~101 处 hex | 暗色主题下硬编码亮色块 + 品牌色 #1677ff/#22C55E 并存 | M |
| F-16 | 架构 | ExecutorDetailPage 等 3 页 | 数据获取双栈：同页混用 TanStack Query 与 useRequest | M |
| F-17 | Bug | ExecutionDetailPage.tsx:168-177 | report 端点挂载即双重请求（useQuery + effect refetch 互相取消） | S |
| F-18 | Bug | 3 处 | 剪贴板写入无错误处理，权限受限时"成功"提示照弹且未处理 rejection | S |
| F-19 | 打磨/桌面 | resources/executor-node/index.js | 59k 行 / 2.1MB 内嵌 bundle 入库，与 executor-node 双源人工同步、漂移风险 | M |
| F-20 | 打磨/桌面 | history-store.ts | 死代码模块（无 importer），两套"历史"心智并存 | S |

### 执行器/基建（15 条）

| 编号 | 类别 | 位置 | 摘要 | 量 |
|---|---|---|---|---|
| E-04 | 安全 | deploy.ts/update-package.ts/download.ts | SSRF 闸三处缺口 + 首跳附带执行器共享 token（纵深；execute.ts 的闸没覆盖这两条链） | M |
| E-05 | 可靠性 | callback.ts / execute.py | 回调落盘重试 5 轮（node ≈1min / python ≈2min）即死信——admin 滚动升级即丢全部任务终态 | S |
| E-06 | 可靠性 | artifacts.ts:104-119 | node 产物上传 fetch 无超时（python 有 30s）——admin 挂起时并发槽被永久占用 | S |
| E-07 | 可靠性 | main.ts:265-268 / main.py:101-103 | 优雅停机不停止 pull 循环——排水窗口内仍接新任务后被树杀 | S |
| E-08 | 可靠性 | file-logger.ts:292-302 | node 工作目录 TTL 清理无活跃执行保护（python 有）——timeout=0 长跑任务目录可被整体删除 | S |
| E-09 | 安全 | scripts/install.sh:209-231 | 裸机 systemd unit 以 root 运行、无沙箱、.env 无 REQUIRE_TOKEN——与容器基线脱节 | S |
| E-10 | 安全 | registry-pypi main.py:42-52 | 默认弱口令 fail-open + root 容器 + 无 compose 加固（该服务管着任务依赖来源） | S |
| E-11 | 可靠性 | auth.py:188-198 | python token 刷新无失败退避（node 有 30s）——admin 不可达时每个入站请求拖 10s | S |
| E-12 | 可靠性 | deploy.ts:573-575 | 应用 releases 历史与 app.log 永不回收——磁盘无界增长 | M |
| E-13 | 测试/CI | package.json scripts | HA/pull/SSO/SSE 等 **8 个行为自检脚本从未进 CI**——compose.ha 与 ARCH-31/32 保证只靠本地手跑 | S |
| E-14 | 测试/CI | ci.yml:539 | python 包安装失败照跑测试（与 PK-04 同源，一条修复销两条） | S |
| E-15 | Bug | main.py:245-272 | 启动注册失败后补注册永不收敛——每个 token 刷新周期重发 register | S |
| E-16 | 打磨 | start-isolated.sh / redis conf | 硬编码开发者家目录绝对路径，任何人一跑即错 | S |
| E-17 | 打磨 | start-dev.sh:57,64 | 硬编码错误容器名 `autoflow-postgres-1`（实际 autocodeflow-*），新用户必然卡死 | S |
| E-18 | 测试 | e2e-full.sh | 46 例 e2e 只注册 executor-node——python 执行器全链零端到端覆盖 | M |

### packages/契约（12 条）

| 编号 | 类别 | 位置 | 摘要 | 量 |
|---|---|---|---|---|
| PK-06 | Bug | node-sdk http-client.ts:157 | 四端信封拆包行为分歧：双 SDK 不校验 code 数值型、cli/mcp 校验——contract.json 无向量钉住 | S |
| PK-07 | 文档 | contract.json:110 等 | 三份"防漂移文档"互相漂移（cli 已收紧但文档都说没收紧） | S |
| PK-08 | Bug/安全 | autocodeflow-db connection.py | `DATABASE_URL` 注入从未实现（文档把愿望当现状）；无 pool_pre_ping/recycle；engine 无 dispose | S |
| PK-09 | 性能 | autocodeflow-http client.py | 每请求新建 AsyncClient 零连接复用；半开态探测不受限；重试忽略 Retry-After；任意异常计入熔断 | M |
| PK-10 | Bug | 实体/迁移 | 元数据漂移三连：fileSize bigint 运行时 string；FK 实体 SET NULL vs DB CASCADE；分区表联合 PK 实体不知情——一次 migration:generate 就可能翻转语义 | M |
| PK-11 | Bug | task-version.entity.ts:12 | task_versions 缺 `(taskId,version)` 唯一约束（application_versions 有）——并发快照可产生重复版本行 | S |
| PK-12 | Bug | notify.py:17-22 | SDK 渠道枚举缺 `feishu`（服务端 NF-05 已支持）——三处渠道表不一致 | S |
| PK-13 | Bug | mcp package.json | engines `>=20` 与 node-fetch v3（ESM-only）真实下限 20.19 冲突——Node 20.0~20.18 启动即 ERR_REQUIRE_ESM；overrides 死配置 | S |
| PK-14 | 架构 | domain-events.ts 等 | webhook 信封/派发载荷/SSE 事件全程无 schemaVersion——载荷形状演进无机器可辨标记 | M |
| PK-15 | 架构/测试 | ci.yml:943-1010 | api-types-drift 只校验"生成物↔生成物"；mcp 43 工具/CLI 30+ 路径/双 SDK 契约全是手抄、无路由面守卫 | M |
| PK-16 | 性能 | audit/refresh 实体 | audit_logs(action/resource) 与 refresh_tokens(userId/expiresAt) 查询面缺索引——清理全表扫 | S |
| PK-17 | 安全 | autocodeflow-ai analyzer.py | 任务日志原文（可含 secrets）直发第三方 AI 端点无脱敏钩子；api_key 缺失时发 `Bearer None` | S |

---

## 六、P3 清单（75 条，按域；打磨批按此清偿）

### 后端（14 条）

| 编号 | 位置 | 摘要 | 量 |
|---|---|---|---|
| R-17 | task.controller.ts:212-324 | batch pause/resume/delete 三端点缺 OPS_THROTTLE 分域限流 | S |
| R-18 | batch-task.dto.ts:9-18 | `BatchTaskIdsDto` 无 ArrayMaxSize——一次合法请求可携数千 uuid → 数千并发事务 | S |
| R-19 | audit-log.entity.ts:10-11 | 声明的 GIN 索引实际不存在（死声明误导） | S |
| R-20 | task.processor.ts:18-19 | NotificationService/AuditService 死依赖注入（BUG-21 遗留耦合） | S |
| R-21 | pagination.dto.ts:39-50 | paginate 响应同时返回 list 与 items 双键——契约漂移土壤 | M |
| R-22 | auth.controller.ts:97 | login Swagger 文案 "Max5/min" 与实际 20/min 漂移 | S |
| R-23 | oidc.controller.ts:61,118 | console.warn 违反本仓日志纪律（应 Logger） | S |
| R-24 | task.service.ts:1121-1235 | SSE 日志流空转期每秒 2 条 SQL（64 流 ≈128qps 常态底噪） | M |
| R-25 | health.controller.ts | @Public 的 /api/health 暴露执行器在线数/队列深度——信息枚举面 | S |
| R-26 | 20+ 处 | `@Optional + fail-open` DI 模式泛滥——事件/审计/门禁静默降级不可观测 | M |
| R-27 | task-batch.controller.spec.ts | 测试只断言"委托"，把 R-01/R-02 缺陷固化 | S |
| R-28 | task.service.ts:1354-1371 | 依赖触发链路绕过审计、triggerType 仍记 manual（有 "dependency" 未用） | S |
| R-29 | scheduler.service.ts:995-999 | 入队载荷带整行 task（含 secrets 密文）进 Redis 驻留 1h——死重量 + 数据驻留面 | S |
| R-30 | executor.service.ts:1644-1672 | markStaleOffline 查询与更新间隙可能对已恢复执行器发离线事件 | S |

### 前端（19 条）

| 编号 | 位置 | 摘要 | 量 |
|---|---|---|---|
| F-07 | components/ErrorBoundary.tsx | **死代码**（零引用；实际兜底是 ErrorFallback 且正常）——删除或修正 | S |
| F-21 | desktop renderer/App.tsx:18-22 | React.lazy 在 render 体内创建——未来加 state 即 Wizard 反复重挂 | S |
| F-22 | desktop StatusWindow.tsx:262-269 | 启动/停止无 try/finally——IPC reject 后按钮永久 disabled | S |
| F-23 | admin-web App.tsx | 渲染 null 的死组件 | S |
| F-24 | MainLayout.tsx:505-528 | 帮助按钮无 onClick、通知 Badge 恒 0——占位死 UI | S |
| F-25 | MainLayout.tsx:494 | 搜索 tooltip 硬编码 "Ctrl K"，Mac 实为 ⌘K | S |
| F-26 | 24 处 | zh-CN locale 硬编码 + 两个"相对时间"实现重复 | M |
| F-27 | TaskDetailPage.tsx:378 | "失败次数"可显示小数（次数出现 1.4 次的语义错误） | S |
| F-28 | TaskFormPage.tsx:399-403 等 | "保存为模板"三处坏味道：死三元、`as never` 断言、cron 单位解析依赖翻译文本 | S-M |
| F-29 | api/tasks.ts:26-31,371-385 | 死代码：TIMEOUT_ACTION_OPTIONS 无消费、executionsWithStatus 与 executions 逐字节相同 | S |
| F-30 | theme/tokens.ts:107 | THEME_INIT_SCRIPT 导出与 index.html 内联脚本双事实源 | S |
| F-31 | vite.config.ts:46-49 | define 注入 `process.env.VITE_*` 无消费方 | S |
| F-32 | client.ts:128-135 + main.tsx:32-40 | 重试双层叠加（axios 1 次 × Query 2 次）——一次失败最多 3 发请求、双报错 | S-M |
| F-33 | 11 处 | `<a onClick>` 无 href——键盘不可达、读屏不识别（与 UI-12 标准不符） | S |
| F-34 | AppDeploymentPage.tsx:124-130 | 3s 轮询无可见性守卫 + 每拍全量拉 executors（同项目他页有标准做法） | S |
| F-35 | timeFormat.ts 等 | 时长格式三套并存、无小时档 | S |
| F-36 | ExecutorDetailPage.tsx:242,480 | 编辑弹窗 setFieldsValue(executor) 全量快照随 onFinish 提交 | S |
| F-37 | desktop ipc-handlers.ts | 函数体内 require('fs')/require('path') 十余处 | S |
| F-38 | __tests__ | 测试缺口：克隆链路/ParamsEditor/GlueEditor/ErrorBoundary/client.ts 并发 refresh 均无覆盖 | M |

### 执行器/基建（27 条）

| 编号 | 位置 | 摘要 | 量 |
|---|---|---|---|
| E-19 | execute.ts:387 / execute.py:1553 | requirements 类型未校验——字符串被逐字符当包名 | S |
| E-20 | health.ts:94 / health.py:57 | 就绪探针端点漂移（/health/ready vs /health/readiness）；node /health 指标在 Windows 失真 | S |
| E-21 | logs.py:40-43 | python 日志读取整文件入内存（64MB/请求；node 已流式） | S |
| E-22 | config.py:16-42 | /config/reload 不支持 workDir 热更——pydantic 静默忽略返回 success | S |
| E-23 | execute.py:804-826 | docstring 写在函数体中段——`__doc__` 丢失 | S |
| E-24 | auth.py:244-253 | 非 ASCII Bearer 抛 TypeError → 500 而非 401 | S |
| E-25 | main.py:312 / main.ts:248 / install.sh | 裸机监听 0.0.0.0 且 .env 无 REQUIRE_TOKEN——token 缺失即公开 RCE 面 | S |
| E-26 | execute.ts:718-728 | Windows `shell:true` 下 --prefix 路径不加引号——WORK_DIR 含空格即安装错位 | S |
| E-27 | auth.ts:120 / auth.py:188 | token 刷新无 in-flight 去重——并发各发一次 /token | S |
| E-28 | deploy.sh / Makefile | 绑定 docker-compose v1（EOL）+ 健康检查端点三处漂移 | S |
| E-29 | init-db.sh | 迁移命令疑似失效 + 初始密码打印到终端 + set -e 下死分支 | S |
| E-30 | Makefile:109-114 | clean 全仓 rm -rf node_modules——连根依赖一起删 | S |
| E-31 | install.sh:16,30 | 默认装 Node 20 与头注"24.x"矛盾、处于弃用周期 | S |
| E-32 | ci-local.sh:180 | 本地 audit 阈值(high) 弱于 CI(moderate)——本地全绿 CI 才红 | S |
| E-33 | playwright.e2e.config.js | 无 retries/workers 约束——两 spec 可并行打同一后端 | S |
| E-34 | docker-compose.yml | version 字段弃用、minio 用 latest、PYPI_API_KEY 死配置 | S |
| E-35 | release-please.yml:63-70 | token 回退链 fail-unsafe——未配 secret 时发布链路静默断开（v1.1.1 实爆过） | S |
| E-36 | 5 个根级脚本 | 缺 `-u`/`pipefail`——未定义变量静默为空、管道失败被吞 | S |
| E-37 | config.ts:59 / config.py:95 | 执行器版本号双事实源（常量与 package.json 各自维护） | S |
| E-38 | install.sh ↔ content.ts | 260 行脚本双拷贝、守卫仅运行于仓库可见环境 | S |
| E-39 | registry-pypi main.py:29 | CORS `*` 与双上传端点重复 | S |
| E-40 | deploy.ts:568-571 | .env 用 k=v 裸拼接——值含换行即注入额外环境变量 | S |
| E-41 | 根 package.json | executor-node 无 ESLint（lint:node 是 echo 占位）——唯一无静态检查的 TS 项目 | S |
| E-42 | execute.py 三处 | pull 拒绝无 failureReason、TASK_NAME 未 str()、health token 口径 | S |
| E-43 | update-package.ts | 自述"extract and replace → self-update"实际只下载不更新——运维语义与 UI 期望不符 | S/M |
| E-44 | callback.ts:273 | 重试无 jitter——恢复瞬间全集群同步尖峰 | S |
| E-45 | e2e-full.spec.js | e2e 缺口：pull 模式/artifacts 全链/token 轮换自愈/死信重放 | M |

### packages/契约（15 条）

| 编号 | 位置 | 摘要 | 量 |
|---|---|---|---|
| PK-18 | mcp tools.ts:1190 | list_dead_letters 读取不存在的 `name` 字段（实体是 appName）——输出恒空 | S |
| PK-19 | openapi.json | /alerts/webhook 路由缺失 + 4 端点无 requestBody 文档 | S |
| PK-20 | task.controller / task-batch.controller | 同一批量能力两套路由并存——双事实源（R-02 缺陷正是 batch 家族） | S |
| PK-21 | config-history.entity.ts:47 | userId 类型 string，全库其余 integer | S |
| PK-22 | node-sdk index.ts:4 | 头注释示例 import `@autoflow/sdk`（包名错误） | S |
| PK-23 | autoflow-sdk models.py:33 | blockStrategy 默认 'SERIAL'（大写，无效枚举形态）；timeout 三重字段并存 | S |
| PK-24 | node-sdk logger.ts:14 | TaskLogger 内存 entries 无上限——长跑任务内存无界增长 | S |
| PK-25 | atlas 三篇 | migrations.md/mcp-server.md/db.md 过时或失实（详见分报告 §1.5） | S |
| PK-26 | scheduler.service.spec.ts:627 | N2 教训结构性复演：写路径枚举真机校验为零——需静态守卫（A8） | M |
| PK-27 | acf-cli login.ts:14 | `login --password` 命令行明文传密码（ps/history 泄漏面） | S |
| PK-28 | mcp package.json | 缺 prepublishOnly——本地 publish 带出陈旧 dist（工作区实测 dist 还是 1.1.1） | S |
| PK-29 | python 三小库 tests | session 生命周期/webhookUrl 联动/非 JSON 响应路径零覆盖 | S |
| PK-30 | 根 package.json | test:all 漏掉四个 python lib 测试 | S |
| PK-31 | task.controller.ts:740 vs 781 | 两个"rollback"语义相近易误用（gitCommit vs 快照）——文档补对照表 | S |
| PK-32 | http client.py:128 | 可重试状态码在非安全方法上抛异常——错误契约未文档化 | S |

---

## 七、架构升级方向汇总（20 个，优先 6 个）

四份分报告各给 5 个方向，合并去重后 20 个。**优先推荐**（跨域收益最大、互相独立可并行）：

### A1 · 执行状态机收口（后端 3.1）★优先
`status IN (pending,running)` 条件 UPDATE + RETURNING 语义目前在 7 处各自手写；抽 `ExecutionTerminalService.transitionToTerminal(ids, patch)` 统一（终态/槽位/事件原子性一处保证），R-06/R-11/R-30 类缺陷从结构上消失。1~2 轮，风险中。

### A2 · 写面守卫装饰器化（后端 3.2）★优先
新增 `@WriteGuard(resource)` 组合装饰器 + metadata 扫描测试**穷举所有写端点必须有守卫元数据**——RBAC 从"逐点人肉"变"缺省拒绝 + 白名单"，堵住 R-03 类漂移的再发。1 轮，风险低。

### A3 · 执行器协议契约化（基建 3.1）★优先
抽 `packages/executor-protocol`（JSON Schema / zod+pydantic 双生成）：ExecuteRequest/CallbackItem/ConfigReload + 4 个运维端点，两侧执行器与 admin 三方用同一组测试向量互 pin（timeout=0、requirements=字符串、failureReason 全枚举）——"注释里的 parity"变"红在 CI"。先做 timeout/readiness 最小切片。

### A4 · 契约单一事实源收口（packages R1）★优先
nest-cli 启用 swagger 插件 + Update* 换源 + executor 三端点 DTO 化 + CI 空 schema 扫描 + mcp/CLI 路由面快照断言 + contract-fixtures 分发 `callbackContract`/`channelList` 常量。让 openapi 真正覆盖全部消费面（对应 PK-02/03/15、E-20/22）。

### A5 · SSE 客户端统一 + 传输安全升级（前端 R1）★优先
`createSseClient` 单一实现（连接/退避/token 注入/状态机/测试桩），随后同一层完成 query-string token → 短效 ticket 升级（对应 F-05/08/34）；AppDeploymentPage 等后续实时需求直接复用。

### A6 · 回调可靠性分层（基建 3.2）★优先
admin 新增 `GET /executors/:address/terminal-states?since=` 只读对账端点；执行器死信目录定期对账（已终态清理、仍 RUNNING 重发）；重试预算改时长型（24h TTL）+ 毒丸上限——admin 滚动升级不再丢任务结果（对应 E-05/E-44）。

### 其余 14 个方向（存档，按需启动）

| 方向 | 来源 | 一句话 |
|---|---|---|
| app-deployment.service 拆分（2505 行 God class → Push/Rollout/Approval 三个 ≤600 行服务） | 后端 3.3 | R-07 类"同一策略两处实现不同步"自然收敛 |
| 配置面二次收口：externalUrls 节 + RetentionService 注册表 | 后端 3.4 | 配置 typo 从"静默 503"变"启动失败"；新增数据族不可能再忘配清理 |
| 跨模块环事件化（task↔executor 直调 → DomainEventBus） | 后端 3.5 | forwardRef 全消失（对应 R-20 死注入） |
| 数据层收口：Query 全站化 + 重试职责归一（消灭 ahooks） | 前端 R2 | F-16/F-32 根治 |
| Monaco 本地化与编辑器资源治理 | 前端 R3 | F-01 的完整工程化收尾 |
| 表单与提交载荷卫生（全受控/白名单/窄 setFieldsValue） | 前端 R4 | F-02/03/28/36 一揽子 |
| 桌面 bundle 出库与内嵌资源管道 | 前端 R5 | F-19/F-20；CI 构建 executor-node 前置 + sha256 清单 |
| 裸机/容器部署安全基线对齐 | 基建 3.5 | "执行器部署最小基线"清单进文档，install.sh/compose/Windows 三处核对 |
| registry 面收敛（pypi 加固 + token 鉴权） | 基建 3.3 | 任务依赖投毒面收敛，BUG-18 python 用例可闭环 |
| CI composite action 化 + selftests job | 基建 3.4 | ci.yml 缩减 200+ 行，8 个自检进门禁（E-13） |
| 迁移守卫：TS 枚举 ⊆ PG 枚举静态校验 + generate dry-run 守卫 | packages R2 | N2 类缺陷从"真机踩坑"变"CI 拦截"（PK-01/10/26） |
| Python 小库工程化：发布管线 + DATABASE_URL 兑现 + 依赖修正 | packages R3 | PK-04/08/12/29 一揽子 |
| 事件/派发协议版本化基线 | packages R4 | outbox 信封 schemaVersion + 派发头 Event-Version（PK-14），增量字段天然兼容 |
| monorepo 编排轻量化（可选） | packages R5 | 不破坏 ARCH-20 前提下的任务缓存/拓扑，收益有限可缓行 |

---

## 八、修复路线图

### 批次 0 · 热修（建议 1~2 天内，几乎全 S 工作量）

| # | 项 | 动作 |
|---|---|---|
| 1 | **R-01**（P0） | task.service 的 update/updateGlue/rollback 三处改 `findByIdRaw` 或保存前回填原始 secrets；补行为回归 |
| 2 | **R-02**（P1） | TaskController.batchDelete + TaskBatchController 四端点透传 user；修固化断言 |
| 3 | **R-03**（P1） | updateGlue/rollback/rollbackToVersion 补归属守卫 + RBAC 矩阵测试 |
| 4 | **R-04**（P1） | jwt.strategy/refreshToken 改 findByIdOrNull |
| 5 | **E-03**（P1） | compose `127.0.0.1:3105:3105` + 去缺省口令 + M3 追加 INITIAL_ADMIN_PASSWORD 校验 |
| 6 | **PK-01**（P1） | 幂等迁移补 cover_early/cancelled 两个 enum 值 |
| 7 | **PK-04+E-14**（P1） | 三包 dev 依赖修 respx + 删 ci.yml:539 continue-on-error |
| 8 | **PK-05**（P1） | mcp healthy 判定修正 + 改固化测试 |
| 9 | **F-02**（P1） | ParamsEditor 全受控 + 回归测试 |

### 批次 1 · P1 清偿（本周）

| # | 项 | 量 |
|---|---|---|
| 1 | **F-01**（P0）：Monaco loader.config 最小切片（完整治理在 A5） | M |
| 2 | **E-02**：python timeout=0 分流 + 两侧互 pin 向量 | S |
| 3 | **E-01**：pull 429 分流 / admin 侧回队 + 修两侧固化断言 | M |
| 4 | **PK-02**：swagger 插件 + Update* 换源 + 重导出 + 空 schema 扫描 | M |
| 5 | **PK-03**：register/heartbeat/pull 三端点 DTO 化 | M |
| 6 | **F-03**：克隆 payload 白名单化 + 字段锚定测试 | S |
| 7 | **F-04**：suggestCron 消费或删除 | S |
| 8 | **F-06**：token 存储策略（短期先修注释 + 威胁模型；HttpOnly Cookie 列批次 2） | S~M |

### 批次 2 · P2 分域排期（1~2 周）

- **安全域**：R-07、R-08、R-14、R-25、E-04、E-09、E-10、E-25、PK-17、F-05/F-06 完整方案
- **可靠性域**：R-11、R-16、E-05、E-06、E-07、E-08、E-11、E-15、PK-08
- **性能域**：R-09、R-10、R-15、R-24、PK-16、F-10、F-11、F-12、PK-09、PK-24
- **CI/测试域**：E-13（selftests job）、E-18、E-32、E-33、E-41、PK-15、PK-26、F-38
- **一致性/契约域**：R-12、PK-06、PK-07、PK-10、PK-11、PK-12、PK-13、PK-14、PK-19、PK-20

### 批次 3 · P3 打磨（每迭代抽 1~2 天，按 §六表格批量清偿）

### 架构演进（季度级，按 §七优先级）

---

## 九、值得肯定的方面（评审中确认的优势，改动时应保持）

- **代码卫生极佳**：admin-api / executor / packages / admin-web 业务代码 **零 TODO/FIXME**、零 `@ts-ignore`、零 skipped 测试（~2,500+ it 用例）。
- **定时任务纪律**：11 个 `@Cron` 全部有 LeaderGate 门禁（ARCH-31 落地完整）。
- **outbox 派发器**（SKIP LOCKED + 租约 + 死信）实现质量高，原始 SQL 全参数化。
- **双执行器 parity 文化**：node/python 大量 ADR 级对照注释、env 白名单 + secret denylist、per-execution HMAC 回调 token、zip 炸弹/路径穿越双闸、有界内存。
- **桌面端安全基线扎实**：contextIsolation、token 掩码、路径域校验、更新器版本兜底。
- **CI 门禁面广**：concurrency、timeout、gitleaks、lockfile 完整性、api-types-drift、windows 矩阵、`pull_request_target` 0 处。
- **openapi 路由级同步率 174/175**；回调契约 CallbackItemDto 字段完整（复核确认）。
- **前端 a11y/错误态/骨架屏**覆盖明显高于一般水准（UI-12 体系）；无 dangerouslySetInnerHTML。

---

## 十、待复核遗留项（合并四份报告 + 第 3 轮新增）

| 来源 | 疑点 |
|---|---|
| 后端 W-1 | refresh_tokens 外键级联语义（R-14 修复依赖） |
| 后端 W-3 | 广播欠计被心跳纠偏的净效应量化（R-06 修正后仍相关） |
| 后端 W-4/W-5/W-6/W-7 | SSE 双槽位一致性；S3 日志深翻页基准；OIDC state cookie 属性；enqueue 补偿 UPDATE 的 open-status 谓词 |
| 前端 | F-36 实际请求体抓包；client.ts 并发 refresh 分支覆盖；SSE token 的生产 nginx 日志策略；stats failed 字段是否本就整型 |
| 执行器 | init-db.sh typeorm 命令是否真失效；E-26 Windows 空格路径复现；E-33 CI worker 数；E-05 多 admin URL 下的死信时限；.env 历史入库（gitleaks 已覆盖面） |
| packages | PK-01 在"曾开 sync"库上的适用边界；PK-10 运行时实测；PK-24 result.logs 是否被 executor 512KB 截断；mcp 工具路由全集；PyPI 实际发布状态；PK-21 存量数据形态；'SERIAL' 大写默认值是否被 executor-python 直接消费 |
| 文档 | docs-site tutorial 系列未抽验；design-system 令牌漂移（F-15 关联） |

---

## 附：阅读指引

- 只想要"下一步做什么" → §八批次 0 的 9 项。
- 修复某条前要看完整证据 → 按编号查对应分报告（§前言文档族索引表）。
- 怀疑某条是误报 → 先查 §四复核修正记录（该条可能已被证伪/改级/扩面）。
- 做季度规划 → §七 20 个架构方向。
