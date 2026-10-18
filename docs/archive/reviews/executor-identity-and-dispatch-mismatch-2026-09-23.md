# 中台部署执行器与任务派发执行器不一致 · 排查报告（2026-09-23 @ f45b2b33）

- 触发来源：生产侧反馈「中台上传的应用明明只部署了执行器 A，但创建任务下发任务时却是执行器 B 在运行；执行器 B 的窗口应用看不到已部署的应用，执行器 A 能看到」
- 附加问题：中台部署页面显示节点地址而非执行器名称/唯一标识（NAT 内执行器地址可能重复）；执行器是否具备唯一标识（如设备指纹）
- 基线：分支 `develop`，HEAD `f45b2b33`，工作区干净（唯一新增为本文档）
- 排查方式：通读注册/心跳/派发/部署四条链路源码 + 系统性 grep；所有结论附 `文件:行号`。**未修改任何现有代码，未运行测试**
- 结论摘要：定位到**两个相互独立的缺陷**。缺陷 1（部署位置未传递到任务派发）是**无条件的**、任何拓扑下都必然复现，为本次现象的主因；缺陷 2（`address` 被当作执行器唯一身份）在 NAT 场景下会引发串台，是同类现象的**另一条独立通路**，且是「地址重复」担忧与「无唯一标识」问题的共同根因

---

## 一、现象与结论对照

| 生产现象 | 根因 | 性质 |
|---|---|---|
| 只部署 A，任务却在 B 上跑 | 缺陷 1：应用清单注册任务时丢失部署目标，派发按全机队负载择优 | **无条件复现**（主因） |
| 同上（另一条通路） | 缺陷 2：A/B 地址碰撞共享 pull 队列，谁先取谁执行 | 条件性（需地址碰撞） |
| B 看不到已部署应用，A 能看到 | 部署产物与任务运行目录是**两棵互不相交的目录树**，B 本就没有部署 | 设计使然，非 bug |
| 部署页显示地址而非名称 | 读面只做密钥掩码、不 join 执行器名称；前端直接渲染地址快照 | 缺名称富化 |
| 地址可能重复 | `address` 是唯一键，但它是**自报、可变、NAT 下可碰撞**的网络定位符 | 设计缺陷 |
| 执行器有无唯一标识 | 无设备指纹级唯一标识；四个候选字段无一可用 | 能力缺失 |

---

## 二、缺陷 1：部署位置根本没有传递到任务派发（主因）

### 2.1 证据链

**① 部署行正确记录了目标执行器**

`apps/admin-api/src/modules/application/app-deployment.service.ts:752,858`

```ts
const deployment = this.repo.create({
  applicationId,
  executorId: executor.id,        // ← 部署目标被正确落库
  executorAddress: executor.address,
  ...
});
```

**② 但应用清单自动注册任务时，只传了 `applicationId`，没有传 `executorId`**

两个调用点均缺失：

- `application.service.ts:1031-1044`（`deployFromGit` 部署时解析 `manifest.json` 自动注册）
- `application.service.ts:1115-1126`（`syncTasksFromManifest`）

```ts
await this._taskService.create({
  name: taskDef.name || taskDef.id,
  id: taskDef.id,
  description: taskDef.description,
  cron: taskDef.cron,
  runtime: taskDef.runtime || manifest.runtime,
  entrypoint: taskDef.entrypoint || manifest.entrypoint,
  timeout: taskDef.timeout || manifest.timeout,
  requirements: taskDef.requirements,
  env: taskDef.env,
  applicationId: app.id,          // ← 只有应用 id，没有 executorId
  glueSource: taskDef.glueSource,
  glueLanguage: taskDef.glueLanguage,
} as any);
```

**③ 派发时只认 `task.executorId` 作为 pinning**

`executor.service.ts:1983-2026` 是 pinning 分支（`if (task.executorId)`），
`executor.service.ts:2027-2142` 是全机队分支（`else`）。

由于 ②，自动注册的任务 `executorId` 恒为 `NULL`，**永远走全机队分支**。

