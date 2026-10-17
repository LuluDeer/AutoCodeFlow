# 优化计划实施报告（2026-10-17）

**分支**: `develop`（未提交、未推送）
**范围**: **全部 7 份 PLAN-*.md 逐项核验** + 高优先级三项的真实缺口实现 + A 类队列第二轮
**方法**: CodeGraph 核验事实 → 只实现真缺口 → 每项通过 typecheck + lint + 测试 + CI 门禁

---

## 〇、第二轮（A 类队列）实施了什么

在第一轮核验出「92 项里 49 项已实现」之后，按剩余**真缺口**做了第二轮，全部来自
报告的「A. 立即可做（无外部依赖）」清单：

| 项 | 落地内容 | 关键设计取舍 |
|---|---|---|
| 后端 3.3 慢查询日志 | `DB_SLOW_QUERY_MS`（默认 1000，0=关闭）→ TypeORM **顶层** `maxQueryExecutionTime` | 必须放顶层而非 `extra`——`PostgresQueryRunner` 读的是 `driver.options.maxQueryExecutionTime`。1000ms 选在 pg `statement_timeout`(30s) 之下、又能抓到病态扫描 |
| 后端 1.2 触发窗口索引 | 迁移 `1790000000056`，`idx_tasks_status_id` on `tasks(status,id)` | `CREATE INDEX CONCURRENTLY` + `transaction=false`；**刻意不删**已冗余的 `idx_tasks_status`（删索引不可逆，需先量测）。已登记 `PLAN-CLAIMS.md` |
| 后端 4.2 系统配置缓存 | `SYSTEM_CONFIG_CACHE_TTL_MS`（默认 1000，0=关闭），进程内 TTL Map | **4 条写路径全部 `try/finally` 失效**（upsert / batchUpsert / remove / rollback）——失败也要失效，因为写可能部分生效。不做负缓存（会把 404 钉住）；跨实例 pub/sub 明确**不做**并在注释里写明限制与逃生舱（TTL=0） |
| 前端 3.2 JSON 日志美化 | 单行着色（`JsonLine`）+ 点开浮层看缩进美化（`JsonPrettyPopover` 挂 body） | **保住固定行高窗口化**：多行美化绝不能进滚动容器。搜索模式下不叠加 JSON 着色（`mark` 必须唯一视觉层） |
| 前端 2.2 表单草稿自动保存 | `useDraft` hook（版本化 key + 作用域 + 防抖 + quota 容错 + SSR 安全）接入 `TaskFormPage` | 恢复遵守既有 dirty 守卫；**丢弃后不复活**（见下方补强）；程序化回填不写草稿 |
| 前端 1.2 窄范围乐观更新 | **仅**任务暂停/恢复（全仓 37 个 `useMutation` 里只有这 2 个带 `onMutate`） | `cancelQueries` **先于**快照（否则迟到的 GET 会盖回乐观值）；快照去重用 `JSON.stringify` 而非 `join`（`join` 会把 params 对象变成 `[object Object]`，导致漏记快照） |
| Desktop 4.2 更新日志展示 | `normalizeReleaseNotes()` 归一 + 4000 字符封顶 + `<details>` 折叠渲染 | 主进程剥 HTML + 渲染层纯文本，**两层防 XSS**；不引 react-markdown |
| Desktop 5.2 诊断报告 | 纯函数 `buildDiagnosticReport()`（runtime/config/health/workDir/recentLogs + meta） | 三层脱敏（键级 / 值自动采集 / 全串擦洗），断言打在**整个序列化结果**上而非逐字段；截断与脱敏都进 `meta` 可审计 |
| DevEx 6.3 CODEOWNERS | `.github/CODEOWNERS`（按域分组） | owner 写真实账号 `@LuluDeer`——写不存在的账号 GitHub **静默失效**，宁可显式也不留空 |
| DevEx 5.3 VSCode 调试 | `docs/vscode-launch.template.json` + `scripts/gen-vscode-launch.mjs` | `.vscode/` 被 `.gitignore:31` 刻意忽略（编辑器配置不入库），故**入库模板 + 生成脚本**而非改 gitignore 强推个人配置。生成器带漂移校验（见下） |

### 本轮独立发现并修复的三个测试质量缺陷

因为负责前端的 subagent **在自验前额度耗尽死掉**，我接手独立验收，用变异测试
（故意破坏实现看测试是否变红）发现三处「测试名不副实」：

1. **`task-form-save-as-template.test.tsx` 缺 localStorage 隔离**（真实失败）。
   新草稿功能落 localStorage，该文件没清理 → 上一个用例填的表单被下一个用例
   「恢复」进来，导致「必填项缺失应被校验门拦截」反了过来。已补
   `beforeEach/afterEach` 的 `localStorage.clear()`（与 agent 给另外 4 个文件加的模式一致）。

2. **页面层「失败回滚」用例验的不是回滚**。删掉 `onError` 里的 `rollback?.()`，
   两条页面层用例**照样全绿**——它们断言的状态靠 `onSettled` 重取（list mock 恒返
   active）同样能得到。真实故障形态恰恰是重取也救不了（同一张网已断），此时若
   回滚没接上，开关会**永久**停在乐观态（用户以为任务停了、实际在跑）。
   已补一条让首屏成功、其后重取全失败的用例，**只有回滚能救**；实测删掉
   `rollback?.()` 该用例立即变红。

3. **草稿「不复活」漏了卸载路径**。删掉 `discard()` 里的 `pendingRef` 重置，
   原有两条 discard 用例**照样全绿**——因为防抖 effect 依赖含 `active`，
   effect cleanup 已把定时器清掉（`clearTimer()` 其实是冗余的第二道保险）。
   真正的复活路径在**卸载 flush**（判据正是 `pendingRef`）：用户「丢弃草稿 →
   立刻切页」会把刚丢掉的草稿写回去。已补「discard 后立即卸载」用例；实测
   删掉该行立即变红。

