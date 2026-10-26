# 发布预检报告：develop → main（2026-10-25）

> 范围：`origin/main..origin/develop` 全量 **51 个提交**（2026-10-24 11:21 ～ 2026-10-25 03:19），基线 `c217e0c4`（main HEAD）→ 待发布 HEAD `457d854f`。
> 性质：**纯评估材料，不含任何 merge/push main 操作**。全部结论基于 git log / git show 实证，逐条附提交号。
> 配套上下文：[deployment-model-review-2026-10-23.md](deployment-model-review-2026-10-23.md)（本批提交的实施底稿，§9.6 六轮进展 + §9.7 5c 设计稿）。

---

## 一、提交分组摘要（51 个提交，按主题）

### A. 部署模型评审 R 系列落地（核心功能面，24 个）

| 代表提交 | 主题 | 一句话价值 |
|---|---|---|
| `182e9e7d` | R1 + R5a | 回滚拆分为 set-current-version / deploy-version 双动作（只改字段 vs 字段+下发）；应用包上传改 `uploads/packages/<appId>/<sha256>/` 内容寻址存储，同字节重传复用 |
| `2bddc708` | R2 | upgrade-all 响应增 coverage 分组回显 + skipped 明细 + includeStopped opt-in——覆盖面不再静默 |
| `2b5da7c5` | **R3（协议 v7 bump）** | 心跳 deployedApps 落库新表 executor_app_versions；releases 版本行增 devices 徽标；派发版本跟随切设备事实——中台首次持有「设备上真正跑哪版」的事实源（P5 收口） |
| `903fbc0e` | R4 | 不可变部署事件表 app_deployment_events（append-only 旁路）——行复用模型下丢失的动作追溯补齐 |
| `105b42f4` | R4 回填（迁移 64） | deployCount 存量回填（每行折算一次 deploy_created，诚实下界）——消除事件聚合混合窗口期 |
| `284986b6` | R4 前端消费 | 部署事件流 UI + releases truncated 显式告警 |
| `0a278da6` | truncated×devices | retainedButTruncated 差集字段——截断事实不再吞设备 retained 徽标 |
| `3f3f56c0` | R5b | python 执行链 zip 包字节缓存（.pkg-cache/）——与 node 侧对等 |
| `60c20a94` | §4.6（迁移 65） | execution_artifacts 产物元数据关系化 + 双轨写 + GET /artifacts 按应用/任务查询 |
| `d31b6a31` / `9ff94ce3` | 事件流过滤 | eventType + since/until 半开区间过滤（前后端 + 契约产物） |
| `ec2184ec` | **5c 目录两段化** | releases/<version>/<deploymentId>/ 两段布局 + KEEP_VERSIONS 版本组保留 + 双布局识别（§9.7 设计稿实施） |
| `56aa2697` | 5c 三缺陷收口 | 真 PG E2E 抓出的 zip 临时文件拍扁 / rename 父目录 / **迁移 63 缺列**（最重） |
| `457d854f` | 5c retention 修复 | current 组豁免在两段布局回滚场景失效——真 fs E2E 抓出并修复（本批最后一个提交） |
| `03e6e3f6` / `ae7ae8d4` | P10 | installedPackages 心跳事实源（manifest 落盘+扫描上报）+ Windows ENOENT 三态判定 |
| `29b8bd17` | P2 | 执行链 zip 缓存（node 侧先行）：URL sha256 键控、4GiB 预算 mtime 淘汰 |
| `85b0e989` / `2f2b503a` | 下载上限 | PACKAGE_DOWNLOAD_MAX_BYTES 双执行器对齐 + 非法值静默解除上限修复 |
| `8ec54c07` | A-4 | 升级确认 Modal 点名将被重置的自定义启动命令 |
| `02a187a9` / `8fa280ba` | CLI/读面 | CLI 消费 truncated/retainedButTruncated；executions 页时间筛选 presets |