**④ 全机队分支的过滤链里没有任何一环检查「该执行器是否部署了这个应用」**

过滤顺序为：`appName 精确匹配 → group → tags → affinity/anti-affinity → runtime → interpreters → 负载评分`
（`docs/atlas/04-flows/task-lifecycle.md:47` 亦有记载）

对 `executor.service.ts` 全文搜索 `deployedApp` / `appInventory` / `installedApp` / `hasApp`：**零命中**。

因此任务被当作**无状态的一次性执行**，按负载评分（负载 50% + CPU 25% + 内存 25% + 长任务惩罚 10%，`executor-score.util.ts`）丢给全机队最空闲的那台。**B 被选中完全正常，不是调度 bug —— 是调度根本不知道部署意图。**

### 2.2 为什么 B 上没有部署，任务却能跑成功？

这是理解「现象矛盾」的关键：**部署产物与任务运行目录是两棵互不相交的目录树。**

| 用途 | 路径 | 代码锚点 |
|---|---|---|
| 应用**部署**产物 | `<workDir>/apps/<appId>/releases/<version>-<deploymentId>/` | `deploy.ts:616`、`app-inventory.ts:120` |
| 任务**运行**工作目录 | `<workDir>/<executionId>/` | `execute.ts:497` |

zip 渠道任务根本不需要本地有部署：

1. 中台把 `applications.packageUrl` 解析出来附在下发载荷里
   —— `executor.service.ts:2377-2439` `resolveDispatchTask()`
2. 执行器**自己下载 zip 并解压到本次执行的临时目录**
   —— `execute.ts:1417-1467`（`downloadFile` → `safeExtractZip(zipPath, workDir)`）

所以 B 的「本地已部署应用」列表是空的（它确实没部署），但任务照跑不误。**与生产描述逐字吻合。**

### 2.3 判定

`task.executorId`（R6 pinning，`executor.service.ts:1983`）本就是为「我指定这一台」设计的机制，
而应用清单自动注册**漏掉了它**。用户「部署到 A」的意图在任务侧被静默丢弃——这是缺陷，不是设计。

**注意语义需产品确认**：是硬 pinning（A 不可用即失败），还是「优先 A、不可用则降级」。见 §5.3。

---

## 三、缺陷 2：`address` 被当作执行器唯一身份，NAT 下会串台

### 3.1 现状

| 事实 | 锚点 |
|---|---|
| 唯一约束建在 `address` 上 | `executor.entity.ts:38` → `uq_executors_address` unique |
| 注册按 `address` 查行 | `executor.service.ts:965-967` → `findOne({ where: { address } })` |
| `address` 是执行器**自报** | `config.ts:84-85` → `EXECUTOR_ADDRESS_PUBLIC \|\| EXECUTOR_ADDRESS` |
| 桌面端默认取**局域网 IP + 8002** | `uv-paths.ts:275,282-287` + `network-util.ts:11-23`（`os.networkInterfaces()` 首个非 internal IPv4） |

仓库自身已承认此问题 —— `ExecutorInstallWizardPage.tsx:73-74` 注释原文：

> 唯一键是 address，appName 不唯一

### 3.2 后果（两台不同内网机器只要局域网 IP 段相同即触发，`192.168.1.100:8002` 极常见）

**① 注册互相覆盖**：B 注册时改写 A 行的 `appName` / `capabilities` / `startupId` 等
（`executor.service.ts:1047-1074`）。两台机器共享一个 `id`、一份 `tokenHash`、一个 `runningTaskCount`。

**② pull 队列被共享 —— 这是「部署到 A 却在 B 跑」的另一条独立通路**：

- `executor.controller.ts:407` → `findByAddress(body.address)` → 两台机器解析到**同一个** `executor.id`
- `executor.controller.ts:437` → `pullWork(executor.id, ...)`
- `executor-pull.service.ts:86-93` → 队列键 `acf:pull:{executorId}` / `acf:cmd:{executorId}`

