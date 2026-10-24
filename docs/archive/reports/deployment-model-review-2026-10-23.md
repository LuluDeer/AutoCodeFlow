# 应用/任务部署模型排查报告与调整方案（zip 包管理模式）

> 状态：**分析与方案（未实现）** · 产出：2026-10-23 · 范围：admin-api / executor-node / executor-python / executor-desktop / admin-web / CLI
> 触发：用户反馈「运行部署模式很乱」——同一版本可重复部署、未部署执行器每次运行都重复部署、产物按部署行落盘、中台历史版本显示生效、回滚与一键升级语义不清。
> 结论口径：**问题成立**。当前 zip 部署链把「应用部署」与「任务执行」设计成**两套互不复用的取件与解压链**，部署行又被当成「设备×应用」的唯一记录载体；这正是「乱」的结构性来源。

---

## 一、现状模型（代码事实，逐条可核）

### 1.1 六条相互独立的链路

| # | 链路 | 入口 | 落点 | 是否复用 |
|---|---|---|---|---|
| A | 应用包上传 | `POST /applications/upload`（controller.ts:236） | `uploads/packages/<name>_<ts>.zip` + 建/更 `application_versions` 快照 | 版本号不填则**不写快照** |
| B | 应用部署（仅部署） | `POST /app-deployments/applications/:appId/deploy` | `<workDir>/apps/<appId>/releases/<version>-<deploymentId>/` + `current` 软链 | 仅当同 (app,executor) 已有终态行时复用**行** |
| C | 应用「运行」 | runMode=once/daemon | 在 B 的 release 目录里跑进程 | — |
| D | 应用升级/回滚 | `/app-deployments/:id/upgrade`、`/applications/:id/rollback/:id` | 同 B，**行原位覆盖**，release 目录换名（唯一后缀） | 版本快照必须已存在 |
| E | 任务执行（zip 渠道） | `ExecutorService.dispatch` → 执行器 `/api/execute` | `<workDir>/<executionId>/`，每次重新下载+解压 | **不读 B 的 release** |
| F | 任务级 python 环境 | `/api/execute` prepare 阶段 | `<workDir>/.venvs/<taskId>[-<X.Y>]`，按 pyvenv.cfg+池存在性判定复用 | venv 复用，但包体**不与版本绑定** |

**核心事实（用户体感的根因）**：zip 应用包在部署时解压到 `apps/<appId>/releases/...`，而任务执行时（E）**从不读该目录**，而是把 `applications.packageUrl` 解析进派发载荷、在 `<workDir>/<executionId>/` 重新下载同一份 zip 再解压。于是：

- 「部署」对 zip 渠道任务而言**不产生任何运行时可复用资产**（只有 daemon/once 模式的部署会真起进程）；
- 「未部署的执行器」每次执行都重下重解压——这不是部署缺失的 bug，而是设计如此；
- 换来的代价是「部署过」的语义与「任务跑过」的语义彻底脱钩。

### 1.2 `app_deployments` 的真实语义（与名字不符）

实体（`app-deployment.entity.ts`）自称「记录 + 进程状态」，但被四处当作不同东西用：

1. **in-flight 互斥载体**：部分唯一索引 `uq_app_deployments_application_in_flight (applicationId) WHERE status IN ('pending','deploying')`（迁移 `1789000000000`）——**同一应用全局只允许一个在途部署**，与执行器无关。待审批行复用 `pending` 因此也占坑。
2. **设备×应用记录**：`deploy()` 在「同 (app, executorId) 存在 failed/stopped 且 runMode 相同」时**原地复用行**（service.ts:979-1035），注释自述「一台设备一条记录」。
3. **版本/发布追溯源**：`getReleases`/`getVersionHistory`/`buildDeployCountMap` 全量 `findAllByApp`（`take: 5000`）。
4. **调度约束集**：strict 模式把 `status IN (running, stopped, upgrading)` 的行当「该应用已部署设备集合」（executor.service.ts:4998-5018）。

四种用途叠加，导致：**同一 (app, executor) 上每次重新部署/升级/回滚都在改同一行**，历史版本要么只在 `application_versions` 里（快照表），要么只剩一行被覆盖后的现状。

### 1.3 版本模型（「历史版本也显示生效」的机制）

- `application_versions` 有唯一索引 `(applicationId, version)`；`saveVersionSnapshot` 按 `(applicationId, version, gitCommit, sourceDeploymentId)` 去重（service.ts:2002-2059）。
- `status` 列在心跳落 RUNNING 时被写成 `released`（:1606），失败/扫死写 `failed`（:1608、:2346）。**该列是「最近一次涉及此版本的部署结果」，不是「该版本全局生效状态」。**
- 版本行的展示状态与执行器地址来自「`deployedVersion` 匹配的最近一次部署行」（`latestByDeployment`，:534-545）：A 机跑 v1、B 机跑 v2 时，v1 与 v2 两行都会显示 running + 各自的机器——**这不是「多个版本同时生效」，而是「每台机器各自的现状被合并到版本行上」**。UI（`ReleasesTab`）与文案没有把这层意思说清，用户看到的就是「历史版本也生效」。
- 真正的「设备当前版本」在**执行器侧**：`<appRoot>/current` 软链 + `app.json.lastVersion`（deploy.ts:1366-1407、app-inventory.ts:309）。中台**不持有**设备当前版本这一事实，只能从「最近一次部署行」推断，且该推断在行被复用覆盖后失真（见 2.6）。

### 1.4 产物（执行产物，FEAT-05）与「部署产物」

- **执行产物**：任务写 `<workDir>/artifacts/`，结束时 best-effort 上传到 admin `uploads/artifacts/<execId>/<name>`（artifacts.service.ts:66-136、artifacts.constants.ts:16-22），按**执行 ID**分目录，TTL 与日志保留期同步回收（artifacts-retention.service.ts）。
- **应用包体**：`uploads/packages/<name>_<ts>.zip`，扁平目录、文件名带时间戳，`recordUploadVersion` 负责把包 URL 钉进版本快照。
- 用户提出的「专门文件夹存产物、内层按应用、再内层按任务 ID」指的是**应用包体/部署产物**的落盘组织，与执行产物不是同一物（报告第三节给出两套的分别处理）。

---

## 二、逐项问题清单（现象 → 代码机制 → 判定）

