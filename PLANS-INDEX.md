# AutoCodeFlow 优化提升计划索引

本目录包含基于全面审计发现的多个优化提升计划，涵盖安全、性能、用户体验、架构、运维等各个方面。

> ## ⚠️ 2026-10-17 核验与实施状态
>
> **全部 7 份计划已逐项核验完毕**（CodeGraph + 配置对账）。结论很重要：
> 这些计划编写于代码演进的不同时点，**约 55% 的条目在仓库中早已实现**。
> 若直接按计划文本实施，会造成三类损害：重复实现（两套并行系统）、
> **安全回归**（计划 §4.1 比现有 DNS pinning 更弱）、**破坏 CI 门禁**
> （指标命名、响应 schema 基线、按 app 独立安装模型）。
>
> **👉 动手前先读 [IMPLEMENTATION-REPORT-2026-10-17.md](./IMPLEMENTATION-REPORT-2026-10-17.md)**
>
> ### 核验总览
>
> | 计划 | 条目数 | 已实现 | 真缺口 | 不要实施 |
> |---|---|---|---|---|
> | 安全加固 | 6 | 3 | 2 | 1（§4.1 是回归） |
> | 可观测性 | 9 | 6 | 1 | 2（pino / terminus 不需要） |
> | 部署运维 | 8 | 3 | 1 | 0 |
> | 后端架构 | 19 | 5 | 3 | 3（§7.1 会打断四端） |
> | 前端 UX | 20 | 12 | 3 | 5 |
> | 开发者体验 | 18 | 11 | 3 | 4 |
> | Desktop UX | 12 | 9 | 1 | 3 |
>
> **已完成的工作**（本轮）：限流白名单守卫 + 漏登记修复、SSE 票据被拒告警、
> HTTP RED 指标 + 执行器 fleet gauge、磁盘/堆健康检查、备份恢复演练。
> 全部通过 typecheck + lint + 4,862 测试 + 16 个 CI 门禁。
>
> **各计划文档顶部**都有该计划的核验结论表（含文件:行号证据），
> **文末**的路线图已重排为 ✅ 已完成 / ⛔ 不要实施 / ⬜ 真正待办。

## 📋 计划清单

### 1. [安全加固优化计划](./PLAN-SECURITY-HARDENING.md)
**优先级**: 高 | **工作量**: 3-5 人天

- 限流器白名单自动化校验
- JWT 凭据生命周期可观测性
- 密码策略与账户安全增强
- SSRF 防护升级
- API 密钥权限细化
- 审计日志不可篡改性

### 2. [前端用户体验优化计划](./PLAN-FRONTEND-UX-IMPROVEMENTS.md)
**优先级**: 中 | **工作量**: 5-8 人天

- 竞态与加载状态优化
- 表单体验增强（实时校验、自动保存、进度指示）
- 执行日志查看器增强
- Dashboard 可视化增强
- 可访问性（A11y）改进
- 性能优化（虚拟滚动、懒加载）
- 移动端适配

### 3. [Executor Desktop 用户体验优化计划](./PLAN-EXECUTOR-DESKTOP-UX.md)
**优先级**: 中 | **工作量**: 4-6 人天

- 系统托盘增强（右键菜单、气泡通知、动态图标）
- 控制台 UI 改进（仪表盘、日志查看器、执行历史）
- 设置面板（可视化配置、首次启动向导）
- 自动更新
- 诊断工具
- 多语言支持

### 4. [后端架构与性能优化计划](./PLAN-BACKEND-ARCHITECTURE.md)
**优先级**: 中 | **工作量**: 8-12 人天

- 调度器性能优化（批量预取、索引优化）
- 执行查询优化（游标分页、归档、物化视图）
- 数据库连接池调优
- 缓存策略（Redis、HTTP 缓存）
- API 限流升级（分层限流、动态限流）
- 事件驱动架构增强
- API 版本管理

### 5. [可观测性与监控优化计划](./PLAN-OBSERVABILITY.md)
**优先级**: 高 | **工作量**: 6-8 人天

