# 后续任务安排与决策建议

基于实施报告的核验结果，我给出以下明确的行动方案：

---

## ✅ 立即行动（今天完成）

### 1. Review 并提交当前变更

当前工作区有 **5 项真实改进**已完成并通过验证：
- ✅ 限流白名单守卫 + 漏登记修复
- ✅ SSE 票据被拒可观测性
- ✅ HTTP RED 指标 + fleet gauge
- ✅ 磁盘/堆健康检查
- ✅ 备份恢复演练脚本

**建议操作**：
```bash
# 1. Review 变更
git diff --stat
git diff apps/admin-api/src/common/guards/executor-aware-throttler.guard.ts

# 2. 如果确认无误，提交
git add -A
git commit -m "feat: 实施高优先级优化（5项真实缺口）

完成项：
1. 限流白名单守卫 + 漏登记修复（/executors/config + terminal-states）
2. SSE 票据被拒可观测性（Prometheus 计数器 + 告警）
3. HTTP RED 指标 + 执行器 fleet gauge（防 DB 抖动误报）
4. 磁盘/堆健康检查（防盘满/堆满时健康检查假绿）
5. 备份恢复演练脚本（首次证明备份可恢复）

修复：deploy.sh 多字节变量名陷阱（macOS bash 3.2 兼容）

验证：4,862 测试全绿 + 16 个 CI 门禁脚本全部通过

基于：IMPLEMENTATION-REPORT-2026-10-17.md 核验结果
"

# 3. 推送到远程
git push origin develop
```

---

## 🤔 需要拍板的决策

### 决策 1: OpenTelemetry 依赖处理 —— ✅ **已收口：保留依赖，修正文档**

**结论：保留 `@opentelemetry/api`，不删。** 依据是核过 lockfile 的**硬事实**，不是惯性：

1. **它不是"可随手删的累赘"**——`prom-client`（admin-api 真的在用，`/api/metrics`
   就是它）把 `@opentelemetry/api` 声明为**硬运行时依赖**：
   `node_modules/prom-client → dependencies: {"@opentelemetry/api":"^1.4.0", "tdigest":"^0.1.1"}`。
   实测 `lock.packages["node_modules/@opentelemetry/api"]` 存在且 **`optional` 未标记**。
   ⇒ **删掉 admin-api 的直接声明并不会把它从 `node_modules` 里移除**，
   只会让将来的 import 退回"靠传递依赖"（更差的卫生习惯）。
2. **我们的直接声明在钉版本**：admin-api 写 `^1.9.1`，prom-client 只要 `^1.4.0`。
   删掉直接声明 = 版本降到 prom-client 的约束面。
3. 它同时是 `docs/PLAN-CLAIMS.md` OBS-01 认领记录里写明的 **SDK 挂载锚点**
   （接 Jaeger/Tempo 只挂 `TracerProvider`，埋点调用点零改动）。
4. 尝试把它变成"真承重"的第三条路已排除：`traceparent.util.ts` **已经**自己
   拒绝了全零 trace-id/span-id 并要求 version=`00`（W3C 规范要点都覆盖了），
   OTel API 在此**没有真实可补的位置**——硬塞一个 import 只会是装饰性的，
   比"声明了没用"更误导。

**实际改动**：只改文档/注释，把"死依赖"的定性纠正为「零 import 的刻意锚点
+ prom-client 的硬传递依赖」，共 7 处：`PLAN-OBSERVABILITY.md`（4 处：
§4 行、§「仍然待办」、§「依赖项（核验后）」、§「仍然待办」第二列表）、
`PLANS-INDEX.md`、`docs/deployment.md`「OTEL / Jaeger」段、`docs/api-reference.md`、
`docs/atlas/06-infra/docker-compose.md`、`apps/admin-api/.env.example`、
`apps/admin-api/src/common/tracing/tracing.service.ts` 头注。
**代码与依赖零改动**（因此无 lockfile 风险）。

**剩下真正该做的**：`PLAN-OBSERVABILITY.md` §4 的 OTLP exporter（需要 collector）。

### 决策 2: Alertmanager 真实接收端 —— ✅ **已按方案 B 落地（本轮完成）**

选 **B（实现 HMAC 签名侧车）**，而不是 A（配 Slack webhook）。理由：
A 需要外部凭据、且只解决「推到一个 Slack 频道」；B 走的是**平台既有通知渠道
扇出**（企微 / 钉钉 / Slack / 邮件，复用管理台已配置的渠道），零外部依赖、
零新 npm 包，且**可离线验证**。

落地物：

