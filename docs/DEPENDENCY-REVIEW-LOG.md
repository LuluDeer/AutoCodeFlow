# 依赖审计豁免复查记录

> 常设文档：每次**到期复查**（CI `check-dependency-review` 判据日）与每次
> **依赖审计轮**都在本文件追加一节，作为「我们曾决定接受某个已知漏洞、以及
> 后来怎么处置」的可审计痕迹。
> 判据与注册表事实源：`scripts/check-dependency-review.mjs`（GHSA 集合从
> `.github/workflows/ci.yml` 的 npm-audit `known='...'` 解析，语义注册在同一脚本的
> `EXEMPTIONS`）。
> 配套：`npm run check:dependency-review:report` 打印当前复查报告。

---

## 复查 #1 —— 2026-09-27（BUG-04 / N-13，判据日提前 4 天执行）

**触发**：N-13「BUG-04 复查机制化」。原复查日 2026-10-01，本轮把机制建起来的同时
提前执行了实质复查（机制若只登记日期、不真的去查，等于又一层纸面）。

### 1. 上游状态（结论：仍未发版，「等上游」维持）

| 事实 | 值 | 证据 |
|---|---|---|
| npm `minio` 最新版 | **8.0.7** | `npm view minio version` |
| 该版发布时间 | **2026-02-27** | `npm view minio time.modified` |
| 距今 | **7 个月未发新版** | 2026-09-27 计算 |
| `minio@8.0.7` 依赖声明 | `query-string@^7.1.3`、`stream-json@^1.8.0` | `npm view minio@latest dependencies.*` |
| 实际解析（admin-api） | `decode-uri-component@0.2.2`、`query-string@7.1.3`、`stream-json@1.9.1` | `package-lock.json` |

### 2. ★ 核心发现：当年登记的「10-01 评估 overrides 强升」计划，**两条里有一条会砸掉整条 S3 链路**

SEC-06 当年留的处置是「届时评估 npm overrides 强升 `query-string@9` + `stream-json@3`」。
本轮用**真实 MinIO 服务端**做了端到端实测（`docker run minio/minio` + admin-api 解析到的
SDK 实例，跑 `makeBucket → putObject → statObject → getObject+gunzip → listObjectsV2 → removeObject`），
逐条 override 单独验证：

| override | 真实 MinIO 端到端 | `require('minio')` | audit 剩余 | 判定 |
|---|---|---|---|---|
| （基线，无 override） | **4/4 通过** | OK | 4 | — |
| `decode-uri-component@0.5.0` | **4/4 通过** | OK | **2** | ✅ **可采纳** |
| `query-string@9.5.1` | **0/4 失败** | OK | 2 | ❌ 运行时炸 |
| `stream-json@3.7.0` | **0/4 失败** | **抛 MODULE_NOT_FOUND** | 3 | ❌ 导入即炸 |

**两条失败的确切机理**（本轮净新发现，原计划未预见）：

1. **`stream-json@3` 让 `require('minio')` 本身抛异常。**
   - `minio/dist/main/notification.js:7` 硬写 `require("stream-json/jsonl/Parser.js")`；
   - v1（minio 声明 `^1.8`）实际提供 `jsonl/Parser.js`（**大写 P**，无 `exports` map）；
   - v3 改为 `src/jsonl/parser.js`（**小写**）并新增 `exports: {"*": "./src/*"}`，
     于是该 require 解析到不存在的路径 → `MODULE_NOT_FOUND`；
   - 更关键的是 `minio/dist/main/minio.js:32` **无条件 eager `require("./notification.js")`**
     ——不是"只坏掉通知功能"，而是**整个 `require('minio')` 即失败**，S3 日志链全废。
   - 这条**不会被现有测试发现**：`s3-log-storage.spec.ts:14` 是 `jest.mock("minio", ...)`，
     模拟掉之后真实模块的加载路径根本不执行。

2. **`query-string@9` 让 minio 运行时 `qs.stringify is not a function`。**
   - v9 是 ESM-only（`"type": "module"`，无 `main`，`exports.default = ./index.js`）；
   - minio 是 CJS，`require("query-string")` 拿到的是 `{__esModule:true, default:{...}}`，
     顶层没有 `stringify`（实测 `typeof require('query-string').stringify === 'undefined'`）。