- Prometheus 指标体系完善（RED + USE 方法）
- Grafana Dashboard（系统总览、告警、业务）
- 结构化日志（JSON 格式、日志聚合）
- 分布式追踪（OpenTelemetry + Jaeger）
- 健康检查增强（详细检查、Readiness vs Liveness）
- APM 集成（Elastic APM / Sentry）
- 性能 Profiling

### 6. [开发者体验优化计划](./PLAN-DEVELOPER-EXPERIENCE.md)
**优先级**: 中 | **工作量**: 4-6 人天

- 本地开发环境改进（一键启动、健康检查、.env 模板）
- 文档改进（交互式网站、代码示例、ADR）
- 代码质量工具链（Husky、Commitlint、自动 CHANGELOG）
- 测试体验改进（分组、工厂、快照）
- 调试工具（Redux DevTools、React Query DevTools、VSCode 配置）
- 开发工作流优化（PR 模板、自动合并、CODEOWNERS）
- 性能分析工具（Bundle 分析、Lighthouse CI）

### 7. [部署与运维优化计划](./PLAN-DEPLOYMENT-OPS.md)
**优先级**: 高 | **工作量**: 8-10 人天

- 容器化与编排优化（多阶段构建、健康检查、K8s 部署）
- 数据库运维自动化（迁移、备份、恢复演练）
- 监控告警自动化（AlertManager、自动修复）
- 蓝绿部署 / 金丝雀发布
- 灾难恢复（多区域、主从复制、DR 演练）
- 成本优化（资源调优、Spot 实例、自动扩缩容）
- 合规与安全（镜像扫描、Secret 管理）

---

## 🎯 实施优先级建议（2026-10-17 核验后修订）

### ✅ 已完成（本次）
1. **PLAN-SECURITY-HARDENING.md** §1（限流白名单守卫 + 真实漏登记修复）、§2.2（票据被拒告警）
2. **PLAN-OBSERVABILITY.md** §1（HTTP RED + fleet gauge）、§5.1（磁盘/堆水位）
3. **PLAN-DEPLOYMENT-OPS.md** §2.3（备份恢复演练 + CI）

### ✅ 已完成（第二轮，2026-10-17 续）
4. **PLAN-OBSERVABILITY.md**「Alertmanager 真实接收端」+ **PLAN-DEPLOYMENT-OPS.md** §3.1
   ——零依赖加签侧车 `scripts/alertmanager-hmac-proxy.mjs`：`alertmanager.yml`
   默认 receiver 从 `'noop'` 改为 `'hmac-proxy'`，30 条告警规则不再进黑洞。
   compose 服务仅 `autoflow-internal` 可达、不映射宿主端口；未配置 secret 即
   fail-closed 退出。自检 `npm run test:alert-proxy` 已进 CI，金向量与 admin-api
   `webhook-hmac.util.spec.ts` 双向钉死（两侧任一算法漂移即红）。

### ✅ 已完成（第三轮，2026-10-17 续）
5. **预存在 CI 红灯收口**：`check-desktop-bundle-drift` 的语义闸 + 字节闸**全部转绿**
   ——重打 `executor-node` bundle（ncc 0.45）+ 回填 `source-digest` 与末行字节哈希
   + 连续两次重打逐字节一致的确定性取证。
6. **PLAN-SECURITY-HARDENING.md** §3.1 密码强度反馈——**不用 zxcvbn**：改为
   `utils/passwordPolicy` 作为后端 `validatePasswordStrength` 的语义镜像 + 实时
   强度计组件。**顺带修掉一个真实缺陷**：`UserManagementPage` 两处内联正则多要求
   小写字母（比后端更严，会拒绝后端可接受的密码）。新增跨组件守卫
   `check-password-policy-sync.mjs`（把两侧正则从源码抽出来逐字符执行核验，含 5 条反证）。
7. **PLAN-BACKEND-ARCHITECTURE.md** §2.2 执行记录保留——把**硬编码 90 天**改为可配置
   `TASK_EXECUTION_RETENTION_DAYS`（缺省 90，行为不变），并在三处文档里把
   **"硬删除且不可逆、没有归档表"** 讲清。**归档表本身未建**（见下"需要决策"）。
