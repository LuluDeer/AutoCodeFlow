# 北极星「被业务确认」判据 —— PM 拍板方案（R324）

> **受众**：PM / 实施方 agent / 集成验收方。
> **状态**：内部 · **最后核对**：2026-11-21
> 固化 PM 对北极星第三要件「被业务确认」的拍板判据与可执行方案；不重定义北极星口径本身，不改生产代码。文中每个「文件:行」均经 CodeGraph 1.6.2 静态核实。

---

## 1. 决策摘要

**一句话裁决（2026-11-21，PM 拍板）**：采纳严格判据 **D** —— 新增显式漏斗事件 `business_confirmed`，作为「被业务确认」的唯一直接表达；计数单位为「每次执行被显式确认一次」，`dedupeKey = confirmed:<execution_id_hash>`，按周 × 活跃实例聚合。产物/证据继续以口径 A（SUCCESS + artifacts）作**过渡期近似值**，两者不混用、不互相替代。

本方案是产品决策文档，只固化为可执行规格；端点、领域事件、listener、指标脚本的实施与验收留后续切片（§6 给出逐步清单与验收级别）。

## 2. 问题与三要件拆解

北极星原文（[ROADMAP 指标段](../ROADMAP.md) 第 126 行，逐字引用，**本方案不改其口径**）：

> **北极星**：每周产生「业务结果」的自动化运行数（有产物 / 有证据 / 被业务确认），按活跃实例统计。

三个要件在代码里的可落地性完全不同：

| 要件 | 可落地性 | 现状载体 |
|---|---|---|
| 有产物 | **可直接近似** | `task_executions.artifacts`（`apps/admin-api/src/modules/task/entities/task-execution.entity.ts:411-412`）+ 同步索引表 `apps/admin-api/src/modules/artifacts/entities/execution-artifact.entity.ts` |
| 有证据 | **可直接近似** | `task_executions.result`（同上 `:327`）、`status = SUCCESS`（枚举见 `:28`，落库列见 `:263`）；终态 winner 写入 `apps/admin-api/src/modules/task/execution-callback.collaborator.ts:463-465`（SUCCESS patch）、`:575-580`（`transitionToTerminal`，`:582` 为重复回调 loser 分支） |
| 被业务确认 | **无字段、无事件，不可直接观测** | 全仓无「业务确认」字段/事件；最接近的是下载审计 `apps/admin-api/src/modules/artifacts/artifacts.controller.ts:255-263`（`audit_logs.action = 'artifact.download'`） |

这个缺口在 30+ 轮 handoff 与方案中反复标注「待 PM 拍板」：见 [TTFV 埋点方案](ttfv-funnel-instrumentation.md) §7.5（第 294 行）与附录遗留项第 2 条（第 329 行），以及 `docs/AGENT_HANDOFF.md` 顶部各轮「剩余方向」。本轮把它从「待拍板」变成「已拍板可执行」。

## 3. 候选判据穷举（A–H 表 + 分级）

分级：**直接** = 语义就是「业务确认」；**近似** = 有信号但不等价；**弱近似/误导** = 信号来自机器动作，与业务采纳无关；**不可得** = 全仓无现成载体。

| 代号 | 候选判据 | 直接性 | 现状载体 / 关键行 | 裁决 |
|---|---|---|---|---|
| A | SUCCESS 且 `artifacts` 非空（有产物/有证据） | 近似 | `task-execution.entity.ts:411-412` | 过渡期近似值 |
| B | `result` 非空即视为确认 | 弱近似/误导 | `task-execution.entity.ts:327` | **否决**（§4） |
| C | `artifact.download` 审计冒充确认 | 弱近似/误导 | `artifacts.controller.ts:255-263` | **否决**（§4） |
| D | 显式漏斗事件 `business_confirmed` | **直接** | `funnel-event.entity.ts:20-62`（裸 varchar eventName，零 DDL） | **采纳（严格口径）** |
| E | 外部系统回执（业务侧 webhook / 回调回执） | 直接但不可得 | 全仓无「业务确认回执」专用载体 | 后续切片保留，当前不采纳 |
| F | `depsFiredAt`（下游扇出已完成）当确认 | 弱近似/误导 | `task-execution.entity.ts:441-445` | 否决（机器调度语义） |
| G | `event_outbox.dispatchedAt` / 通知送达当确认 | 弱近似/误导 | `event-subscriptions` 派发回写 | 否决（消息投递语义） |
| H | 通用 `feedback` / `rating` / `accept-result` 交互当确认 | 直接但不可得 | 全仓无此类交互（调研结论） | **否决**（§4） |

