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
> **👉 动手前先读 [docs/archive/reports/implementation-report-2026-10-17.md](../reports/implementation-report-2026-10-17.md)**
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

### 1. [安全加固优化计划](security-hardening.md)
**优先级**: 高 | **工作量**: 3-5 人天

- 限流器白名单自动化校验
- JWT 凭据生命周期可观测性
- 密码策略与账户安全增强
- SSRF 防护升级
- API 密钥权限细化
- 审计日志不可篡改性

### 2. [前端用户体验优化计划](frontend-ux-improvements.md)
**优先级**: 中 | **工作量**: 5-8 人天

- 竞态与加载状态优化
- 表单体验增强（实时校验、自动保存、进度指示）
- 执行日志查看器增强
- Dashboard 可视化增强
- 可访问性（A11y）改进
- 性能优化（虚拟滚动、懒加载）
- 移动端适配

### 3. [Executor Desktop 用户体验优化计划](executor-desktop-ux.md)
**优先级**: 中 | **工作量**: 4-6 人天

- 系统托盘增强（右键菜单、气泡通知、动态图标）
- 控制台 UI 改进（仪表盘、日志查看器、执行历史）
- 设置面板（可视化配置、首次启动向导）
- 自动更新
- 诊断工具
- 多语言支持

### 4. [后端架构与性能优化计划](backend-architecture.md)
**优先级**: 中 | **工作量**: 8-12 人天

- 调度器性能优化（批量预取、索引优化）
- 执行查询优化（游标分页、归档、物化视图）
- 数据库连接池调优
- 缓存策略（Redis、HTTP 缓存）
- API 限流升级（分层限流、动态限流）
- 事件驱动架构增强
- API 版本管理

### 5. [可观测性与监控优化计划](observability.md)
**优先级**: 高 | **工作量**: 6-8 人天

- Prometheus 指标体系完善（RED + USE 方法）
- Grafana Dashboard（系统总览、告警、业务）
- 结构化日志（JSON 格式、日志聚合）
- 分布式追踪（OpenTelemetry + Jaeger）
- 健康检查增强（详细检查、Readiness vs Liveness）
- APM 集成（Elastic APM / Sentry）
- 性能 Profiling

### 6. [开发者体验优化计划](developer-experience.md)
**优先级**: 中 | **工作量**: 4-6 人天

- 本地开发环境改进（一键启动、健康检查、.env 模板）
- 文档改进（交互式网站、代码示例、ADR）
- 代码质量工具链（Husky、Commitlint、自动 CHANGELOG）
- 测试体验改进（分组、工厂、快照）
- 调试工具（Redux DevTools、React Query DevTools、VSCode 配置）
- 开发工作流优化（PR 模板、自动合并、CODEOWNERS）
- 性能分析工具（Bundle 分析、Lighthouse CI）

### 7. [部署与运维优化计划](deployment-ops.md)
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
1. **docs/archive/plans/security-hardening.md** §1（限流白名单守卫 + 真实漏登记修复）、§2.2（票据被拒告警）
2. **docs/archive/plans/observability.md** §1（HTTP RED + fleet gauge）、§5.1（磁盘/堆水位）
3. **docs/archive/plans/deployment-ops.md** §2.3（备份恢复演练 + CI）

### ✅ 已完成（第二轮，2026-10-17 续）
4. **docs/archive/plans/observability.md**「Alertmanager 真实接收端」+ **docs/archive/plans/deployment-ops.md** §3.1
   ——零依赖加签侧车 `scripts/alertmanager-hmac-proxy.mjs`：`alertmanager.yml`
   默认 receiver 从 `'noop'` 改为 `'hmac-proxy'`，30 条告警规则不再进黑洞。
   compose 服务仅 `autoflow-internal` 可达、不映射宿主端口；未配置 secret 即
   fail-closed 退出。自检 `npm run test:alert-proxy` 已进 CI，金向量与 admin-api
   `webhook-hmac.util.spec.ts` 双向钉死（两侧任一算法漂移即红）。

