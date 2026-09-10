# ARCH-28：workspace / turbo 二期评估与分批迁移报告

> 状态：评估完成（本轮只评估 + 沙箱试点，**整仓迁移不在本轮**）。
> 任务原文（H2 计划 §ARCH-28）：「ARCH-20 已统一入口但保持 7 套独立 lockfile、
> no-hoisting；CI 各 job 重复 npm ci。评估 pnpm workspace / turbo 缓存管道
> （含 docs-site），分批迁移，CI 时长对比报告。」
> 数据来源：`gh run view` 真实 CI run（2026-09-08 develop 两次全绿 run
> 34244749009 / 34222890665）+ 本机冷/热缓存 npm ci 实测（2026-09-10，
> Node 24.13 / npm 11.6.2 / npmmirror 源）。所有数字可复现，无臆造。

---

## 1. 现状量化

### 1.1 仓库形态

- 根 `package.json` 仅做 scripts 委托（ARCH-20 形态），**无根 lockfile**；
  根 `node_modules/` 仅 44KB（零实质依赖）。
- 8 个 npm 子项目各持独立 `package-lock.json`（合计 42,933 行）：

| 子项目 | lockfile 行数 | lockfile 内包数 | 顶层依赖声明数 | node_modules 体积 |
|---|---|---|---|---|
| apps/admin-api | 12,097 | 891 | 60 | 358M |
| apps/admin-web | 5,870 | 423 | 35 | 495M |
| apps/executor-node | 5,880 | 454 | 16 | 85M |
| apps/executor-desktop | 4,978 | 378 | 20 | 598M |
| packages/autocodeflow-node-sdk | 5,491 | 391 | 7 | 96M |
| packages/mcp-server | 3,138 | 219 | 6 | 102M |
| packages/acf-cli | 2,916 | 205 | 10 | 78M |
| packages/docs-site | 2,563 | 174 | 1 | 102M |

（另有 5 个 Python 子项目走 pip/uv，不在 npm workspace 讨论范围；
registry-npm 为纯配置、contract-fixtures 无构建面。）

### 1.2 CI 重复安装面（.github/workflows/ci.yml）

develop push 轮实际运行的 24 个 job 中，**21 个 job 执行 `npm ci` 共 24 次**
（e2e-full 一 job 内连跑 3 个子项目安装；desktop-bundle-drift 2 次）。
全部命中 `setup-node` 的 npm 缓存（`cache-dependency-path` 指向各子项目
lockfile），因此 CI 上是**热缓存安装**；冷缓存只发生在 lockfile 变更后的
首个 job（每子项目每轮最多一次）。

### 1.3 CI 实测时长（run 34244749009，2026-09-08，develop，全绿）

- 整轮墙钟：**4 分 42 秒**（15:26:23 → 15:31:05，24 job 并行）。
- 关键 job 时长（秒）：admin-api-test 221、e2e-full 242、
  docker-multiarch-build(admin-api) 315、windows-admin-web 71、
  admin-api-migrations 62、windows-node-tests(executor-node) 67、
  admin-web-build 29、executor-node-test 29、docs-site-build 16、
  acf-cli-test 15、mcp-server-test 11。
- **npm ci 步骤实测**（同 run，setup-node 缓存命中后的热装）：

| job | npm ci 步骤 | 耗时 |
|---|---|---|
| windows-admin-web | npm ci | 26s |
| e2e-full | npm ci ×3（admin-api/executor-node/admin-web） | 14+11+3=28s |
| admin-api-test | npm ci | 13s |
| admin-api-migrations | npm ci | 13s |
| admin-web-build | npm ci | 11s |
| windows-node-tests ×3 | npm ci | 10+7+7=24s |
| desktop-bundle-drift | npm ci --ignore-scripts ×2 | 6+3=9s |
| mcp-server-test / executor-node-test / acf-cli-test | npm ci | 各 3s |
| autocodeflow-node-sdk-test / docs-site-build | npm ci | 各 2s |
| lockfile-integrity ×7 | npm ci --dry-run | 各 1~2s |

**结论（量化）**：单轮 CI 全部 npm ci 步骤合计约 **2.5 分钟**（摊在 21 个
并行 job 上）；对最慢关键路径（admin-api-test 221s）npm ci 仅占 **6%**，
对 e2e-full（242s）占 **12%**。**npm ci 不是 CI 时长瓶颈**——瓶颈是测试
本体（admin-api 2000+ 例 + e2e 43 例）与 docker multiarch QEMU 构建。

### 1.4 本机冷/热缓存 npm ci 实测（佐证：无缓存时的最坏面）

冷缓存 = 全新 npm cache 目录；热缓存 = 二跑。npmmirror 源、8 核本机：

| 子项目 | 冷缓存 | 热缓存 |
|---|---|---|
| admin-api | 6.38s | 4.79s |
| admin-web | 5.38s | — |
| executor-desktop | 4.25s | — |
| executor-node | 2.00s | — |
| node-sdk | 1.73s | — |
| mcp-server | 1.67s | — |
| docs-site | 1.34s | 0.81s |
| acf-cli | 1.19s | — |
| **合计（串行）** | **≈24s** | — |