8. **PLAN-DEVELOPER-EXPERIENCE.md** §4.1 `test:quick`（jest `--onlyChanged` /
   vitest `--changed`，含 `--passWithNoTests` 避免假红，已端到端跑通）；
   §6.2 Dependabot 扩展到 8 个 npm 安装单元（**不配 auto-merge**，理由见 dependabot.yml 内注释）。

### ⬜ 建议接下来做
9. **PLAN-SECURITY-HARDENING.md** §4.2（出口代理隔离）——**评估后不建议盲接**：
   squid 属"deny-by-default 才能称得上隔离"，而本仓出站面含**用户可配**的 AI
   provider / SMTP / webhook 地址，"盲接会先把可用性打死"（报告原文即警告
   `NO_PROXY` 必须覆盖 `postgres,redis,executor-*`）；且纯配置层改动**离线不可验证**。
   决策与前置条件已写入 PLAN-SECURITY-HARDENING.md §4.2。
### ✅ 已完成（第四轮，2026-10-17 续）
14. **PLAN-BACKEND-ARCHITECTURE.md** §2.1 游标分页——**已按「信封过渡方案」落地**：
    新增可选 `cursor` 查询参数 + 响应**追加** `nextCursor`。既有 6 个信封字段
    （`list/items/total/page/pageSize/totalPages`）的名字、类型、必现性**一个没动**，
    四端零改动零感知。不带 `cursor` 走原 OFFSET 路径且**逐字节不变**（用 `undefined`
    让键整个不出现，而不是恒下发 null——后者会多一个键）。keyset 分支复用既有
    `(taskId, createdAt DESC, id DESC)` 索引。
    **顺带修掉一个真实精度缺陷**：`createdAt` 是 PG 微秒精度而 JS `Date` 只有毫秒，
    教科书式元组比较 `(a,b) < (:at,:id)` 会把同一毫秒内的行**重复返回**；改用毫秒
    半开区间谓词 `(createdAt < :at OR (createdAt < :atNext AND id < :cursorId))`，
    对微秒/毫秒两种行集判定完全一致。非法游标一律 400（**绝不**静默退回第一页——
    那是翻页死循环的源头）。
15. **PLAN-BACKEND-ARCHITECTURE.md** §4.2 跨实例缓存失效——`config-cache-sync.service.ts`
    逐条照抄 `token-cache-sync.service.ts` 已验证的先例（**不发明第三套缓存方言**）：
    写面 PUBLISH 逐出、`ready` 事件全量清空自愈断连窗口、fail-open 三层
    （PUBLISH 失败不改写操作结果 / Redis 不可用靠 TTL 兜底 / 不建立订阅）。
    `@Optional` 尾参注入，既有 `config.service` 单测零破坏。
16. **PLAN-FRONTEND-UX-IMPROVEMENTS.md** §2.3 表单完成度指示——`utils/formCompletion.ts`
    纯函数 + 22 例单测。分母只数「用户必须回答的问题」，条件性字段
    （`appliesWhen=false`）既不进分子也不进分母；分母为 0 返回 **0% 而非 100%**
    （不替用户断言"已完成"）。a11y：`role=progressbar` + `aria-valuenow` + 带数值的
    `aria-label`；状态点 `aria-hidden` 纯装饰，语义由视觉隐藏文本承载。
17. **PLAN-EXECUTOR-DESKTOP-UX.md** §5.1 健康面板 / §2.1 并发进度条——零新依赖。
    健康面板**未重复采集**：新 IPC 内部调用**同一个** `buildDiagnosticReport()`
    纯函数，绝无第二套真值源。并发条用原生 `<progress>` + 手写 CSS，未引组件库；
    `max` 不可用时显示 `N/—` 而非 `N/0`（后者会被读成"一切都超额"）。
18. **PLAN-OBSERVABILITY.md**「仍然待办」第 4、5 条——删除死代码 `TraceMiddleware`
    （全仓唯一引用是 `main.ts` 里被注释掉的一行）；`main.ts` 4 处裸 `console.error`
    改静态 `Logger.error`（stack 走第二参数位，内容无损）。新增**源码级门禁 spec**
    + 双向反证（改回 `console.error` → 红；重建死文件 → 红）。