### P1 同一版本可以重复部署很多次 —— **机制正确，但记录模型造成重复**
- 现状：同版本再次 deploy 时，若 (app, exec) 无终态行 → 新建一行；有终态行且 runMode 相同 → 复用行。跨执行器则必然多行（每台一行）。每次升级/回滚是**行原位覆盖**，不产生新行。
- 于是「同一版本多次部署」的证据散落为：多台各一行 + `application_versions.deployCount`（只增计数）。
- 判定：**不是重复执行同一个部署**（in-flight 索引保证全局串行），而是**没有「部署单元 = 应用×设备×版本」这样的显式记录**，用户无法表达「把 v2 部署到 B 机」并保留 v1 在 A 机的行。要实现该语义，必须新增 (applicationId, executorId, deployedVersion) 维度的记录或版本化行，与现有「复用终态行」策略互斥（见 4.1 权衡）。

### P2 未部署执行器每次运行都重复部署 —— **设计缺陷，非 bug**
- 机制见 §1.1（E 链路）。`archive/audits/cli-agent-ux-audit-2026-10-08.md:298` 与 `docs/design/agent-and-deployment/01-deployment.md:31` 都把该行为记录为**有意**（「部署产物树与执行树互不相交」），并以此论证部署软偏好只能是「偏好」不能是「硬过滤」。
- 代价：每个 zip 任务执行都要重新下载（`ZIP_DOWNLOAD_TIMEOUT_MS=120s`、`packageDownloadMaxBytes`）+ zip 安全审查 + 解压 + 依赖安装；同一个包在 N 台设备、M 次执行上重复 N×M 次传输与解压。
- 判定：**应改为内容寻址缓存 + 设备本地发布目录**（见 4.5），但需要跨三端（admin/node/python）一致改造与缓存回收策略，属较大工程。

### P3 「每个部署内放产物」的组织方式 —— **用户判断成立，布局有硬伤**
- 部署 release 目录名带**唯一后缀**：`resolveReleasePaths` 在目标目录已存在时追加 `-<ts36>-<pid36>-<seq36>`（deploy.ts:861-891），原因是「同 (version, deploymentId) 重复部署会覆盖活 release」——这是对**「deploymentId 进目录名」这一决定**的补丁。
- 由于 `resolveReleasePaths` 在**同执行器重复部署**时也换新目录，历史行复用的「一台设备一条记录」与磁盘上的 release 目录**不再一一对应**；app-inventory 需要 `RELEASE_SUFFIX_RE` 专门剥后缀（app-inventory.ts:134）。
- 产物语义被迫绑进部署目录：`KEEP_RELEASES=5` 按 mtime 保留（deploy.ts:905、982-1029），与中台「版本历史」各自为政。
- 判定：**包体（内容寻址）+ 发布物（应用级目录）+ 运行态（每设备 current 指针）应分层**，而不是全部塞进 `releases/<version>-<deploymentId>`（见 4.5）。

### P4 中台历史版本「也显示生效」 —— **展示语义缺陷**
- 机制见 §1.3。版本行状态列混用了「快照状态机」与「最近一次部署状态」，机器列来自最近一次匹配部署。
- 另外 `GET /applications/:id/releases` 与 `GET /applications/:id/versions`（legacy alias）**两套读面并存**（app-deployment.service.ts:426-684、application.controller.ts:603-621），前端两个 Tab（deployments/versions/releases）各自消费一份，信息不一致进一步放大「乱」。
- 判定：**版本行只应表达「该版本的存在与内容」，不应伪装成「当前生效」**；「哪台设备当前跑哪版」必须来自设备侧上报（新增字段，见 4.3）。

### P5 版本控制应「按设备走」，切换已部署版本应可行 —— **数据模型缺失**
- 现状：设备当前版本无中台事实源（§1.3 末）。心跳（`DeploymentHeartbeatDto`）只带 `deploymentId/status/pid/message`，注册/心跳的 `interpreters` 是唯一的能力上报。
- 可行改造：把「当前生效 releaseKey + version + 若干保留版本」随心跳上报，中台落 `task_executions`-同级的新表或 `app_deployments` 新列（见 4.3）。
- 判定：**这是「按设备做版本控制」的前置数据**，缺失是当前一切「看不出哪台跑哪版」的根。

### P6 回滚语义不清：点回滚要不要重新部署 —— **端点行为正确但命名误导，且 UI 未区分**
- `rollbackApplication`（service.ts:758-834）实际做的是：**改应用的当前字段（version/commit/packageUrl/entrypoint/manifest/env…）** → 再对**所有 RUNNING 部署**逐个 `upgrade`。
- 因此：
  - 「不重新部署」只对**未运行的部署（scheduled/stopped）**成立——它只改配置，确实不动设备；
  - 对 **RUNNING** 的部署，它会触发升级推送，即**真的会重新部署**（用户问的正是这点，答案是「会」）；
  - 对**从未部署过**的应用，它只改配置（无 RUNNING 行），设备上不会有任何变化。
- `docs/rollback-semantics.md` 只对**任务** rollback 两型做了对照，**应用** rollback 未纳入，命名「回滚」掩盖了「改配置 + 全量滚动升级」的组合语义。
- 判定：**功能基本正确，需拆成两个明确动作**（「设置为当前版本」与「下发到设备/全量升级」），并把 legacy 路径的 `packageUrlRestored=false` 如实前置到选择界面（现仅事后 warning，ApplicationDetailPage.tsx:536）。

### P7 一键升级的语义与覆盖范围 —— **部分正确、有两处不一致**
- `upgradeAllWithRollout`（service.ts:2370+）与 `upgradeRunningDeployments`（:2157）**只处理 RUNNING 行**：
  - `scheduled`（仅部署待触发）的设备永远拿不到新版本，除非任务真的被派过去；
  - `stopped/failed/pending` 行被静默跳过（前端只在 runningCount===0 时提示，AppDeploymentPage.tsx:403）。
- 「一键升级」的实际执行是**逐台 `upgrade`（overlay）**：重新下载当前 `applications.packageUrl/dist` 并重解压到新 release 目录，而不是「复用已有产物」。
- 与「一键升级」并存的「版本定向灰度（`version` 参数，渐进式回滚）」是**先按快照改应用字段、再走灰度**（rollout.dto.ts:93-110）——即它**也会改中台的应用当前版本**，与用户期待的「只把某几台切到旧版本、不动全局」不符。
- 判定：需要把「全局版本切换」与「设备级版本切换」拆开（4.2/4.3），并把 upgrade-all 的覆盖面显式化（含 scheduled 设备）。