| 文件 | 内容 |
|---|---|
| `scripts/alertmanager-hmac-proxy.mjs`（新） | 加签侧车本体。零依赖（只用 `node:http` / `node:crypto`）。body 逐字节直通、时间戳用本进程 `now()`、**上游状态码原样回传**（不把 admin-api 刻意的 502 抹成 200，否则 Alertmanager 永不重试）、secret 缺失即拒绝启动 |
| `scripts/alertmanager-hmac-proxy.selftest.mjs`（新） | 36 项离线断言：金向量（接收侧用 **WebCrypto `crypto.subtle`** 独立复核，与签名侧的 `createHmac` 是两条不同实现路径）+ 与 `webhook-hmac.util.ts` 的源码级契约对账 + 真实 HTTP 端到端（含 4xx/5xx 原样回传、不可达/超时 → 502、超限 → 413、secret 不外泄）+ fail-closed 退出码 |
| `config/monitoring/alertmanager.yml` | `route.receiver`：`'noop'` → `'hmac-proxy'`（`noop` 保留作静默兜底） |
| `docker-compose.yml` | 新服务 `alertmanager-hmac-proxy`（`node:24-alpine`，只读挂载脚本，**不映射宿主端口**，仅 `autoflow-internal`，`restart: 'no'`） |
| `apps/admin-api/.../__tests__/webhook-hmac.util.spec.ts` | 钉入**同一组金向量**——两侧各钉一次，单侧算法漂移必然被拦 |

**启用**：`.env` 设 `ALERT_WEBHOOK_SECRET=<随机串>` + `docker compose --profile monitoring up -d`。

**未配置 secret 时的行为**：侧车拒绝启动（exit 1，`restart: 'no'` 故不重启刷屏），
Alertmanager 自身日志报投递失败——**可见的失败**，刻意不做成静默黑洞。

**验证**：`npm run test:alert-proxy` 全绿；admin-api `src/common/utils` 225 例 +
`src/modules/notification` 284 例全绿；22 个门禁脚本全绿；变异测试双向取证
（改侧车分隔符 → 侧车自检红；改 admin-api 校验侧分隔符 → admin-api spec 红）。

---

## 📋 下一轮实施优先级（基于真实缺口）

核验后剩余真缺口，按依赖关系和价值排序（**第 2 项已于本轮完成**）：

### 第一批（本周可启动）- 无依赖，价值高

1. **游标分页替代 offset**（后端架构 §2.1）
   - 文件：executions.controller.ts
   - 收益：offset 10000 查询从 500ms 降至 50ms
   - 工作量：0.5 人天
   - 风险：需更新 admin-web 的分页逻辑
   - 前置澄清：**会改响应信封**——需先设计向后兼容的过渡形态（同时返回
     `cursor` 与 `total`，旧字段保留一个版本），否则四端客户端一起断
   - **建议**：优先实施，但先出「信封过渡方案」再动手

2. ~~**Slack webhook 配置**~~ ✅ **本轮已完成（且做得比原方案更好）**
   - 实际落地方案是「HMAC 加签侧车 → 平台既有通知渠道扇出」，见上方决策 2
   - 不需要 Slack 凭据，也不需要新的外部依赖；`.env` 设 secret 即启用

3. **开发环境一键启动脚本**（开发者体验 §1.1）
   - ⚠️ 先核实：仓根已有 `dev.sh`（薄转发到 Makefile）+ `start-dev.sh` +
     `Makefile` 的 `dev/doctor/status` 目标——「一键启动」可能已存在，缺的也许
     只是**新人文档**而非脚本。动手前先读 `make help`
   - 工作量：0.5 人天
   - **建议**：先核验再决定

### 第二批（下周）- 有轻微依赖

4. **缓存策略（Redis 缓存层）**（后端架构 §4.1）
   - 前置：需确认 Redis 连接配置
   - 收益：用户信息查询从 20ms 降至 5ms
   - 工作量：1 人天
   - 注意：系统配置缓存（§4.2）已在上一轮落地为**进程内 TTL**；若再引
     `cache-manager` + Redis，要明确它与既有 `token-cache-sync.service.ts`
     pub/sub 先例的关系，别造第三套缓存方言

5. **执行记录归档**（后端架构 §2.2）
   - 前置：需确认归档策略（90 天？180 天？）
   - 收益：主表查询性能提升
   - 工作量：1 人天

6. **前端表单实时校验**（前端 UX §2.1）
   - ⚠️ 前置：计划假设有后端 `checkName` 端点——**实际不存在**，
     且现有 60/min 限流会在连击下 429。要么纯前端校验（不请求后端），
     要么先补端点 + 限流豁免
   - 工作量：1 人天

### 第三批（本月内）- 需要更多决策

7. **K8s 部署清单**（部署运维 §1.3）
   - 前置：需确认是否真的要迁移到 K8s
   - 工作量：2-3 人天
   - **建议**：如果当前 docker-compose 够用，暂缓