> 这三处都不是功能 bug，而是**测试给出的假信心**——比没有测试更危险，
> 因为它们会让后来者以为改动有保护网。第 2、3 条尤其隐蔽：实现是对的，
> 但测错了地方。

### 本轮验证

| 范围 | 结果 |
|---|---|
| admin-api 全量（4 分片） | **4,888 通过 / 0 失败** |
| admin-web 全量 | **212 文件 / 1,703 通过 / 0 失败** |
| Desktop 全量（main + renderer selftest） | 全过（含新增 release notes / diagnostic 断言） |
| 仓库门禁脚本 | **16/16 通过** |
| `tsc` / `eslint` / `lint:i18n`（三端） | 全 0 |

**已知预存在红灯（非本轮引入，已独立取证）**：`check-desktop-bundle-drift.mjs`
报 `executor-node 源码语义摘要漂移`。取证：`git diff --stat HEAD -- apps/executor-node/src apps/executor-desktop/executor-node-bundle.sha256`
为空、`git status --porcelain apps/executor-node` 为空——**门禁输入与 HEAD 逐字节
一致**，即 HEAD 本身就是红的。根因是清单回填（`03c8cf4e`，10-16）早于
executor-node 源码最后变更（`f3e340df`，10-17），属清单过期。**修复需要重打
bundle 并回填清单，超出本轮范围，未动。**

---

## 一、最重要的结论：计划文档与代码现状有系统性偏差

7 份计划共 **92 个条目**，逐项核验后：

| 计划 | 条目 | 已实现 | 真缺口 | 不要实施 |
|---|---|---|---|---|
| 安全加固 | 6 | 3 | 2 | 1 |
| 可观测性 | 9 | 6 | 1 | 2 |
| 部署运维 | 8 | 3 | 1 | 0 |
| 后端架构 | 19 | 5 | 3 | 3 |
| 前端 UX | 20 | 12 | 3 | 5 |
| 开发者体验 | 18 | 11 | 3 | 4 |
| Desktop UX | 12 | 9 | 1 | 3 |
| **合计** | **92** | **49 (53%)** | **14** | **18** |

**超过一半的条目早已实现。** 具体例子：

| 计划声称缺失 | 实际状态 | 处置 |
|---|---|---|
| 没有多阶段构建 / healthcheck | **早已实现**（admin-api 多阶段 + 非 root + HEALTHCHECK；10 个服务有 healthcheck） | 未动 |
| 没有定时备份 | **早已实现**（compose `pg-backup` + crond + 256 字节下限校验） | 未动 |
| 没有迁移自动化 | **早已实现**（CI 空库全链 + 幂等性守卫 + 漂移检查 + revert 演练） | 未动 |
| 没有 Prometheus / Grafana / Loki | **早已实现**（`config/monitoring/` 7 个文件，看板被 compose 真实挂载） | 只加 RED 行 |
| 没有告警规则 | **早已实现 26 条**，还有专门同源守卫 | 增至 30 条 |
| 没有结构化日志 | **早已实现**（Nest 原生 `ConsoleLogger({json:true})`，**不需要 pino**） | 未动 |
| 没有 Readiness / Liveness | **早已实现**，且 ready 已正确返回 503 | 未动 |
| API Key 无细粒度权限 | **早已实现**（三级矩阵 + `task:trigger`，4 个 spec） | 未动 |
| SSRF 只有基础防护 | **强于计划**（DNS pinning 已存在） | **拒绝实施计划文本** |
| 账户活动时间线缺失 | **已存在**（SessionsCard） | 未动 |
| 调度器无批量预取 / 指标粗糙 | **早已实现**（keyset 分页 + 5 种 skip reason + P99） | 未动 |
| 连接池不可配 / 无监控 | **早已实现**（`DB_POOL_SIZE` + 4 个 gauge） | 未动 |
| 无事件总线 / 无 URL 版本控制 | **早已实现**（outbox + dead-letter；`enableVersioning`） | 未动 |
| 无骨架屏 / 虚拟滚动 / 懒加载 / A11y | **早已实现**（21 处 / LogWindow / 24 处 lazy / 129 处 aria） | 未动 |
| 无文档站 / 示例库 / ADR | **早已实现**（VitePress / examples / 23 篇 ADR） | 未动 |
| Desktop 无托盘 / 通知 / 自动更新 / i18n | **早已实现**（多数有 selftest，自动更新还有 CI 门禁） | 未动 |

**如果直接按计划文本实施，会产生三类损害**：

1. **重复实现**——在已有功能上再写一套（如 pino、terminus、API key scopes），
   制造两套并行实现。
2. **安全回归**——计划 §4.1 建议「两次 DNS 解析比对 + 100ms 延迟」，这比现有的
   **DNS pinning 严格更弱**（TOCTOU 窗口只是变窄而非消失）。按文本实现会削弱防护。
3. **破坏既有门禁**——本仓有 16 个 CI 门禁脚本，其中 `check-alerts-rules.mjs`
   要求指标名必须是声明在两个特定文件里的 `"autoflow_*"` 字面量；
   计划里 `http_requests_total` 这类命名会被直接判红。

---

## 二、实际完成的四项工作

### 1. 限流白名单同源守卫 + 一处真实缺陷修复

**发现**：白名单 `EXECUTOR_MACHINE_PATH_PATTERNS` **漏登记了两条真实机器面路由**——
`GET /api/executors/config`（executor-node `pull.ts:229` 配置热更新）与
`GET /api/executors/:address/terminal-states`（`callback.ts:633` 死信对账）。
两者都带 `x-executor-address` 头，漏登记的后果是**静默退回按出口 IP 计桶**，
多执行器共享 NAT 出口时被叠加限流——正是该守卫当初要修的 B-2 故障形态。

**修复**：
- 补齐两条白名单正则
- `scripts/check-throttler-whitelist.mjs`（零依赖 + `--selftest`，三条判据）
- 运行时告警：带机器面头落在非白名单路径 → warn + 10 分钟节流 + 给出应加的正则模板
- CI 接线 `npm run check:throttler-whitelist`

