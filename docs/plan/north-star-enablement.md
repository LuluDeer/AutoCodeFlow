# 北极星 / TTFV「生产启用」Runbook（R329）

> **受众**：负责在生产启用北极星看板与 TTFV 漏斗的实施方 / 运维 · **状态**：发布前置 · **最后核对**：2026-11-21
> 本文只讲**怎么把已发布的代码启用起来**，不改生产代码。发布清单 / 部署 / 升级 / 快速上手四篇只给指针，完整口径以本文为准。
> 文中每个「文件:行」均经 CodeGraph 1.6.2 静态核实；`docs/plan/ttfv-funnel-instrumentation.md` §4.3 SQL 块是漂移哨针的事实源，本文不复制其 SQL。

---

## 0. 为什么需要这篇 runbook（发布前置）

代码里的遥测是 **opt-in 双闸 + fail-closed**：不授权就零采集（写入闸门 `funnel-events.service.ts:49-60`，授权判定 `telemetry-optin.service.ts:43`）。三件事同时缺失时，按旧清单发布完**看板必然全空，且没有任何一步会报错提示**：

1. 生产库没跑 `0101` / `0102` 迁移 → `funnel_events` / `telemetry_optin` 两表不存在 → 漏斗写入与 status 读取都失败；
2. `SEC_SECRETS_KEY` 为空 → 授权端点抛 503、listener 静默跳过（见 §1.2）；
3. 没有带 `deviceFingerprint` 的执行器 → 即便开了总闸也授权不到任何实例（`coverage=no_executors`）。

因此本节是**发布前置勾选项**（已挂进 [release-checklist.md](../release-checklist.md)），不是发版后的可选优化。

---

## 1. 启用前置清单（三项，缺一不可，按顺序）

### 1.1 ① 生产迁移：`0101` / `0102` 必须真正落库

```bash
docker compose exec admin-api npm run migration:run:prod
```

- `:prod` 入口是硬性要求：容器镜像无 ts-node（`release-checklist.md:82-90`、脚本定义 `apps/admin-api/package.json:31` 的 `migration:run:prod = node dist/migration-lock-cli.js up`）。
- 本次启用依赖两条迁移：
  - `1790000000101-AddFunnelEvents.ts:39` 建 `funnel_events`（`:41` 指纹列名改为 `install_id`、`:56` 唯一索引 `uq_funnel_events_dedupe_key`）；
  - `1790000000102-AddTelemetryOptin.ts:36` 建 `telemetry_optin`（`:48` 唯一索引 `uq_telemetry_optin_install_id`）。
- **验证**（迁移账本 + 两张表都要核对，日志「跑过了」不算）：

<!-- metric-docs:ignore-unknown 下面的 autoflow 是 PostgreSQL 数据库名与 TypeORM 账本表，不是指标名 -->

```sql
-- 连到 autoflow 库（连接串按现场 DB_* 填写，库名 DB_NAME=autoflow）
-- 账本：两条迁移各 1 行
SELECT name FROM migrations
 WHERE name IN ('AddFunnelEvents1790000000101','AddTelemetryOptin1790000000102')
 ORDER BY name;
-- 期望 2 行，缺任一行即未落库。
-- 表：两张都要存在
SELECT tablename FROM pg_tables
 WHERE schemaname='public' AND tablename IN ('funnel_events','telemetry_optin')
 ORDER BY tablename;
-- 期望 2 行。
```

- ⚠️ **`migrationsRun=false` 不自愈**（`configuration.ts:939`、`main.ts:156-168`、`migration-runner.util.ts:7`：自动迁移已关闭，改由带 `pg_advisory_lock` 的显式入口执行）。旧实例部署后不会自动补跑这两条迁移——**必须人工执行上条命令并核对账本**，否则两表永远不存在。

### 1.2 ② `SEC_SECRETS_KEY`：非空 32 字节 hex

```bash
openssl rand -hex 32   # 生成 32 字节 hex，写进 admin-api 的 .env
```