### 3. 已落地处置（用户拍板）

- **`decode-uri-component@0.5.0` override 落地**（`apps/admin-api/package.json`）
  ——这是唯一经真实 MinIO 验证安全的修复：
  - 真实 MinIO 端到端 **4/4**（put/stat/get+gunzip/listObjectsV2/remove 全通过）；
  - admin-api 全量 **226 套件 / 3790 例全绿**；
  - `GHSA-vcc3-ghjq-m6fr` **已清偿**，已从 CI `known` 列表与脚本注册表移除；
  - audit 计数 **4 → 2**。
  - 附带确认：minio 对 `query-string` 只用 `stringify`（`helpers.js:132`、
    `internal/client.js` 五处，**从不 `parse`**），而 `decode()`（即
    `decode-uri-component` 的唯一入口）只在 `parse` 路径上被调用，
    `stringify` 函数体内不调用 `decode(`/`encode(`——即该漏洞在本仓的
    **实际可达性为零**，这进一步支持采纳该 override（修的是不可达路径，
    风险面只剩"版本替换本身"，已被真实 e2e + 全量测试覆盖）。
- **`stream-json` 继续豁免并续期**：到期动作由「评估强升」改为
  **`DO_NOT_OVERRIDE`**（实测会 break `require('minio')`）。处置方向是
  **等上游 minio 换掉 stream-json，或改用其它 S3 客户端**。
  已把该结论写进 CI 注释与注册表，避免后人再走一遍这条死路。

### 4. 机制交付（本轮真正的产出）

| 文件 | 作用 |
|---|---|
| `scripts/check-dependency-review.mjs` | 复查判据：**到期当天即 fail-closed**；CI 活跃豁免 ↔ 脚本注册表**双向**一致（未登记 / 僵尸豁免 / 日期漂移三类）；解析失败不放过（不给"跳过=通过"的口子） |
| `scripts/check-dependency-review.mjs --selftest` | 15 条有齿自检（真子进程断言退出码 + 关键文本；T4 起原伴生 `.selftest.mjs` 的用例已**并入此处**，伴生文件已删——它测的本来就是本脚本的判据，没有独立工具/网络依赖） |
| CI `npm-audit` job | admin-api 分片跑该守卫（秒级） |
| 根 `package.json` | `check:dependency-review` / `:selftest` / `:report` |

**首版解析器的自身缺陷（自检抓到，值得记）**：最初实现是「扫 npm-audit job 块里
所有 GHSA」，清偿 `decode-uri-component` 后，注释里那句「GHSA-xxx 已清偿」被
**当成活跃豁免**报红。已改为**只认 CI 实际比对用的 `known='...'` 变量**——
活跃豁免的唯一事实源是它，散文注释不是。这正是"清完了还挂着"这类静默形态的镜像。

### 5. 下次复查

- **判据日 2026-10-01**（`GHSA-528h-pc64-c93x` 当时唯一在册豁免；2026-10-19 起已非唯一，见「依赖审计轮 #2」）。
- 到期时脚本会红并打印到期动作，无需依赖任何人记得。

---

## 依赖审计轮 #2 —— 2026-10-19（Dependabot 告警清偿，PR #99/#100）

**触发**：Dependabot 对默认分支报出 38 条告警。本轮逐条溯源：**27 条修复、11 条豁免**。

### 1. 已修复（27 条）

| 范围 | 处置 |
|---|---|
| `admin-web` | js-yaml / tmp / dompurify / uuid / brace-expansion |
| `executor-desktop` | brace-expansion / undici / js-yaml |
| `admin-api` / `executor-node` | glob / brace-expansion |
| `docs-site` | vitepress 1.6.4 → 2.0.0-alpha.20，vite / esbuild 告警归零 |
| Python | anyio 4.12.1 → 4.15.1（**critical**）、pytest 8.4.2 → 9.1.1 |