### P8 部署记录/版本历史的读取面存在**静默不完整**（附带发现，需一并修）
- `findAllByApp` 固定 `take: 5000`（service.ts:340-342），被 `buildDeployCountMap`、`getDeploymentVersionFallback`、`findStats`、`getVersionHistory` 共同使用；
- `getReleases` 的 synthetic 聚合另有 `RELEASES_SYNTHETIC_SCAN_MAX_ROWS=5000`（:134）。
- 复核：应用级删除只清 `uploads/packages` 下**被快照引用的**包（application.service.ts:405-433），**不呼叫**执行器 `/app-uninstall`；`executor-desktop` 的 `apps:uninstall`（ipc-handlers.ts:1199）是本地动作。因此部署行不会因设备卸载而减少，超 5000 行的应用「部署计数/版本历史」会静默失真。
- 另：超过 5 个 release 后，设备会被 `pruneOldReleases` 清掉旧 release；而**部署行仍显示该版本**（UI 误导用户以为设备上有该版本可切）。

### P9 CLI 的「仅部署」是机制的一部分
- `acf app deploy` 默认 `-m scheduled`（「仅部署、中台触发」），且文档明确「显式 once/daemon 会立刻启动入口脚本」（`packages/acf-cli/src/commands/apps.ts:352`、`atlas/05-interfaces/cli.md`）。
- 判定：CLI 与 admin-web 部署弹窗三档（单次/常驻/仅部署）**语义一致**，无需改动；需要调整的是后端对 scheduled 设备的版本推进与设备级版本视图。

### P10 执行器包（executor_packages）的重复部署
- `ExecutorPackage` 有唯一索引 `(name, version, type)`，`create` 先查存在即 400（executor-package.service.ts:249-258），**不存在重复版本**。
- `pushToExecutors` 每次推送都重新走 pull 队列/HTTP，且无「目标已安装该版本」的短路（:793-944），重复推送产生重复传输；另 `status` 只有 active/deprecated，**没有「哪个版本是各执行器当前版本」的事实源**——这与 P5 是同型问题（缺设备级版本收敛），用户感觉「中台部署乱」的一部分来自这里。
- 判定：为执行器包补设备级版本收敛查询/展示，推送侧按「已装同版本」短路（低成本）。

---

## 三、目标模型（建议的「唯一事实源」划分）

| 事实 | 建议事实源 | 现状 |
|---|---|---|
| 包体内容（zip 字节） | **内容寻址**：`uploads/packages/<appId>/<sha256>/<filename>.zip`（或对象存储），上传即算 sha256 | 扁平 `<name>_<ts>.zip`，同名不同内容无法区分 |
| 应用版本（配置/元数据） | `application_versions`（不可变快照）——**保留** | 已有 |
| 应用级发布物（解压后的内容） | 设备侧 `<workDir>/apps/<appId>/releases/<version>/`（**appId/version 两段，不含 deploymentId**） | 含 deploymentId + 后缀 |
| 设备当前版本 | 设备侧 `apps/<appId>/current` 软链（已有）+ **随心跳上报**；中台新表/新列记录 | 中台无 |
| 部署动作历史 | **事件/历史表**（新增或复用 `app_deployments` 但按「不可变历史」写入） | 复用行、被覆盖 |
| 设备×应用「录入行」 | 若需要，新增独立表（`app_deployment_targets`：applicationId+executorId 唯一，记录期望版本/模式/启用） | 与历史混在 `app_deployments` |
| 任务运行环境（venv） | 设备侧 `.venvs/<taskId>[-<runtimeVersion>]`（已有） | 已有，但未与「应用版本」挂钩 |
| 执行产物 | 中台 `uploads/artifacts/<execId>/` | 已有（与本次诉求无冲突） |

**关键取舍：不要把「历史」压进「当前状态行」。** 现模型把二者压在 `app_deployments` 一行上，导致每次动作都覆盖上一次的事实；一旦把「动作历史」不可变化，P1/P4/P6/P7 的多数困惑会自然消失。

---

## 四、建议方案（按收益/成本排序，均给出落地路径）

### 4.0 术语先收敛（零代码，先做）
在 UI/文档中把三个词固定下来，禁止混用：
- **上传（Upload）**：把包放进中台仓库（产生 `application_versions` 快照）。
- **部署（Deploy/Publish）**：把某版本发布到某台设备（产生发布物 + 设备 `current` 指针变化）。
- **运行（Run）**：在设备上起进程（once/daemon）；任务执行（Execute）是另一条链。

### 4.1 「一台设备一行」还是「每次部署一行」——需要产品拍板
- 方案 A（现状加强）：保留「(app, executor) 一行现状 + 行复用」，另立**不可变部署事件表**记录每次动作（版本、行为、结果、操作人）。改动小（只加表 + 写入），能修 P1/P4 的追溯问题。
- 方案 B（目标态）：`app_deployments` 变为**每次部署一行不可变历史**（`deployedVersion` 为写入时的事实），设备当前版本来自设备上报；「一台设备一行」只作为**查询视图**。改动大（in-flight 唯一索引、行复用、读面聚合、前端全部联动）。
- 建议：**先落方案 A**（本轮可完成），把方案 B 作为第二阶段（与 P5 一起做，因为设备上报本来就要改心跳契约）。

### 4.2 把「回滚」拆成两个明确动作（修 P6，收益最高）
1. `POST /applications/:id/set-current-version`（建议命名 `激活版本`）：只改应用当前字段（= 现 `rollbackApplication` 的**前半段**），**不动设备**；响应明示「未下发」。
2. `POST /applications/:id/deploy-version`：接受 `version` + `executorIds?`，向选中设备下发该版本的推送（复用 `upgradeWithSnapshot` 链）。
- UI：版本行按钮改为「设为当前版本」（安全色）+「下发到设备」（危险色），并在选择时前置显示该版本快照是否含 `packageUrl`（取代事后 `packageUrlRestored=false` warning）。
- 影响面：`application.controller.ts`（新增端点）、`app-deployment.service.ts`（拆方法）、`applications.ts` + `ApplicationDetailPage.tsx`（按钮与文案）、`docs/api-reference.md`、`docs/rollback-semantics.md`（把应用 rollback 纳入对照表）。
- 兼容：保留旧端点作为过渡 alias 一版，前端切完后删除。