- 现状：`docs/deployment.md:215` 只把 `SEC_SECRETS_KEY` 描述为「任务级 secrets 落库加密密钥」；但它同时是**匿名 install_id 的 HMAC 派生密钥**——`secret-crypto.util.service.ts:153-159` 的 `deriveAnonymousId(input, purpose)` 复用 `secrets.key` 做 HMAC-SHA256、取前 16 字节（32 hex）。
- **空密钥的两个静默故障**（启用前必须排除）：
  - 授权端点 `POST /agent/telemetry/consent`：`agent.controller.ts:993-999` 对 `userIdHash` 派生失败直接抛 `DEPENDENCY_UNAVAILABLE`（映射 503，`app-error.ts:71`）；`:953-960` 对 install 派生失败同样抛 503——**空 key 时 UI 点授权会看到 503**；
  - listener：`funnel-success.listener.ts:80-85`、`funnel-confirmation.listener.ts:85-90` 在 `deriveAnonymousId` 返回 null 时 `if (!installId) return;` ——**静默跳过，无任何错误日志**，看板照旧空。
- 判定：`deriveAnonymousId` 在 key 为 null 时返回 null（`secret-crypto.util.service.ts:154`），即「无密钥不采集」，不是「用原始指纹顶替」。

### 1.3 ③ 至少一个带 `deviceFingerprint` 的执行器已注册

- 授权对象按 **executor 设备指纹**解析：`agent.controller.ts:941-951` 从不带显式指纹时遍历 `executors` 取 `deviceFingerprint`，再逐条 `deriveAnonymousId(fp, "ttfv-install")`（`:953-961`）；注册入口与指纹参数见 `executor.service.ts:2435` / `:2456`。
- **陷阱：先开闸、后装执行器**。总闸可以先打开，但此时没有任何已知指纹 → status 报 `coverage=no_executors`、授权数 0，漏斗依然空。正确顺序是**先确认执行器在线且带指纹，再走 §2 授权**。
- 核对：管理台「执行器 → 执行器列表」确认目标执行器在线；无指纹的存量执行器需重注册上报指纹后才可授权。

---

## 2. 启用步骤（管理员操作，二选一）

### 2.1 方式 A：管理员 UI（推荐）

路径：**系统设置 → TTFV 授权** Tab（`TelemetrySettings.tsx` 顶部注释 R311），打开开关后被 **Popconfirm 二次确认** 包裹（`TelemetrySettings.tsx:239-255`）——这是隐私写操作的刻意设计。

### 2.2 方式 B：等价 API

```bash
curl -X POST http://<admin>:3105/api/agent/telemetry/consent \
  -H "Authorization: Bearer <ADMIN_TOKEN>" -H 'Content-Type: application/json' \
  -d '{"optIn":true,"source":"admin-ui","deviceFingerprint":"<64位hex原始指纹>"}'
```

- 端点 `POST /agent/telemetry/consent`（`agent.controller.ts:974`，实现 `setTelemetryConsent` `:977-1045`）；`source` 仅收 `admin-ui` / `api`（`agent-telemetry.dto.ts:18-21`）。
- 传 `deviceFingerprint`：服务端用它派生匿名 install_id 精确授权（`agent.controller.ts:942-943,953-961`）；不传则对全部已知执行器指纹授权（`:944-951`）。
- 授权与开闸在同一事务语义里「先授权再开闸」（`:1008-1021`），撤销时「先关闸再撤销」（`:1022-1035`）。

> ⚠️ **不要传 `installId=<原始指纹>`**：`agent.controller.ts:936-939` 对显式 `installId` 是 `ids.add(dto.installId)` **原样落库、不派生 HMAC**。把它填成原始指纹会在 `telemetry_optin` 里写入一条明文指纹，而 listener 写漏斗时用的是 `deriveAnonymousId(fp,"ttfv-install")` 的哈希 ID（§1.2）——两者错配：授权行与漏斗事件永远对不上，看板仍空，且违反「只落匿名 ID」纪律。`installId` 只应传服务端已派生的匿名 ID（或从 status 回读），新授权一律用 `deviceFingerprint`。