**反证已验**：删掉 `/executors/config` 正则 → 守卫立即报红并指出调用点。

**设计取舍**：计划建议「开发环境抛错」。**未采纳**——`getTracker` 在每个请求的
限流路径上，灰度期新执行器版本先行上报就会把新版本变成硬故障；且漏登记的代价是
可用性降级（退回 IP 桶），不是安全漏洞（绕过面已由路由白名单关闭）。

### 2. SSE 票据被拒的可观测性

**发现**：P1-2 修复把票据泄漏面关掉了，但**修复本身零可观测性**——一枚泄漏的
30 秒票据被拿去打 REST 端点时，系统只是静默 401，没有计数器、没有审计、没有告警。

**实现**：`autoflow_sse_ticket_rejected_total{reason="wrong_path"}`，埋点在
`assertTicketOnlyOnStreamPath` 拒绝分支；告警 `AUTOFLOW_SSE_TICKET_REJECTED`
（阈值 >0 / 15m）。

**阈值取 >0 而非速率**：合法前端从不会把票据放进 Authorization 头（EventSource
只在三条 `/stream` 路由的 `?ticket=` 上带），故任何一次拒绝都意味着有人拿到了票据
文件。误报面极低，宁可一次就报。

### 3. HTTP RED 指标 + 执行器 fleet gauge（此前完全缺失）

| 指标 | 类型 | 标签 |
|---|---|---|
| `autoflow_http_requests_total` | Counter | method, route, status_class |
| `autoflow_http_request_duration_ms_{bucket,sum,count}` | Counter ×3 | method, route, status_class, le |
| `autoflow_executors_online` / `autoflow_executors_total` | Gauge | — |

**四个关键设计**（每个都是踩过的坑）：

- **不引入 `prom-client` Histogram**：沿用仓内既有的「三个手写 Counter + doRender
  里 reset+inc 重建 series」惯例，不制造第二种直方图方言。
- **`route` 只能是 Express 路由模板**，未匹配固定 `"unmatched"`，**绝不回退原始
  URL**——未匹配路径正是扫描器最爱打的，回退等于把基数交给攻击者。
- **SSE/长连接排除**：一条挂几小时的日志流会让 `_sum` 变成「在线时长」，P99 被
  单条流带偏。
- **fleet gauge 在 DB 查询失败时保留旧值**：这是 `AllExecutorsOffline` 告警安全的
  前提——一次 PG 抖动绝不能渲染出 `online=0`。告警另加
  `and sum(autoflow_executors_total) > 0`，全新部署不会一装就炸。

### 4. 磁盘 / 堆水位健康检查 + 备份可恢复性演练

**健康检查**（此前 `/health/detailed` 在盘 99% 满、堆耗尽时照样报 healthy）：
- `checkDisk()` 用 `fs.statfs` 的 `bavail` 而非 `bfree`（容器内进程常非 root，
  `bfree` 含保留块会系统性低估水位）
- `checkMemory()` 用 `v8.getHeapStatistics().heap_size_limit` 而非 `os.totalmem()`
  （容器限 512MB 而宿主 32GB 时用后者算比例恒个位数、永远不告警）
- **刻意不进 `/health/ready`**：磁盘慢不该触发全站摘流量，并有专门用例断言

**备份恢复**（此前**只有备份、没有恢复**，dump 从未被证明可恢复）：
- `pg-restore.sh` 默认恢复到一次性 scratch 库；恢复进生产库必须显式
  `--force-overwrite-production`，且目标等于 `$PGDATABASE` 时**在任何 DB 连接之前**拒绝
- 归档闸门严格有序：`<256` 字节 → `gzip -t` → TOC 令牌 → 才连库；
  加载用 `--single-transaction`，半截失败整体回滚
- 表名**对着迁移核实**（交叉检查所有 `DROP TABLE`/`RENAME`），非空断言只用在有种子数据的表
- 77 例**纯离线** selftest（PATH shim 桩掉 psql/createdb/dropdb/gzip + 调用日志），
  **已做变异测试**：删掉生产库闸门 → 7 条断言如期报错

---

## 三、顺带修复的既有 CI 红灯

`scripts/check-shell-multibyte-var.mjs` 在 HEAD 上**已经是红的**（3 处 `deploy.sh`：
`$prev_mode（`、`$MODE）`、`$prev_commit（`）。这是真实缺陷——macOS runner 的
bash 3.2 在非 UTF-8 locale 下会把多字节字符首字节并进变量名，`set -u` 下直接中止。
已加花括号修复，`bash -n` + 50 例 deploy selftest 全绿。

---

## 四、验证结果

### 测试
| 范围 | 结果 |
|---|---|
| admin-api 全量（4 分片） | **4,862 通过 / 0 失败** |
| 改动面定向（metrics + interceptors + health + auth + guards） | 292 通过 |
| 限流白名单新增用例 | 12 通过 |
| 票据计数新增用例 | 4 通过 |
| 健康检查新增用例 | 11 通过 |
| pg-restore selftest | 77 通过 |
| deploy selftest | 50 通过 |

### 门禁（16 个 CI 脚本全部 exit=0）
`check-alerts-rules` · `check-env-drift` · `check-openapi-response-schema` ·
`check-throttler-whitelist` · `check-lint-gates` · `check-shell-multibyte-var` ·
`check-migrations` · `check-no-hoisting` · `check-enum-drift` · `check-index-drift` ·
`check-failure-reasons` · `check-release-config` · `check-compose-sandbox` ·
`check-consumer-routes` · `check-error-i18n` · `check-user-facing-language`

### 静态检查
- `tsc --noEmit`：exit 0
- `eslint src`：exit 0
- 覆盖率：`http-metrics.interceptor.ts` 100/100/100/100；
  `health.service.ts` 96.5 stmts / 79.1 branch（阈值 76/81/88/87）

