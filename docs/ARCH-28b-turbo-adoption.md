# ARCH-28b：turbo 增量接入实测报告（N-01）

> 状态：**实测完成，结论=不接入多包模式；以「no-hoisting 守卫 + 缓存度量」交付。**
> 上游：`docs/arch-28-workspace-evaluation.md`（ARCH-28 评估报告，2026-09-10；§2 裁定
> 「采纳 ③ turbo」，并明确「本轮不落 turbo 配置……应独立任务（建议 ARCH-28b）带 A/B 对比轮验证」）。
> 本报告即该任务（N-01）的执行结果，§5 回填 ARCH-28 的时长对比基线。
> 全部数字为本机实测，可复现；命令与输出逐条记录，无臆造。
>
> 环境：Linux（本开发机）· Node 24.21.0 · npm 11.19.0 · turbo 2.11.4 ·
> 沙箱 worktree `/tmp/acf-turbo`（develop @ d3804307 的 detached checkout，仓库零污染）。

---

## 1. 结论（先说结果）

**turbo 的多包模式在本仓不可用**，因为它的启用前提与本仓 ARCH-20 的 no-hoisting
裁定**直接冲突**，且冲突形态是「静默半破坏」而非「装上就报错」：

| turbo 模式 | 是否可用 | 阻塞原因 |
|---|---|---|
| 多包模式（真正的并行 + 跨包缓存） | ❌ | 要求根 manifest 提供 workspace 发现面（`workspaces` 字段或 `pnpm-workspace.yaml`）。根一旦声明，**8 个子项目的 `npm ci` 全部 exit 1**（§3.1） |
| 单包模式 `--single-package`（每子项目各自缓存） | ⚠️ 可用但无收益 | 缓存确实生效，但省下的只有**本机重复执行**；CI 每个 job 是独立 runner + 全新 checkout，本地缓存不可跨 job 复用（§4） |

因此本轮**不接入 turbo**，改为交付两件在数据上站得住的东西：

1. **`scripts/check-no-hoisting.mjs`（+ 自检）** —— 把本次实测揭穿的破坏形态钉成
   结构守卫。它拦的不是"turbo 用错了"，而是**任何**把根变成安装根的回退（含
   `workspaces` 字段、`pnpm-workspace.yaml`/`lerna.json`/`rush.json`、根 lockfile
   承载依赖图、子项目丢 lockfile）。
2. **本报告 §5 的 A/B 基线 + §6 的 CI 关键路径实测** —— 把"turbo 能省多少"这个
   问题从评估报告里的**预估值**换成**实测量**，并指出真正的瓶颈在哪（§6.3）。

**最重要的单条发现（§3.2）**：现有 `lockfile-integrity` 守卫在破坏发生后给出的
提示是**指向错误修法的**——它说「运行 npm install 同步后提交两文件」，而真去跑
`npm install` 会把 hoist 写进根 lockfile，把临时破坏**固化成持久破坏**。

---

## 2. 为什么先做「破坏形态」实测而不是直接装

ARCH-28 §1.5 已量化本仓的版本分裂面（顶层声明 20 个共用包中 17 个版本不一致；
实际解析到不同版本 161/1390 = 11.6%；express 4/5、eslint 8/9、vitest 3/4 跨大版本
共存）。turbo 的多包模式要求 npm/pnpm 把根当安装根，而 npm 的 workspace 安装
**默认 hoist**——这正是 ARCH-20 当初裁定 no-hoisting 的原因。

所以本任务的第一件事不是「按评估报告建议装 turbo」，而是先证伪/证实：
**加一个 `workspaces` 字段，究竟会发生什么。** 结论比预期严重（§3）。

---

## 3. 破坏形态实测（本任务最有价值的部分）

### 3.1 根声明 `workspaces` → 8 个子项目 `npm ci` 全部失败

在沙箱 worktree 上，仅给根 `package.json` 加：

```json
"workspaces": ["apps/admin-api","apps/admin-web","apps/executor-node",
               "apps/executor-desktop","packages/acf-cli","packages/mcp-server",
               "packages/autocodeflow-node-sdk","packages/docs-site"]
```

然后逐个在**子项目目录里**跑 CI 实际用的命令 `npm ci`：