### ⬜ 建议接下来做
19. **PLAN-SECURITY-HARDENING.md** §4.2（出口代理隔离）——**评估后不建议盲接**：
    squid 属"deny-by-default 才能称得上隔离"，而本仓出站面含**用户可配**的 AI
    provider / SMTP / webhook 地址，"盲接会先把可用性打死"（报告原文即警告
    `NO_PROXY` 必须覆盖 `postgres,redis,executor-*`）；且纯配置层改动**离线不可验证**。
    决策与前置条件已写入 PLAN-SECURITY-HARDENING.md §4.2。
20. **PLAN-BACKEND-ARCHITECTURE.md** §2.2 归档表——**需要业务决策**：只有确认
    "合规要求留存超过保留期的执行记录"才值得建；否则 archive 表是凭空多一份要维护的
    写入路径。本轮已把"不可逆删除"的语义与旋钮显式化，决策所需信息已备齐。
21. **游标分页推广到其余分页端点 + admin-web 迁移消费 `nextCursor`**——本轮只给
    `GET /tasks/:id/executions` 一个样板端点做了加性能力，前端仍走 OFFSET
    （**刻意**：一次改四端是反模式，且会让新旧两种分页"第 N 页"语义混用）。
    建议推广顺序：`GET /tasks` → `GET /tasks/executions/all` → audit →
    executor-package。每接一个都要保留「不带 cursor 逐字节不变」的用例。
22. **PLAN-OBSERVABILITY.md** §4 追踪 exporter（需要 collector）。
    另：手写 `TracingService` 的 `parentSpanId` 恒为 `null`，没有真正的父子 span 树。

### 🚫 不要做（核验后判定）
- **PLAN-SECURITY-HARDENING.md §4.1**（DNS rebinding 双解析）——现有 DNS pinning
  更强，按计划实施是**安全回归**
- **PLAN-SECURITY-HARDENING.md §5**（API Key 权限细化）——**早已实现**
- **PLAN-OBSERVABILITY.md §3.1**（引入 pino）——Nest 原生 JSON logger 已够用
- **PLAN-OBSERVABILITY.md §5.2**（Readiness/Liveness）——**早已实现**且 503 正确
- **PLAN-DEPLOYMENT-OPS.md §1.1-1.2、§2.1-2.2**——**早已实现**

### ⏳ 需要外部基础设施（有环境再排）
K8s/Helm、Trivy、Vault、蓝绿/金丝雀、多区域 DR、HPA/KEDA。
（Alertmanager 接收端**已在第二轮完成**——它不需要真实集群，只需仓库内的加签侧车。）

---

## 📊 投入产出估算

| 计划 | 工作量 | 预期收益 |
|---|---|---|
| 安全加固 | 3-5 人天 | 减少 80% 安全风险 |
| 可观测性 | 6-8 人天 | MTTR 从 30min 降至 15min |
| 部署运维 | 8-10 人天 | 可用性从 99.5% 提升至 99.9% |
| 后端架构 | 8-12 人天 | API P99 响应时间降低 50% |
| 前端 UX | 5-8 人天 | 用户满意度提升 30% |
| 开发者体验 | 4-6 人天 | 开发效率提升 40% |
| Desktop UX | 4-6 人天 | 降低 50% 用户支持工单 |

> 上表为**原始估算**。实际核验后，安全与可观测性的高优先级缺口已在约
> 1 个工作日内闭合（大部分计划条目本就已实现），剩余工作量的性质也变了——
> 从「写代码」变成「接外部基础设施」。

---

## 🚀 如何使用这些计划

1. **选择优先级最高的计划**
2. **分配给合适的 agent 或团队成员**
3. **按照计划中的阶段路线图逐步实施**
4. **每个阶段完成后进行验收**
5. **记录实施过程中的问题和改进**

---

所有计划都基于本次全面审计的发现，包含详细的：
- ✅ 背景说明
- ✅ 具体优化方案（含代码示例）
- ✅ 分阶段实施路线图
- ✅ 依赖项清单
- ✅ 验收标准

**生成时间**: 2026-10-17  
**基于审计**: AUDIT-FINAL-REPORT.md