---

## 3. 验证（启用是否真的生效）

### 3.1 授权状态：`GET /agent/telemetry/status`

```bash
curl -s http://<admin>:3105/api/agent/telemetry/status \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```

- 端点 `agent.controller.ts:1047`（`telemetryStatus`，`:1050-1132`），返回 `systemEnabled` / `count` / `latestOptedAt` / `installs`。
- **启用可观测字段（R329 已落地）**：`knownExecutorCount`（`agent-telemetry.dto.ts:118-119`，已知 executor 去重数）与 `coverage`（`:121-126`，枚举 `no_executors` / `partial` / `full` / `gate_off`）；服务端 telemetryStatus 已返回、UI 已消费。旧构建可能暂缺这两字段，UI 侧保留回落 `status?.knownExecutorCount ?? status?.installs.length ?? 0`（`TelemetrySettings.tsx:115-116`）。验收以**当前构建实际返回**为准。
  - `coverage='no_executors'`（总闸开 + 0 已知 executor）是「先开闸后装执行器」静默零采集陷阱的显式信号——此时 UI 常驻告警并提供「重新授权全部」按钮；装完执行器后必须显式重授权，系统**不会自动授权**新设备（opt-in 隐私原则）。
- **count=0 一律视为未启用，即使 `systemEnabled=true`**：总闸开但零授权是 `no_executors`（`TelemetrySettings.tsx:61-64` 的 `resolveCoverage`），对应「先开闸后装执行器」陷阱。必须 `coverage=full` 或至少 `partial` 且 `count>0` 才算接通。

### 3.2 出数：`GET /agent/north-star/metrics?as_of=`

```bash
curl -s "http://<admin>:3105/api/agent/north-star/metrics?as_of=2026-11-21T12:00:00.000Z" \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```

- 端点 `GET /agent/north-star/metrics`（`agent.controller.ts:1113`），载荷契约 `AgentNorthStarResponseDto`（`agent-north-star.dto.ts:70-88`）：`as_of` + 严格值 `business_confirmed` + 代理值 `business_results_proxy` + 强制 `warnings`。
- 触发一次真实业务动作（执行成功 / 显式业务确认 `POST /agent/executions/:execId/confirm`，`agent.controller.ts:1081`），再查该端点或看管理台北极星双口径卡片是否出数。
- **两列不混用**：`business_confirmed` 只覆盖 opt-in 安装，`business_results_proxy` 是 SUCCESS+有产物的过渡近似值，`warnings` 常驻提醒「有产物/有证据 ≠ 被业务确认」（口径裁决见 [north-star-business-confirmed.md](north-star-business-confirmed.md) §8）。

---

## 4. 隐私口径（对外承诺的四条）

1. **未授权零采集**：漏斗写入收口在 `FunnelEventsService.record` 的单一闸门，未授权返回 `{recorded:false,reason:"not_opted_in"}`（`funnel-events.service.ts:52-60`），闸门异常按未授权处理；对应方案 [ttfv-funnel-instrumentation.md](ttfv-funnel-instrumentation.md) §3.1 的双层开关。
2. **不自动授权新设备**：新注册的执行器不会自动纳入授权——需管理员按 §2 显式重授权（UI 有 R329 显式重授权入口 `TelemetrySettings.tsx:118-130`，不带 `installIds` 即对全部 executor 重授权）。
3. **只落匿名 HMAC ID**：`install_id` / `task_id_hash` / `execution_id_hash` 全部经 `deriveAnonymousId` 派生（`secret-crypto.util.service.ts:153-159`），原始指纹、用户名、任务参数不进漏斗表。
4. **90 天 TTL**：`funnel_events` append-only + 滚动清理，`FUNNEL_EVENT_RETENTION_DAYS = 90`（`funnel-events-retention.service.ts:11-12`）。

> 业务可用性/遥测解耦：未授权时确认端点照常返回业务成功，只是不写漏斗事件（[north-star-business-confirmed.md](north-star-business-confirmed.md) §7）。

---

## 5. 升级 / 排障