### B. 安全审计（1 个）
- `ba5adfc2`：5 条新 GHSA 清偿——multer high（override 2.5.0）/ body-parser high（2.4.0）/ fast-uri×4 / nodemailer×3。**发版前应随附 npm audit 复跑确认全绿。**

### C. 测试基建（2 个）
- `a264cf8a`：python 顺序耦合 flaky 根治——测试真连本机生产 admin-api 的隔离缺陷（测试基建修复，兼生产隔离隐患排除）。
- `0a139575`：sandbox rlimit 用例改子进程环境探针——python 全量 **0 failed 历史首次**。

### D. CI 守卫（6 个）
- `ca80c6dc`：迁移 62/63/64 补登记 + 响应 schema 棘轮 233→236。
- `f9f9bd24`：ADR-026 守卫红修复（R3 整替写补豁免标注）。
- `4056dcf8`：时间筛选测试时区无关化 + R4 装配错误文案中文化。
- `13bfb1c3`：admin-api 30 处 prettier 修复（CI 三 shard 红根因）。
- `4e92c889`：error-codes i18n 生成物补齐（APP_VERSION_NOT_FOUND）。
- `0e03945d`：.env.example 补 R5b/R3 执行器键（env-drift 守卫 B-6 收口）。

### E. 读面优化 / 时间口径（2 个）
- `c9ca1665`：audit 预设区间对齐 events 整天语义（口径统一）。
- `b67c38dc`：audit 时间筛选口径 Tooltip 披露。

### F. 文档落盘（13 个）
- 评审底稿与六轮进展：`049db422`（排查报告+P1-P10 勘误）、`e6fe6dc2`/`70f27de4`/`a1c5f52c`/`b52a0e41`/`c30628a3`/`86d50eb7`/`b8196f48`（§9.6 第一~六轮）。
- `f5050a62`：§9.7 5c 两段目录化设计稿（实施的直接蓝图）。
- 协议/迁移自述：`d7ca5b9f`（python v7 两键恒省略裁定）、`fc7a19e7`（迁移自述 106→109）、`7b7e669b`（CLI 命令地图 67→69）、`063bc116`（api-reference 补 /artifacts）。

### G. chore（3 个）
- `24e52ac5`：全仓 prettier 补账 63 文件（零逻辑变化）。
- `2a373cce`：根 package-lock 版本同步 1.0.1→1.11.0。
- `b2332317`：desktop bundle 清单结构修正（追加式历史当前值必须在文件末尾）。

---

## 二、三大风险面评估

### 风险面 1：数据库迁移链（62→66，5 个新迁移 + 63 建表修正）

本轮新增迁移 5 个（`1790000000062`~`1790000000066`），全部带 down 方法、全部 IF NOT EXISTS 幂等：

| 迁移 | 内容 | 幂等 | down |
|---|---|---|---|
| 62 AddAppDeploymentEvents | 事件表 + 2 索引 | ✅ | 删索引删表 |
| 63 AddExecutorAppVersions | executor_app_versions 表 + installedPackages 列；**建表语句已含 createdAt/updatedAt（修正版）** | ✅ | 删列删表 |
| 64 BackfillAppDeploymentEvents | deployCount 存量回填（keyset 分批 1000） | NOT EXISTS 天然幂等 | **只删 detail.backfill=true 合成行，不误删真实事件** |
| 65 ExecutionArtifactsIndex | execution_artifacts 表 + 2 索引（不回填，刻意的过渡期空语义） | ✅ | 删索引删表 |
| 66 AddExecutorAppVersionTimestamps | executor_app_versions 补 createdAt/updatedAt 两列 | ADD COLUMN IF NOT EXISTS | 逆序删列（丢时间线，注释明示 down 仅演练用） |

**升级路径评估（双向分支均已处理）**：