即便 8 套全冷装串行也不足 30 秒（npmmirror 源带宽好；官方源会放大 3~10 倍，
但 CI 已有 setup-node 缓存兜底）。**重复安装的真实成本是「维护面」而非
「时长」**：8 套 lockfile 意味着 8 处升级、8 处审计、8 处冲突仲裁。

### 1.5 依赖重叠与版本冲突面（no-hoisting 破坏面盘点）

对 8 个 npm 子项目逐 lockfile 对比（脚本统计，非目测）：

- 顶层声明中被 ≥2 个项目依赖的包：**20 个**；其中**声明版本不一致的 17 个**，
  重灾区：
  - `typescript`：5 种声明（^5.1.3 / ~5.6.2 / 5.8.3 / 5.4.5 / ^5.0.0）
  - `@types/node`：4 种（^24 / ^25 / 24.13.3 / ^22）
  - `axios`：3 种（^1.17 / 1.20 / ^1.6）；`jest` / `ts-jest` / `vitest` /
    `eslint`（8 vs 9）/ `supertest`（6 vs 7）均跨大版本。
- 实际解析到**不同版本**的顶层依赖：**161 / 1390**（11.6%）。
- 典型硬冲突：`express` 4.22.2（executor-node）vs 5.2.1（admin-api）；
  `eslint` 8.57.1（admin-api）vs 9.39.5（admin-web）；`vitest` 3.x vs 4.x。

**判定：本仓不具备「单一版本策略」前提。** 任何 hoisting 型 workspace
（npm workspaces / pnpm 默认 hoist）都会把上述 161 处版本分裂暴露给
Node 解析层，破坏面覆盖全部 8 个 npm 子项目——这正是 ARCH-20 裁定
no-hoisting 的原因（AGENT_HANDOFF.md：「未引 pnpm-workspace（no-hoisting
保持）」，PLAN-CLAIMS.md ARCH-20 行同）。pnpm 的隔离模式（默认
`node-linker=isolated`，符号链接虚拟 store）理论上可保版本隔离，但
NestJS/Electron/vite 等对 `node_modules` 物理布局有假设的生态位仍需
逐包回归验证，收益见 §2。

---

## 2. 三方案对比

| 维度 | ① pnpm workspace | ② npm workspaces | ③ turbo（任务图缓存） |
|---|---|---|---|
| 解决什么 | 单一 lockfile + store 硬链接（磁盘/装速） | 单一 lockfile（零工具切换） | **任务级缓存与拓扑编排**（test/build/typecheck 产物级复用） |
| hoisting 风险 | 默认 isolated 隔离，风险低但非零（需逐包回归） | **高**：根 hoist 直接破坏 161 处版本分裂（可用 `install-strategy=nested` 缓解，但那就失去意义） | 无关（不碰 node_modules 布局，可与 ①/② 或现状叠加） |
| 迁移成本 | 8 套 lockfile 合 1（人工仲裁 17 处声明分歧）+ CI 全部 job 改装 + `onlyBuiltDependencies` 白名单 + pnpm 版本钉子（packageManager 字段） | 同左，且 hoisting 调试成本不可预估 | 低：根 `turbo.json` 声明 task 图 + CI 改 `npx turbo run <task>`；lockfile 不动 |
| CI 收益预估 | npm ci 步骤合计 ~2.5min → 单次 workspace install（缓存命中后秒级），**但收益被并行 job 摊薄**：关键路径只省 13s（admin-api-test 的 npm ci） | 同左 | **关键路径收益实在**：e2e-full/admin-api-test 的 build/typecheck 产物跨 job 复用；windows 侧 npm ci 26s→缓存后秒级；多 job 重复 build（admin-web 在 3 个 job 各 build 一次）归一 |
| 与现状兼容 | 需要全量切换（pnpm-lock.yaml 与 8 套 package-lock 并存期混乱） | 需要全量切换 | **增量接入**：不动任何 lockfile，逐 task 迁移 |
| 风险等级 | 中高（生态回归面大，收益小） | 高（hoisting 破坏面实测 11.6% 依赖版本分裂） | **低**（纯编排层，失败即回退 npm 原命令） |

### 裁定建议

**采纳 ③ turbo（增量、低风险、收益对准真实瓶颈），否决 ①②（本轮）。**

理由：

1. **数据不支持 workspace 迁移的收益叙事**。CI npm ci 合计仅 ~2.5min 且
   摊在并行 job 上，关键路径占比 6%~12%；workspace 化省下的安装时间
   对「整轮墙钟 4m42s」的改善 <5%，却要付出 8 套 lockfile 合一 +
   161 处版本分裂的回归验证。ARCH-20 的 no-hoisting 裁定在数据上依然成立。