两台机器长轮询**同一条 Redis 队列**，谁先 `RPOP` 谁拿走。部署命令（`acf:cmd:`）与任务载荷（`acf:pull:`）都会被这样「抢」。

**③ 重启恢复互相误杀**：`hasExecutorRestarted`（`executor.service.ts:504-524`）比较 `startupId`，
而 `startupId` 是**每进程随机 UUID**（`startup-identity.ts:17-18`）。A/B 交替注册或心跳 →
`didRestart` 反复为真 → `failRunningExecutionsAfterRestart()` 按 `executorAddress`
把**对方正在跑的任务**判成 `EXECUTOR_RESTART` 失败（`executor.service.ts:708-726`）。

**④ token 轮换战**：`startupId` 不同 → `sameProcess=false` → 每次注册都 `rotateToken()`
（`executor.service.ts:1190-1199`），两台机器互相吊销对方的 per-executor token。

**这一组后果解释了「偶发、难复现、时好时坏」的特征** —— 取决于哪台先轮询、哪台先注册。

### 3.3 判定

缺陷 2 是**条件性**的（需地址碰撞）。是否为本起事故的实际通路，需用 §4 的诊断 SQL 在生产库确认。
但无论本次是否命中，它都是必须修的设计缺陷。

---

## 四、生产侧确认方法（区分两个缺陷）

以下查询可直接判定本次现象属于哪条通路（只读，安全）：

**① 是否存在地址碰撞（缺陷 2 判据）**

```sql
-- 地址唯一约束下不应有重复行；此处检查「同一 address 的 startupId 是否频繁翻转」
SELECT address, "appName", "executorStartupId", "executorStartedAt", "lastHeartbeat"
FROM executors
ORDER BY "lastHeartbeat" DESC NULLS LAST;
```

若某 `address` 的 `appName` 在日志中出现过**两个不同值**，或 `executorStartupId` 在短时间内反复变化，
即命中缺陷 2。对照中台日志关键字：

```
Executor <addr> restarted with a new startupId=...
Idempotent re-register for executor ... / Rotated token for executor ...
```

**② 目标任务是否缺失 pinning（缺陷 1 判据）**

```sql
SELECT id, name, "applicationId", "executorId", "executorAppName", "executeMode"
FROM tasks
WHERE "applicationId" = '<受影响应用 id>';
```

`executorId` 为 `NULL` 即确认缺陷 1（预期为 NULL，因自动注册从不写该列）。

**③ 确认执行落在哪台**

```sql
SELECT e.id, e."taskName", e."executorAddress", e.status, e."startTime"
FROM task_executions e
WHERE e."taskId" IN (SELECT id FROM tasks WHERE "applicationId" = '<应用 id>')
ORDER BY e."startTime" DESC LIMIT 20;
```

---

## 五、建议修复方向

按性价比与风险排序。

### 5.1 P0 —— 止血（可独立上线，无破坏性）

1. **注册/心跳加 `address` 冲突检测**：同一 `address` 上报不同 `startupId` 且时间重叠时告警
   （不静默覆盖）。至少让问题**可见**，不再静默串台。
   ✅ **已实现**（ARCH-34 P0）：`executor-address-conflict.util.ts` +
   `executor.service.ts` 的 `observeAddressConflict()`（register/heartbeat 两入口共享
   跟踪器，冲突外发 ERROR 级通知）。判据是「**被顶替的**进程生命重新上报」而非
   「同 address 出现不同 startupId」——后者是正常重启的形状，会导致每次重启误报。
2. **pull 队列键改用不可猜测的实例标识**（而非共享的 `executorId`），并让 `register` 返回该标识。
   这是消除「抢队列」的最小改动。
   ⏳ **未实现**。**范围已明确为独立轨道**（不必等 ADR-017 阶段 3）：
   `acf:pull:` / `acf:cmd:` 由 `address` 派生改为由 `id` 派生即可获得不可猜测性——
   `id` 是中台生成的 UUID、执行器无法自选。见 ADR-017「实施记录 · 相关轨道」。