### 变更规模
19 个文件修改 + 5 个新文件（代码）+ 7 份文档，约 2,900 行新增。

---

## 五、后续队列（按依赖分类）

### A. 立即可做（无外部依赖，低风险）
| 项 | 计划 | 文件 | 风险提示 |
|---|---|---|---|
| CODEOWNERS | DevEx 6.3 | `.github/CODEOWNERS` | 零风险 |
| VSCode 调试配置 | DevEx 5.3 | `.vscode/launch.json` | 零风险 |
| JSON 日志美化 | 前端 3.2 | `utils/logLevel.ts` | 纯 CSS，无新依赖 |
| 表单草稿自动保存 | 前端 2.2 | `TaskFormPage.tsx` + `hooks/useDraft.ts` | 注意 dirty guard 语义与既有测试 |
| 窄范围乐观更新 | 前端 1.2 | `TaskListPage.tsx` + `api/queries.ts` | **只做暂停/恢复**，不要一次改 35 处 |
| zxcvbn 强度计 | 安全 3.1 | `apps/admin-web` | 新文案必须走 i18n |
| 慢查询日志 | 后端 3.3 | `configuration.ts` | 单测钉住 `extra` 形态 |
| `(status,id)` 索引 | 后端 1.2 | 新迁移 | `check-index-drift` 是单向的，能过 |
| SystemConfig 缓存 | 后端 4.2 | `config.service.ts` | 有「总读到新值」的 spec |
| 更新日志展示 | Desktop 4.2 | `updater.ts` + `UpdateBanner` | zh/en key 必须同步 |
| 诊断报告 | Desktop 5.2 | `export-flows.ts` | 零新依赖 |

### B. 需要外部基础设施
- ~~**分布式追踪**——要么接 OTLP exporter（需 collector），要么**删掉
  `@opentelemetry/api` 死依赖**~~ → **本已复核并更正（见 §七末）**：只剩"接 OTLP
  exporter（需 collector）"这一条；**删除依赖已驳回**（它是 `prom-client` 的硬运行时
  依赖 + 本仓的 SDK 挂载锚点，删了不减少依赖树，只会退回依赖传递依赖）。
- ~~**Alertmanager 真实接收端**——被 `/api/alerts/webhook` 的 HMAC 要求阻塞，需签名 sidecar~~
  → ✅ **已完成（§七）**：它不属于"需要外部基础设施"——零依赖侧车 + 接线 + 离线自检即可。
- **K8s/Helm、Trivy、Vault、蓝绿/金丝雀、多区域 DR、HPA/KEDA**——均需真实环境。

### C. 需要谨慎评估
- **审计日志哈希链**（安全 §6.1-6.2）——**先读**迁移 `1790000000006` 里记录的
  「append-only vs 哈希链」取舍。计划里的 `findOne` + `save` 在并发下**不是安全的
  链式写入**，需要串行化或 advisory lock。现有 append-only 触发器已是有效控制。
- **出口代理隔离**（安全 §4.2）——`NO_PROXY` **必须**覆盖 `postgres,redis,executor-*`，
  否则执行器流量被塞进代理而中断；三个 compose 解析类门禁会触发。
- **游标分页**（后端 §2.1）——会改响应信封，需先设计向后兼容的过渡形态。
- **票据使用审计**（安全 §2.1）——低价值：高频 SSE 重连会把审计表变成连接日志噪声。

---

## 六、给下一个 agent 的提醒

1. **先核验再动手**。本次 92 个计划条目里 **49 项（53%）其实早已实现**。
   每份计划文档顶部都有核验表，**先读它**。
2. **计划里的代码片段不可编译**，是示意性的。例如：
   - 限流片段调用不存在的 `this.defaultTracker`
   - 指标片段用不存在的 `this.counter()` API，且命名（`http_requests_total`）
     会被 `check-alerts-rules.mjs` 判红
   - 健康检查用 `@nestjs/terminus`，本仓根本没这个依赖
   - Desktop 计划假设 AntD + react-query + react-i18next，实际三者皆无
   - 后端计划假设存在 `nextTriggerTime` 列，实际调度器是内存定时器
3. **指标名必须是 `autoflow_*` 前缀，且声明在 `prometheus-metrics.service.ts` 或
   `runtime-metrics.ts`**——写进第三个文件，`check-alerts-rules.mjs` 看不见它。
4. **告警 YAML 的 expr 必须是单行引号标量**——受限解析器拒绝 `|` / `>` 块标量。
5. **改动 `config/monitoring/alerts.yml` 必须同步 `docs/observability/alerting-rules.yml`**，
   守卫做语义级对账。
6. **jest 必须带 `--node-options=--experimental-vm-modules`**，裸 `npx jest` 会因
   ESM 依赖报 `ERR_REQUIRE_ESM`。
7. **新增 env 键必须登记 `.env.example`**，否则 `check-env-drift.mjs` 红。
8. **新 npm 依赖必须落进使用它的 app 自己的 `package-lock.json`**，
   绝不能加到根——`check-no-hoisting.mjs`（ARCH-20）会判红。
9. **不要加 `setGlobalPrefix('api/v1')`**——现有 `enableVersioning` 是刻意
   VERSION_NEUTRAL，加前缀会一次打断 admin-web / acf-cli / mcp-server /
   执行器机器面四端。
10. **不要引入第二套同类系统**——本仓已有：手写 i18n（非 i18next）、
    Nest 原生 JSON logger（非 pino）、手写健康检查（非 terminus）、
    零依赖虚拟滚动（非 react-window）、zustand（非 Redux）。
    加第二套会让后续维护者不知道该信哪一套。

---

## 七、第三轮：Alertmanager 加签侧车（同日，Agent 自主推进）

### 背景：这一项**不是**「有环境才能落地」