## 4. 反证与为何否决 C / B / H

**否决 C（下载审计冒充确认）**——三条硬理由，正对应「三要件不能靠 ADMIN 下载审计顶替」：

1. **漏普通用户**：下载端点自 A-2 起收紧 `@Roles(ADMIN)`（`artifacts.controller.ts:59` 注释），只有管理员能下载；真实「业务确认」可能来自普通用户或业务系统，用 C 会系统性漏计且样本严重偏斜。
2. **合规冲突**：审计 `audit_logs` 记 `username` 原文、保留 180 天（`apps/admin-api/src/modules/audit/audit.service.ts:153` 注释），而漏斗纪律是「只落哈希、不记身份」（TTFV 方案 §3.2/§3.3）且 TTL 90 天；把 C 当确认会把带身份的长留存审计语义偷渡进匿名短留存漏斗，两套管不对齐。
3. **下载 ≠ 采纳**：取走文件只说明「感兴趣」，不代表结果被业务采用；且与 opt-in 双闸无关（下载不经 opt-in，见 `artifacts.controller.ts:255-263`），用它当确认会绕过隐私闸门。

**否决 B（`result` 非空当确认）**：`result` 是执行器上报的机器输出（`task-execution.entity.ts:327`），任何成功执行都可能非空；它衡量「任务跑出了东西」，不衡量「人/业务接受了结果」，与要件 A 高度重合却更弱——等于把「有证据」改名为「被确认」，是口径造假。

**否决 H（通用反馈/评分交互当确认）**：全仓无 `feedback` / `rating` / `accept-result` 交互，无现成载体；新建通用反馈系统超出本切片，且「评分」语义宽于「采纳」（打分可能很低）。相较之下 D 是最小充分实现：一个轻量确认端点 + 一条漏斗事件即可直接表达「被确认」。

**附带否决 F / G**：`depsFiredAt`（`:441-445`）是下游任务扇出成功的机器调度标记，`dispatchedAt` 是通知投递标记——两者都与「业务是否采纳结果」无因果关系，作为确认判据会引入系统性误计。

## 5. 拍板判据精确定义

**事件**：新增漏斗事件名 `business_confirmed`。`funnel_events.event_name` 是裸 `varchar(64)`、无枚举校验（`apps/admin-api/src/modules/agent/entities/funnel-event.entity.ts:31-32`），因此**零 DDL**；写入闸门仍收口在 `FunnelEventsService.record`（`apps/admin-api/src/modules/agent/runtime/funnel-events.service.ts:46-70`，opt-in 双闸 fail-closed 见 `:52-60`，dedupe 靠唯一索引 `uq_funnel_events_dedupe_key` 见 `:34-36`）。

**字段**（复用现有漏斗表列，见 `funnel-event.entity.ts:20-62`）：只写匿名 HMAC ID（`install_id` / `task_id_hash` / `execution_id_hash`）、`event_name = 'business_confirmed'`、`ts`（确认发生的真实时间）、`dedupe_key`。不写操作者身份、指纹原文、用户名。

**dedupeKey**：`confirmed:<execution_id_hash>`（`<execution_id_hash>` 复用现有 hash 语义 `deriveAnonymousId(executionId, "ttfv-execution")`，不带明文）⇒ 每次执行最多落一条确认事件，即「每次执行被显式确认一次」。

**计数单位与周聚合**：按周 `date_trunc('week', ts)` 聚合，`ts` 取确认发生的真实时间（不是入库 `createdAt`）；`:as_of` 是查询侧观测截止参数。每周输出两个量：`active_installs = COUNT(DISTINCT install_id)`（该周有确认行为的活跃实例数，对应北极星「按活跃实例统计」）与 `confirmed_events = COUNT(DISTINCT dedupe_key)`（该周被显式确认的执行数，`dedupe_key` 幂等去重，对应「每次执行被显式确认一次」）。严格口径 SQL（本块是侧车脚本 `BUSINESS_CONFIRMED_SQL` 的语义事实源，须与其保持同构，见 §6）：

```sql
-- 严格值：按周统计「被业务确认」的执行（北极星口径）。
-- active_installs = 周内去重活跃实例；confirmed_events = 周内去重确认事件（dedupe_key 幂等）。
SELECT
  date_trunc('week', ts) AS week_start,
  COUNT(DISTINCT install_id) AS active_installs,
  COUNT(DISTINCT dedupe_key) AS confirmed_events
FROM funnel_events
WHERE event_name = 'business_confirmed'
  AND dedupe_key LIKE 'confirmed:%'
  AND ts <= :as_of
GROUP BY 1
ORDER BY 1;
```