### ✅ 已完成（第三轮，2026-10-17 续）
5. **预存在 CI 红灯收口**：`check-desktop-bundle-drift` 的语义闸 + 字节闸**全部转绿**
   ——重打 `executor-node` bundle（ncc 0.45）+ 回填 `source-digest` 与末行字节哈希
   + 连续两次重打逐字节一致的确定性取证。
6. **docs/archive/plans/security-hardening.md** §3.1 密码强度反馈——**不用 zxcvbn**：改为
   `utils/passwordPolicy` 作为后端 `validatePasswordStrength` 的语义镜像 + 实时
   强度计组件。**顺带修掉一个真实缺陷**：`UserManagementPage` 两处内联正则多要求
   小写字母（比后端更严，会拒绝后端可接受的密码）。新增跨组件守卫
   `check-password-policy-sync.mjs`（把两侧正则从源码抽出来逐字符执行核验，含 5 条反证）。
7. **docs/archive/plans/backend-architecture.md** §2.2 执行记录保留——把**硬编码 90 天**改为可配置
   `TASK_EXECUTION_RETENTION_DAYS`（缺省 90，行为不变），并在三处文档里把
   **"硬删除且不可逆、没有归档表"** 讲清。**归档表本身未建**（见下"需要决策"）。
8. **docs/archive/plans/developer-experience.md** §4.1 `test:quick`（jest `--onlyChanged` /
   vitest `--changed`，含 `--passWithNoTests` 避免假红，已端到端跑通）；
   §6.2 Dependabot 扩展到 8 个 npm 安装单元（**不配 auto-merge**，理由见 dependabot.yml 内注释）。

### ⬜ 建议接下来做
9. **docs/archive/plans/security-hardening.md** §4.2（出口代理隔离）——**评估后不建议盲接**：
   squid 属"deny-by-default 才能称得上隔离"，而本仓出站面含**用户可配**的 AI
   provider / SMTP / webhook 地址，"盲接会先把可用性打死"（报告原文即警告
   `NO_PROXY` 必须覆盖 `postgres,redis,executor-*`）；且纯配置层改动**离线不可验证**。
   决策与前置条件已写入 docs/archive/plans/security-hardening.md §4.2。
### ✅ 已完成（第四轮，2026-10-17 续）
14. **docs/archive/plans/backend-architecture.md** §2.1 游标分页——**已按「信封过渡方案」落地**：
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
15. **docs/archive/plans/backend-architecture.md** §4.2 跨实例缓存失效——`config-cache-sync.service.ts`
    逐条照抄 `token-cache-sync.service.ts` 已验证的先例（**不发明第三套缓存方言**）：
    写面 PUBLISH 逐出、`ready` 事件全量清空自愈断连窗口、fail-open 三层
    （PUBLISH 失败不改写操作结果 / Redis 不可用靠 TTL 兜底 / 不建立订阅）。
    `@Optional` 尾参注入，既有 `config.service` 单测零破坏。
16. **docs/archive/plans/frontend-ux-improvements.md** §2.3 表单完成度指示——`utils/formCompletion.ts`
    纯函数 + 22 例单测。分母只数「用户必须回答的问题」，条件性字段
    （`appliesWhen=false`）既不进分子也不进分母；分母为 0 返回 **0% 而非 100%**
    （不替用户断言"已完成"）。a11y：`role=progressbar` + `aria-valuenow` + 带数值的
    `aria-label`；状态点 `aria-hidden` 纯装饰，语义由视觉隐藏文本承载。
17. **docs/archive/plans/executor-desktop-ux.md** §5.1 健康面板 / §2.1 并发进度条——零新依赖。
    健康面板**未重复采集**：新 IPC 内部调用**同一个** `buildDiagnosticReport()`
    纯函数，绝无第二套真值源。并发条用原生 `<progress>` + 手写 CSS，未引组件库；
    `max` 不可用时显示 `N/—` 而非 `N/0`（后者会被读成"一切都超额"）。