上一轮把它归到「B. 需要外部基础设施」（`IMPLEMENTATION-REPORT §五.B`：
「Alertmanager 真实接收端——被 `/api/alerts/webhook` 的 HMAC 要求阻塞，需签名
sidecar」）。复核后修正：它**不需要集群、不需要云凭据、不需要新 npm 依赖**，
需要的只是一个仓库内的加签转发件 + 接线 + 离线自检。而代价是 30 条告警规则
持续进黑洞。故本轮把它做完。

### 落地物

| 文件 | 说明 |
|---|---|
| `scripts/alertmanager-hmac-proxy.mjs`（新） | 加签侧车。**零依赖**（只用 `node:http` / `node:crypto`；`scripts/` 不在 `check-env-drift` 的扫描源内，也不需要进任何 `package-lock.json`） |
| `scripts/alertmanager-hmac-proxy.selftest.mjs`（新） | 36 项离线断言，见下 |
| `config/monitoring/alertmanager.yml` | `route.receiver`：`'noop'` → `'hmac-proxy'`（`noop` 保留作静默兜底） |
| `docker-compose.yml` | 新服务 `alertmanager-hmac-proxy`：`node:24-alpine`、只读挂载脚本、**不映射宿主端口**、仅 `autoflow-internal`、`restart: 'no'`、healthcheck 打 `/healthz`（端口经同一变量插值） |
| `apps/admin-api/src/common/utils/__tests__/webhook-hmac.util.spec.ts` | 钉入**同一组金向量**（+2 例） |
| `package.json` / `.github/workflows/ci.yml` | `test:alert-proxy` 脚本 + 挂进零依赖守卫族 job |
| `docs/deployment.md`、`docs/observability/README.md` §3.5.2/§3.5.4、`docs/atlas/06-infra/docker-compose.md` | 接线文档 |

### 四个关键设计（都是踩过/避开的坑）

1. **body 逐字节直通**，不做 `JSON.parse`→`stringify` 往返。签名绑的是字节序列，
   工作流上要的是「转发的就是收到的」。
2. **时间戳用侧车本进程 `now()`**（不是把 Alertmanager 的时间透传）——接收侧窗口
   ±5 分钟；跨机部署须 NTP 对齐（写进 `docs/deployment.md`）。
3. **上游状态码原样回传**。admin-api 在「一个渠道都没送到」时**刻意**返回 502；
   若把它抹成 200，Alertmanager 就永不重试，那处刻意的失败语义被抵消。
4. **secret 缺失即拒绝启动**（exit 1），不降级为无鉴权转发——与 admin-api
   「未配置即 503」同源。compose 因此配 `restart: 'no'`，避免变成重启刷屏。

另有两处实现细节值得记下：
- **超限（413）不能用 `req.destroy()`**：响应还没 flush 就断连，客户端只会看到
  「连接被重置」（实测 undici 报 `SocketError: other side closed`）而不是 413。
  改为「先看 `content-length` 提前拒；chunked 超限则 `pause()` + 回 413 + 响应
  flush 后再收尾」。
- **`main()` 的直接执行判定必须用 `pathToFileURL(argv[1]).href`**：Windows 盘符
  路径下手拼 `file://${argv[1]}` 得到两斜杠，与 `import.meta.url` 的三斜杠不等，
  脚本会**静默不启动**。

### 自检的四层钉子（36 例）

| 层 | 内容 |
|---|---|
| ① 金向量 | 3 组固定 (secret, timestamp, body) → 固定签名字面量；**接收侧用 WebCrypto `crypto.subtle` 独立复核**——与签名侧的 `createHmac` 是 Node 里两条不同的实现路径，不是自己验自己 |
| ② 源码级契约对账 | 读 `webhook-hmac.util.ts` 源码文本，断言 header 名 / `sha256=` 前缀 / `${timestamp}.` 拼接 / ±5 分钟窗口 / `createHmac("sha256"` 这些**字面量**仍在，且与侧车导出常量逐个相等 |
| ③ 真实 HTTP 端到端 | 真起代理 + 真桩接收端，走真实 TCP：成功透传、上游 401/502 **原样回传**、不可达/超时 → 502、超限 → 413 且**不转发**、405/404 守卫、`/healthz` 可用且不泄露配置、空 body 也可签、**secret 不出现在任何出站头**（名或值） |
| ④ fail-closed | 以**子进程**真实执行脚本且不给 secret → 断言退出码 = 1 |

### 双向锁（这是本轮最值得留下的机制）

同一组金向量同时存在于加签侧（`.selftest.mjs`）与校验侧
（`webhook-hmac.util.spec.ts`）。两侧各自以「共享字面量」为基准，因此：

- 改侧车的分隔符 → 侧车自检红（金向量 + 契约对账）；
- 改 admin-api 校验侧的分隔符 → admin-api spec 红。

**两个方向都已实测取证**（变异测试，改完全部还原、`git diff` 为空）。
不这么做的话，单侧漂移的症状是「Alertmanager 发出去了、admin-api 静默 401、
告警到不了值班渠道」，而两侧单测各自都还是绿的。

### 本轮验证

| 范围 | 结果 |
|---|---|
| 零依赖 CI 门禁 + 新自检（19 个 node 脚本） | **全绿** |
| bash 自检（deploy / pg-restore / install-artifact-sha256） | **全绿** |
| 生成物漂移（error-i18n / vscode-launch / install-script） | 无漂移 |
| docs-site 同步校验 | 通过 |
| admin-api `src/common/utils` | 20 套件 / **225 例**通过 |
| admin-api `src/modules/notification` | 11 套件 / **284 例**通过 |
| admin-api `eslint src/common/utils src/modules/notification` | exit 0 |
| admin-api `tsc --noEmit` | exit 0 |
| 侧车自检（`npm run test:alert-proxy`） | **36 例全绿** |

**仍然预存在的红灯（本轮未动、与本次改动面无关）**：
`check-desktop-bundle-drift.mjs` —— bundle 输入与 HEAD 逐字节一致但清单过期，
需重打 `npm run build:executor` 并回填 `executor-node-bundle.sha256`。

### 顺带复核出的两处「过期勾选」