- **Python SDK 最低解释器由 3.9 提高到 3.10**（`autoflow-sdk` 的 `requires-python`）。

### 2. 豁免（11 条）

共同特征：**上游无修复版**（`first_patched_version=null`），且全部位于开发期工具链，
不进生产运行时。已登记在 `scripts/check-dependency-review.mjs` 的 `EXEMPTIONS`，
并同步到 CI 的 `known` 列表。

其中本轮在脚本中新登记 4 条，复查日均为 **2026-12-30**：

| GHSA | 包 | 依赖链 | 可达范围 / 到期动作 |
|---|---|---|---|
| `GHSA-7pqw-9j4j-h8q3` | extract-zip@2.0.1 | admin-web devDep `@lhci/cli` → `@puppeteer/browsers` | 仅 Lighthouse CI；不得 override（无目标版本） |
| `GHSA-jmr9-qjv8-65gv` | extract-zip@2.0.1 | 同上 | 仅 Lighthouse CI；随 GHSA-7pqw 同批复查 |
| `GHSA-ch52-4w7c-c8xp` | http-cache-semantics@4.2.0 | executor-desktop `electron-builder` → `@electron/get` | 仅构建期 |
| `GHSA-hp3w-g68c-fv3c` | sprintf-js | `@istanbuljs/load-nyc-config` → js-yaml@3 → argparse@1 | 仅测试期；**不得 override js-yaml**（会破坏 load-nyc-config 的 API） |

### 3. 下次复查

- `GHSA-528h-pc64-c93x` 不再是唯一在册豁免；新一批的**判据日 2026-12-30**。
- 到期动作：复查上游是否发布新版（extract-zip、`@lhci/cli`、`@electron/get`、jest 对 `@istanbuljs/load-nyc-config` 的 js-yaml@3 依赖）；已发布则升级并移除对应豁免，否则续期。
- 到期时脚本会红并打印到期动作，无需依赖任何人记得。

---

## 依赖审计轮 #3 —— 2026-10-22（GitHub Dependabot 10 条告警）

**触发**：推送 `develop` 时 GitHub 提示默认分支 10 条告警（3 high / 7 moderate）。
本轮以 `gh api .../dependabot/alerts` 逐条核对，并与 `npm audit`（官方 registry）交叉验证。

### 1. 已处理（4 条 Dependabot + 1 条 npm audit 附带 high）

| 范围 | 处置 | 验证 |
|---|---|---|
| `http-cache-semantics@4.2.0` | executor-desktop `overrides` 升 **4.3.0**（> vulnerable range ≤4.2.0） | `npm ls` 4.3.0；`electron-builder --version` 26.15.3；desktop tsc + runtime/collab selftest |
| `sprintf-js@1.0.3`（admin-api） | `overrides.argparse=2.0.1`，消除 js-yaml@3→argparse@1→sprintf-js | admin-api tsc + 432 tests；`npm ls` 无 sprintf-js |
| `sprintf-js@1.0.3`（executor-node） | 同上 | executor-node 1216 tests；`npm ls` 无 sprintf-js |
| `sprintf-js@1.0.3`（node-sdk） | 同上 | node-sdk 142 tests；`npm ls` 无 sprintf-js |
| `basic-ftp@5.3.1`（npm audit 附带 high） | admin-web `overrides` 升 **6.2.3**（> vulnerable range ≤6.2.0） | `lhci --version` 0.15.1；`require('basic-ftp').Client` 可用；admin-web full audit high 10 → 6 |

### 2. 保留（6 条 Dependabot）