18. **docs/archive/plans/observability.md**「仍然待办」第 4、5 条——删除死代码 `TraceMiddleware`
    （全仓唯一引用是 `main.ts` 里被注释掉的一行）；`main.ts` 4 处裸 `console.error`
    改静态 `Logger.error`（stack 走第二参数位，内容无损）。新增**源码级门禁 spec**
    + 双向反证（改回 `console.error` → 红；重建死文件 → 红）。

### ✅ 已完成（第五轮，2026-10-17 续）
19. **WSL 环境解锁**——本机 WSL(Ubuntu 24.04) 提供 PostgreSQL 16 + Redis 7，
    Windows 侧 127.0.0.1 直连可用（端口转发已通）。这解除了「需真实基础设施」的
    阻塞：`swagger:export`、`npm run test:e2e`、`scripts/e2e-full.sh` 全部**真跑**。
20. **`GET /tasks` keyset 游标分页**——推广完成（`sortBy`/`lastStatus` + cursor 显式
    400，过滤条件抽成 `buildTaskListWhere` 供三条路径共用）。
21. **修掉 704f749e 的两个真实翻页缺陷**（详见 IMPLEMENTATION-REPORT §十）：
    · 毫秒半开区间谓词**本身不成立**——同毫秒内「微秒更小但 id 更大」的行被静默漏掉
      （真 PG 实测：6 行只返回 1 行）；已改**行值比较 + 子查询取库内原值**；
    · 游标时间以字符串绑定 → naive timestamp 列丢时区（UTC+8 会话下漏 8 小时）；
      行值比较方案让**时间完全不下传**，从根本上消除。
22. **ADR-024 执行记录归档决策**（`docs/adr/adr-024-*.md`）——四选项 + 触发条件，
    **本轮不实施**（业务决策未定）。核出 6 条此前无人记录的事实（见该 ADR）。
23. **`scripts/e2e-local.sh`** + e2e 可重复运行修复：把「本机怎么把 e2e 跑起来」
    从口头知识变成可执行脚本，并对**环境问题与真实失败**做区分。
24. **全链 Playwright e2e 真跑通过**：49 通过 / 2 跳过 / 0 失败（3.6 分钟），
    覆盖真实 PG + Redis + admin-api + executor-node + executor-python + Chromium UI。

25. **docs/archive/plans/security-hardening.md** §4.2（出口代理隔离）——**评估后不建议盲接**：
    squid 属"deny-by-default 才能称得上隔离"，而本仓出站面含**用户可配**的 AI
    provider / SMTP / webhook 地址，"盲接会先把可用性打死"（报告原文即警告
    `NO_PROXY` 必须覆盖 `postgres,redis,executor-*`）；且纯配置层改动**离线不可验证**。
    决策与前置条件已写入 docs/archive/plans/security-hardening.md §4.2。
26. **docs/archive/plans/backend-architecture.md** §2.2 归档表——**需要业务决策**：见 ADR-024。
    决策所需信息已备齐，等合规口径。
27. ~~游标分页推广~~ ✅ **已完成**：5 个端点（`GET /tasks`、`GET /tasks/:id/executions`、
    `GET /tasks/executions/all`、`GET /api/audit`、`GET /api/executor-packages`）
    和 4 个前端页（见第 34/44 条）。
28. **docs/archive/plans/observability.md** §4 追踪 exporter（需要 collector）。
    另：手写 `TracingService` 的 `parentSpanId` 恒为 `null`，没有真正的父子 span 树。
29. ~~**后端执行记录流式导出端点**~~ ✅ **已完成（第八轮，4cc26327）**：
    `GET /tasks/executions/export` 真流式（背压 + socket close 中止），keyset 取数，
    公式注入防护（8 条安全用例 + 变异测试验证有牙），50 000 行有痕截断，`@Roles(ADMIN)`。
