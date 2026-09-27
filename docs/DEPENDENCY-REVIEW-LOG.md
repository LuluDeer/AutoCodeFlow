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
| `scripts/check-dependency-review.selftest.mjs` | 18 项有齿自检（含合成注册表以与真实条数解耦） |
| CI `npm-audit` job | admin-api 分片跑该守卫（秒级） |
| 根 `package.json` | `check:dependency-review` / `:selftest` / `:report` |

**首版解析器的自身缺陷（自检抓到，值得记）**：最初实现是「扫 npm-audit job 块里
所有 GHSA」，清偿 `decode-uri-component` 后，注释里那句「GHSA-xxx 已清偿」被
**当成活跃豁免**报红。已改为**只认 CI 实际比对用的 `known='...'` 变量**——
活跃豁免的唯一事实源是它，散文注释不是。这正是"清完了还挂着"这类静默形态的镜像。

### 5. 下次复查

- **判据日 2026-10-01**（`GHSA-528h-pc64-c93x` 唯一在册豁免）。
- 到期时脚本会红并打印到期动作，无需依赖任何人记得。