1. `PLAN-SECURITY-HARDENING.md` 的验收项「`docs/observability/README.md` 的
   runbook 锚点 `#autoflow_sse_ticket_rejected` 尚待补正文」——**正文早已存在**
   （README §3.6，含触发条件/为何正常恒为 0/四步处置）。已改勾。
2. `PLAN-OBSERVABILITY.md` §「Alertmanager 真实接收端」与
   `PLAN-DEPLOYMENT-OPS.md` §3.1 的 ⬜ 状态已同步为 ✅。

### 刻意没做的事

- **没有删除 `@opentelemetry/api`**（报告上一轮的建议 B）。**核 lockfile 后本条被
  彻底推翻**——它不是"可随手删的累赘"：
  · `node_modules/prom-client`（admin-api 真的在用，`/api/metrics` 就是它）把
    `@opentelemetry/api` 声明为**硬运行时依赖**（`dependencies["@opentelemetry/api"]
    = "^1.4.0"`，且 lock 里该包 `optional` 未标记）⇒ 删掉 admin-api 的直接声明
    **不会把它从依赖树里移除**，只会让将来的 import 退回"靠传递依赖"（更差）；
  · admin-api 的 `^1.9.1` 高于 prom-client 的 `^1.4.0`，**直接声明实际在钉版本**；
  · 它同时是 OBS-01 认领记录写明的 SDK 挂载锚点（接 Jaeger/Tempo 只挂
    `TracerProvider`，埋点调用点零改动）；
  · "让它真承重"这条路也已排除——`traceparent.util.ts` **已经**自己拒绝了全零
    trace-id/span-id 并要求 version=`00`（W3C 要点全覆盖），OTel API 在此没有
    真实可补的位置，硬塞 import 只是装饰性的，比"声明了没用"更误导。

  **处置：保留依赖，只修正文档定性**（7 处：PLAN-OBSERVABILITY ×4、PLANS-INDEX、
  docs/deployment.md、docs/api-reference.md、docs/atlas/06-infra/docker-compose.md、
  apps/admin-api/.env.example、tracing.service.ts 头注）。代码与依赖零改动 ⇒ 无
  lockfile 风险。真正待办的只剩 §4 的 OTLP exporter（需 collector）。

- **没有改 `check-desktop-bundle-drift` 的判据本身**：它设计正确（语义闸本地可复现、
  字节闸 CI 权威），本轮只是**补账**（见 §八）。

---

## 八、第四轮：红灯收口 + 密码策略同源 + 保留期可配（同日）

### 8.1 把最后一盏红灯关掉：`check-desktop-bundle-drift`

上一轮把它记为"预存在红灯、超出范围、未动"。本轮补账，**两个闸都转绿**。

根因（比上一轮更精确）：`03c8cf4e`（10-16）只回填了清单**末行字节哈希**，
**没更新 `source-digest`**；`f3e340df`（10-17「7 项 P1 高危缺陷」批次）改了三个
bundle 输入（`callback.ts` 新增 `executorAddressHeaderFor()`、`log-stream-pusher.ts`
日志上报带机器面凭据头、`pull.ts` 新增 `pullFreeSlotsFor()` 修 E-01-STARVE 永久饥饿），
**既没重打也没回填** —— 于是语义闸与字节闸**同时**陈旧。

处置与取证：
1. `npm run build:executor`（ncc 0.45）重打 → 4296635 bytes；
2. **同目录连续两次重打逐字节一致**（`a32b60f5…`）—— 这是"字节闸可本地回填"的实测
   依据（清单 §386/§430 已有同结论先例）；
3. 回填 `source-digest: 55d884d4…` 与末行字节哈希，并按清单惯例补**变更记录**
   （说清这次漏打的三项 P1 修复及其后果：桌面端日志上报仍被 NAT 叠加限流截断、
   `MAX_CONCURRENT_TASKS=1` 的桌面执行器**永久拉不到任务**）；
4. 复验：语义闸双段绿；字节闸仿真 MATCH；`test:desktop` 重打 agent-worker 后其
   字节闸同样 MATCH。

### 8.2 SECURITY §3.1：密码策略前后端同源（**不用 zxcvbn**）

计划建议引 zxcvbn，**未采纳**：它是 ~800KB 的**独立强度模型**，与后端"策略合规性"
是两件事，会出现"zxcvbn 说 strong、后端 400"的错配——正是本仓"不引第二套真值源"
纪律要防的。改为 `utils/passwordPolicy.ts` = `validatePasswordStrength` 的**语义
镜像** + `PasswordStrengthMeter`（强度**受合规性封顶**：不合规绝不显示 good/strong）。

**顺带修掉一个真实缺陷**（本轮独立发现）：`UserManagementPage` 的"新建用户"与
"重置密码"两处内联正则含 `(?=.*[a-z])`，**比后端更严**（后端不要求小写）→ 管理台
会拒绝后端本可接受的密码（如 `ADMIN2026!`）；而 `SecuritySettings` 的第三条正则又是
正确的 —— 同一平台三个表单三种答案。已全部收敛到 `utils/passwordPolicy`，
`users.field.passwordPattern` 文案同步去掉"小写字母"（zh/en 双侧）。

新增守卫 `scripts/check-password-policy-sync.mjs`（进 CI，零依赖）。判据**不是文本
对比，而是把两侧正则从源码抽出来真正执行**：三规则在 **103 个字符**（ASCII 0x20–0x7E
+ 换行/制表/NBSP/全角/中文/emoji）上逐字符核验字符集一致；**517 个探针**上
`backendSatisfies(p) === frontendSatisfies(p)`；前端合并正则与其四规则合取同义。
含 **5 条反证**，其中两条是真缺陷回归锁：**「抄漏一个字符」**（实测抓出 `?` 缺失）
与**「合并正则不跨换行」**（初版前瞻用 `.` 而非 `[\s\S]`，被这条抓出）。