### 5.2 P1 —— 语义修正

> **修订（实现阶段复核）**：本节原第 3 项经源码复核后**判定为误诊，已作废**；
> 修正后的方案即第 4 项，并已落地（见 §5.2.1）。以下保留原始表述并标注结论，
> 以免后续读者按错误方向再改一遍。

3. ~~**应用清单自动注册任务时补 `executorId`**（`application.service.ts:1031` 与 `:1115` 两处），
   把「部署到 A」的意图传递到任务派发。~~

   **❌ 误诊，已作废。** 复核结论：`deployFromGit(id, gitRepo, gitBranch, gitCommit?)`
   （`application.service.ts:945`）与 `syncTasksFromManifest(appId, manifestPath?)`
   （`:1084`）**作用域内根本没有执行器**——它们的职责是把应用源码/manifest **导入
   `applications` 表**（建任务定义），不是「部署到某台机器」。唯一调用链是
   `application.controller.ts:669`（手动同步 manifest）与 `:485`（git 导入），
   两条路径都不涉及任何 executor。在这里写 `executorId` 只能靠猜（且会写错：同一
   应用可部署到多台）。**正确的插入点是派发时刻**，即第 4 项。

4. **`dispatch()` 增加「已部署该应用」偏好**，作为 pinning 缺失时的兜底
   （对存量 `executorId IS NULL` 的任务同样生效）。✅ **已实现**（§5.2.1）。

#### 5.2.1 已落地实现（ARCH-35 P1）

**关键前置结论（决定了方案形态）**：经双执行器全量核验，**任务执行完全不依赖
执行器本地是否部署过该应用**。四种 `codeSource`（`git`/`glue`/`application_zip`/
存量 `NULL`）的执行路径（`<workDir>/<executionId>/`）与部署产物路径
（`<workDir>/apps/<appId>/`）是**两棵互不相交的目录树**，执行路径从不读 `apps/`：
git 自行 clone、glue 脚本随载荷下发、zip 自行下载 admin 附加的 `packageUrl`。
`applicationId` 在执行器侧**从不变成文件路径**。最硬的旁证：`executor-python`
**没有 deploy 路由**（`commands.py` 将 deploy 声明为 "unsupported"）——若执行依赖
本地部署，所有 python 执行器上的任务都将无法运行。

**因此方案必须是「偏好」而非「过滤」**：硬过滤会误伤全部未部署任务与 python
执行器（候选集清空 → 派发失败）。实现要点：

| 项 | 实现 |
|---|---|
| 判据 | `app_deployments` 中 `status='running'` 的行；`executorId` 精确命中优先，`executorAddress` 兜底（存量行 `executorId` 为 NULL） |
| 算法 | `partitionByDeploymentAffinity()` **稳定分区**（`executor-deployment-affinity.util.ts`）：命中组整体前置、组内保持评分顺序。**不改评分**——决策日志的 score 必须始终是真实负载分，否则「为什么选这台」无法回溯 |
| 插入点 | `executor.service.ts` 的 `dispatch()`，**评分排序之后、原子占坑之前**（在排序前分区会被随后的全量 sort 打散） |
| 降级 | 占坑循环按序逐个尝试：部署那台满了/离线了自动回落全机队，**零新增失败面**（`ordered` 与入参同元素集） |
| 开关 | `EXECUTOR_PREFER_DEPLOYED`（默认 `true`；置 `false` 一行回滚到纯负载择优） |
| 容错 | 查询失败**不抛**（warn + 原序）——偏好缺失 ≠ 无法调度 |
| 可观测 | 决策日志新增 `deploymentAffinity` 字段（`preferred`/`matchedByExecutorId`/`matchedByAddressOnly`/`runningDeployments`），可区分「没部署」与「部署了但没命中候选」 |
| 不缓存 | 刻意不加 TTL 缓存：事故场景正是「刚部署完 A → 立刻下发任务」，缓存会让用户在最该生效的时刻看到旧结论 |

