# TTFV 首次成功漏斗埋点设计方案（P1）

> **受众**：PM / 实施方 agent / 集成验收方。
> **状态**：稳定 · **最后核对**：2026-11-22
> 本文只做**埋点方案设计**（不改业务代码），定义 P1「首次成功漏斗」的口径、事件、落点、存储与分期验收；不覆盖真正的埋点实现、真实环境采集与看板搭建。文中每个「文件:行」均经 CodeGraph 1.6.2 静态核实，核对清单见 [§2.3](#23-触发点核对清单)。

---

## 1. 目标与口径

### 1.1 指标口径来源（ROADMAP 原文）

口径以 [ROADMAP 指标段](../ROADMAP.md) 为唯一事实源，逐字引用：

- 北极星（ROADMAP:126）：**每周产生「业务结果」的自动化运行数（有产物 / 有证据 / 被业务确认），按活跃实例统计。**
- 先行指标（ROADMAP:130-135）：**TTFV 中位数 ≤10 分钟；24h 激活率 ≥60%；模板 → 成功转化率 ≥80%；W4 实例留存 ≥40%；桌面 SOP 成功率 ≥90%，人工接管率 ≤10%；社区：star / fork / 外部 contributor / issue 响应时间。**
- P1 定义（ROADMAP:104）：**首次成功漏斗：记录 opt-in 的 TTFV（安装 → 首个成功执行），目标中位数 ≤10 分钟；demo 完成率。**

本方案聚焦漏斗四指标：TTFV、24h 激活率、模板→成功转化率、demo 完成率；北极星只在 §1.2 给出「可聚合性」约束，不重定义其口径。

### 1.2 逐指标精确口径

通用排除规则（适用于全部基于执行行的指标）：排除 `synthetic = true` 的合成行（`apps/admin-api/src/modules/task/entities/task-execution.entity.ts:295`，合成行 startTime/result 全空、非真实尝试）；排除终态非 SUCCESS 的回调；排除 `transitionToTerminal` 未命中（`affected = 0`，即重复回调的 loser 分支，`apps/admin-api/src/modules/task/execution-callback.collaborator.ts:582`）；排除内部种子/demo/selftest 实例（需实施方给出实例白名单，当前无现成标记）。

| 指标 | 分子 | 分母 | 时间窗 | 排除 / 备注 |
|---|---|---|---|---|
| TTVF 中位数（产品口径） | opt-in install 下首个 `task_first_success` 的 `endTime` − 该 install 的 `install_completed` 时间，取 `PERCENTILE_CONT(0.5)` | 观测窗内**已成功转化**的 opt-in install 数 | 安装后 ≤24h 内的首成功才计入 | 未成功 install 不进中位数，但须单独看转化率以防幸存者偏差 |
| TTVF_proxy（阶段1代理口径） | 首个 SUCCESS 执行 `endTime` − 关联 `task.createdAt`（`apps/admin-api/src/modules/task/entities/task.entity.ts:440`） | 有 SUCCESS 执行的 task 数 | 无统一安装锚点，按 task 维度 | **不是产品口径**；无 install_id / opt-in 维度；仅用于验证计算链路 |
| 24h 激活率 | 安装后 24h 内至少产生一次 `task_created` 或首次触发执行的 install 数 | 同批 opt-in 且 `install_completed` 已满 24h 的 install 数 | 安装起 24h | R318 起执行类数据源 = `task_first_attempted`（首次触发执行，覆盖 COMPLETED+FAILED+KILLED 三终态、排除 synthetic），不再用 `task_first_success` 代理；`task_created` 因浏览器无 executor 指纹仍未接，待真机校准（§7.7） |
| 模板→成功转化率 | 由模板实例化创建且产生 ≥1 个 SUCCESS 执行的 task 数 | 同批由模板实例化的 task 数 | 观测窗（建议按周） | 模板来源当前在 task 主表无稳定字段（见 §6），阶段1近似、阶段2显式记 `template_key` |
| demo 完成率 | demo 脚本退出码 = 0 的运行次数 | demo 脚本启动次数 | 每次脚本运行 | 数据源是脚本退出码，非产品 DB；不进北极星 |
| 北极星（仅约束） | — | — | 按周 / 按活跃实例 | 埋点须保证能按周、按 install_id 聚合「SUCCESS 且带产物」的执行数（`TaskExecution.result` / artifacts，`apps/admin-api/src/modules/task/entities/task-execution.entity.ts:327`） |

---

## 2. 事件模型

### 2.1 事件总览

| 事件名 | 语义 | 真实埋点现状 | 落点性质 |
|---|---|---|---|
| `install_completed` | 安装完成 / 首次上线 | **无专门埋点**；仅有 executor register 代理 | 需新增（代理可先派生） |
| `login_success` | 一次成功登录 | 已有安全审计 `auth.login` 成功记录，非漏斗事件 | 派生 + 新增漏斗事件 |
| `task_created` | 任务创建成功 | 已有 controller 成功路径 | 新增漏斗事件 |
| `task_first_success` | 任务首个成功执行终态 | SUCCESS patch 与终态门真实存在 | 新增漏斗事件（挂在既有终态写入点） |
| `task_first_attempted` | 任务首次触发执行（成功/失败/killed 终态，排除 synthetic） | R318 新增：COMPLETED + FAILED + KILLED 三终态监听（KILLED 走独立事件，不经 FAILED） | 新增漏斗事件（dedupeKey=`first-attempted:<task_id_hash>`，§7.7） |
| `demo_completed` | demo 脚本跑通 | 脚本退出码 | 脚本侧采集通道 |

### 2.2 逐事件定义

#### 2.2.1 `install_completed`

- **触发点（代理，CodeGraph 核实）**：`apps/admin-api/src/modules/executor/executor.service.ts:2435` 的 `register` 方法为执行器首次注册入口；稳定设备指纹参数 `deviceFingerprint` 见同文件 `:2456`；指纹规范 `FINGERPRINT_RE = /^[0-9a-f]{64}$/` 见 `apps/admin-api/src/modules/executor/executor-fingerprint.util.ts:138`，`DEVICE_FINGERPRINT_HEX_LENGTH = 64` 见 `:65`，归一化函数 `normalizeDeviceFingerprint` 见 `:183`，legacy 兜底 `legacyExecutorIdentity` 见 `:101`。
- **关键属性**：`install_id`（由指纹派生的匿名 ID，见 §3.2）、`appName`、`executor_type`、`version`、`observed_at`（取 register 落库时间）。
- **幂等 / 去重键**：`install_id` 的**首次** register（即 `min(createdAt) per fingerprint`）；同指纹后续 register 不重复发事件。
- **未验证 / 需真机**：register ≠ 用户安装完成；桌面 GUI、headless、Web 控制台三种形态的"安装"语义不同，跨端统一 install_id **未验证，需真机**。

#### 2.2.2 `login_success`

- **触发点（CodeGraph 核实）**：密码登录 `apps/admin-api/src/modules/auth/auth.controller.ts:151` `login`，成功审计落点在同文件 `:191-202`（`action: "auth.login"`，成功路径不记 detail）；OIDC 登录 `apps/admin-api/src/modules/auth/oidc.controller.ts:157` `callback` → `completeLogin` 见 `:191`。
- **关键属性**：`install_id`（若上下文可得）、`method`（`password` / `oidc`）、`occurred_at`；**不记 username / user id 原文**（对齐审计脱敏，见 §3.3）。
- **幂等 / 去重键**：一次成功登录会话一条；可从 `audit_logs` 的 `auth.login` 成功记录按 session 派生，避免双写。

#### 2.2.3 `task_created`

- **触发点（CodeGraph 核实）**：`apps/admin-api/src/modules/task/task.controller.ts:163` `create`（路由 `POST /api/tasks` 见 `:153`）→ `apps/admin-api/src/modules/task/task.service.ts:1515` `create`；模板实例化入口 `apps/admin-api/src/modules/task-template/task-template.service.ts:210` `instantiate`，官方模板 key 集合 `OFFICIAL_TEMPLATE_KEYS` 见 `apps/admin-api/src/modules/task-template/task-template.constants.ts:565`；任务创建时间 `apps/admin-api/src/modules/task/entities/task.entity.ts:440` `createdAt`。
- **关键属性**：`task_id_hash`（脱敏，见 §3.2）、`template_key`（∈ `OFFICIAL_TEMPLATE_KEYS` 或 `null`）、`source`（`api` / `import` / `template` / `manifest`）、`trigger_type`、`created_at`。
- **幂等 / 去重键**：`task.id`（唯一）；同一 task 多次 update 不重发。

#### 2.2.4 `task_first_success`

- **触发点（CodeGraph 核实，全链）**：
  - 回调入口 `apps/admin-api/src/modules/task/execution-callback.controller.ts:123` `callback`，业务委派 `handleCallback` 见 `:159`。
  - SUCCESS patch 构造：`apps/admin-api/src/modules/task/execution-callback.collaborator.ts:454` `finishedAt`、`:456` `endTime`、`:463-464` `if (cb.status === "success") patch.status = ExecutionStatus.SUCCESS`。
  - 终态写入：同文件 `:575` 调用 `transitionToTerminal`（仅 `affected = 1` 的 winner 才真正落库，`:582` 为重复回调分支）；统一终态门 `apps/admin-api/src/modules/task/execution-terminal.ts:220` `transitionToTerminal`、`:61` `isTerminalStatus`、`:52` `TERMINAL_EXECUTION_STATUSES`；worker 侧终态判定 `apps/admin-api/src/modules/task/task.processor.ts:135` `handle` 同样走 `isTerminalStatus`。
  - 状态与列：`ExecutionStatus.SUCCESS` 见 `apps/admin-api/src/modules/task/entities/task-execution.entity.ts:28`；`taskId` 见 `:261`、`createdAt` 索引见 `:256`、`endTime` 见 `:330`、`duration` 见 `:331`、`synthetic` 见 `:295`、`attemptSeq` 见 `:369`。
- **关键属性**：`task_id_hash`、`execution_id_hash`、`end_time`、`start_time`、`duration_ms`、`attempt_seq`、`synthetic = false`（硬性过滤）。
- **幂等 / 去重键**：`(task_id_hash, first)` —— 每 task 只取 `min(endTime) WHERE status = SUCCESS AND synthetic = false`；由 `transitionToTerminal` 的 winner 语义保证只发一次。

#### 2.2.5 `demo_completed`

- **触发点（CodeGraph / 脚本核实）**：`scripts/demo.sh:457` 定义终态集合、`:468` `process.exit(last === "success" ? 0 : 1)` 为完成判据；其余 demo（`demo-desktop-agent.sh`、`demo-headless-agent.mjs`、`demo-ops-agent.mjs`）各有独立判据，口径需逐一确认（**未验证**）。
- **关键属性**：`scenario`、`exit_code`、`elapsed_ms`（脚本级）、`run_id`（CI run）。
- **幂等 / 去重键**：一次脚本运行一条（CI `run_id` + 脚本名）。
- **备注**：脚本退出码是 CI/本地产物，不进产品 DB；采集到漏斗看板需要独立通道（日志解析或 CI artifact）。

### 2.3 触发点核对清单

下表每个「文件:行」均由 `codegraph node <文件> --offset/--limit` 或 `codegraph node <符号>` 在 2026-11-21 返回逐字源码确认（索引 `Index is up to date`，Files 2,585 / Nodes 50,997）：

| # | 事实 | 触发点（文件:行） | CodeGraph 结果 |
|---|---|---|---|
| 1 | executor 注册入口 | `apps/admin-api/src/modules/executor/executor.service.ts:2435` | ✅ register 方法签名 |
| 2 | 指纹参数 | `apps/admin-api/src/modules/executor/executor.service.ts:2456` | ✅ `deviceFingerprint?: string \| null` |
| 3 | 指纹规范 | `apps/admin-api/src/modules/executor/executor-fingerprint.util.ts:65/:101/:138/:183` | ✅ 常量 / legacy / RE / normalize |
| 4 | 密码登录成功审计 | `apps/admin-api/src/modules/auth/auth.controller.ts:151/:191-202` | ✅ login + 成功 audit.log |
| 5 | OIDC 登录 | `apps/admin-api/src/modules/auth/oidc.controller.ts:157/:191` | ✅ callback + completeLogin |
| 6 | 任务创建 | `apps/admin-api/src/modules/task/task.controller.ts:153/:163` | ✅ route + create |
| 7 | 任务创建 service | `apps/admin-api/src/modules/task/task.service.ts:1515` | ✅ create 方法 |
| 8 | 模板实例化 | `apps/admin-api/src/modules/task-template/task-template.service.ts:210` | ✅ instantiate 方法 |
| 9 | 官方模板 key | `apps/admin-api/src/modules/task-template/task-template.constants.ts:565` | ✅ OFFICIAL_TEMPLATE_KEYS |
| 10 | 任务创建时间 | `apps/admin-api/src/modules/task/entities/task.entity.ts:440` | ✅ createdAt 属性 |
| 11 | 回调入口 | `apps/admin-api/src/modules/task/execution-callback.controller.ts:123/:159` | ✅ callback + handleCallback |
| 12 | SUCCESS patch | `apps/admin-api/src/modules/task/execution-callback.collaborator.ts:454/:456/:463-464/:575/:582` | ✅ 逐字源码 |
| 13 | 终态门 | `apps/admin-api/src/modules/task/execution-terminal.ts:52/:61/:220` | ✅ 常量 / 判定 / 写入 |
| 14 | worker 终态判定 | `apps/admin-api/src/modules/task/task.processor.ts:135` | ✅ handle + isTerminalStatus caller |
| 15 | SUCCESS 枚举与执行列 | `apps/admin-api/src/modules/task/entities/task-execution.entity.ts:28/:256/:261/:295/:327/:330/:331/:369` | ✅ 枚举与列 |
| 16 | demo 完成判据 | `scripts/demo.sh:457/:468` | ✅ 终态集合 + exit code |
| 17 | metrics 模块现状 | `apps/admin-api/src/modules/metrics/metrics.service.ts:26/:49/:101/:172/:294/:348/:359` | ✅ MetricsService 符号表 |

非代码事实（文档读取核实）：ROADMAP:104/126/130-135；[OPEN-DECISIONS C1](../OPEN-DECISIONS.md)；[ADR-028](../adr/adr-028-config-secret-at-rest.md)。

---

## 3. 隐私与 opt-in

### 3.1 opt-in 开关落点

ROADMAP:104 明确「记录 **opt-in** 的 TTFV」，因此默认不采集，需双层开关：

1. **系统级总闸**：`system_config` 增 key `telemetry.ttfv.enabled`（默认 `false`），经 `SystemConfigService` 读取——该类见 `apps/admin-api/src/modules/config/config.service.ts:58`；`findOne` 见同文件 `:221`。此开关不是密钥，**不设 `isSecret`**，避免落入 ADR-028 明文档位。
2. **实例级授权**：opt-in 授权状态存新增 `telemetry_optin` 表（`install_id`、`user_id_hash`、`opt_in`、`opted_at`、`source`）。未授权 install 不产生任何漏斗事件；授权前已发生的行为不追溯补采（避免"默认采集后补同意"）。

### 3.2 匿名 ID 生成与留存

- `install_id`：**不直接落原始设备指纹**。用服务端密钥对 `deviceFingerprint` 做 HMAC-SHA256 后取前 16 字节编码为匿名 ID；密钥复用现有 `SecretsCryptoService` 信封体系（ADR-028 已声明 `encryptValue`/`decryptValue` 就绪），且该密钥**不进漏斗表**。
- `task_id` / `execution_id`：同理哈希化（`task_id_hash` / `execution_id_hash`），原始 UUID 不进事件表；需要回查时用受控映射表，读面按 ADMIN 限权。
- 留存：事件表 append-only，建议 90 天滚动清理（参考 `config_history` 每日 04:05 清理机制，见 [ADR-028](../adr/adr-028-config-secret-at-rest.md)）；`install_id ↔ 指纹` 映射随授权撤销即时删除。
- **不采集**：密码、token、用户名原文、任务参数与日志正文——这些受 §3.3 防线约束。

### 3.3 与现有审计 / 凭据脱敏口径的兼容

- 复用审计既有姿态：成功登录已有 `auth.login` 审计（`apps/admin-api/src/modules/auth/auth.controller.ts:191-202`，只记 username / 来源不记凭据）；配置写动作的审计 detail 只记 `valueType` / `isSecret` / 长度、**不记值**（[ADR-028](../adr/adr-028-config-secret-at-rest.md)）。漏斗事件沿用"只记结构化字段与哈希，不记值"的同一纪律。
- 值级脱敏防线 [OPEN-DECISIONS C1](../OPEN-DECISIONS.md) 已收口 `apps/admin-api/src/common/utils/sanitize-secrets.util.ts`（PEM / JWT / 供应商前缀 / URL 凭据 / 高熵词元）；漏斗事件不落任何自由文本参数，从源头绕开该残余面，无需改动该防线。
- ADR-028 接受"平台级配置密钥明文落库 + 读面掩码 `***`"；本方案的 opt-in 开关非密钥，授权哈希不可逆，不扩大其暴露面。

---

## 4. 存储与计算

### 4.1 现状（CodeGraph 探查结论）

- **无**业务 telemetry / analytics / tracking 模块：仓库内相关目录只存在于 `node_modules`（OpenTelemetry / Sentry），非产品埋点。
- 已有 `apps/admin-api/src/modules/metrics/metrics.service.ts:26` `MetricsService`，方法 `getSummary`（`:101`）、`getDailyTrend`（`:172`）、`generateReport`（`:294`）、`getReports`（`:348`）、`getTodayReport`（`:359`），注入 `TaskRepo` / `execRepo` / `reportRepo`，聚合窗口 `AGGREGATION_WINDOW_DAYS`（`:49`）。它是**运维指标**（今日运行数 / 趋势 / 执行器统计 / 近期失败）与 `ExecutionReport` 报表，**不是产品漏斗事件表**，不能直接承载 install_id / opt-in / 事件去重键。

### 4.2 复用 vs 新增

| 能力 | 结论 | 依据 |
|---|---|---|
| 阶段1代理口径计算 | **复用现有表**，加一条只读 SQL，不建表 | `task_executions` 有 status / endTime / startTime / duration / synthetic（§2.2.4） |
| 漏斗事件落库 | **需新增** `funnel_events`（append-only：install_id、event_name、task_id_hash、execution_id_hash、ts、dedupe_key） | 无现成事件表；metrics 模块字段不匹配 |
| opt-in 状态 | **需新增** `telemetry_optin` + `system_config` 开关 | 无现成授权载体 |
| 审计派生的 `login_success` | **复用** `audit_logs`（append-only） | `auth.login` 成功记录已存在 |
| demo 完成率 | **需新增**脚本采集通道（日志/CI artifact） | 退出码不在 DB |

### 4.3 查询 / SQL 思路（基于真实列，PostgreSQL）

阶段1——TTFV_proxy 中位数与样本量（无需新表、无需改代码）：

```sql
WITH first_success AS (
  SELECT e."taskId", MIN(e."endTime") AS first_success_at
  FROM task_executions e
  WHERE e."status" = 'success'
    AND e."synthetic" = false
    AND e."endTime" IS NOT NULL
    AND e."endTime" >= e."createdAt"
  GROUP BY e."taskId"
)
SELECT
  PERCENTILE_CONT(0.5) WITHIN GROUP (
    ORDER BY EXTRACT(EPOCH FROM (fs.first_success_at - t."createdAt")) / 60.0
  ) AS ttfv_proxy_minutes,
  COUNT(*) AS sample_size
FROM first_success fs
JOIN tasks t ON t."id" = fs."taskId"
WHERE t."createdAt" >= :window_start;
```

阶段2——真实 TTFV 中位数（新表就位后）：

```sql
SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (
    ORDER BY EXTRACT(EPOCH FROM (s."ts" - i."ts")) / 60.0
  ) AS ttfv_minutes,
  COUNT(*) AS converted_installs
FROM telemetry_optin o
JOIN funnel_events i
  ON i."install_id" = o."install_id" AND i."event_name" = 'install_completed'
JOIN funnel_events s
  ON s."install_id" = o."install_id" AND s."event_name" = 'task_first_success'
WHERE o."opt_in" = true
  AND s."ts" > i."ts"
  AND EXTRACT(EPOCH FROM (s."ts" - i."ts")) <= 86400;
```

24h 激活率、模板转化率在阶段2由同一 `funnel_events` 按 `event_name` 分组派生；北极星按周对 `task_first_success` 事件 `COUNT(DISTINCT install_id)` 并关联产物事实。

---

## 5. 分阶段落地

### 阶段 1：最小可验证（纯派生，零业务改动）

§4.3 第一条 SQL 已落为脚本 `scripts/ttfv-proxy-report.mjs`（直接复用文档 SQL 的关键 token，漂移由 `--selftest` 哨针比对）。

可复制用法（CLI 接口）：

```bash
# 连库出报告：--dsn 优先，否则读 DATABASE_URL > DB_HOST/DB_PORT/DB_USERNAME/DB_PASSWORD/DB_DATABASE
node scripts/ttfv-proxy-report.mjs --report --dsn "$DSN" --window-days 30 --json
# 也可只用环境变量连库，或用 --since ISO 替代 --window-days（二者任选其一）
node scripts/ttfv-proxy-report.mjs --report --since 2026-10-22T00:00:00Z
# 自检（不连库）：夹具中位数语义复刻 + 文档 SQL 关键 token 漂移哨针
node scripts/ttfv-proxy-report.mjs --selftest
```

输出字段：`ttfv_proxy_minutes`（中位数分钟）、`sample_size`（样本量）。脚本随输出打印口径警告：`⚠️ 非产品口径：TTFV_proxy，无 install_id / opt-in 维度，仅验证计算链路`；`sample_size < 5` 时追加 `样本量小，中位数无统计意义`。口径细节见 §1.2 表格与 §6 风险，此处不重复。

- 可验收指标：**TTFV_proxy 中位数**（代理口径）+ **模板→成功转化率**（按命名/来源近似）。
- 验收标准：`node scripts/ttfv-proxy-report.mjs --selftest` 退出码 0（含漂移哨针：文档 SQL 关键 token 与脚本内置 SQL 比对）；连库 `--report` 输出的 `ttfv_proxy_minutes` / `sample_size` 在固定 seed 上稳定。连库真跑需可用 PG，无库时仅达到 selftest 级别，不声称完成连库验收。
- 级别：静态探查 + 只读查询；**不声称**真实漏斗已可运营。

### 阶段 2：完整埋点（新增表 + 4 个触发点写事件）

- 动作：建 `funnel_events` / `telemetry_optin` 与 `system_config` 开关；在 §2.2 四个真实触发点写事件（复用 `transitionToTerminal` winner 语义保证首个成功只发一次）。
- 可验收指标：真实 **TTFV 中位数**、**24h 激活率**、**模板→成功转化率**（带 `template_key`）。
- 验收标准：进程内集成断言事件行落库、`dedupe_key` 去重生效、opt-in=false 时零事件；不得用"接口返回 200"代替副作用断言。

### 阶段 3：校准与运营（看板 / 样本质量）

- 动作：接 demo 脚本采集通道；加样本质量校验（排除规则生效、install_id 跨端冲突告警）；北极星周聚合。
- 可验收指标：**demo 完成率**、四指标看板、北极星周聚合可复算。
- 验收标准：浏览器/真机验证用户路径可达；跨端 install 归因结论书面化（当前未验证）。

---

## 6. 风险与不做

- **缺真实 install_completed 埋点**：阶段1只能给代理口径；"安装→首成功"的产品 TTFV 在阶段2前**无法计算**，不以代理口径冒充达标。
- **跨端 install 事件难采**：Web 无"安装"概念，桌面/headless 以 register/指纹代理；统一 install_id **未验证 / 需真机**。
- **opt-in 样本稀疏**：样本量小时中位数无统计意义，须同时报 `sample_size`，不做"≤10 分钟已达标"的结论。
- **模板来源字段不确定**：`task-template.service.instantiate` 走 `taskService.create`，CodeGraph 未见显式 `template_key` 落库；阶段1按近似、阶段2在事件里显式记录——该字段是否存在稳定列需实施方二次核实（**未验证**）。
- **demo 口径分散**：多个 demo 脚本完成判据不同，逐一确认前不合并统计。
- **不做的**：不改业务代码、不引入第三方 telemetry 依赖、不采集凭据/日志正文、不把 `MetricsService` 改造成漏斗表、不在本轮做现值加密（ADR-028 已接受的边界）。

## 7. 触发点接入决策（R307 · PM 拍板，2026-11-21）

> 本节把「4 个触发点怎么接」从模糊问题变成可执行规格。背景：R302–R306 已落地 funnel_events 表、90 天清理、HMAC 匿名 ID、opt-in 双闸、闸门接入写入口（单一不可绕过），但 `FunnelEventsService.record` 仍无生产调用方。

### 7.1 install_id 语义统一（关键决策）

**决策：install_id 统一为 executor 稳定设备指纹的 HMAC 派生**（§2.2.1 / §3.2 口径，复用 R304 的 `SecretsCryptoService.deriveAnonymousId(fp, "ttfv-install")`）。

依据（R307 独立复核后逐字修正的行号）：
- **register 携带指纹**：指纹入站校验在 `executor.service.ts:2488`（`registerReport.assertValidIdentityFields`），规范化在 `:2506`（`normalizeDeviceFingerprint(data.deviceFingerprint)`，作行定位键）；参数声明 `:2456`。*（初稿误写 :398——那是心跳列名白名单，已据复核纠正）*
- **执行回调携带指纹**：`execution-callback.controller.ts:182`（注释）/:223（`resolveExecutorIdByFingerprint(item.deviceFingerprint)` 实际解析）；DTO 可选字段见 `execution-callback.dto.ts:133-146`。
- **实例级随机 ID 不可用**：`execution-events-relay.service.ts:85` 的 `instanceId = randomBytes(12)` 进程级、重启即变（:84 注释明写"无需跨重启稳定"）。
- **user hash 无现成机制**，且用户是浏览器侧概念，与 executor 安装身份不同维。

⇒ TTFV 中位数两端（install_completed=register、task_first_success=终态事件）都可经指纹派生 install_id（task 侧需回查，见 §7.3）。浏览器登录/建任务拿不到 executor 指纹——**诚实不记该事件，不伪造 install_id**。

**落地状态提醒**：`deriveAnonymousId`（secret-crypto.util.service.ts:153）当前零生产调用方（仅 spec）——"复用派生"是设计意图，尚未接线。

### 7.2 触发点接入顺序与路径

按「TTFV 核心指标优先 + 链路可得性」排序（行号经 R307 复核修正）：

1. **`task_first_success`（分子端，最小起点）**：SUCCESS 判定在 `execution-callback.collaborator.ts:463-464`（`cb.status==="success" → patch.status=SUCCESS`）；终态 winner 在 `:575` `transitionToTerminal`（loser 在 `:582 if(!updated.affected) continue`）；终态事件 emit 在 `:742`。**因果准确性**：winner 保证「每 execution 恰好一次」，**不是每 task 一次**——同一 task 可因重试产生多 execution；task 级唯一靠 `dedupeKey` + DB 唯一索引 `uq_funnel_events_dedupe_key`（funnel-events.service.ts:34-36、`.orIgnore()` :77）保证。dedupeKey = `first-success:<task_id_hash>` 合理。
2. **`install_completed`（分母锚点）**：executor 首次 register。⚠️ 同指纹并发首注册下两行是"已接受的过渡态"（`executor.entity.ts:47-53` 索引刻意非唯一）；`min(createdAt)` 取行策略需明确（取最早行、后续复用），否则分母重复/漂移。**仓库无 EXECUTOR_REGISTERED 现成事件**——需新增事件或在 register 尾部直连写 funnel。
3. **`login_success` / `task_created`**：浏览器上下文无 executor 指纹，install_id 不可得 ⇒ **阶段2 暂不接**。

### 7.3 跨模块接入方案（R307 复核修正）

已知：`AgentModule` forwardRef 依赖 `TaskModule`（agent.module.ts:97），反向 task.module 未 import agent——当前单向。若 task 直接注入 agent 的 FunnelEventsService 会双向。**另注意**：`FunnelEventsService`/`TelemetryOptinService` 均在 agent.module providers 但**不在 exports**（:150-156），外部注入需先导出。

**推荐：领域事件驱动（SUCCESS 事件已确认存在）**——`execution.completed`（`domain-events.ts:38`，emit 于 `task.service.ts:4838-4843`，winner 调用点 collaborator.ts:742，relay 已覆盖 COMPLETED/FAILED/KILLED @ execution-events-relay.service.ts:66-70）。现成消费者：outbound-event-dispatcher.service.ts:158、metrics/executions-stream.controller.ts:128。agent 模块新增 listener 订阅即可，task 模块零改动。

**三个必须处理的约束（初稿遗漏，R307 补）**：
- **终态载荷无指纹**：`ExecutionTerminalEventPayload`（domain-events.ts:173-211）只有 executionId/taskId/taskName/status/durationMs/finishedAt，**无 deviceFingerprint/executorId/install_id**。listener 必须按 executionId 回查 execution→executor.deviceFingerprint 再派生；或扩 payload（影响面更大）。注意 `fingerprintExecutorIdByExecution`（execution-callback.controller.ts:198/220）是回调内临时 Map，不可复用。
- **viaRelay 去重契约**：产生副作用的订阅方必须 `if (event.viaRelay) return`（domain-events.ts:210，notification listener 已 skip @ execution-events.listener.ts:86），否则多副本双写。且 notification 刻意不订阅 SUCCESS（:76-78）——**不能拿它当 SUCCESS 消费载体，须新增 funnel listener**。
- **install_completed 无现成事件**：见 §7.2 第 2 条。

备选 TelemetryModule（迁移 2 service + 2 entity + 改 3 处 imports/exports）改动面未必比事件方案小很多——事件方案 SUCCESS 侧需 1 listener + 指纹回查，install 侧仍需新事件；两者差距有限，按载荷回查复杂度再定。

### 7.4 授权入口（端到端闭环缺口，前置）

`grant/revoke`（telemetry-optin.service.ts:65/86）生产零调用、仅 spec，**无 API 端点**——用户无法 opt-in ⇒ 闸门恒 false ⇒ 触发点接了也无事件。必须补：config controller（ADMIN + `@CurrentUser`，范式见 config.controller.ts:170-217/:338-373）加 `POST /config/telemetry/consent`。**接线要求**：export TelemetryOptinService 并补 module imports（config.module.ts 当前只 forFeature SystemConfig/ConfigHistory）。

**三个 R307 补充的定义缺口**：① install_id 的 HMAC 派生责任方（谁调 deriveAnonymousId 写入 opt-in 表）无生产实现；② **维度错配**——授权键只有 installId（executor 设备身份），userIdHash 是浏览器用户概念，一个 install 可被多用户共享，须明确"授权主体是安装而非用户"，降级 userIdHash 语义；③ 系统总闸 `telemetry.ttfv.enabled` 缺键即 false（isOptedIn :44-53），还需定义该 key 的置位路径，否则授权端点也打不开闸门。

### 7.5 明确的未决项

- 北极星「被业务确认」判据：产物/证据可 SUCCESS+artifacts 近似，"业务确认"无字段，待独立拍板。
- 跨端 install 真机验证：register ≠ 用户"安装完成"，三形态语义差异——阶段2 以 register 为代理，真机校准留阶段3。

### 7.6 下一轮实施最小起点（R307 复核结论）

1. **`task_first_success`**：agent 模块新增 listener 订阅 `DOMAIN_EVENTS.EXECUTION_COMPLETED`，`if(event.viaRelay) return`，按 executionId 回查 executor.deviceFingerprint → `deriveAnonymousId(fp,"ttfv-install")`/`deriveAnonymousId(taskId,"ttfv-task")` → `funnelEvents.record({dedupeKey:"first-success:"+taskIdHash, ts:finishedAt})`。零新增事件、零跨模块注入。
2. **`install_completed`**：register 尾部 emit 新事件（或注入 export 后的 FunnelEventsService），ts 取该行 createdAt，明确同指纹竞态取 min(createdAt) 行。
3. **授权闭环**：config controller POST consent + export/接线 + 定义 HMAC 派生责任方与总闸置位路径。

### 7.7 R318：消除 §1.2 激活率近似（task_first_attempted）

R313 的 `scripts/ttfv-real-metrics.mjs` 因缺「首次触发执行」事件，用
`task_first_success`（首次**成功**终态）代理 §1.2 激活率分子，触发后失败者
被算未激活 ⇒ 低估。阶段2 后续（本轮 R318）已消除该近似：

- 新增漏斗事件 `task_first_attempted`：listener 同时订阅
  `DOMAIN_EVENTS.EXECUTION_COMPLETED`（success）、
  `DOMAIN_EVENTS.EXECUTION_FAILED`（failed/timeout）、
  `DOMAIN_EVENTS.EXECUTION_KILLED`（管理员 kill，独立事件不经 FAILED）——
  三个终态覆盖全部首次触发，同一 handler 谁先到谁写；回查 execution 后显式排除 `synthetic = true`（与 §1.2 通用
  排除规则、R291 代理口径一致），`dedupeKey = first-attempted:<task_id_hash>`
  由 `.orIgnore()` 保证每 task 只落一条；`viaRelay` 跳过，全程 fail-open。
- 指标脚本口径同步：`AUTHORITATIVE_SQL` 的 `activated` CTE 改读
  `event_name = 'task_first_attempted'`；`first_success` CTE 保留，仅供 TTFV
  中位数（§4.3 基础 SQL 口径不变）。输出字段 `ttfv_minutes / activation_24h /
  sample_size` 不变，`ACTIVATION_APPROX_WARNING` 已删除，warnings 只剩 opt-in
  样本与小样本须知。
- 验收锚点：selftest 新增「触发后失败（只有 `task_first_attempted`）也算激活」
  夹具，并断言 warnings 含 opt-in/小样本、无近似/低估标注；文档 §4.3 SQL
  基础 token 哨针保持 10/10（增强 token 增 `task_first_attempted` 后 9/9）。

---
## 附：需主 agent 裁决 / 越域的遗留项

1. **docs 孤儿登记**：`check-docs.mjs` 的 `ENTRY_POINTS` 为 `docs/README.md` / `README.md` / `docs/atlas/README.md`，`ORPHAN_EXEMPT` 仅 `docs/archive/`。本文 `docs/plan/ttfv-funnel-instrumentation.md` 未被任一入口链接，会被判孤儿。修复需在 `docs/README.md` 挂链——**该文件不在本切片写域**，请主 agent 裁决或派发。
2. **北极星"业务确认"判据**：产物/证据可由 SUCCESS + artifacts 近似，"被业务确认"无现成字段，需 PM 给判据后再定埋点。
3. **retention 天数（90 天）与 install_id 映射存储**为方案建议值，需合规/PM 拍板。