| 子项目 | `npm ci`（真实安装） | `npm ci --dry-run --ignore-scripts`（lockfile-integrity 守卫的命令） |
|---|---|---|
| apps/admin-api | **exit 1** | exit 1 |
| apps/admin-web | **exit 1** | exit 1 |
| apps/executor-node | **exit 1** | exit 1 |
| apps/executor-desktop | **exit 1** | exit 1 |
| packages/acf-cli | **exit 1** | exit 1 |
| packages/mcp-server | **exit 1** | exit 1 |
| packages/autocodeflow-node-sdk | **exit 1** | exit 1 |
| packages/docs-site | **exit 1** | exit 1 |

**8/8 失败。** 机理：根有 `workspaces` 后，npm 的 prefix 从子项目上移到根
（`npm prefix` 在 `apps/admin-api` 里返回仓库根），于是任何子项目的 `npm ci`
都变成「解析整个 workspace 图并按根 hoist」，直接撞上 §1.5 的版本分裂：

```
npm error code ERESOLVE
npm error While resolving: admin-api@0.0.1
npm error Found: ioredis@6.0.0
npm error Could not resolve dependency:
npm error peerOptional ioredis@"^5.0.4" from typeorm@1.1.1
```

### 3.2 两个让回退极难归因的放大器（本任务净新发现）

**① 报错文本与被跑的项目无关。** 上面那段报错是在
`apps/executor-node/` 里跑 `npm ci` 得到的——它谈的是 `admin-api` 的
`ioredis`/`typeorm`，**一个字都没提 executor-node**。按报错去查 executor-node
的依赖树会一无所获。根因是 npm 此时解析的是整个 workspace 图，报错来自图中
冲突最尖锐的那条边，而它与当前工作目录无关。

**② 部分列出比全部列出更隐蔽。** 只把部分子项目写进 `workspaces` 时，
**被列进去的红、没列进去的绿**：

| `workspaces` 内容 | docs-site | admin-api | executor-node | acf-cli |
|---|---|---|---|---|
| 全部 8 个 | exit 1 | exit 1 | exit 1 | exit 1 |
| 仅 `packages/docs-site` | **exit 1** | exit 0 | exit 0 | exit 0 |

即"CI 一半红一半绿"——最容易被当成 flake 重跑掉。

**③ 既有守卫的提示指向错误修法。** `lockfile-integrity` job 的失败文案是：

> `::error::<project>: package.json 与 package-lock.json 漂移 — 运行 npm install 同步后提交两文件`

这句话描述的是**完全不同的故障**（真实的 lock↔manifest 漂移），照它去查会一路
走偏。实测开发者面对这种红有三种反应，其中一种会把破坏固化：

| 反应 | 实测结果 |
|---|---|
| 在根跑 `npm install` | **exit 1**（同样 ERESOLVE）——根 lockfile 不变（仍是 `[""]`），破坏未固化 |
| 在子项目跑 `npm install` | **exit 1**——同样不写根 lockfile，破坏未固化 |
| 加上 `--legacy-peer-deps`（"先让它过"的典型反射） | **exit 0** —— 根 lockfile 从 1 个条目涨到 **866 个**，hoist 被写进仓 |

即前两种反应只是红着不走，破坏是**可逆**的；而 `--legacy-peer-deps` 这一种
会把整个依赖图落进根 lockfile——此后即便删掉 `workspaces` 字段，根 lockfile
的 hoist 痕迹也已入库（要清理必须 `git checkout` 该文件）。CI 上该 job 只跑
`--dry-run`，**不会**触发这条路径；风险面是本地开发与任何"照着报错修"的人。
同 job 的矩阵还漏了 `docs-site`（7/8）。

### 3.3 为什么这次破坏不会被"看一眼 CI"发现

`lockfile-integrity` 的 `--dry-run` 覆盖了 7 个项目且都会红（§3.1 右列），
所以 CI 总体**不是静默的**。但它的红**归因错误**（§3.2 ③），且缺 docs-site。
真正危险的是本地开发面：开发者按提示跑一次 `npm install` 就完成固化。
故本轮守卫直接盯**结构**，不看任何命令的退出码。

---

## 4. turbo 两种模式的实测

### 4.1 多包模式：确实强，但前提不可用

在沙箱里按 turbo 要求配好（根 `packageManager: pnpm@10.0.0` +
`pnpm-workspace.yaml` 列 8 个子项目），实测：