- **已跑 63 的环境**（develop/staging 等 10-24 落库点之后的环境）：63 首版建表漏了实体的 `@CreateDate/@UpdateDateColumn` 两列（jest 映射替身测不到；真 PG 上心跳落库每拍必败——设备版本事实**从未落过库**，`56aa2697` 真 E2E 暴露）。66 以 `ADD COLUMN IF NOT EXISTS` 补列收口。
- **空库/生产（main 基线，未跑过 63）**：一次到位——63 建表语句已修正为含两列，66 对新库是 no-op。**双向幂等，无顺序敏感**。
- **结论：✅ 升级路径闭合。** 唯一残留事实：develop 环境在 66 之前的窗口内 executor_app_versions 数据缺失（心跳落库一直失败），属不可追溯的既成事实，不影响生产首发。

### 风险面 2：协议 v7（中台↔执行器混合窗口期）

- **变更内容**（`2b5da7c5` + protocol.json）：register/heartbeat 新增**可选**键 `deployedApps` / `installedPackages`；`currentProtocolVersion` 6→7，`supportedMinProtocolVersion` 仍为 **1**，兼容矩阵 v1~v7 全部 `adminSupported: true`。
- **可选键语义已钉死**：键缺失 = 未上报（旧执行器）→ admin **完全不动 DB**（fail-honest）；python 侧无事实源两键**恒省略**（`d7ca5b9f` 裁定 + 4 用例钉住，含 node 形态目录在场也不代报）。
- **无强制升级点**：中台按矩阵兜底不硬拒；执行器侧 v7 仅常量+注释（node 侧扫描失败也省略键不阻塞心跳）。
- **回滚向（新执行器 → 旧中台）实证**：heartbeat/register 控制器为内联 `@Body() body: {...}` 类型（`executor.controller.ts:355`），非 class DTO，全局 ValidationPipe 的 `forbidNonWhitelisted`（main.ts:380）**不生效**——旧 main 收到新键会静默忽略，心跳不 400。
- **结论：✅ 双向兼容，混合窗口期安全。** 旧执行器升级前中台只是缺设备事实（读面回退部署行推断，R3 已实现回退路径）。

### 风险面 3：5c releases 目录两段布局（执行器本地实现细节，协议面零变化）

- **实施语义**（`ec2184ec` + §9.7）：新部署落 `releases/<version>/<deploymentId>/` 两段；**旧单段目录不搬**（§9.4 红线：搬活目录有删改竞态）；deployed-apps 扫描双布局识别（版本归一无重复）；prune 按版本组（KEEP_VERSIONS=3 组，组内全保），旧单段目录同批 mtime 淘汰 = 自然迁移；current 软链切换机制零改动。
- **无一次性迁移风险**：✅ 确认。增量迁移设计，旧目录只会在自然 prune 中淘汰；admin 侧 releaseKey 仅等值比对 + varchar 存储，历史值混两种形态不影响判定。
- **残留风险（已在发布前收口）**：`56aa2697`（zip 临时文件名含 / 的 ENOENT + rename 父目录缺失——两处部署链首炸点）与 `457d854f`（desktop release-retention 的 current 组豁免在两段回滚场景失效——正在生效的版本组会被整组删除）均已修复且有真 fs E2E 钉住。
- **⚠️ 唯一回滚陷阱（见下节）**：执行器**降级**回旧版后，旧代码的 current 豁免是整键相等比对——current 指向两段路径时豁免失效，旧 prune 可能把生效版本组当普通目录淘汰。

### 附：前端 api-types 重新生成的部署依赖

- `apps/admin-web/src/types/generated/api-types.ts` 本轮 **+444 行**（源 `apps/admin-api/openapi.json` +966 行：R1 双端点/R2 coverage/R3 devices/事件流过滤/§4.6 artifacts/truncated 字段等），由 `pnpm gen:api-types`（openapi-typescript）生成，与 openapi.json **同提交再生成**（R1/R2/R3 各提交内均含双侧）。
- **依赖方向**：新 web 的新类型预期新 api 的响应字段（devices 徽标/coverage 分组/retainedButTruncated）；新 api 的响应字段对旧 web 全部**增量可选**（TS 层旧类型忽略即可，响应向后兼容）。
- **结论：web 不得早于 api 部署；旧 web + 新 api 无破坏（只是看不到新能力）；推荐同批部署。**