附带一处 i18n 守卫登记：`components/PasswordStrengthMeter.tsx` 走动态键
（`t(常量表[level])`），已按既有 `dynamicCallFiles` 机制登记并写明取键来源
（两张字面量常量表，词条已全落 zh/en，另由单测断言 labelKey 前缀）。

### 8.3 BACKEND §2.2：执行记录保留期从硬编码改为可配置

复核确认 `task_executions` 走 **90 天硬删**（`executor.service.cleanupOldRecords` →
`cleanupOldTaskExecutions`，每日 02:00 cron + LeaderGate，分批 DELETE 并连带回收
执行日志与 S3 日志对象），**且 90 天是硬编码**。已改为可配置
`TASK_EXECUTION_RETENTION_DAYS`（缺省 90 = 行为逐字节不变）。

两处**刻意**的防护：① `configuration.ts` 归一非法/零/负数为 90；② **取用点再归一
一次**。理由是这条配置唯一的危险方向是"cutoff 被推到未来 → 删空整张表"，而
`?? 90` 抓不到**类型不对**的值 —— 这不是假设：本文件既有单测把 ConfigService mock
成 `get: () => "http"`，实测该形态下 `"http" * 86400000` = NaN → Invalid Date。
该用例已改名并加注，**成为"取用点必须做数值归一"的回归锁**。

口径（"硬删除且不可逆、没有归档表"）此前只存在于代码里，现已写进 `.env.example` /
`docs/deployment.md` 环境变量表 / `docs/operations.md` 磁盘段三处。
**归档表本身未建**：那是业务决策（合规是否要求留存超期记录），没有前提就建表 =
凭空多一条要长期维护的写入路径 + 一份没人查的数据。

### 8.4 DevEx 两项

- `test:quick`：6 个分片（jest `--onlyChanged` / vitest `--changed`）+ `--passWithNoTests`。
  后者**必需**：两个 runner 在"没有受影响的测试"时默认 exit 1，会把"本次改动确实
  没碰到测试"误报成红（实测 executor-node 与 node-sdk 正是这个分支）。已端到端跑通。
  Python 侧（无等价 changed 模式）与 desktop（其 test 脚本串 40+ 个秒级 selftest）
  刻意不纳入，口径写在脚本注释里。
- Dependabot：从"只有 github-actions"扩到 **8 个 npm 安装单元**（逐目录，因为本仓
  刻意不做 workspace 提升）。**auto-merge 刻意不配**：`gh pr merge --auto` 在分支
  保护未要求任何 status check 时**会立即合并**，而本仓正确性几乎全压在 CI 上——把
  "是否已过 CI"的判定权交给仓库设置是不可接受的隐式依赖。正确配方（`workflow_run`
  + conclusion==success + head 前缀 `dependabot/` 再 `--squash`）写进 `dependabot.yml`。

### 8.5 本轮验证

| 范围 | 结果 |
|---|---|
| 零依赖 CI 门禁 + 自检（22 个） | **全绿** |
| bash 自检（deploy / pg-restore / install-artifact） | **全绿** |
| 生成物漂移 + docs-site 同步 | 无漂移 |
| **admin-api 全量** | **288 套件 / 4892 例全绿** |
| admin-web 全量 | **214 文件 / 1721 例全绿**（+18） |
| admin-web `tsc -b` / `eslint`（0 error）/ `lint:i18n` | 全绿 |
| Desktop `test:main` + `test:renderer` | 全绿 |
| `typecheck:all` / `lint:api` / `lint:node` | exit 0 |
| 双 bundle 字节闸仿真（executor-node / agent-worker） | 均 MATCH |

**仓库内已无已知红灯**（上一轮的 `check-desktop-bundle-drift` 已闭合）。

### 8.6 本轮评估后**不做**的项（含理由，非遗漏）

| 项 | 结论 |
|---|---|
| SECURITY §4.2 出口代理隔离 | **不建议盲接**：squid 只有 deny-by-default 白名单才算"隔离"，而出站面含**用户可配**目标（多 AI provider / SMTP / 通知 webhook / 镜像源），盲接先打死可用性；纯配置层且**离线不可验证**（计划原文自警 `NO_PROXY` 漏一个就断执行器流量）。前置条件已写进计划 §4.2 |
| BACKEND §2.1 游标分页 | **需先出信封过渡方案**（`{data,total,page,pageSize}` 被四端消费），直接换信封会一次打断 web/admin-web/cli/mcp/执行器 |
| BACKEND §2.2 归档表 | **需业务决策**（合规是否要求留存超期记录）；决策所需信息本轮已备齐 |
| FRONTEND §2.3 / DESKTOP §5.1、§2.1 | 零新依赖的小改动，属下一批（未开工，不虚报） |
| SECURITY §6.1-6.2 审计哈希链 | 需先读迁移 `1790000000006` 的取舍注释并解决并发串行化；现有 append-only 触发器已是有效控制 |




---

## 九、第五轮：剩余真缺口收尾（同日，5 个 agent 并行）

本轮把上一轮报告里「属下一批」的四项真缺口全部落地，并额外补了 §4.2。
编排方式：按**互不重叠的文件足迹**把 5 项派给 5 个 agent 并行实施，
主会话只做核验、契约产物收口与提交。每个 agent 的第一条指令都是
「先核验缺口是否真实存在」——本仓有 53% 的计划条目其实早已实现的前科。

### 9.1 落地物