30. **⚠️ 最小权限 DB 角色（ADR-025 核出，价值最高的待办）**——方案已写好在
    `docs/DB-LEAST-PRIVILEGE.md`（21 条断言在真 PG 上实测全绿）。**属部署契约变更，
    需维护者拍板后再动手**。四条 ADR-025 未预见的硬约束已探明，其中一条是阻塞项：
    · `main.ts:129` 在**非 development 启动时自动跑迁移** ⇒ 应用账号必须有 DDL 权限，
      会让整个最小权限自我抵消（必须先解决，推荐删掉 boot 自动迁移）；
    · `log-retention-cleanup.service.ts:208/233-234` 运行时跑 `DETACH PARTITION` 与
      `CREATE TABLE ... PARTITION OF` ⇒ **恒需父表属主**，故必须有唯一属主例外；
    · `ALTER TABLE ... OWNER TO` 要求新属主有 schema CREATE（副作用：app 能在 public 建表）；
    · 属主检查认可角色成员关系 ⇒ 用单向 `GRANT acf_app TO acf_migrator` 即可。
    ⬜ **剩余两条纯 DB 内挡不住的**（属主 `DISABLE TRIGGER` / 超管
    `session_replication_role`）只有它能解——TRUNCATE 已在第十一轮用触发器补上。

### ✅ 已完成（第七轮，2026-10-18）
33. **`GET /tasks/executions/all` keyset 分页**（2e0c5d28）——新增
    `applyAllExecutionsFilters` 作过滤条件唯一真值源（OFFSET/keyset 共用一份，
    有「两条路径发出同一组谓词」的用例钉死）。真 PG 独立验证：同毫秒 4 行、
    id 与微秒反序 → 行值比较返回 3 行 ✅ / 半开区间变体返回 **0 行** ❌。
34. **前端消费 `nextCursor`**（03d5d944）——ExecutionsPage 加「稳定翻页」开关
    （**默认关闭 = 现有行为逐字节不变**），游标**栈**支撑「上一页」，keyset 下
    页码器整体消失换成上一页/下一页（杜绝"点第 5 页其实是第 2 页"）。
35. **`docs/DB-LEAST-PRIVILEGE.md`** 最小权限 DB 角色实施方案——文档内 6 个 SQL 块
    被**逐字抽取送进真 PG 执行**建库，再在它上面跑 21 条断言（PASS=21 BROKEN=0）。

### ✅ 已完成（第八轮，2026-10-18）
36. **执行记录流式导出端点**（4cc26327，见第 29 条）——兑现了一条空承诺。
37. **keyset 推广到 `GET /api/audit` 与 `GET /api/executor-packages`**（4cc26327）——
    关键技术难点：`audit_logs.id` 是 **integer 不是 uuid**，现有游标解码器的 uuid 形状
    校验会让每个审计游标 400。解法是抽出 `splitCursorPayload()` 作唯一公共前半段，
    另加 `decodeNumericKeysetCursor`（id 判据 `/^[1-9][0-9]*$/`，比 `Number.isInteger`
    严得多——拒 `01`/`0`/`-1`/`+1`/`1e3`/`1.0`/` 1`，这些 PG 都能解析成合法数值）。
    载荷里 id 保持**字符串**（序列主键上限 2^63，超 2^53 用 JS number 会静默丢精度）。
38. **审计过滤器收口**——原态是「2 份复制 + 1 个部分共用」的三段式：`findAll` 与
    `exportCsv` 各自内联**同样四条**（连注释都抄），`applyExtraFilters` 只装后四条。
    即「两条路径同一过滤集」这条承诺实际只覆盖 8 个里的 4 个。已收口成 `applyAuditFilters`。

### ✅ 已完成（第九轮，2026-10-18）
39. **AuditLogPage 与 ExecutorPackagesPage 消费 `nextCursor`**（0fe64906）——
    照抄 ExecutionsPage 范式：开关默认关闭、游标栈、keyset 下页码器整体消失换自绘上/下页、
    cursor 三态在状态层分开、"关闭时请求里没有 cursor 键"做成代码保证。
    两处按实际代码裁剪：AuditLogPage 无 `useUrlStateSync`（那条重置点不存在）；
    它是「草稿 → 点搜索才应用」两段式，故重置落在应用瞬间而非 onChange。