| GHSA | 包 | 原因 |
|---|---|---|
| `GHSA-7pqw-9j4j-h8q3` / `GHSA-jmr9-qjv8-65gv` | extract-zip@2.0.1 | 上游最新即 2.0.1（无修复版）；仅 admin-web `@lhci/cli` 的 Lighthouse CI 链可达。`@puppeteer/browsers@3` 可去依赖但跨 major，未验证 Lighthouse 兼容性，不做危险 override。 |
| `GHSA-528h-pc64-c93x` / `GHSA-hqr4-qq8f-hg3x` / `GHSA-mjw6-4jj6-33hc` | stream-json@1.9.1 | 修复版在 v3，但 v3 是 ESM-only 且改了路径，minio@8.0.7 的 CJS `require('stream-json/jsonl/Parser.js')` 会直接失败；仅 admin 私服内部 MinIO 通知链可达，不得 override。 |
| `GHSA-hp3w-g68c-fv3c` | sprintf-js@1.1.3（executor-desktop） | 剩余链路 electron-builder→@electron/get→global-agent→roarr@2→sprintf-js；无修复版，且仅构建期下载 Electron 时可达。argparse override 已覆盖其余三个包的测试链。 |

### 3. 复查

- 下次复查日仍为 **2026-12-30**（注册表 6 条）。
- 关注：extract-zip 上游、`@lhci/cli`/puppeteer 链、global-agent/roarr、minio 是否改用 ESM stream-json 或换 S3 客户端。

---

## 依赖审计轮 #4 —— 2026-10-23（复查轮 #3 的 6 条，0 条新增可修）

**触发**：推送 `develop` 时 GitHub 仍提示默认分支 6 条告警（2 high / 4 moderate）。
逐条复核「上游是否已发修复版」，结论：**没有任何一条变成可修的**。

### 1. 已关闭（1 条，advisory 被上游撤回）

| GHSA | 包 | 依据 |
|---|---|---|
| `GHSA-hp3w-g68c-fv3c` | sprintf-js@1.1.3 | advisory **已于 2026-10-22 19:21 UTC 撤回**（`withdrawn_at`，理由：格式串精度异常属应用侧职责）；且 sprintf-js 无 1.1.4+ 版本。已按误报 dismiss。 |

### 2. 仍保留（5 条，全部 `first_patched_version: null`）

| GHSA | 包 | 本轮复核结果 |
|---|---|---|
| `GHSA-7pqw-9j4j-h8q3` / `GHSA-jmr9-qjv8-65gv` | extract-zip@2.0.1 | `npm view extract-zip versions` 最高仍 **2.0.1**（2.0.1 即最新）。链路 `@lhci/cli → lighthouse → puppeteer-core → @puppeteer/browsers`，**devDependency**。本轮实测：`npm run build` 产物 `dist/` 中 **grep 不到 `extract-zip` 也不到 `lhci`** —— 不进运行时。 |
| `GHSA-528h-pc64-c93x` / `GHSA-hqr4-qq8f-hg3x` / `GHSA-mjw6-4jj6-33hc` | stream-json@1.9.1 | 1.x 线止于 **1.9.1**（已装），修复仅在 v3；v3 会让 `require('minio')` 抛 `MODULE_NOT_FOUND`（机理见轮 #3 §2.1，含真实 MinIO 端到端反证）。维持不 override。 |

### 3. 本轮净新增的验证证据

- `apps/admin-web` 生产构建产物 grep：`extract-zip` / `lhci` 均**不在 `dist/`**（此前轮次只论证了「是 devDependency」，本轮补了产物级证据）。
- sprintf-js 的撤回是**上游结论**（不是我们放宽），关闭有据。

### 4. 复查

- 下次复查日维持 **2026-12-30**（注册表 5 条）。
- 触发重开的条件不变：extract-zip 上游发版 / minio 换 S3 客户端或改 ESM / roarr 线变化。

---

## 服务端变更 #5 —— 2026-10-29（S3 服务端 MinIO → RustFS；**客户端不变**）

**性质**：不是依赖审计轮，而是**服务端替换**触发的复核。结论：**依赖图与豁免清单零变化**，但把「换服务端 ≠ 换客户端」这件事记在案，避免后人误以为 stream-json 的三条告警已随 MinIO 一起消失。

### 1. 变更内容