| 场景 | 耗时 | 备注 |
|---|---|---|
| 冷缓存 8 包并行 `turbo run build` | **6.2s** | 8/8 successful |
| 热缓存同命令 | **0.02s** | `>>> FULL TURBO`（8 cached） |
| 本仓现状：8 包**串行** npm 脚本 | **28.1s** | 实测 `npm run build:web && … && admin-api` |

**并行 + 缓存把本机 28.1s 压到 6.2s（冷）/ 0.02s（热）** —— 收益真实存在。
但这条路要求根声明 workspace 发现面，而这就触发 §3 的 8/8 失败。

补充实测（runner 委派语义，值得单独记）：turbo **按「所在的 workspace 根」的
`packageManager` 委派**执行任务，而不是按子项目声明。本仓子项目各自声明 npm
（它们各有自己的 lockfile，这是 no-hoisting 的必然形态），而 turbo 多包模式要求
根声明一个包管理器——两者**必然冲突**：

| 配置 | `pnpm run build`（在子项目里） | 后果 |
|---|---|---|
| 根=`pnpm` + `pnpm-workspace.yaml` 存在 | **exit 0** | pnpm 认 workspace 根，忽略子项目的 `packageManager: npm`，**用 pnpm 去跑子项目的 npm 脚本** |
| 根=`pnpm`，无 workspace 清单 | **ERR_PNPM_OTHER_PM_EXPECTED** | `× This project is configured to use npm` |
| 根=`npm` + `workspaces` 字段 | turbo 委派 `npm run` | 但子项目 `npm ci` 全红（§3.1） |

即「根说 pnpm、子项目用 npm 装」这条折中路线即使**表面能跑通**（第一行），
也是让 pnpm 去驱动一个用 npm 安装的 `node_modules`——`node_modules/.bin` 的
布局、workspace 链接语义、hoist 假设都不同源。这不是可以长期依赖的形态。

### 4.2 单包模式：缓存生效，但对 CI 无收益

turbo 的 `--single-package` 允许逐子项目用（子项目各自声明 npm，根不声明
workspace 面），且缓存**确实生效**：

| 子项目 | 冷 | 热 |
|---|---|---|
| apps/admin-web | 0.06s（已命中前次） | 0.04s |
| apps/admin-api | 6.01s | **0.04s** |
| packages/mcp-server | 0.85s | **0.03s** |
| packages/acf-cli | 0.04s | 0.03s |
| packages/autocodeflow-node-sdk | 1.15s | 1.16s |
| packages/docs-site | 2.64s | 2.62s |

**但这对 CI 几乎没用**：每个 CI job 是独立 runner + 全新 checkout + 无共享
缓存，本地 turbo cache 不可跨 job 复用。要跨 job 复用就必须上**远程缓存**
（`TURBO_TOKEN`/`TURBO_TEAM`/Vercel 或自建），那是新增外部依赖与凭据面，
且 §6.3 的数据显示 CI 瓶颈根本不在这些 build 步骤上。

**结论**：单包模式能省的只有「本机连着跑两次构建」这一个场景，代价是给 8 个子
项目各加一份 `turbo.json` + 根加一份 devDependency + CI 命令改造（可读性下降）。
收益/代价不成立，故不接入。

---

## 5. CI 关键路径实测基线（回填 ARCH-28 §5）

取 develop 最近一次全绿 run（`36300739454`，2026-09-27）逐 job / 逐 step 实测：

| job | 总时长 | 最长 step |
|---|---|---|
| `selftests` | 544s | **Behavior selftests (serial) 518s** |
| `admin-web-build` | 320s | **npm test -- --coverage 286s** |
| `e2e-full` | 287s | Run 48-case full-chain e2e 204s |
| `admin-api-coverage` | 189s | （全量 jest + coverage） |
| `admin-api-test` (1) | 115s | Unit tests (shard 1/4) 45s |
| `admin-api-migrations` | 64s | Initialize containers 18s |

`npm ci` 在其中的占比（对照 ARCH-28 §1.3 的 2026-09-08 基线，结论一致）：

| job | npm ci | 占该 job |
|---|---|---|
| admin-api-test (1) | 12s | 10% |
| admin-web-build | 8s | 2.5% |
| e2e-full | 12+5+10=27s（3 处） | 9% |
| selftests | 12+4=16s（2 处） | 3% |