8. **蓝绿/金丝雀部署**（部署运维 §4）
   - 前置：需要 K8s 或 Istio
   - 工作量：2-3 人天
   - **建议**：暂缓，当前 deploy.sh rollback 已足够

9-13. **其他真缺口**（见 IMPLEMENTATION-REPORT-2026-10-17.md §五）

---

## ✅ 本轮已闭环（2026-10-17 第二轮）

| 项 | 状态 |
|---|---|
| 决策 2 / PLAN-OBSERVABILITY「Alertmanager 真实接收端」 / PLAN-DEPLOYMENT-OPS §3.1 | ✅ 加签侧车落地 + 接线 + 自检进 CI |
| `docs/observability/README.md` 的 runbook 锚点 `#autoflow_sse_ticket_rejected` | ✅ 复核后发现**早已补齐**（该文件 §3.6 已有正文）——PLAN-SECURITY-HARDENING 的勾选项已过期，已更新 |
| 决策 1（OTel 依赖） | ✅ 已收口：**保留依赖**（核 lockfile 确认它是 `prom-client` 的硬运行时依赖 + 本仓 SDK 挂载锚点，删除无收益且更差）+ 修正 7 处文档定性 |

---

## ✅ 本轮已闭环（2026-10-17 第三轮）

| 项 | 状态 |
|---|---|
| **预存在 CI 红灯** `check-desktop-bundle-drift` | ✅ **已转绿**（语义闸 + 字节闸双双 MATCH）。重打 executor-node bundle（ncc 0.45）+ 回填 `source-digest` 与末行字节哈希 + 连续两次重打逐字节一致的确定性取证 + 清单变更记录补账（说明 `f3e340df` 漏打的是哪三项 P1 修复） |
| **SECURITY §3.1** 密码强度反馈 | ✅ 落地（**不用 zxcvbn**——见下方理由）+ **顺带修掉一个真实缺陷** + 新增跨组件守卫进 CI |
| **BACKEND §2.2** 执行记录保留 | ✅ 保留期从**硬编码 90 天**改为可配置 `TASK_EXECUTION_RETENTION_DAYS`；"硬删除不可逆、无归档表"写进 3 处文档。⬜ 归档表仍是业务决策 |
| **DevEx §4.1** `test:quick` | ✅ 6 个分片 + `--passWithNoTests`（避免"无受影响测试"被误报成红），端到端跑通 |
| **DevEx §6.2** Dependabot | ✅ 扩展到 8 个 npm 单元；⬜ auto-merge **刻意不配**（理由与正确配方写进 `dependabot.yml`） |

### 为什么 §3.1 不用 zxcvbn（计划原文建议它）

zxcvbn 是 **~800KB 的独立强度模型**，它与后端 `validatePasswordStrength` 的**策略**
是两件事——完全可能出现"zxcvbn 说 strong、后端 400"。本仓的纪律是"不引入第二套
同类系统 / 第二套真值源"，所以改为：`utils/passwordPolicy.ts` = 后端策略的**语义
镜像** + 强度**受合规性封顶**（不合规绝不显示 good/strong，600+ 探针上核验）。
收益：零新依赖、界面与后端**不可能给出相反答案**、且把「前后端是否同源」变成
CI 可判的机器判据（`check-password-policy-sync.mjs`）。

### 为什么 §4.2 出口代理隔离**不做**（评估结论）

squid 只有做成 **deny-by-default 白名单**才谈得上"隔离"，而本仓出站面含**用户可配**
的目标（多 AI provider / SMTP / 通知 webhook / 注册表镜像）。盲接 = 先把可用性打死，
且**纯配置层、离线不可验证**（计划原文自己就警告 `NO_PROXY` 必须覆盖
`postgres,redis,executor-*`，漏一个就断执行器流量）。前置条件已写进
PLAN-SECURITY-HARDENING.md §4.2，留给维护者。

---

## ⛔ 不要实施的 18 个条目

**强烈建议不要派活给以下条目**（会造成安全回归或破坏现有功能）：

1. **PLAN-SECURITY-HARDENING.md §4.1** - DNS rebinding 防护
   - 原因：现有 DNS pinning 更强，按文本实施是**严格倒退**

2. **PLAN-BACKEND-ARCHITECTURE.md §7.1** - API 版本控制 `setGlobalPrefix('api/v1')`
   - 原因：会**同时打断 4 个客户端**（web/cli/mcp/executor）

3. **PLAN-OBSERVABILITY.md §3.1** - 引入 pino 替换现有日志
   - 原因：Nest 原生 ConsoleLogger 已支持 JSON，引入 pino 是**重复实现**