---

## 三、回滚预案

### 3.1 代码回滚（git revert / 重部署旧版）

| 面 | 可行性 | 依据 |
|---|---|---|
| 中台 admin-api | ✅ 新响应字段全部增量可选，旧前端忽略即可 | openapi 只增不改（R1 旧 rollback 端点保留为 deprecated alias） |
| 执行器降级（node） | ⚠️ **有条件** | 协议双向兼容（v7 键旧中台忽略）；但 **5c 两段布局下旧版 prune 的 current 豁免失效**（整键比对 ≠ 两段路径，与 `457d854f` 修的缺陷同构）——降级后首个 prune 周期可能删掉生效版本组。**降级前先重部署目标应用（产生单段目录）或人工确认 releases/ 目录形态** |
| admin-web | ✅ 纯展示层 | 新类型字段运行时缺失只影响新 UI 区块 |
| CLI（acf-cli） | ✅ | 新命令对旧 api 报 404/400，可预期 |

### 3.2 数据库迁移 down（全部可用，逆序 66→65→64→63→62）

- **62/63/65**：DROP IF EXISTS 幂等，重复执行与 revert 重放均无副作用（各迁移注释明示）。
- **64**：down 只删 `detail->>'backfill' = 'true'` 的合成行，**不误删真实事件**（应用级判定 + spec 钉住）。
- **66**：逆序删列幂等；注释明示「down 本就只用于迁移链演练，不做数据回填」（删列丢创建/更新时间线）。
- **⚠️ 关键约束：迁移 down 必须与代码回滚同批**——down 之后新代码的 entity 立即找不到表/列（迁移 66 缺列即 `column does not exist` 每拍必败的实证）。反之，**代码回滚而不 down 迁移是安全的**：旧代码不认识新表，新表只是闲置（62/65 的 append-only 表无旧代码写入点；63 表数据停更；64 合成行对旧读面不可见——旧 deployCount 读面不查事件表）。
- **推荐回滚姿态**：优先「只回代码、不动 DB」；确需腾挪时再逆序 down。

### 3.3 协议兼容（双向）

- 新中台 + 旧执行器（v6-）：可选键缺失 = 不动 DB，读面回退部署行推断——已实现并有测试（executor.version-follow-device-fact.spec）。
- 旧中台 + 新执行器（v7）：新键被内联 `@Body()` 静默忽略——无 400 风险。
- **无协议层面的回滚阻断。**

### 3.4 目录布局回退语义

- 中台侧：releaseKey 仅等值比对 + varchar，历史值混形态无影响（`ec2184ec` 提交说明 admin 零改动）。
- 执行器侧：**降级陷阱见 3.1**——这是本次发布唯一需要人工介入的回滚场景。
- 不存在「目录搬回」的需求：旧目录从未被移动，双布局识别在两个方向的代码里都成立（新版认双布局；旧版只操作自己新建的单段目录 + 误扫风险见 3.1）。

---

## 四、发布前人工验证清单