**测试**：`executor-deployment-affinity.util.spec.ts`（21 例，穷举分区/匹配/脏数据
边界）+ `executor.service.spec.ts` 的「ARCH-35 P1 接线」块（10 例，含**偏好生效**、
**降级回落**、开关关闭/无 applicationId/无部署行/仓库未装配的**零行为变化**、
查询抛错的 best-effort、决策日志字段）+ `executor-deployment-entity-registration.spec.ts`
（5 例，钉住 `AppDeployment` 在 executor 侧二次注册后 `@ManyToOne(Application)`
的关系闭包可解析——这类错误只在启动期建元数据时暴露，全 mock 的单测永远测不到）。

**刻意不做的相邻改动（避免后续读者误以为是遗漏）**：`selectLeastLoaded()` 同样被
`app-deployment.service.ts:741` 的**部署**链路调用（未指定 `executorId` 时自动选
最闲的一台），本项**没有**给它加部署归属偏好。原因：部署的语义是「把应用装到某台
机器上」，**同一应用可有意部署到多台**（用户连点两次部署即期望得到两台）；若部署
也粘住「已部署过的那台」，第二次部署会变成原地重装，用户将**无法**把应用铺到多台
执行器。任务派发则相反——任务只应跑在「该应用所在之处」之一。两者语义不同，故只改
后者。

**遗留**：本项修的是「用户的部署意图被静默丢弃」，**不修** address 冲突（第 1、2、5 项）。
若生产环境确有 address 碰撞，偏好仍可能因两机共享一行而指错——那属 §5.1/§5.3 的范围。

### 5.3 P2 —— 身份体系（需 ADR）

5. **引入设备指纹唯一标识**：`machineId`（Windows `MachineGuid` / Linux `/etc/machine-id`）
   + 安装实例盐值 → `deviceFingerprint`，作为**注册幂等键与冲突检测依据**；
   `address` 降级为纯「当前可达地址」元数据。
   - ✅ **阶段 1 已落地**（ARCH-34）`address` 冲突检测 + ERROR 告警，
     见 `executor-address-conflict.util.ts`；零行为变更，已上线。
   - ✅ **阶段 2 已落地**（ARCH-36）三端上报 `deviceFingerprint` + 中台落列（可空）+
     冲突/漂移观测。**仍不改定位逻辑**——注册继续按 `address` 定位行，
     故可独立发布与回滚。落地明细见
     [ADR-017](../../adr/adr-017-executor-unique-identity.md) 的「实施记录」。
   - ⏳ **阶段 3 未做**：注册定位切换为 `deviceFingerprint`、`address` 降级、
     列加非空约束 + 存量回填 `legacy:${address}`、冲突时后到者 `409` 拒绝。
     前置条件是存量机队基本升到协议 v3（否则旧端不上报指纹，定位会退化）。
6. **读面富化**：`app_deployments` / `task_executions` 读面 join 执行器 `appName` + 稳定短 ID，
   前端展示「名称（短 ID）」，地址折叠进 tooltip。注意 `executorId` 当前可空，需兼容存量行。
   ⏳ **未实现**（独立于阶段 3，可先行）。

**风险提示**：第 5 项涉及注册/令牌/调度三处语义，且 `address` 是现有唯一索引 ——
属需要写 ADR 的架构变更，**不建议在补丁里顺手改**。已另起草案见 `docs/adr/adr-017-*.md`
（现为 Accepted，阶段 1+2 已落地、阶段 3 待实施）。

**阶段 2 落地时发现的一个静默故障**（值得记录，因为它本会被阶段 3 误当成「正常换网」）：
安装盐原计划放在 `workDir` 顶层，而 `workDir` 顶层的**一切（含文件）**都会被 TTL 清扫
按 mtime 删除 → 盐被删掉后重建 = **指纹每周静默漂移一次**，且在阶段 2 的观测面上会
伪装成「地址漂移」（合法的换网形态）而不告警。两端同批把 `.device-identity` 加入
`PROTECTED_WORKDIR_NAMES` / `_PROTECTED_WORKDIR_NAMES`。