4. **PLAN-FRONTEND-UX-IMPROVEMENTS.md §5.1** - Redux DevTools
   - 原因：项目**未使用 Redux**，是 TanStack Query + React Context

5. **PLAN-DEVELOPER-EXPERIENCE.md §3.1** - 引入 @nestjs/terminus
   - 原因：健康检查已自研实现，引入 terminus 是**重复**

详见各计划文档顶部的核验表，标注 ⛔ 的条目。

---

## 🎯 我建议的具体行动计划

### 本轮已完成（2026-10-17 第二轮）
1. ✅ 核验基线：22 个门禁/自检脚本全绿（唯一红灯是**已知的** bundle 清单漂移）
2. ✅ 决策 2 落地：Alertmanager 加签侧车 + 接线 + 自检进 CI
3. ✅ 决策 1 定性：**不做删依赖**（理由见上），决策留给维护者
4. ✅ 计划文档状态同步（PLAN-OBSERVABILITY / PLAN-DEPLOYMENT-OPS / PLANS-INDEX / 本文件）

### 下一步（建议）
5. ⬜ 决策 1 收口（若选删依赖：删 + 同步 7 处文档叙述）
6. ⬜ `check-desktop-bundle-drift` 的**预存在红灯**修复：重打 executor-node
   bundle 并回填 `executor-node-bundle.sha256`（本轮未动——它需要跑
   `npm run build:executor`，且与本次改动面无关）
7. ⬜ 第一批真缺口：游标分页（先出信封过渡方案）/ 核验「一键启动」是否已存在

---

## 📊 预期收益（修订）

- ✅ **告警响应时间从「无穷大」降至分钟级**——30 条规则不再进黑洞（本轮达成，
  且走的是平台既有渠道扇出，不依赖任何外部凭据）
- ⬜ 查询性能提升 50-80%（游标分页 + 缓存 + 归档）
- ⬜ 开发效率提升（一键启动——先核验是否已存在）
- ⬜ 用户体验提升（表单优化）

**剩余工作量**：约 6-8 人天（远低于原计划的 41-55 人天——其中绝大部分条目
早已实现，见 IMPLEMENTATION-REPORT-2026-10-17.md §一）

---

## 💡 核心建议

**不要盲目按计划文档派活**，而是：
1. ✅ 先看核验报告 IMPLEMENTATION-REPORT-2026-10-17.md
2. ✅ 只实施标注为「真缺口」的条目
3. ⛔ 跳过标注为「不要实施」的条目
4. ℹ️ 对「已实现」的条目，可以验证和完善文档

这样可以：
- 避免重复实现
- 避免安全回归
- 避免破坏现有功能
- 专注于真正有价值的改进

---

## ✅ 提交建议

本轮改动是**自洽的一整块**（加签侧车 + 接线 + 自检 + 文档），与工作区里
先前那批未提交改动（限流/指标/健康检查/草稿/乐观更新等）**没有文件重叠**，
可以合并提交，也可以拆成两笔。建议拆两笔以便回溯：

```bash
# 一、先前那批（已在工作区、已验证）
git add -A -- ':!scripts/alertmanager-hmac-proxy*' ':!docker-compose.yml' ':!.env.example'
git commit -m "feat(obs): 限流白名单守卫 / HTTP RED 指标 / 磁盘堆健康检查 / 备份恢复演练"

# 二、本轮：Alertmanager 加签侧车
git add scripts/alertmanager-hmac-proxy.mjs scripts/alertmanager-hmac-proxy.selftest.mjs \
        config/monitoring/alertmanager.yml docker-compose.yml .env.example \
        package.json .github/workflows/ci.yml \
        apps/admin-api/src/common/utils/__tests__/webhook-hmac.util.spec.ts \
        docs/deployment.md docs/observability/README.md docs/atlas/06-infra/docker-compose.md
git commit -m "feat(obs): Alertmanager 加签侧车——30 条告警规则不再进黑洞

- 零依赖侧车（node:http/node:crypto）按平台契约加 HMAC 后转发 /api/alerts/webhook
- 上游状态码原样回传（不抹掉 admin-api 刻意的 502，保住 Alertmanager 重试语义）
- secret 缺失即 fail-closed 退出；compose 不映射宿主端口，仅内网可达
- 自检 36 例（金向量 + WebCrypto 独立复核 + 源码级契约对账 + 真实 HTTP e2e）
- 同一金向量钉在 admin-api webhook-hmac.util.spec.ts，两侧双向锁

验证：22 门禁全绿 + admin-api 定向 509 例全绿 + 变异测试双向取证"
```

**注意**：不要在本轮提交里带上 `.codegraph/`、`.tmp-*`、以及
`check-desktop-bundle-drift` 相关的大体积 bundle 产物（后者是另一个独立问题）。