`dedupe_key LIKE 'confirmed:%'` 这一过滤把 `business_confirmed` 事件与其他漏斗事件（如 `task_first_success`、`task_first_attempted`）在物理层隔开，保证口径不被污染。漏斗表无 `synthetic` 列（写入端 opt-in 双闸已收口，见 §7），故严格值不按合成行过滤；过渡期近似值的 `synthetic = false` 排除见 §8。

**写入链路**：显式端点 emit 领域事件 → 新增 listener 复用 success listener 的回查链写 `funnel_events`（回查 execution → executor.deviceFingerprint → `deriveAnonymousId(fp, "ttfv-install")`，见 `apps/admin-api/src/modules/agent/runtime/funnel-success.listener.ts:66-102`，真库 e2e 见 `apps/admin-api/test/funnel-listener.e2e-spec.ts`）。`viaRelay` 跳过、`synthetic = true` 排除、fail-open 语义与现有三个 listener 对齐。

## 6. 实施步骤（后续切片清单，本轮不实施）

| # | 步骤 | 关键约束 | 验收级别 |
|---|---|---|---|
| 1 | 新增显式端点 `POST /agent/executions/:execId/confirm` | 幂等；ADMIN 或授权用户（复用现有鉴权，不自定义角色）；业务可用性优先（§7） | 单测 / 内存替身 + 真实进程内集成（并发确认同一 execution 只落一条幂等 + 端点业务可用性不受 telemetry 授权影响，仿 `funnel-listener.e2e-spec.ts`） |
| 2 | emit 领域事件（新事件名） | 载荷只传 `executionId` / `taskId` / 确认时间；**不传指纹、不传用户名** | 单测 / 内存替身 |
| 3 | 新增 `business_confirmed` funnel listener | 复用 `funnel-success.listener.ts:66-102` 回查链；`viaRelay` skip、`synthetic` 排除、fail-open、单一 opt-in 闸门 | 真实进程内集成（仿 `funnel-listener.e2e-spec.ts` 真库 e2e） |
| 4 | 指标脚本按 §5 SQL 做周聚合 | 漂移哨针以 §5 首个 `sql` 块为事实源；由并行切片 northstar-metrics-script 落地 | 静态 / 哨针对账 |
| 5 | 双口径看板（§8） | 近似值与严格值并列、显式标注、不混用 | 浏览器 / 真机 |

侧车指标脚本的漂移哨针 `checkDrift()` 以本节标题后的第一个 `sql` 代码块为**语义事实源**：去掉 `--` 注释、归一空白后，与脚本内置 `BUSINESS_CONFIRMED_SQL` 做**全串逐字相等**比对（主判据，能抓出 `GROUP BY` 列 / `COUNT` 列 / `as_of` 等 token 存在但语义分叉的情况）；另保留 4 个基础 token（`business_confirmed` / `date_trunc('week'` / `COUNT(DISTINCT install_id)` / `confirmed:`）存在性检查作快速定位，代理 SQL 另有 7 条约束自检。改动本 SQL 须同步脚本内置 SQL，否则哨针 exit 2 并点名首处差异。代理口径 SQL（§8）以脚本内置 7 条约束自检为判据，不依赖文档独立 sql 块。

## 7. 隐私与合规

- **最小落库**：只落匿名 HMAC ID + 事件名 + 时间；不记操作者身份（谁点的确认不进漏斗）、不记指纹原文、不记用户名。与 TTFV 方案 §3.2/§3.3 的「只记结构化字段与哈希，不记值」同一纪律。
- **受既有闸门约束**：严格值事件受 opt-in 双闸（系统总闸 + 实例授权，`funnel-events.service.ts:52-60`）与 90 天 TTL 约束；未授权 install 的确认不写漏斗事件，授权前的确认不追溯补采。
- **业务可用性与遥测解耦（PM 明确）**：确认端点**自身不因 telemetry 未授权而拒绝业务动作**——确认动作照常返回成功，只是不写漏斗事件。`FunnelEventsService.record` 的 fail-closed 只作用于漏斗写入（未授权返回 `{ recorded: false, reason: "not_opted_in" }`，见 `:58-60`），不影响端点对业务确认的成功语义；listener 全程 fail-open，遥测失败绝不回灌主链。

## 8. 过渡期双口径与升主条件

看板同时展示两列，**不混用、不互相替代**：