### 5.1 已发布实例追加执行器后如何重授权

新执行器注册后**不会**自动授权。管理员在「系统设置 → TTFV 授权」点显式**重新授权**（`TelemetrySettings.tsx:118-130`），或按 §2.2 用不带 `installId`、不带 `deviceFingerprint` 的 `{"optIn":true}` 调 consent——后端遍历全部 executor 指纹重新派生并授权（`agent.controller.ts:944-961`）。重授权后按 §3 复核 `coverage` 与 `count`。

### 5.2 `SEC_SECRETS_KEY` 变更的破坏性（务必先读）

`deriveAnonymousId` 把 `secrets.key` 当 HMAC 密钥（`secret-crypto.util.service.ts:155-158`）。**换 key = 换 HMAC 密钥**：

- 所有历史 `install_id` / `task_id_hash` / `execution_id_hash` 全部失效（同一输入派生出新值）；
- `telemetry_optin` 里的授权行按旧 install_id 存储 → 需**全部重新授权**（§5.1）；
- 旧漏斗数据的 install_id 口径与新数据断裂：看板按 install_id 聚合时，换 key 前后是两批互不相连的实例，历史周趋势不可与新品直接拼接。

处置：把 key 变更当**一次性口径断点**记录；换 key 后立即重授权并重验 §3。key 本身纳入密钥备份（`deployment.md:215`），丢失则密文 secrets 无法解密——与漏斗 ID 失效是同一把密钥的两面。

---

## 6. 故障表（症状 → 处置）

| 症状 / `coverage` | 根因 | 处置 |
|---|---|---|
| `gate_off` | 系统总闸 `telemetry.ttfv.enabled` 未置位 / 读失败。注意这是**未启用的正常态**：设置页此时不显示 `coverage` 告警（告警只在 `no_executors`/`partial` 出现），别误以为缺告警块是 bug | 按 §2 授权（授权端点同时开闸，`agent.controller.ts:1008-1021`）；确认系统配置写入成功 |
| 两表不存在 / status 500 / 漏斗零行 | `0101`/`0102` 未迁移，`migrationsRun=false` 不自愈 | 执行 §1.1 迁移命令，核对账本 2 行 + 两表存在 |
| 授权端点 503 / 日志无漏斗写入 | `SEC_SECRETS_KEY` 为空 | 生成并配置 32B hex（§1.2），重启 admin-api 后重授权 |
| `count=0`（即使 `systemEnabled=true`） | 零授权：`coverage=no_executors` 或空授权行 | 确认有带指纹的在线执行器（§1.3），按 §2 授权；不要停在「只开总闸」 |
| `no_executors` | 总闸开但无已知 executor 指纹 | 执行器带 `deviceFingerprint` 重注册，再按 §5.1 重授权 |
| `partial` | 部分执行器已授权 | 按 §5.1 对全部执行器重授权，目标 `full` |
| 授权成功但看板仍空 | ① `installId` 误传原始指纹致错配（§2.2）；② listener 静默跳过（空 key）；③ 数据未到 `as_of` | 用 `deviceFingerprint` 重授权；核对 key；调整 `as_of` 后按 §3.2 复查 |
| 换 key 后历史断档 | HMAC 密钥变更使旧 install_id 全失效（§5.2） | 记录口径断点、全部重授权，历史与新数据分开展示 |

---

## 7. 边界与验收级别

- 本文为**静态文档守卫**级别：所有 file:line 经 CodeGraph 逐字核实；迁移落库、key 生效、出数均需在目标环境按 §1/§3 实跑确认（真库副作用断言），本文不声称已完成生产启用。
- 写域边界：本文 + README 挂链 + 四篇发布文档的指针；**未触碰**任何生产代码 / spec / script / baseline、`AGENT_HANDOFF.md`、以及 `ttfv-funnel-instrumentation.md` §4.3 SQL 漂移哨针块。
- 验收命令：`node scripts/docs/check-docs.mjs`（含 orphan，本文须从 README 可达）、`node scripts/docs/check-doc-style.mjs`、`npm run test:docs`。