| # | 验证项 | 优先级 | 说明 |
|---|---|---|---|
| 1 | **staging 跑完整迁移链 62→66（真 PG）** | 🔴 必做 | 迁移 63 缺列只有真库能暴露（jest 替身全绿掩盖）；空库（生产首发路径）与已跑 63 旧版的库（staging）**两条路径都要跑**：前者验证一次到位，后者验证 66 补列 |
| 2 | **双端版本联测（新中台 + 新/旧执行器各一）** | 🔴 必做 | v7 可选键三态语义（缺失=不动/恒省略/整替）+ 旧执行器回退路径；python 执行器重点验证两键恒省略 |
| 3 | **桌面端安装包构建 + selftest** | 🔴 必做 | `457d854f`（current 组豁免）与 `b2332317`（bundle 清单结构）都是 desktop 侧收口；确认 bundle-drift CI 守卫绿 |
| 4 | npm audit 复跑 | 🟡 建议 | `ba5adfc2` 五条 GHSA 清偿后确认无新 advisory |
| 5 | 5c 混合布局 E2E | 🟡 建议 | 旧单段 + 新两段共存场景：deployed-apps 扫描版本归一 / prune 不删 current / 卸载重装全链路（§9.7 验收口径） |
| 6 | 升级演练：staging 库从 main 基线直接升 | 🟡 建议 | 模拟生产真实路径（62→66 全链首跑），验证空库分支 |
| 7 | .env.example 新键巡检 | 🟢 低 | EXECUTOR_KEEP_VERSIONS / DEPLOYED_APPS_SCAN_TTL_SECONDS 已入 example（`0e03945d`/`ec2184ec`），运维通告随发版附上 |

---

## 五、总结

- **51 个提交，主体是部署模型评审（2026-10-23）§4 的成体系落地**（R1-R5b + §4.6 + 5c + P2/P10），配套安全审计 1 轮、测试基建 2 项（python 0 failed 历史首次）、CI 守卫 6 项收口、六轮进展文档。
- **三大风险面结论**：迁移链双向幂等闭合（已跑 63 的环境靠 66 补列、空库一次到位）；协议 v7 无强制升级点、双向兼容（旧中台对新键静默忽略已实证）；5c 无一次性迁移风险（增量迁移 + 自然淘汰），唯一陷阱在**执行器降级方向**（旧 prune 豁免失效，需先重部署或人工确认）。
- **推荐回滚姿态**：只回代码、不动 DB（新表对旧代码无写入点、无读面污染）；执行器降级前处理 5c 目录形态。
- **发布判定：可发布（conditional go）**——三项 🔴 验证（真 PG 迁移链双路径 / 双端联测 / 桌面构建）通过后放行。

---

*生成方式：git log/show 实证分析（基线 c217e0c4 → 457d854f），无任何 merge/push 操作。*

---

# v2 增补（R4-R21，+38 提交）

> **增补范围**：v1 预检（基线 `c217e0c4` → `457d854f`，51 提交）之后的新增量 `92d414c2..origin/develop`（HEAD `d032c620`），共 **38 个提交**——其中 1 个是 v1 报告自身落盘（`92d414c2`，非代码），**实质提交 37 个**（「自主推进 R4-R21」全部产出）。`origin/main..origin/develop` 全量计数 51 → **89**。
> 性质不变：纯评估材料，无 merge/push/commit；全部结论基于 git log/show 实证（关键实现辅以 CodeGraph 调用面核验），逐条附提交号。

## 一、增量分组摘要（37 个实质提交）

### A. 真缺陷修复（fix ×5）

| 提交 | 面 | 内容 |
|---|---|---|
| `985e56b9` | admin-web | UI-08 首屏骨架补齐三页——两处「加载中误报空态」真 bug（AgentSessions/AppDeployment/ExecutorList） |
| `53e52fc4` | admin-api | 服务层巡查四缺陷——双轨写事务化 ×2（executor 侧轨写、events 产物写入入事务）+ 静默吞错补 warn ×3 |
| `5b5c2bc1` | executor-python | 三缺陷——lifespan 池收口 / 缓存 IO 下线程 / 悬空引用 |
| `9c9710e4` | executor-node + SDK | 日志脱敏三漏网收敛（deploy/execute/update-package 路由）+ SDK 文档漂移两处；连带 bundle 清单重打 |
| `4624e4e0` | executor 双侧 | **P1 凭据通道**（本增量唯一新风险面，见 §二.2） |

### B. 新能力（feat ×2）

