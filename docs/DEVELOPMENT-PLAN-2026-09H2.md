# AutoCodeFlow 长期开发计划（2026-09-08 H2 版）

> 基线：develop @ 403b0ad · CI 21+ job 全绿 · 九套件接手基线全绿：**admin-api 2037 · admin-web 480 · executor-node 266 · executor-python 222 · acf-cli 74 · mcp-server 84 · node-sdk 61 · autoflow-sdk 110 · registry-pypi 68**
> 本文是第十七轮起的长期开发计划，基于 2026-09-08 对 `AGENT_HANDOFF.md`、`docs/PLAN-CLAIMS.md`（105 任务台账）、`docs/DEVELOPMENT-PLAN-2026-09.md`（上一期计划，Phase A 大部分已销账）、各 review/verify 文档与全仓代码的全量盘点产出。
> 工作法延续「轮次制 + 认领板」：每轮 = 侦察 → 并行认领（多 agent/多会话）→ 真机验证 → 文档销账。
> **认领事实源：[PLAN-CLAIMS.md](./PLAN-CLAIMS.md)（本表 §10 已同步注册，认领前必读板头规则）**

---

## 目录

- [0. 现状快照（2026-09-08）](#0-现状快照2026-09-08)
- [1. P0：当轮在途与立即清偿项](#1-p0当轮在途与立即清偿项)
- [2. 遗留 Bug 清偿池](#2-遗留-bug-清偿池)
- [3. 功能补漏池](#3-功能补漏池)
- [4. 新功能池](#4-新功能池)
- [5. 架构演进池](#5-架构演进池)
- [6. UI/UX 池](#6-uiux-池)
- [7. 质量工程池](#7-质量工程池)
- [8. 安全纵深池](#8-安全纵深池)
- [9. 文档与发布工程池](#9-文档与发布工程池)
- [10. 新增任务注册表（本期增量 · 认领板同步）](#10-新增任务注册表本期增量--认领板同步)
- [11. 里程碑排期建议（第 17~26 轮）](#11-里程碑排期建议第-1726-轮)
- [12. 风险登记与依赖](#12-风险登记与依赖)

---

## 0. 现状快照（2026-09-08）

### 0.1 架构地图（与前版一致，能力增量加粗）

```
┌─────────────────────────── 控制面 ───────────────────────────┐
│ admin-web (React18+Vite+AntD5, 18+ 页面, zustand+TanStack)   │
│      │ axios(401刷新) + SSE(metrics/logs) + Query 缓存        │
│      ▼                                                        │
│ admin-api (NestJS+TypeORM+PG16+Redis7+BullMQ)                │
│  ├ 调度: Leader Election + DB claim 双保险 + loadScore 0.5/0.25/0.25/0.1 │
│  ├ 队列: BullMQ concurrency=5, priority enum, jitter 退避    │
│  ├ 回调: per-execution HMAC token + artifacts 上传/下载通道   │
│  ├ 事件: DomainEventBus(进程内) + 出站 webhook 订阅/重试/死信  │
│  └ 可观测: prom-client + OTel api-only(traceId 落库) + Grafana│
└──────────────┬───────────────────────────────────────────────┘
               │ 注册/心跳/派发/回调/部署指令（token 三态）
┌──────────────┴───────────────────────────────────────────────┐
│ executor-node (Express, ncc bundle) · executor-python (FastAPI)│
│ executor-desktop (Electron, NSIS 产包)                        │
└───────────────────────────────────────────────────────────────┘
┌─────────────── 支撑面 ────────────────────────────────────────┐
│ registry-npm(Verdaccio) · registry-pypi(FastAPI+索引页)       │
│ minio(S3 日志, 按日 RANGE 分区清理) · acf-cli · mcp-server     │
│ autoflow-sdk(Py) · @autocodeflow/sdk(Node) · ai/db/http/notify│
│ contract-fixtures 四端契约向量 · docs-site(VitePress)         │
└───────────────────────────────────────────────────────────────┘
```

### 0.2 上一期计划（DEVELOPMENT-PLAN-2026-09，105 任务）销账盘点

| 状态 | 规模 | 说明 |
|---|---|---|
| ✅ done | ~86 项 | §2 Bug 池 15/19、§3 功能补漏 12/12 全清、主题 A/B/C/F 全清、UI-01~08/11/14、ARCH-20~22/26/27、QA-02/03/04/06/07、SEC-01~08、DOC-01~06 |
| ⬜ unclaimed | 31 项 | 本表 §2~§9 全部收编并重新编号/合并（BUG-04/07/12/17/18/19/20、ECO-04、AUTH-01/02/04、DSK-01~05、ARCH-23/24/25、UI-09/10/12/13、QA-01/05/08/10、SEC-01/09、SEC-NEW-1/2/3） |
| 🔶 in_progress | 1 项 | QA-09（安全红线 e2e 套件化——清单已建六域 30+ 红线，e2e 剩余） |

### 0.3 近期基线与治理事实（新计划的事实输入）

- **迁移链**：最高时间戳 `1790000000013`（`CreateEventOutboxDeadLetters`，属于 FEAT-19-B/ARCH-31 follow-up）；outbox lease/dead-letter 代码已落地，但真实 PostgreSQL 迁移执行、多实例锁竞争/事务隔离仍 pending；新迁移已登记 ARCH-29 分配表。新任务占号前先 `ls apps/admin-api/src/migrations` + 认领板独占声明。
- **coverage 地板**：admin-api 91.6/81.34/78.47/90.6（门槛 75/69/84/84）——QA-02 后已达标，新任务不得拉低。
- **协作纪律**（历轮 3 次冲突沉淀，常设）：开工前 `git pull --rebase` + `git status` 盘点；未提交改动归其作者会话；`git add` 后立即 commit（dc82ac7 顺带提交事故教训）；executor-node src 改动与 bundle 同 commit（W-18 守卫）；RBAC 收紧前后端同批发布（N11/W2 教训）；API 变更走 PR 模板四查（DOC-01）。
- **真机矩阵**：QA-04 已固化 VERIFY-MATRIX.md——按变更类型必跑；历轮 P0 前科（BullMQ priority 字符串 enum、迁移链断裂、分步表单 missing）均由真机轮抓出，mock 全绿 ≠ 能跑。

---

## 1. P0：当轮在途与立即清偿项

> 开始新开发前必须收敛，否则后续分支踩在未收敛工作区上。

| # | 内容 | 现状 | 收口动作 | 验收 |
|---|---|---|---|---|
| P0-1 | **QA-09 安全红线 e2e 套件化**（in_progress, main-A） | `docs/SECURITY-REDLINE-CHECKLIST.md` 六域 30+ 红线已建 | 红线路径固化为可跑 e2e 套件（SSRF 六出站点/RBAC 全端点/注入面/审批第二人规则），接入 CI job | e2e 安全套件绿 + CI 挂钩 |
| P0-2 | **DEP-04 真机收尾**（后端 abc6e82 + 前端 374bbe8 已 done） | 双人第二人规则、审批通过→真机派发、审批徽标/待办 Alert 实测未做 | 按 VERIFY-MATRIX 走双人账号全链（提交者 A 开关+部署 → 管理员 B approve → 真机推送；reject/cancel 各一例） | VERIFY 文档 + 403/409 并发双审批断言 |
| P0-3 | **docs-site host 决策 + 发布**（ECO-05 遗留） | VitePress 站点已建成仅本地构建，未 host | 决策 host 面（GitHub Pages / admin-web nginx /docs / 独立容器），落地 CI deploy job | 站点公网/内网可访问 |
| P0-4 | **桌面端 safeStorage 专项开工前拍板**（SEC-NEW-1 前置） | executorToken 明文落盘（config-store），三平台 keychain 差异未定 | 拍板：三平台 Keychain/DPAPI/libsecret 差异表 + 存量明文迁移策略 → 才能开 SEC-NEW-1 | 拍板记录入 ADR |

---

## 2. 遗留 Bug 清偿池（继承编号）

> 上一期未清偿的 Bug 池，全部收编；来源与证据见上一期计划 §2，此处只列缺口与验收。

| 编号 | 级别 | 内容 | 建议方案 | 验收 |
|---|---|---|---|---|
| BUG-04 | P3 | minio 链 moderate 漏洞等上游（GHSA 豁免 2 项，复查 2026-10-01） | SEC-06 npm-audit job 跟踪；上游发版即升 | 复查日 audit 清零或豁免续期归档 |
| BUG-07 | P2 | QA8 detached 进程组对 Windows 信号行为深验（taskkill 树杀已修，Ctrl/BREAK 组合边角未系统化） | Windows 测试任务书增专项：超时杀树/停机杀树/kill 端点三链 detached 孙进程残留探针 | 三链孙进程残留=0 自动化断言入库 |
| BUG-12 | P2 | desktop 凭据存储边界/IPC 参数校验/子进程 env 继承面复审（SEC-01 汇总项） | 复审 + 修复；与 SEC-NEW-1 打包认领 | 复审报告 v2 销账 |
| BUG-17 | P3 | nginx SSE 15s ping 保活帧长流 24h 验证 | 真机挂 24h 日志流 + access log 断连统计 | 断连=0（除主动断开） |
| BUG-18 | P2 | 私服 npm/PyPI 端到端集成从未真机闭环（registry 发布内部包→任务引用→executor 安装，node/py 双 runtime） | 批十已建哑私服基建（被 SEC-NEW-2 拦截）；SEC-NEW-2 修复后重跑链路 | E2E 用例 + VERIFY 文档 |
| BUG-19 | P2 | 大规模并发压测从未做（容量上限/BullMQ/PG 池水位未知） | =QA-05 专项，同任务认领 | 容量白皮书（单实例 500 并发目标） |
| BUG-20 | P3 | ARM64 multi-arch 镜像 | CI buildx job（仅 build 不跑 e2e）+ ARM 冒烟文档 | multi-arch 推送成功（与 DSK-05 同人） |

---

## 3. 功能补漏池

> 上一期 §3 十二项已全清；本池收编盘点中新发现的「最后一公里」缺口。

| 编号 | 级别 | 内容 | 现状与缺口 | 建议方案 | 验收 |
|---|---|---|---|---|---|
| FEAT-13 | P2 | **「保存为模板」UI 入口** | CORE-03 后端 POST 自定义模板/DTO 已就绪，TaskFormPage 无入口 | 表单「保存为自定义模板」按钮（config 序列化白名单字段），模板页可管理 | 表单→存模板→列表可见复用 |
| FEAT-14 | P2 | **DEP-01 /releases 前端消费** | 后端聚合端点+契约已文档化，ApplicationDetailPage 仍消费旧 versions 端点 | 详情页「版本×部署」一屏视图接入 /releases（当前版本 Tag/部署状态/操作人） | 追溯「这次部署用了哪个包」一屏完成 |
| FEAT-15 | P2 | **webhook 事件订阅 UI** | FEAT-07 后端三件套（订阅 CRUD+HMAC+死信 replay）已 done，admin-web 零 UI | 设置区「事件订阅」Tab：CRUD+secret 一次性回显+死信列表+replay 按钮 | UI 创建订阅→触发任务→死信可见可 replay |
| FEAT-16 | P3 | **EventSource 全站 SSE 化推广** | UI-14 仅 Dashboard 接流；Executions 列表 15s 轮询、执行器详情 30s 轮询保留 | 按 ARCH-26+UI-14 模式渐进：Executions 列表流+事件驱动推送（execution 终态主动 emit） | 切页零重复拉取；终态刷新 <3s |
| FEAT-17 | P3 | **ARCH-26 TanStack Query 全站推广** | 基础设施+两示范页 done，剩 13 处 useRequest 轮询页面 | 逐页换 query hooks（TaskList/Executions 已示范），SSE 数据并入缓存 | 全站 staleTime 统一；写后 invalidate 面收口 |
| FEAT-18 | P2 | **KILLED 终态领域事件补发** | ARCH-21 KILLED 未 emit（载荷类型预留）；FEAT-07 订阅方收不到被杀事件 | kill 链路落库后 emit execution.killed（或 folded failed+status）+ 订阅过滤适配 | kill 端点触发后订阅方收到事件 |
| FEAT-19 | P2 | **跨进程 outbox（webhook at-least-once）** | 基础 outbox 表/派发器/FEAT-07 接线已落地；`1790000000012` lease 与 `1790000000013` `CreateEventOutboxDeadLetters`（FEAT-19-B/ARCH-31 follow-up）已补齐 outbox lease/dead-letter 代码；真实 PostgreSQL 迁移执行、多实例锁竞争/事务隔离仍 pending | outbox 表+后台派发器（FEAT-07 死信表复用）+ DB lease/row claim，重启续投与多实例竞争验证 | 重启后在途订阅事件最终送达；真实 PostgreSQL 双实例竞争无重复 claim |
| FEAT-20 | P3 | **部署 triggerType 落库** | DEP-01 聚合行 triggerType 按 status 指纹推导，operator 恒 null | app_deployments 增 triggerType/operator 列（写入路径填充）+ 契约同步 | /releases 行 operator 真实可溯 |

---

## 4. 新功能池

> 主题 A（内核）/B（观测）/C（生态）/F（部署）已全清；本池为 H2 新立项。

| 编号 | 级别 | 内容 | 细化任务 | 验收 |
|---|---|---|---|---|
| NF-01 | P2 | **任务级 API 触发 token** | 任务维度 `POST /api/tasks/:id/trigger` 带 per-task token（AUTH-03 API Key 之后），CI/脚本免登录触发；rate limit 复用 SEC-09 分域 | API Key 与任务 token 双通道真机触发成功；吊销立即 401 |
| NF-02 | P2 | **执行编排（链式工作流 UI）** | 依赖 DAG 已可视（FEAT-02），缺「编排视图」——依赖创建/批量重跑/失败分支策略（continue/fail-fast）表单化 | 3 任务链从创建到依赖触发全 UI 操作；fail-fast 断言 |
| NF-03 | P3 | **任务级 RBAC 预研** | AUTH-01 Project 隔离的前置轻量版：任务/应用 owner 字段+非 admin 只能改自己的（不迁移全域，先加列） | 非 admin 用户改他人任务 403；owner 可见性矩阵 |
| NF-04 | P3 | **执行器标签调度增强** | **后端已完成；admin-web 表单半场已实现，待验收/认领收口**：亲和/反亲和字段与 payload 已接入当前工作区，尚未标 done；tags 已有；补「标签亲和+反亲和」调度约束（broadcast/pinning 之外的第三态），loadScore 组合 | 双执行器标签约束真机各一例；admin-web 半场验收后再销账 |
| NF-05 | P3 | **通知渠道：Slack/飞书** | 渠道机制已有（webhook/钉钉/企业微信/mail），补 Slack incoming webhook + 飞书 bot 两渠道类型 + 模板变量复用 FEAT-10 | 两渠道真机实收消息 |
| NF-06 | P2 | **MCP 写面扩容** | ECO-03 后 mcp 12+ 工具偏读面；补 update_task/pause_resume/retry_execution/deploy_app 四写工具（复用 ADMIN token 语义+二次确认文案） | 每工具单测+Claude Desktop 实测脚本 |
| NF-07 | P3 | **acf-cli 执行器管理命令** | `acf exec tail` 已有；补 `acf executor list/rotate/offline`（对齐 W2 ADMIN 语义）+ `--json` 覆盖 | 三命令单测+真机 |
| NF-08 | P3 | **demo 场景包** | DOC-03 demo:seed 已有；补「故障演练演示包」（预置失败任务/runbook/死信/审批待办各一例，教程四篇可直接复现） | seed 后教程四篇零配置可跑 |

---

## 5. 架构演进池（继承编号）

| 编号 | 级别 | 内容 | 现状痛点 | 方案 | 验收 |
|---|---|---|---|---|---|
| ARCH-23 | P3 | OpenAPI → 前端类型生成 | admin-web/src/api/*.ts 手写类型，历轮「类型对齐」返工多次 | admin-api 导出 OpenAPI JSON → openapi-typescript 生成 + CI drift 校验；渐进替换手写 interface | 手写 interface 替换过半；类型漂移 CI 红 |
| ARCH-24 | P3 | 读写分离 | 报表/列表查询与调度主链同库 | 可选 `DB_READ_REPLICA_URL`（TypeORM replica 路由），默认关闭 | 单测+可选配置零破坏 |
| ARCH-25 | P3 | 插件化任务 runtime | runtime 硬编码 node/python/shell | runtime 注册表协议（capabilities 已有字段基础）+ 一个示例 runtime（deno） | 文档+示例 runtime 接入零 admin 改动 |
| ARCH-28 | P2 | **根 lockfile/workspace 统一（二期）** | ARCH-20 已统一入口但保持 7 套独立 lockfile、no-hoisting；CI 各 job 重复 npm ci | 评估 pnpm workspace / turbo 缓存管道（含 docs-site），分批迁移，CI 时长对比报告 | 迁移后 test:all/typecheck:all 全绿+CI 时长下降量化 |
| ARCH-29 | P2 | **迁移时间戳治理** | 迁移号已达 1790000000002，秒级时间戳空间趋紧且多会话撞号风险高（QA-08 前科） | ① 迁移号分配表入认领板常设段（当前占用：1789500000000-01/1789800000000-01/1789900000000-05/1790000000000-02）；② 评估递增序号策略 | 新迁移先查表占号；撞号 CI 拦截 |
| ARCH-30 | P3 | **AI 分析服务化** | processor AI 直调保留（ARCH-21 范围注记）；ai 库调用失败静默 | AI 分析迁入事件监听器+失败重试队列+aiAnalysis 落库率指标 | handleCallback 零 AI 依赖；失败可观测 |
| ARCH-31 | P3 | **多 admin 实例调度漂移审计（documented/blocked）** | 盘点矩阵已完成，但 silence/channel config/rollout 与双实例真机验证未完成；outbox DB lease/row claim 代码已落地，真实 PostgreSQL 多实例竞争验证仍 pending；Leader Election 双保险已稳，SSE 槽位/webhook 队列语义仍分散 | 后续拆分 silence（跨实例读穿/Redis 同步）、channel config（共享持久化/Redis）、rollout（批次状态与心跳跨实例协调）；outbox 已补 DB 行级 claim/租约，继续做真实 PostgreSQL 双实例竞争验证 | 矩阵文档+真机双实例验证清单 5 条全部通过后再解除 blocked |

---

## 6. UI/UX 池（继承编号）

| 编号 | 级别 | 内容 | 说明 | 验收 |
|---|---|---|---|---|
| UI-09 | P2 | 移动端适配（旧表格半场 + 当前补齐半场进行中） | 旧半场 @3351eb9 已覆盖执行列表/执行详情表格与 MainLayout；当前工作区补充 Dashboard/ExecutionDetail 适配代码与测试，尚未真实浏览器验收 | 三页 375px 宽真实浏览器可用；无横向滚动；验收完成后再销账 |
| UI-10 | P2 | i18n 框架接入 ⚠️大 | react-i18next，zh-CN 为事实基准默认，语言文件按页面拆分；越晚成本越高 | 框架落地+首页/任务两页示范迁移；其余渐进 |
| UI-12 | P3 | 键盘可达性与无障碍 | 焦点管理/aria 标签/对比度审计（UI-02 双主题已建基础） | axe 扫描 critical=0 |
| UI-13 | P3 | desktop 渲染层对齐设计系统 | 自绘暗色 inline style 抽 CSS 变量，共享 design-system 令牌 | desktop 面板与 admin-web 视觉同源 |
| UI-15 | P2 | **toast/错误反馈一致性治理** | QA-03 发现两处前科：UserManagement 校验 rejection 无 catch、ApiKeys 吊销失败静默（useMutation 无 onError） | 盘点全站 mutation 错误处理，统一 getErrMsg+onError 纪律（lint 规则或 codemod） | 全站静默失败=0（盘点表入库） |
| UI-16 | P3 | **toast-only 页 StateError 补齐** | UI-08 缩水项：audit/Registry 等请求失败仅 toast，无页内错误块 | 按两页标杆模式逐页接入 | 盘点表 17 页三态全达标 |

---

## 7. 质量工程池（继承编号）

| 编号 | 级别 | 内容 | 现状 | 目标/验收 |
|---|---|---|---|---|
| QA-01 | P1 | E2E 场景扩展（随功能逐批入库） | 29 例基线 | +15 例：依赖 DAG 链路/通知真发(mailhog)/releases 回滚/API Key/静默规则/命令面板/灰度发布/artifacts/维护窗口/**审批流双人**（P0-2 产物收编） |
| QA-05 | P2 | 并发压测专项（=BUG-19，claimed/未完成） | scripts/load-test 有底子，当前仍未完成容量验收 | 场景：500 并发执行/1000 任务每分钟入队/SSE 500 连接/回调风暴 10k 每分钟；产出容量白皮书+瓶颈定位；可选 CI 基线 job |
| QA-08 | P2 | 跨版本迁移演练月度 job | 双轮幂等 job 已有 | 第三态：存量库跨 3 版本升级演练（v1.0.1→HEAD），CI 月度跑 |
| QA-10 | P3 | 关键路径性能基准 | 无 | 微基准（handleCallback 批量 100/storeLogLines 万行/dispatch 决策/loadScore）防退化 |
| QA-11 | P2 | **executor-python 测试稳健性收尾** | unraisable 修复已入库（86bf0ef）；deprecation 警告（Starlette testclient/anyio）仍在 | 评估 CI 加 `-W error::DeprecationWarning` 白名单模式，防第三方升级静默破坏 | CI 无 warning 噪声；strict 模式绿 |
| QA-12 | P3 | **桌面端 e2e（Electron）** | desktop 仅 selftest；UI 面无自动化 | electron Spectron/Playwright _electron 冒烟（注册/托盘/任务面板三场景） | 冒烟 3 例入 CI（可 windows-only） |

---

## 8. 安全纵深池（继承编号）

| 编号 | 级别 | 内容 | 说明 | 验收 |
|---|---|---|---|---|
| SEC-01 | P1 | 五模块专项复审汇总（BUG-12~16 已四项 done，剩 desktop 一项） | 剩 desktop 凭据/IPC/env（=BUG-12），复审报告 v2 收口 | 报告 v2 全部「已确认/已排除」 |
| SEC-09 | P3 | 限流分域（AUTH-03 已解锁） | API Key 级限流/回调心跳豁免面复核/超限 429 可观测 series | 限流命中可观测+分域配置 |
| SEC-NEW-1 | P2 | executorToken 明文落盘 → safeStorage 加密+存量迁移 | 前置 P0-4 拍板；config-store 改造+三平台差异+迁移一次性脚本 | 三平台加密落盘；存量明文首启迁移；selftest 全绿 |
| SEC-NEW-2 | P2 | py 执行器私网 gitRepo 策略与 admin 对齐 | 镜像 EXECUTOR_ALLOW_PRIVATE_NETWORK 开关（正则 S7 改开关式判定）；⚠️ 安全姿态变更，需拍板记录 | 内网 GitLab 拉取 py 执行器跑通；默认姿态不变 |
| SEC-NEW-3 | P3 | py 侧 register 失败补注册 | 对齐 node 313d203（maybeReRegister 钩子）；/token fallback 后带富元数据补注册 | register 失败→token 恢复→心跳元数据完整 |
| SEC-10 | P2 | **审计日志防篡改纵深** | 审计表可被 DB 直改 | 评估 hash-chain（prev_hash 链式）或 append-only 角色；高风险操作链验证 | 审计链验证工具+篡改可检出 |

---

## 9. 文档与发布工程池（继承编号）

| 编号 | 级别 | 内容 | 说明 | 验收 |
|---|---|---|---|---|
| ECO-04 | P1 | release 首发演练 v1.1.0（上期遗留最高优先） | 需 NPM_TOKEN/PYPI_API_TOKEN secrets + GitHub Environments(release) 审批人配置；DOC-05 release-please 管道已就绪 | tag → 三包发布成功且可安装冒烟；npm 403 教训：scoped 包名查 org 命名空间 |
| DOC-07 | P2 | operator 升级 runbook | DOC-02 前半 done（容量+备份），升级 runbook 等 QA-08 产出后补 | 升级 runbook 入 operations.md |
| DOC-08 | P3 | windows-findings 滚动清偿 | W 系列长尾项按轮认领；BUG-07 专项并入 | 每轮 Windows 触达面勾选 VERIFY-MATRIX |
| DOC-09 | P3 | 教程/文档站与代码同步机制 | docs-site 重组自 docs/，无 drift 检测 | 关键文档（sdk-guide/api-reference 摘要）CI 比对或单一事实源改造 |

---

## 10. 新增任务注册表（本期增量 · 认领板同步）

> 本节为 **PLAN-CLAIMS.md 新增行**的镜像（H2 新编号段：P0-1~4 / FEAT-13~20 / NF-01~08 / ARCH-28~31 / UI-15~16 / QA-11~12 / SEC-10 / DOC-07~09）。
> **沿用原编号的遗留 unclaimed/claimed/in_progress（BUG-04/07/12/17/18/19/20、ECO-04、AUTH-01/02/04、DSK-01~05、ARCH-23/24/25、UI-09/10/12/13、QA-01/05/08/10、SEC-01/09、SEC-NEW-1~3、QA-09）不在此重复注册**——认领行以 PLAN-CLAIMS 总表原行为准，内容见本计划 §2~§9 各池。
> 规则不变：认领=状态改 claimed + Owner + 文件足迹；完成=done + commit；足迹重叠不得并行。

| 编号 | 优先级 | 状态 | 建议足迹 | 依赖/备注 |
|---|---|---|---|---|
| P0-1 QA-09 收尾 | P0 | unclaimed | e2e-full.spec.js + security-redline checklist + CI | 独立认领（e2e 文件高冲突，一次一人） |
| P0-2 DEP-04 真机 | P0 | unclaimed | 真机轮（零代码，VERIFY 文档） | 需双账号+执行器环境 |
| P0-3 docs-site host | P1 | unclaimed | packages/docs-site + CI/部署配置 | 决策项，可小可大 |
| P0-4 safeStorage 拍板 | P1 | unclaimed | docs/adr/（零代码） | SEC-NEW-1 前置 |
| FEAT-13 保存为模板 | P2 | unclaimed | admin-web TaskFormPage/TaskTemplatesPage + api | 后端已就绪零 admin-api |
| FEAT-14 /releases 前端 | P2 | unclaimed | admin-web ApplicationDetailPage + api/applications.ts | 契约已文档化（api-reference「Releases」段） |
| FEAT-15 webhook 订阅 UI | P2 | unclaimed | admin-web settings 区新 Tab + api/event-subscriptions.ts | 后端 FEAT-07 done；零迁移 |
| FEAT-16 SSE 推广 | P3 | unclaimed | admin-web hooks/pages（Executions 先行）+ admin-api 终态 emit | 依赖 ARCH-26 基础设施 |
| FEAT-17 Query 推广 | P3 | unclaimed | admin-web 13 处 useRequest 页面逐页 | 与 FEAT-16 可同人（同页面耦合） |
| FEAT-18 KILLED 事件 | P2 | unclaimed | admin-api task.service kill 链 + domain-events + executor 双端消费（如需） | 与 FEAT-19 打包认领佳 |
| FEAT-19 outbox | P2 | unclaimed | admin-api 新 outbox 表（迁移占号）+ 派发器 + FEAT-07 接线 | 依赖迁移号（ARCH-29 表） |
| FEAT-20 triggerType 落库 | P3 | unclaimed | admin-api app-deployment 写面 + 迁移两列 + 契约 | DEP-01 遗留 |
| NF-01 任务触发 token | P2 | unclaimed | admin-api task 模块 + 迁移 + 契约 | AUTH-03 后；SEC-09 配套 |
| NF-02 编排 UI | P2 | unclaimed | admin-web 编排视图新页 + admin-api 依赖策略字段（可能零后端） | FEAT-02 DAG 组件复用 |
| NF-03 任务 owner 预研 | P3 | unclaimed | admin-api task/application 实体加列 + guard + 迁移 | AUTH-01 前置侦察 |
| NF-04 标签亲和调度 | P3 | in_progress | 后端已完成（7494289）；admin-web 半场当前工作区已实现，待验收/认领收口 | 亲和/反亲和字段、表单双字段与 payload 已接入；CORE-05 loadScore 组合；未标 done |
| NF-05 Slack/飞书渠道 | P3 | unclaimed | admin-api notification 渠道注册表 + settings UI | FEAT-10 模板复用 |
| NF-06 MCP 写面 | P2 | unclaimed | packages/mcp-server | ADMIN token 语义 |
| NF-07 CLI 执行器命令 | P3 | unclaimed | packages/acf-cli | W2 语义对齐 |
| NF-08 demo 演练包 | P3 | unclaimed | scripts/demo-seed* + docs/tutorials | DOC-03 复用 |
| ARCH-28 workspace 统一 | P2 | unclaimed | 根 package.json + CI workflows | 决策+迁移，二期大项 |
| ARCH-29 迁移号治理 | P2 | unclaimed | docs/PLAN-CLAIMS.md 常设段 + CI 校验 | 小任务，宜尽快 |
| ARCH-30 AI 服务化 | P3 | unclaimed | admin-api notification 监听器 + ai 库接线 | ARCH-21 范围注记收口 |
| ARCH-31 多实例矩阵 | P3 | documented/blocked（矩阵稿见 docs/ARCH-MULTI-INSTANCE-MATRIX.md；整体多实例实现与验证未完成，保持 blocked） | 已完成盘点/评估；outbox DB lease/row claim 代码已落地但真实 PostgreSQL 多实例竞争验证 pending；后续仍需拆分 silence（跨实例读穿/Redis 同步）、channel config（共享持久化/Redis）、rollout（批次状态与心跳跨实例协调）并逐项双实例验证 | 真机双实例验证清单 5 条全部通过后再解除 blocked |
| UI-15 反馈一致性 | P2 | unclaimed | admin-web mutation 面盘点+统一 | QA-03 两处前科 |
| UI-16 StateError 补齐 | P3 | unclaimed | admin-web toast-only 页 | UI-08 缩水项 |
| QA-11 py 测试 strict | P2 | unclaimed | executor-python tests + CI | 小任务 |
| QA-12 desktop e2e | P3 | unclaimed | executor-desktop + CI（可 windows-only） | Playwright _electron |
| SEC-10 审计防篡改 | P2 | unclaimed | admin-api audit 模块 | 拍板项（hash-chain vs append-only） |
| DOC-07 升级 runbook | P2 | unclaimed | docs/operations.md | QA-08 产出后 |
| DOC-08 windows 长尾 | P3 | unclaimed | 滚动 | 每轮认领 |
| DOC-09 文档同步机制 | P3 | unclaimed | packages/docs-site + CI | 小任务 |

---

## 11. 里程碑排期建议（第 17~26 轮）

> 节奏：一轮 = 1~2 天，并行 3~4 路 + 真机验证 + 销账。P0 永远先于新功能；足迹冲突任务不并行。

| 轮次 | 主题 | 建议包 | 出口标准 |
|---|---|---|---|
| **17** | **清偿 + 小任务速通** | P0-1（QA-09 e2e 化）· P0-2（DEP-04 真机）· ARCH-29（迁移号表）· QA-11（py strict）· UI-15（反馈一致性盘点）· SEC-NEW-3 | QA-09 销账；真机 VERIFY；三个小任务 done |
| **18** | **发布 + 生态** | ECO-04（v1.1.0 首发，需用户配 secrets）· NF-06（MCP 写面）· NF-07（CLI 执行器命令）· FEAT-13/14（模板 UI + releases 前端） | 三包发布成功；admin-web 两处消费闭环 |
| **19** | **部署域收口** | FEAT-15（webhook UI）· FEAT-18+19（KILLED 事件+outbox，打包）· FEAT-20（triggerType）· P0-3（docs-site host） | webhook 全链 UI 可管；outbox 重启续投真机验证 |
| **20** | **安全纵深** | P0-4 拍板 → SEC-NEW-1（safeStorage）· SEC-01 收口（desktop 复审）· SEC-09（限流分域）· SEC-NEW-2（py 私网开关，ADR 拍板）· SEC-10（审计防篡改拍板） | 复审报告 v2 全销账；token 加密落盘 |
| **21** | **压测与容量** | QA-05（=BUG-19）· QA-08（迁移月度 job）· DOC-07（升级 runbook）· BUG-18（私服 E2E，SEC-NEW-2 后） | 容量白皮书；月度演练绿 |
| **22** | **架构二期启动** | ARCH-28（workspace/turbo 评估+迁移）· ARCH-30（AI 服务化）· ARCH-31（多实例矩阵） | CI 时长对比报告；矩阵文档 |
| **23** | **平台扩展** | DSK-02（Linux 包）· DSK-03（自动更新）· DSK-05+BUG-20（ARM64，可同人）· BUG-20 | AppImage/deb 产包；multi-arch 镜像 |
| **24** | **体验三期** | UI-09（移动三页，补齐半场待真实 375px 验收）· UI-16（StateError 补齐）· UI-12（无障碍）· FEAT-16+17（SSE+Query 推广，可同人）· UI-13 | 三页真实 375px 浏览器验收通过且无横向滚动；推广过半 |
| **25** | **隔离预研** | NF-03（任务 owner 预研）· AUTH-01 拍板（scope/迁移三批方案 ADR）· NF-01（触发 token）· NF-04（标签亲和，后端完成/admin-web 半场待验收） | AUTH-01 ADR + 预研 spike；NF-04 admin-web 半场验收后再销账 |
| **26** | **i18n + 大项落地** | UI-10（i18n 框架，⚠️大）· NF-02（编排 UI）· NF-05（Slack/飞书）· NF-08（demo 包）· DSK-04（desktop 体验） | i18n 基础设施落地 |
| 滚动 | 长尾跟踪 | BUG-04（上游）/BUG-07（Windows 真机窗口）/BUG-17（24h SSE）/DSK-01（macOS 真机）/AUTH-02/04/ARCH-23/24/25（按需启动） | 随条件成熟逐轮认领 |

**依赖提醒**：
- ECO-04 被 secrets 阻塞 → 催用户配 `NPM_TOKEN`/`PYPI_API_TOKEN` + environment 审批人。
- SEC-NEW-1/SEC-01 依赖 P0-4 拍板；SEC-NEW-2 是 BUG-18 的前置（py 执行器私网拉包被拦）。
- FEAT-18+19 打包认领（同 kill 链与 webhook 足迹）；FEAT-16+17 打包认领（同页面耦合）。
- AUTH-01（Project 隔离，⚠️大）需产品拍板 scope 后才开工，NF-03 是其轻量预研；AUTH-02 依赖 AUTH-01；AUTH-04（OIDC）可选。
- 触碰 executor-node/python src：bundle 同 commit / Windows 对照；RBAC 收紧：前后端同批；新迁移：先查 ARCH-29 分配表。

---

## 12. 风险登记与依赖

| 风险 | 影响 | 缓解 |
|---|---|---|
| 多 agent 并行同写工作树 | 覆盖/半成品入库（历轮 3+ 次冲突） | PLAN-CLAIMS 板纪律；add 后立即 commit；提交前 `git log --stat` 盘点 |
| mock 全绿但真机挂（4 次前科：N2 enum/迁移链/分步表单/CORE-01 priority） | 生产 P0 | QA-04 矩阵硬出口；调度/队列/迁移改动强制 compose 冒烟 |
| 迁移号撞号 | 迁移链断裂（round5 前科） | ARCH-29 分配表 + 认领板独占声明 + CI 撞号检查 |
| 发布 secrets 缺失（npm 403 前科） | ECO-04 永久阻塞 | 轮次 18 前催办；scoped 包名查 org 命名空间 |
| UI-10 i18n 拖延 | 迁移成本随页面数线性增长 | 轮次 26 前完成框架落地；页面迁移渐进 |
| coverage 门槛与业务节奏冲突 | 弱断言凑数 | 只对出过真 bug 的区域定向补测；只增不减基线纪律 |
| 第三方依赖升级静默破坏（unraisable/audit 教训） | CI 噪声/安全债 | QA-11 strict warnings 评估；SEC-06 豁免复查日期机制（BUG-04 复查 2026-10-01） |

---

## 附录：本期盘点证据链

- 认领台账：`docs/PLAN-CLAIMS.md` 105 行任务全扫（unclaimed 31 项逐条收编至 §2~§10）。
- 交接文档：`AGENT_HANDOFF.md`（第十六轮批 T 终验收 + win 侧接棒快照，九套件基线 2037/480/266/222/74/84/61/110/68）。
- 在途确认：DEP-04 前端 374bbe8 + 销账 403b0ad 已入库，工作区干净（2026-09-08 核对）。
- 上期计划：`docs/DEVELOPMENT-PLAN-2026-09.md`（销账状态见 §0.2）。
- 记忆库：pytest unraisable 已修复（86bf0ef）；Windows 轮唯一开放项 = requirements 转发缺口（产品决策，归入 AUTH-01 拍板范围）。
- 迁移占用：`ls apps/admin-api/src/migrations` 最高 1790000000002；1789900000004/05 空闲。
- TODO/FIXME 全仓扫描：0（apps+packages src）——遗留均在此计划显式登记。