### 4.3 设备级版本控制（修 P4/P5，与 4.1 方案 B 前置数据）
- 心跳/注册契约新增（纯增量，旧执行器忽略）：
  ```ts
  deployedApps?: Array<{
    appId: string;
    currentVersion: string | null;
    currentReleaseKey: string | null;
    retainedVersions: string[];   // 本次保留在磁盘的版本（prune 后）
    runMode: 'once' | 'daemon' | 'scheduled' | null;
    lastDeployedAt: string | null;
  }>
  ```
- 执行器实现：`executor-node` 侧已有 `app-inventory.ts` 的扫描（可直接复用/收敛为共享实现）；`executor-python` 目前**没有** deploy 路由与 apps 目录，如实上报空数组（不造假数据）。
- 中台落地：新表 `executor_app_versions`（executorId + applicationId 唯一，存 currentVersion/retainedVersions/lastReportedAt），或先作为 `executors` 的 jsonb 列（成本更低，查询弱）。
- 读面：`GET /applications/:id/releases` 每行增加 `deployedOn: [{executorId, executorName, version, isCurrent, hasLocalRelease}]`；版本行状态列从「最近一次部署状态」改为设备聚合，**不再暗示全局生效**。
- 影响面：`executor-heartbeat.dto.ts`/`executor-register.dto.ts`、`executor.service.ts` 心跳处理、`app-deployment.service.ts` 读面、`ApplicationDetailPage.tsx` 版本/发布 Tab、桌面端 `app-inventory` 复用、协议契约（`packages/executor-protocol/protocol.json` 若纳入 schema 需同步三端）与一致性测试。

### 4.4 一键升级覆盖面显式化（修 P7）
- 后端：`upgradeAll` 增加 `includeScheduled`（默认 true，向「已部署该应用的设备」全量下发，含 scheduled/stopped），返回值按状态分组：`{running: n, scheduled: n, stopped: n, skipped: [...]}`。
- 执行器：scheduled 模式下「升级」= 拉新包、切 `current`、**不启动进程**（现行为已如此，仅需允许对 stopped/scheduled 行下发）。
- 前端：把「升级所有」的提示从「N 个运行中实例」改为「将覆盖 M 台设备（其中 X 台仅部署待触发）」，避免用户以为只覆盖 running。
- 「版本定向」语义澄清：把 `upgrade-all {version}` 拆为「激活该版本（改应用字段）」+「灰度下发」两步显式动作，或至少在响应/文档中标注它**改了中台当前版本**。

### 4.5 包体与发布物分层（修 P2/P3，工程量最大，建议第二阶段）
1. **内容寻址仓库**：上传时算 sha256，落 `uploads/packages/<appId>/<sha256>.zip`；`application_versions.snapshot.packageUrl` 指向该地址。同一个包上传两次得到同一 URL（天然去重、可校验、可断点缓存）。
2. **执行器本地包缓存**：`<workDir>/.pkg-cache/<sha256>.zip` + 解压产物缓存 `<workDir>/.pkg-extract/<sha256>/`；任务执行（E 链路）与部署（B 链路）都先查缓存，命中则直接硬链接/复制到工作目录，未命中才下载。这样「未部署的设备首次运行」由**一次下载**变为「一次下载 + N 次零成本复用」，且**部署过的设备天然命中**（因为部署已把包放进缓存）。
3. **发布物目录改为 appId/version 两段**：`apps/<appId>/releases/<version>/`（版本字符串做归一化，不含 deploymentId）；删除 `resolveReleasePaths` 的后缀补丁（同名版本再部署只需幂等覆盖或直接复用，因为部署动作不再写 deploymentId 进路径）。
4. **保留策略与版本对齐**：设备侧「保留最近 N 个版本 + current」；中台版本列表据设备上报标注「设备上是否仍保留该 release」（修 P8 的误导）。
5. **执行器包同理**：`executor_packages` 已有 sha256（`checksum`），push 前短路「目标已持有同 checksum」（低成本，本轮可做）。

### 4.6 存储组织（回答「为什么不专门弄一个文件夹存产物」）
- **应用包体**（上传/部署）：`uploads/packages/<appId>/<sha256>/<origName>.zip`（内容寻址 + 应用二次分组，可追溯、可去重）。
- **执行产物**（任务是运行输出）：保持 `uploads/artifacts/<execId>/<name>`（现状），但**建议增加应用维度索引**：`uploads/artifacts/<appId>/<taskId>/<execId>/<name>`，或在 DB 清单里带 `applicationId/taskId` 便于按「应用 → 任务」浏览与清理。**注意**：现清理按 execId 目录 TTL，改成嵌套目录需同步改 `artifacts-retention.service.ts` 与下载路由，属独立小工程。
- 用户建议的「内层按应用、再内层按任务 ID」**建议采纳为执行产物的组织**；对**应用包体**则更推荐内容寻址（避免同一版本重复占盘）。

### 4.7 修 P8 的读取面上限
- 把 `findAllByApp` 的固定 5000 改为**分页/聚合查询**（DB 侧 `COUNT`/`GROUP BY`），或用「部署事件表」（4.1 方案 A）直接聚合；
- 在返回体加 `truncated` 显式标记，避免静默失真；
- 复核应用删除是否需要联动设备卸载（现不联动）。若产品上要「删应用 = 设备清理」，需新增 admin→executor 的 `app-uninstall` 扇出（执行器端点已存在）。

---

## 五、影响范围矩阵（改动 → 波及面）

| 改动 | admin-api | admin-web | executor-node | executor-python | desktop | CLI/SDK/MCP | 契约/文档 | 测试 |
|---|---|---|---|---|---|---|---|---|
| 4.0 术语收敛 | — | 文案 | — | — | 文案 | 文档 | README/atlas | 前端文案测试 |
| 4.1A 部署事件表 | 新迁移 + `deploy/upgrade/stop/rollback` 写入 | 追溯展示 | — | — | — | CLI 读面 | api-reference、app-deployment 实体页 | migrations.spec、service.spec |
| 4.2 拆分回滚端点 | controller/service/audit | 版本行按钮/确认 | — | — | — | CLI `app rollback` | api-reference、rollback-semantics | controller/service spec |
| 4.3 设备版本上报 | DTO + 心跳处理 + 新表/列 + releases 读面 | 版本/发布 Tab | app-inventory 复用 + 心跳 | 空数组（无 deploy） | 心跳 payload | protocol.json（可能）、CLI 展示 | executor-protocol-contract、heartbeat 契约测试 |
| 4.4 upgrade-all 覆盖面 | service + 分组返回 | 提示/策略弹窗 | 允许 scheduled/stopped 升级 | — | — | CLI `upgrade-all` | rollout specs、trigger-operator |
| 4.5 包缓存 + 版本化 release 目录 | 上传路径/URL、快照 | 展示（无变化） | **deploy.ts + execute.ts 取件与解压、缓存回收、retention** | **对等改造（若 python 也承载 zip 任务）** | 目录解析 | — | CONTRACT、app-inventory、deploy 单测 | deploy*.spec、execute*.spec、python 对等测试 |
| 4.6 产物目录 | artifacts 常量/服务/retention/下载 | 展示 | artifacts 上传路径 | artifacts.py | — | — | artifacts 文档 | 三端 artifacts 测试 |
| 4.7 读取面上限 | service 查询 | — | — | — | — | — | — | service spec |