---

## 六、回答「执行器有没有唯一标识」

**结论：没有设备指纹级唯一标识。** 现存四个「像 ID」的字段，无一可用：

| 字段 | 位置 | 性质 | 能否当唯一标识 |
|---|---|---|---|
| `executors.id` | `executor.entity.ts:40` | 中台生成 UUID | **唯一且稳定，但注册时不用它定位行**（用 address），故「哪台机器对应此 id」无保证 |
| `executorStartupId` | `executor.entity.ts:97` | 每进程随机 UUID（`startup-identity.ts:17-18`） | ❌ 每次重启即变，仅做幂等/重启检测 |
| `appName` | `executor.entity.ts:41` | `APP_NAME` env，默认 `executor-node-1` / `os.hostname()` / `executor-node-$(hostname)` | ❌ 非唯一、无约束 |
| `EXECUTOR_ID` | `config.ts:86` | env，默认空串 | ❌ **全仓唯一用处**是 `update-package.ts:160,180` 上报，注册身份完全不用它 |

即：**唯一键 = address = 自报、可变、NAT 下可重复的网络定位符。**

---

## 七、附录：关键代码锚点索引

| 主题 | 锚点 |
|---|---|
| 部署落库（含 executorId） | `app-deployment.service.ts:752,858` |
| 应用清单注册任务（**缺失 executorId——已判定无需在此修，见 §5.2 修订**） | `application.service.ts:1031-1044`、`:1115-1126` |
| **部署归属偏好（ARCH-35 P1 已实现）** | `executor-deployment-affinity.util.ts`、`executor.service.ts` 的 `dispatch()` 评分排序后/占坑前、`resolveRunningDeployments()` |
| 派发 pinning 分支 | `executor.service.ts:1983-2026` |
| 派发全机队分支 | `executor.service.ts:2027-2142` |
| 调度评分公式 | `executor-score.util.ts` |
| zip 渠道 packageUrl 解析 | `executor.service.ts:2377-2439` |
| 执行器侧 zip 下载/解压 | `execute.ts:1417-1467` |
| 任务运行目录 | `execute.ts:497` |
| 部署产物目录 | `deploy.ts:616`、`app-inventory.ts:120` |
| **address 冲突检测（ARCH-34 P0 已实现）** | `executor-address-conflict.util.ts`、`executor.service.ts` 的 `observeAddressConflict()` |
| address 唯一索引 | `executor.entity.ts:38` |
| 注册按 address 查行 | `executor.service.ts:965-967` |
| 注册字段覆盖 | `executor.service.ts:1047-1074` |
| 重启检测 | `executor.service.ts:504-524` |
| 重启误杀 | `executor.service.ts:708-726` |
| token 轮换判定 | `executor.service.ts:1190-1199` |
| pull 端点身份解析 | `executor.controller.ts:407,437` |
| pull 队列键 | `executor-pull.service.ts:86-93` |
| 地址自报来源 | `config.ts:84-85`、`uv-paths.ts:275,282-287`、`network-util.ts:11-23` |
| 部署读面（仅掩码，无 join） | `app-deployment.service.ts:279-291` |
| 前端地址渲染 | `AppDeploymentPage.tsx:401-402`、`ApplicationDetailPage.tsx:537,665` |
| 前端名称渲染（对照组） | `ExecutorListPage.tsx:190-195` |

## 关联

- 计划项：建议登记为 BUG-EXEC-DISPATCH-MISMATCH / ARCH-34（执行器身份）
- 相关 ADR：ADR-015（pull 派发）、ADR-016（控制面 pull）、**ADR-017（执行器唯一标识，草案）**
- 相关文档：`docs/atlas/04-flows/executor-registration.md`、`docs/atlas/04-flows/task-lifecycle.md`、
  `docs/atlas/01-apps/admin-api/modules/executor.md`