**与 ARCH-28 §1.3 结论一致且更强化**：`npm ci` 不是瓶颈。瓶颈是
①`selftests` 的 518s 串行自检（占整轮关键路径），②`admin-web` 的 286s 全量
vitest + coverage，③e2e 204s。

---

## 6. 那真正的收益在哪（本轮实测的副产品）

### 6.1 `selftests` job 是唯一值得动的关键路径

`selftests`（544s）是全场最长 job，其 518s 全部在一段**串行**脚本里：

```
npm run test:arch31-multi-instance
npm run test:arch31-outbox
npm run test:arch31-outbox-dup
npm run test:arch31-rollout
npm run test:pull-dispatch
npm run test:qa05-callback-tier
npm run test:oidc-sso
npm run test:nginx-sse
npm run test:ha-compose
npm run test:registry-npm
```

这 10 个脚本**各自独立起栈**（各自 PG/Redis/端口），串行是刻意选择（失败即停）。
turbo 在这里也用不上——它们不是包级任务，而是根级脚本。真要压缩得靠
job 分片（一条工作流改动，但会改变「失败即停」语义与资源占用），属独立任务，
本轮不动。

### 6.2 已就位、无需 turbo 的缓存面

`admin-api-test`（4 分片）与 `admin-api-coverage`（全量）**跑的是同一份代码的
同一套测试 5 遍**——NETOPT-1⑪ 已把 coverage job 收窄到 develop push + schedule
（PR 只跑分片），这是比 turbo 更直接的重复消除，且已经落地。

### 6.3 结论性判断

评估报告 §2 预判 turbo 的收益点（「admin-web 在 4 个 job 重复 build」
「executor-node 在 3 个 job 重复」）**在实测数据下不成立**：这些 build 步骤
在各自 job 里只有 8~12s（admin-web-build 的 build step 12s），而
**同一 job 内**紧随其后的测试是 286s。跨 job 复用需要远程缓存（§4.2）。
即「turbo 能省的是秒级，代价是 §3 的 8/8 安装面破坏」——风险收益倒挂。

---

## 7. 交付物

| 文件 | 作用 |
|---|---|
| `scripts/check-no-hoisting.mjs` | no-hoisting 结构守卫；5 条判据盯结构不看退出码 |
| `scripts/check-no-hoisting.selftest.mjs` | 13 项有齿自检（含 4 个负例族 + 真实仓库正向断言） |
| 根 `package.json` | 新增 `check:no-hoisting` / `check:no-hoisting:selftest` |
| `.github/workflows/ci.yml` | `repo-guards` job 接入（与 check-migrations 等同批，秒级） |
| 本报告 | 实测证据 + A/B 数据 + 未接入理由 |

**未交付（如实）**：turbo 未接入（§1 结论）；turbo 依赖未加入 `package.json`
（沙箱实测用，入仓会让 `npm ci` 面新增一个不必要的包）。

---

## 8. 复现命令

```bash
# 守卫（本机秒级，无需安装/数据库）
node scripts/check-no-hoisting.mjs
node scripts/check-no-hoisting.selftest.mjs

# §3 破坏形态复现（在任意干净 checkout 上；务必先备份 package.json）
node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));
p.workspaces=['apps/admin-api','apps/executor-node'];fs.writeFileSync('package.json',JSON.stringify(p,null,2));"
(cd apps/executor-node && npm ci)      # → ERESOLVE，且报错谈的是 admin-api
git checkout -- package.json            # 还原

# §4 turbo 模式复现（需临时装 turbo，勿提交）
npm install --no-install-scripts turbo@2.11.4
```

---

## 9. 与 ARCH-28 评估报告的关系

ARCH-28 §2 的**方向裁定（采纳 ③ turbo、否决 ①② workspace）在数据上依然成立**
——本报告 §3 用更强的证据（8/8 安装面失败）巩固了「不迁 workspace」的结论。
但 ARCH-28 §2 对 **turbo 可增量接入、风险低** 的判断，在实测下需要修正：
turbo 的多包模式**同样要求根成为安装根**，因此它与 ARCH-20 的 no-hoisting
不是「可叠加」，而是**互斥**。

ARCH-28 §5 预留的「CI 时长对比基线（供后续任务回填）」已在本报告 §5 回填。