**风险提示**：4.5 是本报告里唯一会动「部署目录布局 + 任务取件路径」的改动，也是修复 P2/P3 的唯一路径；它必须与 4.3（设备上报）和 4.1（历史模型）一起排期，否则会出现「删了 deploymentId 后缀却仍无按设备版本视图」的中间态。建议顺序：**4.2 → 4.4 → 4.3 → 4.1A → 4.7 → 4.5 → 4.6**。

---

## 六、兼容性与红线

1. **不改派发载荷结构**：`DISPATCH_TASK_FIELD_WHITELIST`（dispatch-task-payload.util.ts:35）与 `CONTRACT §2.4「零结构变更」` 是既有红线；任何包来源变更应只改 `packageUrl` 的**值形态**（内容寻址 URL），不新增/删除载荷键。
2. **部署路径的唯一性来源不能退化**：`resolveReleasePaths` 的存在理由是「重复部署不删活 release」；4.5 若改为 `releases/<version>`，必须保证**同版本再部署幂等复用**而非删除重写（否则重蹈删除活目录 → 回滚指向不存在目录的缺陷，deploy.ts:831-856 有完整复盘）。
3. **in-flight 唯一索引**：`upgrade` 全程 UPGRADING 不进索引是刻意的（支持同应用多台并发滚动升级）；任何把历史行改为不可变的方案，必须重新设计该索引与 `deploy()` 的 409 语义。
4. **执行器包体安全闸不可绕过**：zip-guard + zip-slip + 符号链接拒绝（`safeExtractZip`）在缓存命中路径上同样必须执行第一次解压；缓存只缓存**校验通过的产物**。
5. **不新增静默降级**：4.3 的设备上报失败应「无数据」而不是「上报当前版本为最新」；4.5 缓存损坏应删除重建（对照 `venvReuseProblem`、`isBareGitRepo` 的既有纪律）。
6. **文档红线**：报告类文档进 `docs/archive/`（根目录洁癖 CI）；新文档必须挂 `docs/README.md` 或 `docs/archive/reports/README.md`，否则孤儿检查红（`scripts/docs/check-docs.mjs`）。

---

## 七、验证建议（方案落地时的验收口径）

| 场景 | 期望 |
|---|---|
| 同一版本部署到两台设备 | 两台各有独立记录/上报；中台显示「v1 在 A、B 两台的当前状态」，不产生「重复部署」歧义 |
| 未部署设备首次运行 zip 任务 | 一次下载 + 本地缓存；第二次运行零下载（日志可证） |
| 已部署设备运行同一包任务 | **零下载**（命中部署时落下的缓存）——这是 P2 的验收点 |
| 设备上被 prune 掉的旧版本 | 中台版本行明确标注「设备已不保留」，不得暗示仍可切 |
| 点「回滚」 | 弹窗明确问「仅设为当前版本，还是同时下发到设备」；选择后行为与提示一致 |
| 一键升级 | 明确列出将覆盖的设备数与模式分布；scheduled 设备也切到新版本（不启动进程） |
| 版本行状态 | 每行展示各设备现状聚合，不出现「历史版本也生效」的误导 |

---

## 八、开放项（需拍板）

1. **4.1 选方案 A 还是 B**：是否接受为「每次部署一行不可变历史」重做 `app_deployments` 与 in-flight 索引？（建议 A 先行。）
2. **4.5 的排期**：包缓存 + 内容寻址是否本轮做？它决定 P2「重复部署」是否根治。
3. **执行器包（executor_packages）是否同步做设备级版本收敛**（P10）。
4. **应用删除是否联动设备卸载**（现不联动，P8 附带项）。
5. **scheduled 设备的「升级」语义**：是否允许对 stopped 行下发（不启动进程）？

---

## 附：关键代码坐标（便于实施定位）

| 主题 | 位置 |
|---|---|
| 部署入口/复用行/in-flight 守卫 | `apps/admin-api/src/modules/application/app-deployment.service.ts:840-1078` |
| 推送载荷与 pull 分流 | 同上 `:1712-1890` |
| 版本快照写入/去重 | 同上 `:2002-2083` |
| 版本历史/releases 合并读面 | 同上 `:426-684` |
| 回滚 | 同上 `:758-834` |
| 升级/停止/心跳/卡死扫描 | 同上 `:1339-1466`、`:1541-1622`、`:2202-2351` |
| 一键升级/灰度 | 同上 `:2157-2172`、`:2370+` |
| 部署约束（strict 集合） | `apps/admin-api/src/modules/executor/executor.service.ts:4972-5030` |
| zip 派发解析与版本跟随 | 同上 `:4853-4933`、`:5103-5135` |
| 上传与版本快照落库 | `apps/admin-api/src/modules/application/application.controller.ts:236-507`、`application.service.ts:405-535` |
| 部署路径/release 唯一后缀/保留 | `apps/executor-node/src/routes/deploy.ts:790-891`、`:982-1029` |
| 任务取件与解压 | `apps/executor-node/src/routes/execute.ts:1650-1719` |
| 任务 venv 复用 | `apps/executor-node/src/routes/execute.ts:1138-1162`、`:1264-1329` |
| 部署侧 venv | `apps/executor-node/src/python-venv.ts:621-716` |
| 设备端应用清单 | `apps/executor-desktop/src/main/app-inventory.ts:224-321` |
| 执行产物 | `apps/admin-api/src/modules/artifacts/artifacts.constants.ts`、`artifacts-retention.service.ts` |
| 执行器包推送 | `apps/admin-api/src/modules/executor-package/executor-package.service.ts:793-944` |
| 现有「仅部署」口径 | `packages/acf-cli/src/commands/apps.ts:352`、`docs/atlas/05-interfaces/cli.md:73`、`docs/api-reference.md:316` |