| 面 | 变更 |
|---|---|
| 服务端 | `minio/minio:RELEASE.2024-10-13T13-34-11Z`（Docker Hub 已下线，此前靠 `ALLOW_UNPINNED` 豁免）→ `rustfs/rustfs:1.0.4@sha256:ed9210d6…293dcc2`（Apache-2.0，manifest list digest 固定） |
| 卷属主 | rustfs 以非 root `10001:10001` 运行 → 新增一次性 `volume-permission-helper`（`alpine:3.20@sha256:d9e853e8…a4b6bc`，`chown -R 10001:10001`，`restart: "no"`，被 `depends_on: condition: service_completed_successfully` 等待） |
| 镜像固定 | `check-image-pinned` 的 `ALLOW_UNPINNED` 豁免从 **1 条降为 0 条**（16 条 compose 镜像引用 + 10 条 Dockerfile FROM 全固定） |
| 客户端 | **未改**：`apps/admin-api/package.json` 仍是 `minio@^8.0.7`，`src/modules/task/log-storage/s3-log-storage.ts` 一行未动（`minio` 是通用 S3 SDK，对 RustFS 同样可用） |

### 2. 依赖结论（本轮复核的核心）

- **`package.json` / `package-lock.json` 均未改动** ⇒ `npm audit` 结果与上轮逐条一致，本轮**不新增、不移除任何豁免条目**。
- **stream-json 的三条 moderate 仍在**（`GHSA-528h-pc64-c93x` / `GHSA-hqr4-qq8f-hg3x` / `GHSA-mjw6-4jj6-33hc`，实装 `stream-json@1.9.1`）：它们来自 **npm 客户端 SDK 的依赖树**（`minio → stream-json ^1.8`），与服务端是 MinIO 还是 RustFS **完全无关**。修复版仅在 v3，而 v3 会让 `require('minio')` 抛 `MODULE_NOT_FOUND`（机理见轮 #3 §2.1）——结论维持 **DO_NOT_OVERRIDE**，复查日仍为 **2026-12-30**。
- 换句话说：**换服务端只解决了「MinIO 镜像不再发布」这条供应链问题，一条 npm 告警都没消掉**。

### 3. 真实 RustFS 端到端实测（非 mock）

环境：本机 `docker compose -f docker-compose.yml --profile rustfs up -d rustfs`，镜像固定到上面的 digest，容器 healthy 用时约 60s，`volume-permission-helper` 退出码 0。

| 用例（客户端 = admin-api 实装的 `minio@8.0.7` / 其编译产物 `S3LogStorage`） | 结果 |
|---|---|
| `listBuckets()`（S3 协议握手） | ✅ 空列表正常返回 |
| `makeBucket("autoflow-logs")` → `bucketExists` | ✅ |
| `putObject` → `statObject` | ✅ size=91，etag 正常 |
| `getObject` 字节比对（含 UTF-8 中文行） | ✅ 逐字节一致 |
| `S3LogStorage.put`（gzip 对象 `execution-logs/*.log.gz`）→ `get` 解压 | ✅ 文本逐字节一致（58 bytes gz） |
| `S3LogStorage.getStream` 流式读 | ✅ 与 `get` 同源同内容 |
| `removeObject` → `listObjectsV2` | ✅ 剩余 0 个对象 |
| 反证：不给卷 chown 直接 `docker run` | ✅ 如期失败 `[FATAL] Server runtime failed: Io error: Permission denied (os error 13)`——证明 helper 不是装饰 |

另：`GET /health` → 200；Console `http://127.0.0.1:9001/rustfs/console/` → 200；S3 API 根路径 `/` → 403（未带签名，S3 正常语义）。

### 4. 迁移注意（数据不能原地复用）

RustFS 的「MinIO 磁盘格式兼容」是 preview/非默认构建，官方明确「MinIO 加密的对象 RustFS 读不了」⇒ **旧 `minio_data` 卷不能挂给 rustfs**。历史日志二选一：① 新旧并存 + `mc mirror`（S3 侧复制，与服务端实现无关）；② 接受历史日志随 30/90 天保留期自然过期（日志非业务数据）。步骤见 `docs/operations.md`「MinIO → RustFS 迁移」。

### 5. 复查

- 下次复查日不变：**2026-12-30**。
- 新增触发条件：RustFS 发布安全公告 / 其镜像仓库改用其它 registry（届时 digest 固定可能失效）。