- `a953e807`：MCP `update_task` 参数面对齐 UpdateTaskDto——15 新字段（secrets/维护窗口/priority/timeout 系/依赖/block·misfire 策略/亲和×2/deploymentPolicy/乐观锁透传等）+ 2 修复（timeout 补缺、timeoutSeconds 补 max(86400)）。全部 `optional()`、值域逐字对齐后端事实源；handler 零改动（undefined 过滤透传天然正确）。
- `ef20de4f`：MCP `create_task_from_template` 描述层对齐——create 侧必填集与 14 字段全集（tools.ts 仅 4 行描述变更）。

### C. 性能（perf ×1）

- `4865a598`：ExecutionsPage executions 引用稳定化——failureBuckets memo 恢复生效。

### D. warnings 治理（refactor ×4，行为保持的生产重构）

`3bcd2963`（router lazy 页面拆独立文件，24→0，路由表逐字未动、消费方 main.tsx 零改动）→ `be345db8`（42→29，色阶纯函数挪共享模块）→ `687773be`（29→14，deps 全清零）→ `4fb6b822`（14→**0 收官**，allowExportNames 集中登记 + copyErrorText 去重）。admin-web eslint 达 0/0。

### E. 测试基建 / CI 守卫（×5）

- `5812f225`：glue-backfill flake 根治——双层根因（模块加载进等待预算 + 全局超时从未生效）。
- `9cdb030b`：**TINFRA-1 治本**——setup 改从 @testing-library/react 入口 configure（forks 池双实例陷阱），永久守卫用例钉死 asyncUtilTimeout===10000。
- `85d13088`：netrc 0600 断言 Windows 平台感知（NTFS 权限位映射差异；实现侧 writeFile mode 参数不变）。
- `d691fd62`：bundle 清单 digest 判据 bug 修复（首条→**最后一条**，与字节闸同语义；P1 源码变更后 bundle 重打回填）。
- `f8943eea`：R4/R5 两处 CI 红收口（根 lock puppeteer 污染 + 漏改 spec 的 DataSource 替身）。

### F. style / chore（×2）

- `44e0c394`：lint 尾巴三处清零——**迁移 66 文件仅 class 声明换行**（零语义，diff 逐行核实）。
- `5c3bf581`：node-sdk README 登记进 release-please 广播（config +4 行）。

### G. 文档（×18，零代码影响）

- §9.6 进展 16 个（R4→R21 全轮次：`7079091c`/`fb3d5c89`/`3b6b021a`/`303df050`/`ae41f42e`/`af0cb0a8`/`bccee553`/`e4bf5252`/`bc2998c9`/`6628cd0a`/`f9ceae8c`/`2c472789`/`c462d68e`/`b564ee08`/`c53e0507`/`d032c620`）。
- `188abaca`：registry 巡查四漂移修正 + **P1 契约断裂如实登记**（修复前的文档先行，含 .env.example ⚠️ 警示）。
- `5ffc3875`：atlas 五处内容漂移修正（协议 v7 两键/5c 布局/P1 netrc/MCP 15 字段/产物索引面）。

## 二、风险面增量评估

### 2.1 迁移链：零变化（确认）

- **迁移 66 已含于 v1**：v1 §风险面 1 表格已覆盖 62→66 全部 5 个迁移（66 在 `457d854f` 之前入库，即已属 51 提交范围）。
- **增量区间零新迁移**：`git diff --name-status 92d414c2..origin/develop` 对迁移目录仅 1 条——迁移 66 被 `44e0c394` 触碰，diff 逐行核实为 **class 声明换行**，up/down 方法零改动。
- **结论**：v1 迁移链评估（双向幂等闭合、双路径升级）**原样有效，无需修订**。

### 2.2 P1 凭据通道（`4624e4e0`）——本增量唯一新风险面

**背景**：`188abaca` registry 巡查发现的 P1 契约断裂——registry-pypi S9 全端点 Basic Auth，而执行器侧凭据禁入 argv 红线 + uv 子进程环境白名单剥净一切凭据通道，默认部署带私有依赖的任务安装必 401。

**机制**（diff 逐行 + CodeGraph 调用面核验）：