2. **turbo 补的是另一块短板**：admin-web 在 admin-web-build /
   windows-admin-web / e2e-full / api-types-drift 四个 job 重复 build；
   executor-node 在 3 个 job 重复 build；turbo 的远程/本地缓存可把这些
   变成缓存命中。且 turbo 不碰 node_modules，ARCH-20 裁定零破坏。
3. **pnpm workspace 列为「观察项」而非「不做」**：若未来 ① 出现强驱动
   （如磁盘成本、官方源带宽、子项目数量翻倍），可按 §3 分批路线执行；
   本轮沙箱试点已验证 docs-site 单包可行性（§4），不是技术不可行。

### 明确「不做」的部分与理由

- **不做整仓 pnpm/npm workspace 迁移**：收益 <5% 关键路径改善 vs
  161 处版本分裂回归面（§1.5），风险收益倒挂。
- **不做 npm workspaces**：hoisting 破坏面实测存在（express 4/5、
  eslint 8/9、vitest 3/4 跨大版本共存），无「隔离模式」兜底，直接否决。
- **本轮不落 turbo 配置**：turbo.json + CI 改造属行为变更，应独立任务
  （建议 ARCH-28b）带 A/B 对比轮验证，避免与本评估混入同一验收面。
- **不动 8 套 lockfile**：SEC-06 lockfile-integrity job 依赖现有
  per-project lockfile 形态，迁移前保持稳定。

---

## 3. 分批路线（若未来执行 workspace 迁移）

前提触发条件（满足其一才启动）：磁盘/带宽成本成为实际痛点、npm 子项目
数量翻倍、或 turbo 接入后仍需进一步压缩安装面。

- **第一批（低风险试点）**：`packages/docs-site`（独立 VitePress，顶层
  依赖仅 vitepress 1 项，零跨包依赖）+ `packages/mcp-server`（6 项依赖，
  无跨大版本冲突）。pnpm-workspace.yaml 只含这两目录，CI docs-site-build
  job 先行切换验证一个观察轮。
- **第二批**：acf-cli / node-sdk / executor-node（jest 系，依赖树中等）。
- **第三批（最后）**：admin-api（891 包，NestJS 生态对布局最敏感）、
  admin-web（vitest 4 + eslint 9 新栈）、executor-desktop（Electron
  postinstall 重、598M）。
- 每批验收：该批子项目 test/typecheck/build 全绿 + SEC-06 lockfile-integrity
  适配 + CI 时长对比数据回填本报告。

## 4. 沙箱试点记录（docs-site × pnpm workspace，未入仓）

按任务书「最小试点、严格隔离」执行——**全部在 /tmp 沙箱，仓库零改动**：

- 环境：corepack pnpm 11.21.0（Node 24.13）。
- `pnpm-workspace.yaml` 仅含 `packages: [docs-site]`（+ store-dir 与
  `onlyBuiltDependencies: [esbuild]`）。
- `pnpm install`：173 包解析、125 安装，store 硬链接复用后二次安装
  「reused 126, downloaded 0」——**store 复用生效**。
- `pnpm build`（vitepress build）：**绿**，2.0s，14 页 HTML 产物齐全
  （与 npm 形态产物一致）。
- 踩坑记录（迁移成本的真实样本）：
  1. pnpm v10+ 默认拦截依赖生命周期脚本，esbuild postinstall 被拒 →
     需 `onlyBuiltDependencies` 白名单（或 `pnpm approve-builds`），
     否则 vitepress build 前置的 deps-status-check 直接失败。整仓迁移时
     每个含 postinstall 的依赖（electron、esbuild、sharp 类）都要过一遍
     白名单仲裁——这是 §2 中「迁移成本」的具体形态。
  2. pnpm 生成的 `pnpm-lock.yaml` 与现有 `package-lock.json` 并存期，
     SEC-06 的 `npm ci --dry-run` 判据需要同步适配。
- 仓库内验证：试点后 `cd packages/docs-site && npm run build` 仍绿
  （2.0s，9 内容页 + 404），原 npm 形态零破坏。

## 5. CI 时长对比基线（供后续任务回填）

本轮基线（run 34244749009，develop，全绿，2026-09-08）：

| 指标 | 值 |
|---|---|
| 整轮墙钟 | 4m42s |
| npm ci 步骤合计（21 job / 24 次） | ~2.5min（并行摊薄） |
| 关键路径 job | e2e-full 242s / docker-multiarch(admin-api) 315s |
| npm ci 占关键路径比 | 6%（admin-api-test）~12%（e2e-full） |

后续若执行 ARCH-28b（turbo）或 workspace 迁移，以同口径（develop 全绿
run、`gh run view --json jobs` 步骤级时长）回填对比表。

## 6. 改动清单（本轮）

| 文件 | 变更 |
|---|---|
| `docs/arch-28-workspace-evaluation.md` | 新增（本报告） |
| `docs/development.md` | 「测试命令」节顶部加一行报告链接（最小侵入） |

仓库其余文件（含 8 套 lockfile、ci.yml、根 package.json）**零改动**；
试点在 /tmp 沙箱完成，未入仓。