40. **「导出全部」前端接入**（0fe64906）——并列而非替换；下载走 axios blob；
    筛选映射按后端 DTO 逐个核实（搜索框→`taskName`、执行器→`executorAddress`、
    时间范围过滤的是 **createdAt** 不是执行 startTime 列）；"不分页"做成
    类型 + 装配层的代码保证（用例断言 `'page' in params === false`）。
41. **`listLatest()` 不得改走 keyset，用独立 spec 钉住**——它要的是
    "active 前 100" 固定切片，不是翻页；放在页面 spec 里只会检验 mock 自己。


### ✅ 已完成（第十轮，2026-10-18）
42. **TaskListPage 消费 `nextCursor`**（cbf1714b）——前端 keyset 迁移收尾。
    一处任务前提被我写错、agent 正确更正：我要求"先核实有没有排序 UI"——
    核实结论是本页**没有排序 UI**（名称列 `sorter` 是纯客户端排序，从不发
    `sortBy`/`sortOrder`），故只需处理 `lastStatus`。agent 把这条写进页面注释，
    防日后加排序下拉时漏掉。
43. **新增记住两个测试侧坑**（不是产品缺陷，是判据定位方式）：
    · TaskListPage 每行「启用」列也是 `role="switch"`，全页 N+1 个 ⇒ 稳定翻页开关
      必须按 `name: /稳定翻页/` 定位，不能用裸 `getByRole('switch')`；
    · 「状态」「触发方式」既是筛选 placeholder 又是表格列标题 ⇒ 须按
      `.ant-select-placeholder` 过滤。
### ✅ 已完成（第十一轮，2026-10-18）
44. **`audit_logs` 补 `BEFORE TRUNCATE` 守卫**（3d12113d）——堵住「一条 TRUNCATE 清空
    全部审计」。既有守卫是 `BEFORE DELETE OR UPDATE ... FOR EACH ROW`，对 TRUNCATE
    **完全不生效**（语句级操作不走行触发器）；我曾复刻同款守卫实测确认 TRUNCATE 放行。
    新迁移 `1790000000057` 加 `BEFORE TRUNCATE ... FOR EACH STATEMENT`，**不给逃生门**
    （保留期清理走 bypass+DELETE，全仓零处 TRUNCATE audit_logs）。
    **对照实验**：摘掉守卫 → TRUNCATE ALLOWED（洞复现）；装回 → DENIED。
45. **修正审计防篡改的过度承诺**（7d48cd9e）——`docs/operations.md` 与 `docs/atlas/…/
    audit-log.md` 原写「任何 UPDATE/DELETE 都会被拒绝」，让读者把"有触发器"读成
    "不可篡改"。已补一张实测边界表：TRUNCATE（现已守住）/ 属主 `DISABLE TRIGGER` /
    超管 `session_replication_role`（后两条**仍放行**，PG 固有语义，不谎称挡住）。
    并注明 `scripts/audit-verify.mjs` **不是完整性校验器**（只试 UPDATE、不试 DELETE/
    TRUNCATE、把 id 空洞当合法 ⇒ 检测不出删除）。


### 🚫 不要做（核验后判定）
- **docs/archive/plans/security-hardening.md §4.1**（DNS rebinding 双解析）——现有 DNS pinning
  更强，按计划实施是**安全回归**
- **docs/archive/plans/security-hardening.md §5**（API Key 权限细化）——**早已实现**
- **docs/archive/plans/observability.md §3.1**（引入 pino）——Nest 原生 JSON logger 已够用
- **docs/archive/plans/observability.md §5.2**（Readiness/Liveness）——**早已实现**且 503 正确
- **docs/archive/plans/deployment-ops.md §1.1-1.2、§2.1-2.2**——**早已实现**

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
**基于审计**: docs/archive/reports/audit-final-report-2026-10-17.md