---

## 九、复核补记（2026-10-24 · ZCode 独立复核）

> 对本报告做了一轮独立代码复核（CodeGraph 逐符号对照当前 develop）。**主体结论与 P1–P10 判定全部成立**；发现 1 处事实错误、3 处未覆盖点、若干方案调整。

### 9.1 已坐实的关键断言（抽样坐标）

- runMode 缺省归一 once：`app-deployment.service.ts:927/:985/:1043`；CLI 默认 `scheduled` + `deploy-only` 别名：`acf-cli/src/commands/apps.ts:344-361`；web 任务型应用默认 scheduled：`ApplicationListPage.tsx:398`。
- 执行链不读部署树：`executor-node/src/routes/execute.ts:1650-1719`（packageUrl → `<workDir>/<executionId>/package.zip` → `safeExtractZip` 解压进 workDir；`ZIP_DOWNLOAD_TIMEOUT_MS=120s` :950）。
- 行复用与 in-flight：`deploy()` :979-1035；索引常量 :124（迁移 1789000000000）；`upgrade()` 行原位 :1339-1384。
- 版本行聚合：`getReleases` `latestByDeployment` :534-545；读面上限 `take:5000` :335-344、`RELEASES_SYNTHETIC_SCAN_MAX_ROWS` :134-135。
- 回滚双动作：`rollbackApplication` :758-834（legacy `packageUrlRestored:false` :831）；upgrade-all 只吃 running 且版本定向先改中台字段：:2395-2419；前端 `runningCount===0` 拦截：`AppDeploymentPage.tsx:403`。
- release 后缀/保留：`resolveReleasePaths` :861-891、`KEEP_RELEASES=5` :905、`pruneOldReleases` :982-1029。
- 心跳无版本事实：`DeploymentHeartbeatDto` 仅 deploymentId/status/pid/message；executor-python 无 deploy 路由（`routers/` 仅 config/execute/health/logs）。

### 9.2 勘误（1 处）

- **§P8 与开放项 4「删应用不联动设备卸载（现不联动）」不成立**。`application.service.ts:764-1103`（NETOPT-8③）已实现 best-effort 并行扇出：每台关联执行器 `stop×N + uninstall×1`，pull 队列与 HTTP 双通道（禁止同台混发），单条失败不阻断、审计聚合。开放项 4 撤销；剩余可选项只是把「将同时通知 N 台执行器卸载」写进删除确认文案。

### 9.3 报告未覆盖的三点

1. **派发面已有「设备级版本跟随」**：`executor.service.ts:5103 resolveVersionFollowPackage`（FEAT-22 方案 B）+ `pickDeploymentVersionForExecutor`——派发命中带 `deployedVersion` 部署行的执行器时，中台解析**该版本快照的 packageUrl** 下发。「任务跑设备上已部署的版本」在派发面已部分实现；P5 缺的是**事实源与展示面**。⚠️ 4.3 落地后必须把该函数的判据从「部署行推断」切到「设备上报」，否则两套设备当前版本并存打架（此为 4.3 影响面表中缺失的一条）。
2. **`upgrade()` 会把行上 startCommand 覆写为 `app.entrypoint`**（:1358-1364，A-4）——部署时自定义的启动命令在升级后丢失，UI 未披露。4.2 拆分时应一并明确该语义（或对「用户显式自定义过」的行保留）。
3. **`deploy()` 悬空 executorId 静默改选最低负载机**（:880-908，P0-3）——与「部署到指定设备」直觉冲突；行上记录的是实际执行器但 UI 未标注「原指定执行器已删除，已改选」。

### 9.4 方案调整（相对 §四 排序）

- **4.5 拆三段，前两段提前**：
  - **5a 中台内容寻址**：`uploads/packages/<appId>/<sha256>.zip`，独立可先行；只改 packageUrl 的**值形态**（红线 1 不破）；旧文件/旧 URL 原地保留。
  - **5b 执行器 zip 字节缓存**：`<workDir>/.pkg-cache/`，按 URL 键控 + 命中校验字节量；**只缓存经 zip-guard 审查过的包，且每次执行仍跑 `safeExtractZip`**（审查不可被缓存跳过——红线 4）。v1 **不做解压产物缓存**（硬链接写穿透会污染缓存，复制又比重新解压贵）；下载是大头，解压便宜。P2 的 N×M 代价由 5a+5b 根治，**不必等 5c**。
  - **5c `releases/<version>` 两段目录化**：最高风险（活目录删除语义、app-inventory 后缀解析、prune 对齐全要动），仍留第二阶段并与 4.3/4.1 联动。
- **4.3 扩两件事**：对齐 `resolveVersionFollowPackage`（见 9.3-1）；P10 设备级包版本收敛改乘 4.3 同一心跳载荷（`packages: [...]`），不再单独立项。
- **4.7 并入 4.1A 同期做**：事件表落地后 deployCount/legacy 回退读面直接消费事件聚合，避免 GROUP BY 改两遍。
- **4.4 覆盖面细化**：默认 running+scheduled；upgrading 跳过并列入 skipped 明细（在途升级不可重入）；stopped 显式 opt-in（`includeStopped`，默认 false——stopped 可能是人为停用）；failed 排除（失败多与环境相关，应走显式重新部署）。

### 9.5 开放项答复（复核口径的建议）

1. 4.1 先 A（事件表）后 B——同意报告建议；B 等 4.3 事实源稳定后再评估。
2. 4.5 本轮做 5a+5b，5c 第二阶段。
3. P10 并入 4.3 心跳（同上）。
4. **撤销**（前提不成立，见 9.2）。
5. 允许对 scheduled 行下发升级且不启动进程——执行器现行为即如此（`deploy.ts:1422-1427`，scheduled 部署完成即报 running「已按定时模式完成部署」）；stopped 行按 4.4 细化 opt-in。

### 9.6 实施进展（2026-10-24 当日落盘，develop 分支）