- 部署级凭据对 `PYPI_REGISTRY_USERNAME/PASSWORD`（与 REGISTRY_USER/PASS 同值即可）→ 写 **0600 netrc 文件**（`O_TRUNC` 幂等覆写保 inode，不 delete+rename）→ 仅以 `NETRC` env 键注入 uv install 子进程，uv 原生 netrc 客户端消费。
- 双侧对等：executor-python（`interpreters.py` `write_pypi_netrc`/`maybe_inject_pypi_netrc`，`build_uv_env` 调用 + `execute.py` 本地兜底分支同注入防漂移）与 executor-node（`python-venv.ts`，netrc 挂 uv 池目录）。CodeGraph 证实调用面闭合（2 callers + 专属测试 `test_pypi_netrc.py`，宿主 NETRC 不穿透由白名单钉住）。
- **凭据红线保持**：零入 argv / 日志 / URL userinfo / 主进程 os.environ。

**默认行为不变（升级零风险的核心依据）**：

- config 两键默认空串；`maybe_inject_pypi_netrc` 任一为空即 return（什么都不做）——**不配 = 安装行为逐字节不变**（匿名 401 姿态与历史一致）。
- compose 注入 `${PYPI_REGISTRY_USERNAME:-}` 空默认（executor-python 与 executor-node 两块都已注入）；不设置时子进程拿到空串，等价未配。
- .env.example 已登记：P1 注释块**替换**了 `188abaca` 的 ⚠️ 断裂警示（断裂已修复，文档同步，区间净 diff 证实）。

**升级注意事项（配置方必知）**：

1. **fail-fast 校验**（config.py `model_validator`）：只配其一 → 启动即 ValueError；配了凭据但 `PYPI_REGISTRY_URL`/`PYPI_EXTRA_INDEX_URL` 全空 → 同样拒绝启动。报错只提键名不回显值。**误配半对会拒绝启动**——运维通告需明示。
2. netrc 写文件失败 = warning + 不注入（不新增失败模式，回退匿名 401 姿态）。
3. 凭据文件落盘于 uv cache 旁 `.uv-netrc`（0600）——宿主安全审计多一个属主受限文件。
4. per-task 一次性凭据未做（登记为演进，注入点可直接复用）。
5. Windows：0600 断言平台感知（`85d13088`），实现侧 mode 参数不变（实质防线仍在，断言仅放宽到 0o700 位）。

**回滚**：不配两键即回到旧行为——纯 opt-in 增量，**无回滚陷阱**。

### 2.3 TINFRA-1 / flake / CI 守卫：纯测试基建确认；warnings 治理如实区分

- **纯测试基建（生产面零影响，确认）**：`5812f225`、`9cdb030b`（test-setup.ts 仅被 vite.config.ts `setupFiles` 消费，不进产物）、`85d13088`、`f8943eea`（lock + spec 替身）——均不进生产构建。
- **warnings 治理（D 组 4 个 refactor）不是纯测试基建**：触碰 admin-web 生产源码约 20 文件。但为**行为保持的等价重构**——路由表逐字未动（消费方零改动）、色阶纯函数逐字挪动、其余为 deps 修正与 lint 登记；vitest 全量绿 + eslint 0/0 钉住。风险定性：**低（等价重构 + 全量回归背书），但非零**，如实登记。
- `d691fd62` 是 CI 守卫真 bug 修复（digest 判据）：单记录清单时代两闸碰巧同值掩盖，P1 轮首次出现两条记录暴露——守卫面修复，无生产行为。

### 2.4 retention 组豁免修复（`457d854f`）归属澄清与观察点