| 项 | 落地 | 关键设计判断 |
|---|---|---|
| BACKEND §2.1 游标分页 | `keyset-cursor.util.ts`（纯函数）+ `task.service.getExecutionsByKeyset` + 可选 `cursor` 参数 + 响应追加 `nextCursor` | **只做加性**：旧 OFFSET 路径逐字节不变（`undefined` 让键整个不出现，而非恒下发 `null`——后者会多一个键）。**修掉一个真实精度缺陷**（见 9.2） |
| BACKEND §4.2 跨实例缓存失效 | `config-cache-sync.service.ts`（pub/sub 逐出） | **逐条照抄** `token-cache-sync.service.ts` 的已验证先例，不发明第三套缓存方言 |
| OBS §4/§5 遗留 | 删 `TraceMiddleware` 死代码；`main.ts` 4 处裸 `console.error` → 静态 `Logger.error` | 新增**源码级门禁 spec** + 双向反证（改回去即红） |
| FRONTEND §2.3 表单完成度 | `utils/formCompletion.ts` 纯函数 + NavRail 百分比/状态点 | 分母只数「必须回答的问题」；分母为 0 返回 **0% 而非 100%** |
| DESKTOP §5.1 + §2.1 | 健康面板 + 并发进度条 | 健康面板**复用同一个** `buildDiagnosticReport()` 纯函数，绝无第二套真值源 |

### 9.2 游标分页里那个值得单说的缺陷

教科书写法是元组比较 `(createdAt, id) < (:at, :id)`。但本仓 `task_executions."createdAt"`
是 **PG `TIMESTAMP`（微秒精度，列默认 `now()`）**，而游标经 JS `Date` 往返只有**毫秒**。
于是库里 `…:00.123456` 的行满足 `createdAt > :at`（`:at` = `…:00.123`），
被判定为「仍排在游标之后」→ **同一行被重复返回 → 翻页永不到末页**。

改成毫秒**半开区间**谓词，对微秒/毫秒两种行集给出完全一致的判定：

```sql
(createdAt < :at)                                  -- 游标所在毫秒之前的行
OR (createdAt < :atNext AND id < :cursorId)        -- 与游标同一毫秒的行，靠决胜键
```

`:atNext` = `:at + 1ms`。第一支必须是 `<` 而不是 `<=`——用 `<=` 会把游标那一整毫秒
都当成「在游标之后」，游标行自己被再次返回，翻页原地打转（实测就是这样红的）。

**另一处不妥协**：`total` 仍返回**真实总数**（复用同条件 COUNT），不返回 `-1`/近似值。
理由是 `total` 是 `number` 且四端都在渲染「共 N 条」，没有任何字段级「这是估算」标记——
悄悄改语义就是撒谎。要省这条 COUNT，正确做法是新增显式的 `totalExact: false`。

### 9.3 契约产物的离线收口（本机无 DB/Redis）

`openapi.json` 的唯一写入方是 `test/openapi-export.e2e-spec.ts`，它要引导完整
AppModule（需 PG + Redis）。本机两者都没有，`swagger:export` 跑不了，
而 CI 的 api-types-drift job 正是「重跑 swagger:export 再 diff」——不补产物 CI 必红。

做法：写一个**只取 `TaskController` 装饰器元数据**的临时探针（不引导 AppModule，
因此不需要 DB/Redis），用它产出真实的 Swagger 结果，再与手工补丁**逐字节比对**：

```
ORDER  match: true | gen: id,page,pageSize,name,status,runtime,cursor,limit
CURSOR match: true
SCHEMA match: true
```

**这一步抓到了一次真实的猜错**：我最初按直觉把 `cursor` 放在 `limit` 之后，
探针实测是**之前**（`@ApiQuery` 在 DTO 派生参数**之前**落位）。若不做实测，
CI 会红在我自己「看起来很像」的补丁上——这正是「不要按计划文档的片段照抄」的同一个教训。

配套：新增 2 条英文映射进 `scripts/api-i18n/data/openapi-en-map.json`
（`check:api-i18n` 会如实报缺），注入幂等（连跑两次 SHA256 一致），
随后 `gen:api-types` 重生成前端类型。探针用完即删，未留在仓库。

### 9.4 本轮验证

| 范围 | 结果 |
|---|---|
| **admin-api 全量** | **292 套件 / 4959 例全绿**（基线 4892，+67） |
| admin-web 全量 | **214 文件 / 1750 例全绿**（基线 1721，+29） |
| Desktop `test:main` + `test:renderer` | 全绿 |
| `typecheck:api` / `:web` / `:desktop` | 全部 exit 0 |
| `eslint`（admin-api / admin-web） | **0 error**（admin-web 63 warning 均为既有） |
| `lint:i18n` 双守卫 | 通过，**无需更新 baseline** |
| CI 门禁（20 个） | 全绿，含 `check:response-schema`(226/226) / `check:api-i18n`(1582 节点) / `test:consumer-routes` |
| bash 自检（deploy / pg-restore） | 全绿（50 + 77 断言） |

**仓库内仍无已知红灯。**

### 9.5 本轮**没做**的（如实）

| 项 | 为什么 |
|---|---|
| 游标分页推广到其余 5 个端点 + 前端迁移 | **刻意**。一次改四端是反模式；且新旧两种「第 N 页」语义混用会漏页。本轮只出后端加性能力 + 一个样板端点 |
| BACKEND §2.2 归档表 | 仍是业务决策（合规是否要求留存超期记录），前置信息已备齐 |
| SECURITY §4.2 出口代理隔离 | 仍是「不建议盲接」，理由见 8.6 |
| SECURITY §6.1-6.2 审计哈希链 | 需先解决并发串行化；现有 append-only 触发器已是有效控制 |

### 9.6 给下一个 agent 的新增提醒

11. **`openapi.json` / `api-types.ts` 是入库生成物**。改了任何 `@ApiProperty` /
    `@ApiQuery` / `@ApiOkResponse` 就必须同步产物，否则 CI 的 api-types-drift 红。
    本机无 DB/Redis 时不能跑 `swagger:export`——用「只取 controller 装饰器元数据」
    的探针实测，别按直觉猜（本轮就猜错过一次参数顺序）。
12. **新增中文 `description` 必须在同轮补进 `scripts/api-i18n/data/openapi-en-map.json`**，
    否则 `check:api-i18n` 红。
13. **PG 微秒 vs JS 毫秒**：任何用时间戳做游标/水位线/区间比较的地方都要先确认
    列的精度与往返精度，教科书式元组比较在这里是错的（见 9.2）。