| 项 | 状态 | commit |
|---|---|---|
| R1/4.2 回滚拆分：set-current-version + deploy-version 双端点（admin-api/web/CLI/文档，旧 rollback 留 deprecated alias） | ✅ | 182e9e7d |
| R5a/4.5-5a 上传内容寻址 `uploads/packages/<appId>/<sha256>/<name>.zip`（同字节去重、清理/引用计数适配、旧文件兼容） | ✅ | 182e9e7d |
| R5b/4.5-5b executor-node zip 字节缓存 `.pkg-cache/`（URL sha256 键控、审查不跳过、4GiB 预算 mtime 淘汰、workDir 清扫保护） | ✅ | 29b8bd17 |
| R2/4.4 upgrade-all 覆盖面显式化（coverage 分组回显 + skipped 明细 + includeStopped opt-in；canary 口径不变） | ✅ | 2bddc708 |
| R4/4.1A+4.7 `app_deployment_events` 不可变事件表（10 写入点）+ deployCount 切事件聚合（legacy 回退）+ getReleases `truncated` 标记 + events 分页读面 | ✅ | 903fbc0e |
| R3/4.3+P5 设备级版本事实上报与消费：心跳 `deployedApps` 三态契约（协议 v7）+ executor_app_versions 表（迁移 63）+ getReleases devices 读面 + `resolveVersionFollowPackage` 切「设备上报优先、部署行回退」+ 前端设备徽标；收口时补齐注册白名单断言（deployedApps/installedPackages 两键）与 3 个 spec 的 getAppVersionFacts mock | ✅ | 2b5da7c5 |
| R4 补位：deployCount 存量回填迁移 1790000000064（无事件应用从现存部署行合成 deploy_created 下界事件，detail.backfill 标注，NOT EXISTS 应用级防双计，keyset 分批）——混合窗口期消除；buildDeployCountMap legacy 分支保留理由重写 | ✅ | 105b42f4 |
| R4 前端消费面：版本追溯 Tab 新增部署事件流 Card（九值类型映射/执行器可读名/detail 摘要翻译/分页 raceGuard，端点实测为 /app-deployments/applications/:appId/events）+ releases truncated 显式告警条与锚点跳转；zh/en 各 +32 词条 | ✅ | 284986b6 |
| R5b python 对等：executor-python zip 包字节缓存 `.pkg-cache/`（URL sha256 键控、meta 命中校验 fail-open、两段原子写、4GiB 预算 mtime 淘汰+part 回收、审查每执行照跑且 violation purge、清扫保护、事件循环分实例锁）；遗留不对称：python 下载上限硬编码 vs node 可配 | ✅ | 3f3f56c0 |
| P10 执行器包版本收敛：executor-node installedPackages 心跳事实源（update-package 落 manifest 清单——type 取 admin 推送载荷原值 node/python/universal 闭环、installed-packages 扫描+TTL 缓存、心跳上报）；protocol.json v7 注释同步；executor-python 两键上报留后续 | ✅ | 03e6e3f6 |
| /events 过滤参数：eventType 单值（@IsIn 九值，命中 application_type 索引前缀）+ since/until 半开区间 [since,until)；前端类型下拉（复用九值中文标签）随行翻页；契约产物重生成 | ✅ | d31b6a31 |
| python zip 下载上限可配化：PACKAGE_DOWNLOAD_MAX_BYTES 与 node 同名（默认 200MB 零漂移、非法值回落+warn）；顺带登记 node 侧 NaN 静默解除上限缺陷留后续 | ✅ | 85b0e989 |
| 升级 startCommand 重置的 UI 披露（§9.3-2 收口）：升级 Modal 点名将被重置的自定义启动命令行（appEntrypoint 基准对比，无基准不披露） | ✅ | 8ec54c07 |
| 第三轮（2026-10-24 下午）：node 下载上限 NaN 静默解除修复（parsePositiveIntEnv，parseInt("1.5")=1 截断缺陷一并抓出）；P10 Windows ENOENT 三态判定（文件占位不再伪装空清单）；python v7 两键恒省略裁定（无事实源不硬造，node 形态目录在场不代报）；events 时间范围筛选 UI（RangePicker 半开区间换算+口径披露）；CI 守卫三连修（bundle digest 漂移/CLI 地图 67→69/迁移登记） | ✅ | 2f2b503a/ae7ae8d4/d7ca5b9f/9ff94ce3/196271a2+7b7e669b |
| 第四轮（2026-10-24 傍晚）：python 测试顺序耦合 flaky 根治——**真根因是测试真连本机生产 admin-api**（get_admin_api_base_url 的 internal 档优先级压过 conftest 的 default 档 override，泄漏 socket raddr=127.0.0.1:3105 实证）+ O-24 切池后 15 处旧 mock 失效 + lifespan 测试漏拦回调 drain；三层收口后全量 4F+3E → 2F（仅剩 sandbox×2 环境限制）；atlas 迁移自述 106→109；时间筛选断言时区无关化（CI 是 UTC）；R4 装配错误文案中文化 | ✅ | a264cf8a/fc7a19e7/4056dcf8 |
| 第五轮（2026-10-24 深夜）：sandbox rlimit 环境探针（**子进程隔离**——进程内探针会把 RLIMIT_AS 留在低位毒化后续测试，zip_safety LZMA 假红三轮全量二分定位），python 全量 **0 failed 历史首次**；§4.6 产物元数据索引落地（execution_artifacts 迁移 65 + 双轨写 + GET /artifacts 查询）；时间筛选口径统一（audit 预设区间对齐 events 整天语义，ExecutionsPage 时刻粒度判定自洽不动）；§9.7 5c 目录化设计稿落盘；CI 三次红逐一收口（lint 30 处/api-reference 附录/时区） | ✅ | 0a139575/60c20a94/c9ca1665/f5050a62/13bfb1c3/063bc116 |
| 第六轮（2026-10-25 凌晨）：**5c 目录两段化实施**（§9.7 设计稿全项：prune 版本组语义 KEEP_VERSIONS=3、双布局识别、current 豁免、不搬旧目录红线）；truncated×devices 差集修复（retainedButTruncated 字段——设备事实本就全量在手，差集纯内存零成本）；audit Tooltip 披露；**5c E2E selftest 暴露三处真缺陷并收口**（zip 临时文件拍扁/rename 父目录/**R3 迁移 63 缺 createdAt 列——设备版本事实从建表起从未落过库**，迁移 66 补列）；bundle 清单追加式结构双重错位修正。selftest 20/20、CI 全绿 | ✅ | ec2184ec/0a278da6/b67c38dc/56aa2697/b2332317 |
| 自主推进 R1-R3（2026-10-25 凌晨，03:00 起长程 goal）：R1 agent-worker 5c 零影响验证（import 图/逻辑副本/blast radius 三重证据）+ executions 页 presets 补齐（1h/24h/7d，三方向评估后定向增强）；R2 CLI truncated 消费（表格 warn+折叠，与前端同口径）+ **desktop retention current 组豁免真缺陷**（两段布局回滚场景活版本组被整删，mixed-layout 真 fs E2E 抓出，与 executor 侧同语义修复，红绿双向验证）；R3 发布预检（51 提交 conditional go，三风险面闭合论证，迁移链/协议 v7/5c 布局逐一评估+回滚姿态）+ **UI-08 三页首屏骨架**（两处「加载中误报空态」真 bug，先红后绿 4 用例） | ✅ | 8fa280ba/02a187a9/457d854f/92d414c2/985e56b9 |
| 自主推进 R4（2026-10-25 凌晨）：ExecutionsPage memo 修复（executions 引用稳定化，failureBuckets memo 恢复生效，消费者全查证零破坏）；**admin-api 服务层巡查四缺陷**——产物索引双轨写/版本事实整替两处无事务（winner-only 语义下无自愈通道，中途失败=数据永久丢失/撕裂）均事务化；s3GetExistingLog 与通知审计兜底三处静默吞错补 warn（后者是全渠道失败唯一落痕，静默=告警双重丢失）。巡查同时验证干净：标记债清零/N+1 无可修项/事务成文理由齐备 | ✅ | 4865a598/53e52fc4 |

**第二处评审前提修正（随 R2 实证）**：P7 的「scheduled（仅部署）设备永远拿不到新版本」**不成立**——scheduled 部署完成即上报 RUNNING（`deploy.ts:1422-1427`），且 `detectStuckDeployments`（`app-deployment.service.ts:2392-2541`）只扫 PENDING/DEPLOYING/UPGRADING、**永不触碰 RUNNING 行**；默认覆盖面本就包含 scheduled 设备，实际缺口是覆盖面不被如实回显与 stopped 无 opt-in（R2 已补）。

**下轮候选（本轮未做，按建议优先级）**：~~R3/4.3 设备版本上报~~（已落地，见上表 2b5da7c5）；5c `releases/<version>` 目录两段化（与 R3 联动）；4.6 执行产物目录分层/元数据索引；~~事件表前端消费面~~（已落地 284986b6，遗留：/events 无 eventType/时间过滤参数——表已有 application_type 索引可支持；truncated 截断会连带吞掉被截版本的 devices retained 徽标）；~~executor-python zip 缓存对等实现~~（已落地 3f3f56c0，遗留不对称：python ZIP_DOWNLOAD_MAX_BYTES 硬编码常量 vs node PACKAGE_DOWNLOAD_MAX_BYTES 可配）；~~deployCount 存量回填迁移~~（已落地 105b42f4，已知取舍：迁移 62→64 窗口期已产生真实事件的存量应用不回填——防双计的应用级判定边界）；~~P10 executor_packages 版本收敛收口~~（已落地 03e6e3f6：executor-node 侧；executor-python 两键上报留后续）；~~升级重置 startCommand 快照的 UI 披露~~（已落地 8ec54c07）。新增遗留：node 侧 PACKAGE_DOWNLOAD_MAX_BYTES 非法值 NaN 静默解除上限（85b0e989 登记，已于 2f2b503a 收口）；/events 时间过滤暂未上前端 UI（后端 since/until 已就绪，已于 9ff94ce3 收口）。

### 9.7 5c 设计稿：`releases/<version>` 目录两段化（2026-10-24 落盘，第二阶段实施蓝图）

> 现状：`apps/<appId>/releases/<releaseKey>/`，releaseKey = `${version}-`${deploymentId}`（buildDeploymentPaths，deploy.ts:791-819）。
> 目标：`releases/<version>/<deploymentId>/` 两段——目录名即版本（deployed-apps.ts:23 注释已预留此演进）。

**为什么做**：① 同版本多部署行不再共享前缀歧义，retained 语义按版本归组；② deployed-apps 扫描的版本归一直接取目录名（去掉 `-${deploymentId}` 后缀反解的脆弱性）；③ uninstall/name-recovery 的按版本清理有真目录边界。

**触点清单（CodeGraph 取证，52 处消费引用）**：
| 触点 | 位置 | 改动 |
|---|---|---|
| 路径构造 | deploy.ts buildDeploymentPaths（:791） | releaseKey 拼接改 path.join(version, deploymentId)；normalizeReleasePart 语义不变（version 含非法字符仍拒） |
| 保留策略 | pruneOldReleases（:983，KEEP_RELEASES=5） | 改两层：先按版本组裁剪到 KEEP_VERSIONS（建议 3），组内保全部；current 指向的组豁免 |
| 活链接 | currentLink → releases/<version>/<deploymentId> | readCurrentTarget 归一逻辑同步（路径深度 +1） |
| 事实扫描 | deployed-apps.ts（releases 目录归一） | 目录名即版本，去掉后缀反解；兼容期同时认旧单段布局（迁移窗口） |
| 桌面端 | app-uninstall.ts / app-name-recovery.ts | 卸载按 appRoot 整删不受影响；name-recovery 若解析 releaseKey 需同步 |
| 迁移兼容 | 部署时增量迁移 | 新部署落新布局；旧目录**不搬**（搬运活目录有删改竞态），deployed-apps 双布局识别，prune 自然淘汰旧目录 |

**风险与红线**：① 活目录搬运 = 高风险区（评审 §9.4 已裁定「不搬」），增量迁移避开；② `current` 软链切换的原子性（rename 语义）必须保留——两段化不改切换机制只改指向深度；③ 协议面零变化（目录是执行器本地实现细节，R3 的 currentReleaseKey 字段值形态变化需评估 admin 侧归一容错——resolveVersionFollowPackage 对 releaseKey 只做等值比对，值形态变化不破坏判定，但设备版本表的 currentReleaseKey 历史值会混两种形态，读面展示需截断容错）。

**验收口径**：deployed-apps 扫描在混合布局（旧单段+新两段）下版本归一无重复；prune 在版本组语义下不误删 current 目标；卸载/重装全链路绿；KEEP_RELEASES→KEEP_VERSIONS 的容量语义变化（5 个 release → 3 个版本×每版 N 部署）写入 .env.example 若做成可配。

**工作量评估**：deploy.ts 核心 ~200 行改动 + deployed-apps 兼容 ~60 行 + 桌面端 ~40 行 + 测试三面（部署/扫描/卸载）；独立成一个 PR，不与其它混。
