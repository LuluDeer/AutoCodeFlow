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