| 口径 | 定义 | 标注 |
|---|---|---|
| 业务结果近似值（口径 A） | `status = SUCCESS` 且 `artifacts` 非空（有产物/有证据） | 必须标注「有产物/有证据 ≠ 被业务确认」；`synthetic = false` 排除；按 task 维度，无 install_id 维度（与 TTFV_proxy 一致） |
| 严格值（口径 D） | `business_confirmed` 漏斗事件，按 §5 聚合 | 只覆盖 opt-in 安装（opt-in 约束的直接后果） |

**升主条件（阈值已于 R448 由 PM 拍板，不再悬置）**：显式确认端点上线并积累样本后，严格值升为主口径、近似值降为参考。**两个数值阈值（脚本 `promotionEligibility` 自动判定，AND 关系）**：

1. **样本期 ≥ 4 个完整周**（`business_confirmed.weeks.length ≥ 4`）——月度观察窗抹平单周波动，对齐 ROADMAP「W4 留存 ≥40%」的观察口径。
2. **sample_size ≥ 20**（`business_confirmed.totals.active_install_weeks ≥ 20`，即 4 周内活跃 install 周合计）——统计意义下限；> 既有 `SMALL_SAMPLE`（`sample_size < 5`）守卫阈值，取更严者。用 install 而非确认事件数，因北极星按活跃实例统计。

**第三个条件（opt-in 覆盖率）不在脚本判**：脚本只有 opt-in 安装数据、拿不到全量 install 分母，强行算会假精。它是**运营前置**——由 `GET /agent/telemetry/status` 的 `coverage='full'` 且 `count>0` 保证授权完整。脚本 `promotionEligibility.reasons` 始终带此提示（明标「脚本不验证」），避免运营把 `eligible=true` 误当成可直接升主。

**当前生效口径**：两列保持并列，避免「用近似值冒充达标」；仅当上述两数值阈值满足 **且** 运营确认 coverage=full 时，才把严格值升为主口径。`eligible=false` 时看板仍双列，脚本输出的 `reasons` 逐条说明差在哪。

## 9. 风险与回退

| 风险 | 缓解 |
|---|---|
| 严格值样本稀疏，早期波动大 | 双口径过渡（§8）；近似值保底，不据此下达标结论 |
| 端点被滥用（任意 ADMIN 可确认任意 execution） | 复用现有鉴权；端点调用本身走业务审计（不进漏斗、不记身份进漏斗事件） |
| 确认与遥测授权耦合导致业务受阻 | 业务可用性/遥测解耦（§7），未授权时照常返回成功 |
| 口径漂移（脚本 SQL 与文档分叉） | §5 SQL 漂移哨针对账（§6 步骤 4） |

**回退**：漏斗事件 append-only，关闭严格值面板即可回到近似值口径，无需删数据；端点可加开关独立下线，不影响既有 TTFV 漏斗与执行主链。本轮纯文档，无生产改动可回退。

## 10. 需后续切片裁决的点

**仍未决（依赖外部条件，当前不推进）**：

1. **授权范围**：除 ADMIN 外哪些角色/主体可调用确认端点（普通用户？业务系统服务账号？）。需真实的多角色使用需求驱动。
2. **业务落点**：「被确认」是否需要在 execution 业务侧留痕（如 `confirmedAt` 字段）；涉生产 DDL，需真实需求证明匿名漏斗事件不够。
3. **外部回执（候选 E）**：是否纳入、回执可信度与幂等如何校验。需外部系统对接需求。
4. ~~升主量化阈值~~ **已裁决（R448，移至此）**：样本期 ≥4 周 + `active_install_weeks ≥ 20`（脚本 `promotionEligibility` 自动判）；opt-in 覆盖率作为运营前置（coverage=full），不在脚本判。详见 §8。此前"需生产样本"的判断混淆了「定阈值」（产品决策，已做）与「判断是否满足」（脚本计算，已做）。

**已闭环（R325–R441，勿重复列为待办）**：

- ~~实施切片~~：§6 步骤 1–3 已在 R325（确认端点+事件+listener，真库 e2e）、R326（真库对账）、R327（数据 API）落地；双口径看板 UI 在 R328 落地；均达真实进程内集成级。
- ~~钩子收尾~~：本文档早已在 [docs 索引](../README.md) §2.6 挂链，orphan 守卫持续绿。
- 后续加固：R329–R330（生产启用断点 + B3 指纹拦截）、R431（确认端点入参收口）、R432（健康自检）、R436–R438（真浏览器+真后端四级顶层覆盖）、R439–R441（CI 防复发 + 命令序列/`:prod` 路径真机复演）。详见 [项目状态总览](../PROJECT-STATUS.md)。