- **归属**：`457d854f` 是 **v1 评估范围的最后一个提交（v1 基线 HEAD），不是 v2 增量**——v1 §一.A 与 §风险面 3 已覆盖其论证；桌面构建必做 #3 在 v1 即以其为依据。
- **v2 补充观察点**（基于增量区间新证据）：① 修复引入的 `mixed-layout.selftest`（374 行真 fs、四形态混布 60 断言，R2b 缺陷回归红绿双向确认）已入桌面 selftest 门；② P1/脱敏改了 executor-node 源码，**桌面 bundle 已两次重打回填**（`9c9710e4`、`d691fd62` 更新 executor-node-bundle.sha256）。升级后观察：桌面端首个 retention 裁剪周期在混合布局下 current 组不再被误删。

### 2.5 atlas / 文档大批量 + 协议面：零影响（确认）

- 18 个文档提交：16 个仅动评审底稿；`5ffc3875` 仅动 `docs/atlas/**`；`188abaca` 动 README/tutorial + `.env.example` **仅注释行**。半代码面仅 `5c3bf581`（release-please 配置）与 `44e0c394`（lint 格式），零运行时行为。
- **协议 / openapi / api-types 零触碰**：增量区间无任何提交动 protocol.json / openapi.json / api-types.ts——v1 风险面 2（协议 v7 双向兼容）与「web 不得早于 api 部署」结论**原样有效**。

## 三、必做清单更新（🔴 3 → 4 项）

v1 三项必做**仍充分**（其依据面——迁移链/协议/5c——在增量区间零变化）：

| # | 验证项 | 优先级 | v2 增补说明 |
|---|---|---|---|
| 1 | staging 真跑迁移链 62→66 双路径 | 🔴 必做 | 不变（增量零新迁移） |
| 2 | 双端版本联测（v7 可选键三态） | 🔴 必做 | 不变（协议零触碰） |
| 3 | 桌面端安装包构建 + selftest | 🔴 必做 | **口径增强**：确认 bundle 清单已含 P1/脱敏后的重打 digest（`d691fd62` 回填）；mixed-layout.selftest（current 组豁免回归）随 selftest 门跑 |
| **4** | **staging 验证 P1 netrc 凭据通道 E2E（新增）** | 🔴 必做 | 配 `PYPI_REGISTRY_USERNAME/PASSWORD`（与 REGISTRY_USER/PASS 同值）跑一个带私有依赖的 requirements 任务：401 → Installed；同时验证**不配键时行为不变**（匿名 401 姿态）与误配半对的 fail-fast 拒启形态 |
| 5-7 | npm audit / 5c 混合布局 E2E / .env 巡检 | 🟡/🟢 | .env 巡检追加两新键的运维通告（含 fail-fast 语义与「与 REGISTRY_USER/PASS 同值」指引） |

## 四、go/no-go 判定更新

- **判定：维持 conditional go（可发布，条件后置），放行条件由三项 🔴 扩为四项 🔴**（新增 staging netrc 通道验证）。
- 依据：
  1. v1 三大风险面（迁移链 / 协议 v7 / 5c 布局）在增量区间**零变化**——原论证原样有效。
  2. 增量唯一新风险面（P1 凭据通道）为 **opt-in 纯增量**：默认不配 = 行为逐字节不变（代码路径逐行核实）；配置 = 新能力，有真 uv 0.13.4 + 401 stub → Installed 的 E2E 实证；无回滚陷阱（不配即回退）。
  3. 生产代码增量（fix ×5 + feat ×2 + perf ×1 + 等价 refactor ×4）由 R21 全包大回归快照背书：admin-api 5881 / admin-web 1957 / executor-node 1285 / executor-python 1241（0 failed）/ acf-cli 410 / mcp 302 用例全绿，十守卫全绿（§9.6 R21，`d032c620`）。
  4. MCP 面对齐（`a953e807`/`ef20de4f`）为参数面增量（全部 optional + handler 零改动），对既有 agent 调用零破坏。

---

*v2 增补生成方式：git log/show 实证分析（增量 `92d414c2..d032c620`：37 实质提交 + v1 报告提交 1 个；全量 51→89），关键实现辅以 CodeGraph 调用面核验；无任何 merge/push/commit 操作。*
