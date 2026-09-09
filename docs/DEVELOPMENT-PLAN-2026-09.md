# AutoCodeFlow 后续开发计划（2026-09-06 审计基线版）

> 基线：develop @ f8230f2 · CI 24 job 全绿（run 34035565675）· 全端测试绿
> 本文是第十六轮起的中长期开发计划，基于 2026-09-06 对代码、`AGENT_HANDOFF.md`、`docs/optimization-notes.md`、`docs/DEEP_REVIEW_*.md`、`docs/windows-findings.md` 与 design-system 的全量审计产出。
> 工作法延续项目既有的「轮次制」：每轮 = 侦察 → 并行修复/开发 → 真机验证（V）→ 文档销账（PROGRESS/VERIFY + AGENT_HANDOFF 状态快照刷新）。

---

## 目录

- [0. 现状审计快照](#0-现状审计快照)
- [1. P0：当前工作区未闭环事项（必须最先处理）](#1-p0当前工作区未闭环事项)
- [2. Bug 修复与遗留缺陷清偿（Backlog）](#2-bug-修复与遗留缺陷清偿backlog)
- [3. 功能补漏（现有功能完善）](#3-功能补漏现有功能完善)
- [4. 新功能路线图](#4-新功能路线图)
- [5. 架构升级](#5-架构升级)
- [6. 交互与 UI 升级](#6-交互与-ui-升级)
- [7. 质量工程与测试](#7-质量工程与测试)
- [8. 安全加固路线](#8-安全加固路线)
- [9. 文档与发布工程](#9-文档与发布工程)
- [10. 里程碑排期（第 16~25 轮建议编排）](#10-里程碑排期第-1625-轮建议编排)
- [11. 风险登记与依赖](#11-风险登记与依赖)
- [附录 A：全量任务索引](#附录-a全量任务索引)
- [附录 B：审计方法与证据来源](#附录-b审计方法与证据来源)

---

## 0. 现状审计快照

### 0.1 架构地图

```
┌─────────────────────────── 控制面 ───────────────────────────┐
│ admin-web (React18+Vite+AntD, 18 页面/10 组件, zustand)      │
│      │ axios(拆包/401刷新/重试) + SSE 日志流                  │
│      ▼                                                        │
│ admin-api (NestJS+TypeORM+PG16+Redis7+BullMQ)                │
│  ├ 调度器: Leader Election(Redis锁) + DB claim 双保险         │
│  ├ 队列: BullMQ concurrency=5, 终态保留策略, P2 sweep 重试    │
│  ├ 回调: per-execution HMAC token (v1.<execId>.<exp>.<hmac>) │
│  └ 可观测: prom-client /api/metrics + /metrics/scheduler     │
└──────────────┬───────────────────────────────────────────────┘
               │ 注册/心跳/派发/回调/部署指令（共享token + 动态token）
┌──────────────┴───────────────────────────────────────────────┐
│ 执行面                                                        │
│  executor-node (Express, ncc bundle 内置于 desktop)          │
│  executor-python (FastAPI, uv venv, 回调落盘死信)            │
│  executor-desktop (Electron, 托盘常驻, Win NSIS 已产包)      │
└───────────────────────────────────────────────────────────────┘
┌─────────────── 支撑面 ────────────────────────────────────────┐
│ registry-npm (Verdaccio) · registry-pypi (FastAPI)           │
│ minio (可选 S3 日志驱动) · acf-cli · mcp-server(12+ 工具)     │
│ autoflow-sdk(Py) · @autocodeflow/sdk(Node) · ai/db/http/notify│
└───────────────────────────────────────────────────────────────┘
```

### 0.2 测试与 CI 基线（第十六轮起点）

| 端 | 测试 | 备注 |
|---|---|---|
| admin-api | 1170（60 套件）+ eslint 0/0 | coverage 地板 68/58/56/69，偏低 |
| executor-node | 227 | ncc bundle 必须与 src 同 commit 重打（W-18 守卫） |
| executor-python | 197 | pytest |
| admin-web | 87 vitest + Playwright E2E 29/29 | 组件测试先例已建立 |
| autoflow-sdk (Py) | 91 | |
| registry-pypi | 50 | |
| acf-cli / mcp-server / node-sdk / notify / ai | 48 / 52 / 43 / 18 / 25 | |
| CI | 24 job 全绿 | 含 windows-node-tests、e2e-full-windows(PR/dispatch)、desktop-bundle-drift、npm-audit、迁移链双轮幂等 |

### 0.3 版本与发布状态

- v1.0.1 已发布：npm `@autocodeflow/sdk`、`autocodeflow-mcp-server`，PyPI `autoflow-sdk`；main 与 develop 树一致。
- `release.yml` 就绪但**未做首发演练**：需配置 `NPM_TOKEN` / `PYPI_API_TOKEN` secrets 与 GitHub Environments(release) 审批人。

### 0.4 工作区当前状态（⚠️ 审计时点）

- `apps/admin-api/src/modules/executor/executor.controller.ts` 有**未提交**改动（+11 行，W2：执行器 5 个管理端点补 `@Roles(ADMIN)`）。
- 新增**未跟踪**文件 `__tests__/executor.controller.rbac.spec.ts`（279 行）。
- 第十五轮已确认存在**并行会话同期协作**——处置纪律见 §1。

### 0.5 长期路线图遗留（来自 AGENT_HANDOFF）

| # | 方向 | 状态 |
|---|------|------|
| 1~9 | 版本快照/失败分类/Webhook 签名/超时时区重试/负载感知/版本隔离/心跳稳定/E2E/CLI-MCP | ✅ 已完成 |
| 10 | SDK 统一与示例 | ⬜ 未系统梳理 → 本计划 §4 主题 D |
| 11 | 日志外置存储 S3 | ✅ 已完成 |
| 12 | 桌面执行器跨平台 | ⬜ 未验证（macOS/Linux 打包缺失）→ §4 主题 E |
| — | 多租户/项目隔离 | ⬜（optimization-notes §4.3 中期建议）→ §5 ARCH-20 |
| — | /releases 统一资源 | ⬜（optimization-notes §4.2）→ §4 主题 F |

---

## 1. P0：当前工作区未闭环事项

> 本节任务在开始任何新开发前必须完成，否则后续所有分支都会踩在未收敛的工作区上。

### W2-闭环：执行器管理端点 RBAC 收紧（进行中，勿重做）

- **内容**：`executor.controller.ts` 的 `PATCH :id`、`POST :id/reload-config`、`POST :id/rotate-token`、`POST :id/set-offline`、`DELETE :id` 五个端点补 `@Roles(UserRole.ADMIN)`（rotate-token 返回明文 token，属最高危）。
- **已完成**：controller 改动（工作区未提交）+ `executor.controller.rbac.spec.ts`（279 行，未跟踪）。
- **剩余步骤**：
  1. **先 `git pull --rebase` 并 diff 盘点**——第十五轮流程注记明确要求：并行会话可能已推进同一文件，员工报告与 git 实际状态必须交叉核对。
  2. 跑 `cd apps/admin-api && npx jest --testPathPattern=executor.controller` 确认新 spec 全绿 + 全量 1170 无回归。
  3. **前端同批发布对齐（关键！）**：`ExecutorDetailPage.tsx` 的 update/reloadConfig/rotateToken/setOffline/delete 操作、`ExecutorListPage` 的批量操作，普通用户现在会 403。按第五/六轮模式（RequireAdmin 路由守卫 + 组件内 role 条件渲染 + 菜单隐藏）补门控，避免「可见但点了报错」的体验回退（参照 N11 收紧 notification/ai config 后第七轮补前端门控的教训——前后端必须同批）。
  4. Playwright e2e 若覆盖普通用户操作执行器的路径，需同步修正角色。
  5. `docs/api-reference.md` 补 RBAC 说明；AGENT_HANDOFF 状态快照刷新。
  6. 单独提交：`feat(admin-api,admin-web): W2 执行器管理端点 ADMIN 收紧+前端门控对齐`。
- **验收**：非 admin 用户 UI 上五个操作入口不可见/禁用；直接 API 调用 403；CI 全绿。
- **工作量**：0.5 轮内完成（含真机冒烟）。

### 并行协作纪律（常设规则，非一次性任务）

1. 任何会话开始：`git pull --rebase` + `git status` + diff 盘点。
2. 发现工作区有他人未提交改动：先判断归属（对照 AGENT_HANDOFF「本轮遗留」），不覆盖、不重做，续作或等其闭环。
3. executor-node 源码改动与 `resources/executor-node` bundle 重打必须**同 commit**（W-18 desktop-bundle-drift 守卫会拦，但教训要前置）。

---

## 2. Bug 修复与遗留缺陷清偿（Backlog）

> 来源标注：[H]=AGENT_HANDOFF 遗留、[DR]=DEEP_REVIEW_73935fe（DR-01~07 标记已修复，此处为复核义务）、[RV]=DEEP_REVIEW_0beef76 待补证、[N]=历轮 audit 未尽项、[OPT]=optimization-notes。
> 优先级：P0 破坏正确性/安全 · P1 高频路径缺陷 · P2 特定时序/配置才触发 · P3 体验/卫生。

### 2.1 admin-api

| 编号 | 级别 | 内容 | 位置/证据 | 建议方案 | 验收 |
|---|---|---|---|---|---|
| BUG-01 | P1 | **N51：admin-api 重启后（签发缓存冷）任一执行器首次 reload-config 必报错一次**（rotate-on-push 固有，执行器一个心跳内自对齐后重试成功） | [H] 第十一轮遗留 | reload-config 端点对 401 做一次「强制重签 + 重试」内循环（复用 issueToken 幂等语义）；或签发缓存持久化到 Redis，重启不冷 | 真机：admin 重启后 30s 内 reload-config 首发即成功 |
| BUG-02 | P2 | **sweep 对 worker 崩溃型 RUNNING 行的 re-enqueue 重试语义待产品拍板**（与 stale_recovered 重试预算的边界） | [H] 第十三轮遗留 | 按 P2 方案：崩溃型 RUNNING 行在 grace 后走 scheduleRetryAfterRecovery，但 hasRetryBudget=0 时只标 FAILED 不重入队 | 单测覆盖两种预算态；文档写明语义 |
| BUG-03 | P2 | coverage 地板 68/58/56/69 偏低，migration/模块边界处有盲区 | CI coverage step | 见 §7 QA-02（提升地板至 75/65/60/75） | CI coverage 阈值上调且绿 |
| BUG-04 | P3 | minio 依赖链 3 个 moderate 漏洞，等上游发版 | [H] npm audit | 每轮 CI npm-audit job 跟踪；上游发版后升版本 | audit 清零或豁免理由归档 |
| BUG-05 | P2 | SSE 并发计数是进程内的，多实例实际上限 = 实例数 × 64，无全局视图 | [H] 部署注意 | 指标端点暴露 per-instance 值并在 Grafana 面板聚合展示；容量规划文档写明线性关系 | Grafana 面板新增 SSE 连接数 panel |
| BUG-06 | P2 | `LOG_RETENTION_DAYS` 默认 30 天对 S3 驱动下的 DB 行不清理语义需复核（S3 对象无生命周期策略联动） | 代码走查：log-storage 分流后 DB 行在 s3 成功路径是否仍受清理 job 覆盖 | 若 S3 成功则 DB 不写行→确认无膨胀；失败回退路径确保进清理范围 | 集成测试：s3 回退行 31 天后被清理 |

### 2.2 执行器（node / python / desktop）

| 编号 | 级别 | 内容 | 位置/证据 | 建议方案 | 验收 |
|---|---|---|---|---|---|
| BUG-07 | P2 | **QA8：spawn detached 进程组对 Windows 信号行为的深度验证未做**（taskkill 树杀已修 R-08，但 detached + Ctrl/BREAK 组合的边角未系统化） | [H] 第十五轮遗留 | Windows 测试任务书增补专项：超时杀树/停机杀树/kill 端点三链在 detached 模式下的孙进程残留探针 | 三链孙进程残留 = 0 的自动化断言入库 |
| BUG-08 | P2 | executor-node register 失败无自动重注册——`/token` fallback 重建的行**丢失富元数据**（type/capabilities/maxConcurrent/version），直到进程重启才恢复 | [H] executor-node main.ts registerExecutor 注释（N41） | `/token` fallback 成功后补一次完整 register（带元数据），或 fallback 响应携带元数据回传 | 真机：register 失败→token 恢复后心跳元数据完整 |
| BUG-09 | P2 | python 停机树杀后 live 回调不在 drain 范围（QA8 关联：杀掉的进程可能已产生回调） | [H] 第十四轮遗留 | 停机流程：树杀后强制 flush callbacks 落盘目录 + drain 二次扫描 | 停机后无孤儿 .meta；admin 无悬挂 RUNNING |
| BUG-10 | P3 | executor 失败分类可继续细化（依赖安装失败/Git 拉取失败/运行时不支持/进程启动失败拆成独立 failureReason） | [OPT] §2.2 后续增强 | 双执行器在各自错误路径打细分 reason；admin-web 映射表与文案同步 | 失败详情页能区分至少 10 类原因 |
| BUG-11 | P3 | desktop W-16：assets 图标未入库（Windows 安装包图标缺省） | [H] windows-findings W-16 | 图标资产入库 + electron-builder 配置引用 | 安装包/托盘/任务栏图标正确 |
| BUG-12 | P2 | desktop 凭据存储边界、IPC 参数校验（路径域已修但凭据落盘方式未审计）、子进程环境变量继承面 | [RV] B.1 待补证 | 见 §8 SEC-10 专项复审 | 复审报告销账 |

### 2.3 客户端包（CLI / MCP / SDK）

| 编号 | 级别 | 内容 | 位置/证据 | 建议方案 | 验收 |
|---|---|---|---|---|---|
| BUG-13 | P2 | 已完成：acf-cli 认证传递、禁用/降级行为、重试出口已复审；补 Authorization 逐请求取最新 token、login 同时落库 refreshToken、401 单飞刷新链路文档化，修正 README login 参数与 token/refresh 语义 | [RV] B.2 | `packages/acf-cli/src/__tests__/client.test.ts` / `commands.test.ts` 补回归，`README.md` 补 CLI 鉴权说明 | `npm --prefix packages/acf-cli test -- src/__tests__/client.test.ts src/__tests__/commands.test.ts` 通过（69 tests） |
| BUG-14 | P2 | 已完成：mcp-server 工具调用→API 鉴权链路已复审；覆盖 30s 超时、401/403 错误文案、access token 过期 refresh 自愈、并发 401 单飞、refresh token 内存轮换、`/auth/*` 排除、403 不刷新、refresh 请求不携带过期 Authorization | [RV] B.3 | `packages/mcp-server/src/__tests__/api.test.ts` 已入库 BUG-14 回归，`README.md` 补 refresh token 配置说明 | `npm test` 与 `npm run typecheck` 均通过 |
| BUG-15 | P2 | 已完成：Node/Python SDK 与 autocodeflow-http 鉴权、disabled/fallback、401/403、timeout 与 retry 上限已复审；Node SDK 固化 403 readable/no retry，Python callback 固化 timeout 不重试，autocodeflow-http 固化 401/403 不重试返回 response、GET retry 预算、timeout safe-method 语义 | [RV] B.4 | `packages/autocodeflow-node-sdk/src/__tests__/http-client.test.ts`、`packages/autoflow-sdk/tests/test_callback.py`、`packages/autocodeflow-http/tests/test_client.py` 入库，README 补错误传播/legacy env 差异 | node SDK 26 tests、autoflow-sdk callback 28 tests、autocodeflow-http 21 tests 通过 |
| BUG-16 | P3 | 已完成：registry-npm 下载路由与 token 权限边界已复审；Verdaccio 包权限保持匿名不可读/不可写、登录用户可读写，公共包 fallback 仍需先认证，compose 默认 loopback 暴露 | [RV] B.5 | `apps/registry-npm/README.md` 补权限矩阵，`scripts/registry-npm-config.selftest.mjs` 固化静态回归并接入 `npm run test:registry-npm` | `npm run test:registry-npm` 与 `docker compose config --quiet` 通过（compose 仅既有 env/version 警告） |

### 2.4 部署与运维

| 编号 | 级别 | 内容 | 位置/证据 | 建议方案 | 验收 |
|---|---|---|---|---|---|
| BUG-17 | P3 | nginx SSE 依赖 15s `: ping` 保活帧（QA3 方案），专有 location 已在 c90cdae 落地——需真机确认长流 24h 不断 | [H] 第十五轮遗留 | 真机挂 24h 存储任务日志流 + nginx access log 断连统计 | 断连次数 = 0（除客户端主动断开） |
| BUG-18 | P2 | **未覆盖验证项：私有 npm/PyPI 仓库端到端集成**（任务 requirements 指向私服装内部依赖的真实闭环从未真机验证） | [H] 未覆盖清单 | 真机专项：registry-npm 发布内部包→任务 requirements 引用→executor 安装成功（node/py 双 runtime） | E2E 用例 + VERIFY 文档 |
| BUG-19 | P2 | **大规模并发压测从未做过**（容量上限、BullMQ/PG/连接池水位未知） | [H] 未覆盖清单 | 见 §7 QA-05（压测专项，scripts/load-test 已有底子） | 容量白皮书：单实例 500 并发执行目标 |
| BUG-20 | P3 | 已完成：macOS / ARM64 multi-arch 构建链路补 CI buildx 验证与部署文档；CI 覆盖 admin-api、executor-node、executor-python 的 linux/amd64,linux/arm64 build（push=false），发布镜像前置 manifest inspect/ARM64 冒烟说明已补 | [OPT] §3.4 路线图 | `.github/workflows/ci.yml` 新增 `docker-multiarch-build`，`docs/release-checklist.md` / `docs/deployment.md` 补 multi-arch 校验步骤 | CI workflow YAML 解析通过；实际镜像推送仍待接入 GHCR/DockerHub 发布凭证后闭环 |

---

## 3. 功能补漏（现有功能完善）

> 已有功能中的「最后一公里」缺口，用户可感知但未闭环的部分。

| 编号 | 级别 | 内容 | 现状与缺口 | 建议方案 | 验收 |
|---|---|---|---|---|---|
| FEAT-01 | P1 | **通知静默规则（silences）持久化** | NOTIF-003 落地为内存 Map（上限 1000 + 定期清理），**重启即丢**，且无 UI 管理 | ① `notification_silences` 表（渠道/任务/应用维度、有效期、创建人）；② CRUD API；③ admin-web 设置页「静默规则」Tab；④ 与通知发送路径集成判断 | 重启后静默仍生效；UI 可增删查 |
| FEAT-02 | P1 | **任务依赖 DAG 可视化** | `tasks.dependencies` 字段与依赖触发已完整（深度上限 64、DB claim 扇出），但前端**无任何 DAG 展示**——用户只能猜执行顺序 | TaskDetailPage 增 DAG 视图（antd + dagre/reactflow：节点=任务、边=依赖、状态着色=最近一次执行结果）；点击节点跳详情 | 依赖链任务在 UI 可见环路与执行链 |
| FEAT-03 | P1 | **执行历史对比入口强化** | 已完成：执行列表支持多选后直接点击「对比」打开 `ExecutionCompare`，并补齐 params 字段展示 | 已完成：对 params/exitCode/duration/failureReason 做差异高亮，保留状态、时间、错误信息等既有对比项 | admin-web `executions-page` 回归覆盖两键打开对比、参数展示与关键差异高亮 |
| FEAT-04 | P2 | **executor_metrics_history 数据消费** | 已完成：心跳保存 executor 当前指标后 best-effort 追加 `executor_metrics_history` 快照，读侧按 24h / 15min bucket 聚合 | 已完成：ExecutorDetailPage 已消费 `GET /executors/:id/metrics` 的 `history` 并展示 24h CPU/内存/并发折线图 | admin-api heartbeat 回归覆盖历史采样写入与 fail-open；admin-web 趋势图回归覆盖空态、旧响应兜底与三条折线 |
| FEAT-05 | P2 | **执行产物（artifacts）通道** | 任务只能回传日志与 exitCode，无法上报文件（截图/报表/CSV） | executor 侧 artifacts 目录 + 回调清单（大小/哈希，复用包上传通道）；admin 侧 /uploads 鉴权下载；详情页产物列表 | RPA 示例任务可上传截图并在 UI 查看 |
| FEAT-06 | P2 | **任务级维护窗口** | 调度无「停机窗口」概念，发布期定时任务照跑 | 任务/应用级 `maintenanceWindows`（cron 段），调度器触发前检查跳过（计入 skipped 指标） | 窗口内触发被跳过且可观测 |
| FEAT-07 | P2 | **Webhook 出站事件**（系统事件 → 用户 webhook） | 入站 webhook（CI 触发部署）已完善，出站只有通知渠道 | 事件订阅表（execution.failed / deployment.completed / executor.offline…）+ HMAC 签名出站（复用 applications webhook 的签名算法）+ 重试与死信 | 订阅方收到签名正确的失败事件 |
| FEAT-08 | P2 | **配置历史回滚** | `config_history` 表与 ConfigHistory 类型已对齐（c90cdae），但只可看不可回滚 | 历史条目「回滚到此版本」按钮（写路径走 system-config 同一校验/掩码守卫） | 回滚后值与历史一致且留痕 |
| FEAT-09 | P3 | **全局搜索 / 命令面板** | 18 个页面靠侧边栏导航，任务多时找任务/执行器低效 | ⌘K 命令面板：任务/执行器/应用/执行记录模糊搜索直达 | 键盘三击达任意任务详情 |
| FEAT-10 | P3 | **通知模板变量** | 通知内容是固定模板拼串，无变量定制 | 渠道级模板（{{task}}/{{failedReason}}/{{logs 摘要}}），渲染沙箱限制 8KB | 模板渲染单测 + 真机外发 |
| FEAT-11 | P3 | **任务运行手册（runbook）字段** | 任务失败后排障知识散落在团队 wiki | tasks 增加 markdown runbook 字段，失败通知/详情页展示 | 详情页可见 runbook 并随通知附链接 |
| FEAT-12 | P3 | **registry-pypi 简单索引页 UI 化** | 已完成：`apps/registry-pypi/main.py` 已提供需认证的人类可读 `/` 落地页、`/simple/` 包列表与包级版本/体积/时间展示，保持 PEP 503/pip 兼容，并覆盖 XSS 转义与缓存头测试 | `apps/registry-pypi/tests/test_registry.py` 定向覆盖 root/simple/package 三类 HTML 页、无外部资源、pip 锚点兼容与转义回归 |

---

## 4. 新功能路线图

> 四个主题按「内核 → 生态 → 隔离 → 部署」排列，每主题给出阶段划分与验收。主题间无强依赖，可按轮次编排穿插。

### 主题 A：调度与执行内核增强（P1，预计 3 轮）

| 编号 | 内容 | 细化任务 | 验收 |
|---|---|---|---|
| CORE-01 | **任务优先级队列 UI 化** | 后端 priority 归一化已做（normalizeTaskPriority）；补：① DTO/表单暴露 priority（low/normal/high/critical）；② BullMQ 按 priority 消费验证（concurrency=5 下高优先出队）；③ 列表/详情展示 | 高优任务在队列拥塞时先于 normal 执行（真机断言） |
| CORE-02 | **重试策略精细化** | 现有 maxRetry+指数退避；补：① retryableErrors 已消费但无 UI——表单暴露可重试错误类型多选；② retryDelay 支持 jitter；③ 每次重试的 attempt 链路在详情页可视化（attempt #N of M，下次重试时间） | 重试链路全程 UI 可见可干预（可手动提前重试） |
| CORE-03 | **任务模板与一键克隆** | 常用任务形态（定时备份/健康巡检/数据同步）固化为模板 | ① 模板实体+预置 5 个官方模板；② 列表「克隆」按钮（复制 config 生成草稿）；③ 模板市场页（后续 CORE-12） | 从模板到可运行任务 ≤ 3 次点击 |
| CORE-04 | **超时策略分级** | 现有单级 timeout 树杀；补：① warn 阈值（80% timeout 时通知）；② 超时动作可选 kill / kill+retry / notify-only | 三种超时动作真机各验证一例 |
| CORE-05 | **执行器资源配额** | maxConcurrentTasks 已有；补：任务级 `estimatedDurationSec` 参与 loadScore 计算（现仅 runningTaskCount/max），长任务预估权重更高 | 双执行器混布长/短任务时分布更均衡（真机 2+2 变体） |
| CORE-06 | **调度可观测 2.0** | SchedulerMetrics 已有 tick/claimed/skipped；补：① per-task 触发延迟分布（计划时刻 vs 实际入队时刻直方图）；② Grafana 面板新增「调度延迟 P99」 | 面板可见 15s 任务 P99 抖动 < 100ms |

### 主题 B：可观测性 2.0（P1，预计 2 轮）

| 编号 | 内容 | 细化任务 | 验收 |
|---|---|---|---|
| OBS-01 | **OpenTelemetry 分布式追踪** | 现状只有 metrics 无 tracing。引入 @opentelemetry/api（可选开关 `OTEL_ENABLED`）：① 触发→入队→派发→执行器→回调 全链路 span（W3C traceparent 经 dispatch 指令透传给执行器，回调带回）；② 执行详情页展示 trace 链接（接 Jaeger/Tempo，compose 增 profile） | 一次执行的完整 span 树可在 UI 一键跳转 |
| OBS-02 | **告警路由到通知渠道** | Grafana 6 条规则已有，但告警通知与平台通知渠道割裂 | ① Alertmanager webhook → admin-api 新端点 → 走通知渠道外发；② 告警消息含 runbook 链接（依赖 FEAT-11） | PG 宕机告警 5 分钟内到企业微信 |
| OBS-03 | **执行日志结构化检索** | 日志是纯文本行；补：日志行入库时抽取 `level`（ERROR/WARN）列 + 索引，详情页按级别过滤、日志页错误高亮聚合 | 「只看 ERROR」一秒过滤千行日志 |
| OBS-04 | **执行报告（execution_reports）消费** | 表已建但 UI 未见消费（AI 分析另存） | 详情页「分析报告」Tab：AI 分析结果 + 重试链路 + 时间线（pending→dispatch→running→terminal 各时刻） | 时间线可视化与 DB 时间戳一致 |
| OBS-05 | **容量水位指标** | PG 连接池/BullMQ 队列深度/SSE 槽位/磁盘（executor 侧已有 TTL 回收）统一为「水位」Gauge 系列 + 告警阈值文档 | 容量四件套面板齐备 |

### 主题 C：SDK / CLI / MCP 生态收口（P1，路线图 #10，预计 2 轮）

| 编号 | 内容 | 细化任务 | 验收 |
|---|---|---|---|
| ECO-01 | **SDK 统一与示例系统梳理**（路线图 #10 正式收口） | ① 双 SDK（autoflow-sdk Py / @autocodeflow/sdk Node）API 面对照表——能力矩阵（http/log/callback/db/notify/ai）逐项对齐标注差异；② 补齐缺失对等能力（列出清单后实现）；③ examples/ 增 4 个官方示例任务（每 SDK 2 个，覆盖回调+私服依赖） | 矩阵文档 + 示例任务真机跑通 |
| ECO-02 | **CLI 脚本化增强** | ① `acf exec tail <execId>` 实时跟随日志（SSE）；② `acf task lint` 本地校验 glue 脚本语法；③ 输出 `--json` 全命令覆盖（CI 消费友好） | 三命令单测 + 真机 |
| ECO-03 | **MCP 工具面扩容** | 现 12+ 工具；补：`get_execution_timeline`（OBS-04 数据）、`list_dead_letters`、`create_task_from_template`（CORE-03）、`get_scheduler_health` | 每工具单测 + Claude Desktop 实测脚本 |
| ECO-04 | **release 首发演练** | 打 v1.1.0 tag 走 release.yml 全流程：version-guard → npm/PyPI 发布 → environment 审批（需先配 secrets） | 三包新版本可安装且冒烟通过 |
| ECO-05 | **SDK 文档站** | docs/sdk-guide.md 升级为带版本矩阵的文档（VitePress，可选 host 于 admin-web /docs 路径） | 站点可浏览、示例可复制即跑 |

### 主题 D：多租户与权限模型（P2，预计 3~4 轮，需产品拍板范围）

| 编号 | 内容 | 细化任务 | 验收 |
|---|---|---|---|
| AUTH-01 | **Project（项目空间）实体**（optimization-notes §4.3 落地） | ① `projects` 表 + `projectId` 外键到 tasks/applications/executors/executor-packages（迁移分三批，全部幂等 + 默认项目回填）；② JWT 携带 project 上下文（token 内 claim + 中间件校验）；③ 全列表查询自动按 project 过滤 | A 项目用户看不到 B 项目任务（API + UI 双验证） |
| AUTH-02 | **角色细化** | 现有 admin/user(/viewer)；补 project 级角色（project-admin/developer/viewer），RolesGuard 支持「全局角色 OR 项目角色」 | 权限矩阵测试 20+ 用例 |
| AUTH-03 | **限权 API Key**（optimization-notes §2.3 后续增强） | ① `api_keys` 表（按应用/项目绑定、scope 只读/触发/管理、过期/吊销、最后使用时间）；② API Key 认证 guard（与 JWT 并列）；③ 管理页 CRUD + 审计 | CI/CD 用 API Key 触发任务成功；吊销后立即 401 |
| AUTH-04 | **SSO（OIDC）登录**（P3，可选） | 关键 SSO 库（authorization_code + PKCE），本地账号映射；无 SSO 环境零影响（开关关闭） | 接 Keycloak 真机登录成功 |
| AUTH-05 | **审计日志增强** | 审计页已有；补：① 项目维度筛选；② 导出 CSV 已有——补按 project 权限收敛；③ 高危操作（rotate-token/删除执行器）强制二次确认并记 reason | 审计可回答「谁在何时对哪个项目做了什么」 |

### 主题 E：桌面执行器与跨平台（P2，路线图 #12，预计 2~3 轮）

| 编号 | 内容 | 细化任务 | 验收 |
|---|---|---|---|
| DSK-01 | **macOS 打包**（路线图 #12） | electron-builder dmg 配置 + 代码签名（无证书先 ad-hoc + 文档说明 Gatekeeper 放行）；托盘/自启动（autolaunch 已有代码）macOS 适配 | macOS Intel + Apple Silicon 双真机注册上线并跑通 glue 任务 |
| DSK-02 | **Linux 打包** | AppImage / deb 目标；桌面自启动（.desktop 文件） | Ubuntu 22.04 真机跑通 |
| DSK-03 | **desktop 自动更新** | electron-updater + 私有更新源（走 executor-packages 通道或 GitHub Releases）；版本比对与回滚 | 旧版本应用内升级成功 |
| DSK-04 | **desktop 体验** | ① 状态页实时图表（复用 FEAT-04 数据）；② Wizard 步骤即进度保存；③ 崩溃自动重启守卫（看门狗进程） | 连续 7×24 常驻无人工干预 |
| DSK-05 | **ARM64 矩阵** | docker buildx 多架构（admin-api/executor-node/python 三镜像）+ 树莓派/ARM 云主机冒烟文档 | multi-arch 镜像 + ARM 冒烟记录 |

### 主题 F：应用部署 2.0（P2，预计 2~3 轮）

| 编号 | 内容 | 细化任务 | 验收 |
|---|---|---|---|
| DEP-01 | **/releases 统一资源**（optimization-notes §4.2 落地） | 合并 application_versions 与 app_deployments 语义：统一 `/applications/:id/releases`（版本号、包地址、部署时间、状态、触发方式、操作人），旧端点 alias 保留一个过渡期 | 追溯「这次部署用了哪个包」一屏完成 |
| DEP-02 | **灰度/金丝雀发布** | upgrade-all 支持百分比策略（先 1 台→健康检查通过→全量）；healthCheck 钩子（部署后探活端点 N 秒） | 三执行器灰度 1+2 真机验证 |
| DEP-03 | **部署健康检查钩子** | 应用 manifest 可声明 `healthCheck.path/interval/failThreshold`；失败自动回滚到上一 release（复用 3.3 已有的 current 回退） | 坏包自动回滚，无人工介入 |
| DEP-04 | **部署审批流**（P3，依赖 AUTH-03） | 高危应用部署需第二人审批（API + UI 待办列表） | 审批前不派发指令 |

---

## 5. 架构升级

| 编号 | 级别 | 内容 | 现状痛点 | 方案 | 验收 |
|---|---|---|---|---|---|
| ARCH-20 | P2 | **monorepo 工作区统一** | 各子项目独立命令，根目录无统一入口（handoff 明示），新人上手要背 8 套命令 | pnpm-workspace scripts 聚合（`pnpm test:all` / `pnpm typecheck:all`），或引入 turbo 管道缓存；Makefile 同步收敛 | 一条命令跑全端测试 + tsc |
| ARCH-21 | P2 | **领域事件总线** | 通知/AI 分析/依赖扇出直接 service 调用，耦合在 handleCallback 主链 | 进程内 EventEmitter 薄层（Nest EventEmitter2）：`execution.completed` 等事件解耦通知与 AI；为 FEAT-07 出站 webhook 铺路 | handleCallback 主链不再直接 import NotificationService |
| ARCH-22 | P2 | **execution_log_lines 分区表** | 保留期清理靠每日分批 DELETE（30 天），大表 VACUUM 压力仍在 | PG 原生按日 RANGE 分区 + `DETACH PARTITION` 替代 DELETE（迁移脚本含存量数据搬迁；S3 驱动用户可不开） | 清理 job 改 detach 后时长下降 10×；存量库升级演练 |
| ARCH-23 | P3 | **OpenAPI → 前端 client 代码生成** | admin-web/src/api/*.ts 手写类型，历轮多次「类型对齐」返工（N13/U13/ConfigHistory 等） | admin-api 导出 OpenAPI JSON → openapi-typescript 生成类型 + 手写薄封装层；CI 校验生成物 drift | 手写 interface 全部替换；类型漂移在 CI 红 |
| ARCH-24 | P3 | **读写分离与只读副本** | 报表/列表查询与调度主链同库 | 可选 `DB_READ_REPLICA_URL`，列表类查询走只读副本（TypeORM replica 路由） | 单测 + 可选配置默认关闭 |
| ARCH-25 | P3 | **插件化任务 runtime** | runtime 硬编码 node/python/shell 三类 | runtime 注册表协议（executor 上报 capabilities 已有字段基础）；新 runtime（如 deno/browser）零 admin 改动接入 | 文档 + 一个示例 runtime |
| ARCH-26 | P2 | **前端状态与数据层升级** | zustand 仅 auth store，页面各自 useRequest 轮询，切页重复拉取 | 引入 TanStack Query（渐进：新页面先用）；统一缓存/重试/失效策略；SSE 数据并入缓存 | 重访页面零闪烁；请求去重可见 |
| ARCH-27 | P3 | **配置中心收口** | **已完成**：生产代码的 `process.env` 读取已收口到 `configuration.ts` / `env.ts`，ESLint 规则禁止业务模块裸读并对配置映射、模块加载期工具保留明确豁免；本轮 admin-api lint 与 typecheck 通过 | configuration.ts 全量注册审计（lint 规则禁止模块内直接读 process.env，白名单豁免） | 违规 lint 报错；配置项清单文档 |

---

## 6. 交互与 UI 升级

> 设计系统 `design-system/autocodeflow/MASTER.md` 已定义（暗色 dashboard、Fira Code/Sans、#22C55E 强调色），但 admin-web 实际用 antd 默认亮色主题，**两者从未对齐**。以下分三期。

### 6.1 Phase 1：设计系统对齐（P1，1 轮）

| 编号 | 内容 | 细化任务 | 验收 |
|---|---|---|---|
| UI-01 | **主题令牌落地** | ① antd v5 ConfigProvider darkAlgorithm + token 映射设计系统色板（primary/accent/border/bg）；② index.css 注入 CSS 变量（--color-*、--space-*、--shadow-*）；③ 字体引入 Fira Code（代码/日志/等宽场景）+ Fira Sans（正文），按 MASTER.md | 全站视觉与设计稿一致；无硬编码色值残留（lint stylelint） |
| UI-02 | **明暗主题切换** | ① 主题 store（持久化 localStorage + 跟随系统）；② 切换按钮入全局头部；③ 图表/SSE 日志区双主题适配 | 双主题下所有 18 页面无对比度问题（axe 扫描） |
| UI-03 | **布局升级** | ① 侧边栏分组（概览/任务/执行/执行器/应用/系统）；② 折叠态；③ 面包屑与页头标准化组件（PageHeader：标题/描述/操作区） | 新导航 IA 下任意页面 ≤ 2 跳 |

### 6.2 Phase 2：核心页面体验（P1，1~2 轮）

| 编号 | 内容 | 细化任务 |
|---|---|---|
| UI-04 | **Dashboard 重构** | ① 指标卡趋势 sparkline（24h 执行量/成功率/平均时长）；② 失败 Top 任务榜（点击过滤）；③ 执行器资源热力条；④ 调度延迟卡（CORE-06 数据）；⑤ 空态引导（无任务→引导创建） |
| UI-05 | **执行详情页信息架构** | ① Tab 化（日志/时间线/报告/参数/产物[FEAT-05]）；② 日志查看器升级：虚拟滚动（万行不卡）+ 级别过滤（OBS-03）+ 搜索高亮 + 下载/复制固化；③ 失败定位卡片（failureReason→建议动作映射，含 runbook 链接） |
| UI-06 | **任务表单重构** | ① 现分步表单的 validateFields 陷阱已有兜底（第八轮 P0），重构为分区单页 + 锚点导航，消除分步挂载类缺陷土壤；② cron/fixed_rate 可视化预览（未来 5 次触发时刻，timezone 感知）；③ executor pinning/broadcast 互斥在 UI 层联动禁用（N17 语义前置） |
| UI-07 | **执行器列表/详情** | ① 卡片/表格双视图；② 分组树（executorGroup）；③ 批量 reload-config/token 轮换（ADMIN 门控对齐 W2）；④ 实时状态用 SSE 心跳推送替代 30s 轮询（后端已有 /logs/stream 模式可复制） |
| UI-08 | **空态/加载态/错误态标准化** | ErrorFallback/PageFallback 已有组件——全页面盘点统一接入；骨架屏替代 Spin；错误态统一「重试 + 复制错误信息」 |

### 6.3 Phase 3：进阶体验（P2~P3，随功能排期）

| 编号 | 内容 | 说明 |
|---|---|---|
| UI-09 | 移动端适配 | 管理场景高频的是「值班时看失败」：Dashboard/执行列表/详情三页响应式 + 底部导航；不做全站移动化 |
| UI-10 | i18n 框架 | react-i18next 接入（zh-CN 为默认与事实基准），语言文件按页面拆分；英文翻译可后置。现状全中文硬编码，越晚接成本越高 |
| UI-11 | 命令面板 | FEAT-09 的 UI 载体（⌘K），含动作（新建任务/触发/暂停） |
| UI-12 | 键盘可达性与无障碍 | 焦点管理、aria 标签补全（titlebar 按钮已有 aria-label 先例）、对比度审计 |
| UI-13 | executor-desktop 渲染层对齐设计系统 | 桌面端是自绘暗色风（App.tsx inline style），抽 CSS 变量与 admin-web 共享 design-system 令牌 |
| UI-14 | 实时推送统一 | admin-web 全面 SSE 化路线图：Dashboard 汇总流 + 执行器状态流，替代全站轮询（配合 BUG-05 的多实例容量文档） |

---

## 7. 质量工程与测试

| 编号 | 级别 | 内容 | 现状 | 目标/验收 |
|---|---|---|---|---|
| QA-01 | P1 | **E2E 场景扩展** | 29 例（pinned 全链/角色门控/四模式） | +15 例：依赖 DAG 链路、通知真发（dev mailhog）、/releases 回滚、API Key、静默规则、命令面板、灰度发布、artifacts、维护窗口 |
| QA-02 | P1 | **coverage 地板提升** | admin-api 68/58/56/69 | 分两轮提到 75/65/62/75（重点：scheduler 边角、log-storage 分流、application 部署状态机） |
| QA-03 | P1 | **admin-web 组件测试扩面** | 87 vitest，先例已建 | 18 页面中高频 10 页核心交互覆盖（表单校验/权限渲染/错误态），目标 200+ 用例 |
| QA-04 | P1 | **真机验证常态化** | 每轮 V 已成惯例，但矩阵未覆盖 | 建立「真机矩阵」checklist：Linux×PG16/Redis7 基线、Windows 全栈、macOS（DSK-01 后）、双 admin 实例、双执行器混布——每轮改动按触达面勾选 |
| QA-05 | P2 | **并发压测专项**（BUG-19） | scripts/load-test 已有底子 + README | ① 场景：500 并发执行、1000 任务/分钟入队、SSE 500 连接、回调风暴 10k/min；② 产出容量白皮书（瓶颈定位：PG 连接池/BullMQ/回调 55mb 路由）；③ 性能回归基线进 CI 可选 job | 
| QA-06 | P2 | **混沌/故障注入** | 无 | compose 演练脚本：Redis 宕（fail-open 路径）、PG 主从切换、执行器断网 30s 恢复、admin 滚动重启双实例——各场景断言数据零丢失/零重复（复用第五轮 Leader Election 验证资产） |
| QA-07 | P2 | **契约测试（客户端包）** | **已完成**：`packages/contract-fixtures/contract.json` 作为单一事实源，CLI/MCP/Node SDK/Python SDK 四端均消费共享向量并覆盖信封、2xx 区间与错误体形态；本轮四端定向回归全绿（32 + 30 + 30 + 33） | 建立共享契约 fixture 包（envelope/2xx 区间/错误体形态），CLI/MCP/node-sdk/py-sdk 四端消费同一测试向量，防再次漂移 | 四端共享 fixture 定向测试通过
| QA-08 | P2 | **迁移演练自动化** | 迁移链双轮幂等 job 已有（空库+续跑） | 补第三态：**存量库跨 3 个版本升级演练**（v1.0.1→HEAD），CI 月度跑 | 
| QA-09 | P3 | **安全回归用例固化** | 历轮审计修复散在各自 spec | 汇总「审计红线路径」清单（SSRF 六出站点/RBAC 全端点/注入面），一份 e2e 安全套件兜底 |
| QA-10 | P3 | **性能基准** | `scripts/micro-benchmark.mjs` 已建零依赖微基准 + `bench:micro`/`bench:micro:selftest` 根脚本入口 | 关键路径微基准（handleCallback 批量 100、storeLogLines 万行、dispatch 决策）防退化；可选 `--threshold-ms name=ms` 接入 CI |

---

## 8. 安全加固路线

> 历轮已闭环 R1-R19 / S1-S16 / DR-01~07 / W 系列安全项，本节是下一阶段纵深。

| 编号 | 级别 | 内容 | 说明 | 验收 |
|---|---|---|---|---|
| SEC-01 | P1 | **DEEP_REVIEW_0beef76 待补证五项专项复审**（对应 BUG-12/13/14/15/16） | desktop 凭据存储与 IPC、CLI 认证链、MCP 鉴权链、双 SDK 降级语义、registry-npm token 边界——按报告建议修复顺序逐项补证并销账 | 复审报告 v2 全部升级为已确认/已排除 |
| SEC-02 | P1 | **任务 env 与 secrets 加密落库** | 任务 env 明文 jsonb；DB 备份即泄密 | 应用层加密（AES-256-GCM，key 走 env KMS 语义）；写路径加密/读路径解密对调度透明；备份泄露演练 |
| SEC-03 | P1 | **登录安全升级** | 密码强度校验已有基础；补 ① TOTP 两步验证（可选启用）；② 登录设备/会话管理页（refresh token 吊销列表——DR-04 已修撤销语义，补 UI 面） | TOTP 真机绑定+登录；会话可远程注销 |
| SEC-04 | P2 | **SSRF 守卫统一治理** | assertSafeExecutorUrl/assertSafeGitRepoUrl/assertSafe（通知）三套并存，deny 段各自维护 | 收敛为单一 url-guard util + 统一 deny 列表常量 + 单测矩阵（含 ::ffff:/198.18/100.64 段回归） |
| SEC-05 | P2 | **上传面纵深** | 包上传 500MB 上限/diskStorage/流式哈希已做；补 ① zip bomb 防护（解压比上限+条目数上限，S6 Windows 校验扩展到通用路径）；② 病毒扫描钩子（可选 clamd） | 恶意样件测试集全拒 |
| SEC-06 | P2 | **依赖供应链** | npm-audit job 已有（high 级） | ① 升级到 --audit-level=moderate（minio 上游发版后）；② lockfile 完整性 CI 校验；③ pre-commit 已有——补 gitleaks secret 扫描 | 
| SEC-07 | P2 | **executor 侧最小权限** | env 白名单已双向收口 | ① Linux 部署文档 + 容器 non-root 化（Dockerfile USER）；② executor 容器 drop capabilities 示例 compose | 容器内非 root 且任务可跑 |
| SEC-08 | P3 | **CSP 与响应头强化** | helmet 已启用（生产 CSP undefined 放开 Swagger） | 生产 CSP 收紧（SSE/内联脚本白名单化）、HSTS、Referrer-Policy 全量 | securityheaders.com A 级 |
| SEC-09 | P3 | **速率限制分域** | 全局 60/min + 登录独立限流 | API Key（AUTH-03）级限流、回调/心跳豁免面复核、超限 429 可观测 series | 限流命中可观测 |

---

## 9. 文档与发布工程

| 编号 | 级别 | 内容 | 说明 |
|---|---|---|---|
| DOC-01 | P1 | api-reference 增量机制 | 已完成：`.github/PULL_REQUEST_TEMPLATE.md` 已包含「API 变更？」强制检查项，覆盖端点、Breaking 变更、环境变量与迁移号；OpenAPI 生成（ARCH-23）后可继续自动同步端点表 |
| DOC-02 | P1 | operator 手册补全 | 已补：`operations.md` 覆盖备份恢复演练（含 pgBackRest 建议）、容量规划水位阈值、升级 runbook；QA-05 容量白皮书与 QA-08 跨 3 版本演练结果后续回填 |
| DOC-03 | P2 | quickstart 视频化/沙箱 | 已补：`docs/quickstart.md` 接入 `pnpm demo:seed` 可选沙箱路径（3 个 demo 任务：fixed_rate 成功流、cron Python 样本、故意失败样本），新用户可快速看到执行记录/失败详情；视频化或在线沙箱后续追加 |
| DOC-04 | P2 | 架构决策记录（ADR） | 已完成：`docs/adr/` 已固化 ADR-001~012，并补 `adr-template.md` 与索引写作规则；后续架构/契约决策按序号追加 |
| DOC-05 | P2 | CHANGELOG 自动化 | 已完成：采用 release-please（`.github/workflows/release-please.yml` + `release-please-config.json` + manifest），从中文 conventional commits 生成 Release PR/CHANGELOG，裸 `vX.Y.Z` tag 继续衔接既有 `release.yml` 发布闸 |
| DOC-06 | P3 | 教程系列 | 已完成：`docs/tutorials/` 已包含「从 0 到生产」四篇与索引（第一个定时任务 → 私服依赖 → 多执行器扩容 → 告警接入值班），并从 quickstart 下一步入口串联 |

---

## 10. 里程碑排期（第 16~25 轮建议编排）

> 节奏参考历史：一轮 = 1~2 天（并行 4 路 + 真机验证 + 文档）。轮次内 P0 永远优先于新功能。

| 轮次 | 主题 | 包含任务 | 出口标准 |
|---|---|---|---|
| **16** | **清偿与闭环** | W2 闭环（§1）· BUG-01/02/07/08/09 · SEC-01 五项复审 · QA-04 矩阵 checklist 建立 | 工作区干净；DEEP_REVIEW 全销账；基线刷新 |
| **17** | **可观测性 2.0** | OBS-01/02/03 · FEAT-01（静默持久化）· FEAT-04 · BUG-05/06 | Grafana 面板 v2；静默重启生效 |
| **18** | **生态收口** | ECO-01~04（路线图 #10 收口 + release 演练）· QA-07 契约 fixture · v1.1.0 发布 | 三包发布成功；SDK 矩阵文档 |
| **19** | **UI Phase 1+2 前半** | UI-01/02/03 · UI-08 · ARCH-27（配置收口 lint） | 设计系统落地；主题切换可用 |
| **20** | **UI Phase 2 后半** | UI-04/05/06/07 · ARCH-26（TanStack Query 渐进） | Dashboard/详情/表单/执行器四核心页重构完成 |
| **21** | **内核增强** | CORE-01~04 · FEAT-02（DAG）· FEAT-03/08 | 优先级/重试/超时动作 UI 化；DAG 可视 |
| **22** | **多租户 Phase 1** | AUTH-01/02/03（需先产品拍板 scope）· ARCH-21/22 · SEC-02 | 项目隔离生效；日志分区迁移演练 |
| **23** | **部署 2.0 + 桌面** | DEP-01~03 · DSK-01/02 · FEAT-05（artifacts） | 灰度真机 1+2；macOS 包产出 |
| **24** | **压测与容量** | QA-05/06/08 · BUG-17/18 · DOC-02 | 容量白皮书；混沌演练报告 |
| **25** | **二期立项评估** | P3 池：AUTH-04/05 · DEP-04 · UI-09~14 · ARCH-23~25 · CORE-05/06 · DSK-03~05 · SEC-03/05~09 | 按采纳度重排二期计划 |

**依赖关系提醒**：
- AUTH-03（API Key）是 DEP-04、SEC-09 的前置；OBS-01 trace 透传需 executor 双端配合（同轮做）；FEAT-11（runbook）是 OBS-02 告警链接的前置；ARCH-23（类型生成）完成前 UI 相关轮次要继续手工对齐类型（历轮返工高发区）。
- 任何触碰 `apps/executor-node/src` 的轮次：bundle 重打同 commit；任何 RBAC 收紧：**前后端同批发布**（W2 与 N11 两次教训）。

---

## 11. 风险登记与依赖

| 风险 | 影响 | 缓解 |
|---|---|---|
| 并行会话同写工作树（第十五轮已实际发生 3 次冲突） | 覆盖他人改动、半成品入库 | §1 纪律；提交前 diff 盘点；每轮开工先 pull --rebase |
| 「mock 一切不等于能跑」类缺陷再发（N2 enum、迁移链、分步表单三次前科） | 单测全绿但真机 P0 | QA-04 真机矩阵硬性出口标准；调度/队列/迁移改动强制 compose 冒烟 |
| RBAC 收紧的破坏性发布 | 前端 403 体验回退（N11 前科） | 前后端同批发布写入 checklist；发布注记模板固定段落 |
| 多租户改造的迁移面大 | 存量数据回填风险 | AUTH-01 分三批迁移，每批幂等 + 默认项目回填 + 存量库演练（QA-08 第三态） |
| coverage 地板提升与业务节奏冲突 | 为凑数写弱断言 | 只对「历轮出过真 bug 的区域」定向补测（scheduler/log-storage/部署状态机） |
| 上游依赖（minio 链 moderate）卡安全清偿 | audit 永不归零 | 豁免归档机制：CI 注释 + 复查日期 |
| Windows/平台差异（信号/路径/编码）持续产出长尾 bug | 修复成本高 | QA-04 矩阵 + windows-findings.md 持续滚动；PR 模板加「平台影响？」检查项 |

---

## 附录 A：全量任务索引

| 编号 | 标题 | 优先级 | 预估 | 所属节 |
|---|---|---|---|---|
| W2-闭环 | 执行器管理端点 RBAC 收紧闭环 | P0 | 0.5 轮 | §1 |
| BUG-01 | reload-config 冷缓存首击 401（N51） | P1 | 0.3 轮 | §2.1 |
| BUG-02 | sweep 崩溃型 RUNNING 重试语义拍板 | P2 | 0.2 轮 | §2.1 |
| BUG-03 | coverage 地板提升 | P2 | 1.5 轮 | §2.1/§7 |
| BUG-04 | minio 链上游漏洞跟踪 | P3 | 持续 | §2.1 |
| BUG-05 | SSE 多实例容量可观测 | P2 | 0.2 轮 | §2.1 |
| BUG-06 | S3 回退行清理语义复核 | P2 | 0.2 轮 | §2.1 |
| BUG-07 | Windows detached 信号深验（QA8） | P2 | 0.3 轮 | §2.2 |
| BUG-08 | /token fallback 富元数据丢失（N41） | P2 | 0.3 轮 | §2.2 |
| BUG-09 | python 停机树杀后回调 drain 缺口 | P2 | 0.3 轮 | §2.2 |
| BUG-10 | 失败分类细化 | P3 | 0.5 轮 | §2.2 |
| BUG-11 | desktop 图标资产入库（W-16） | P3 | 0.1 轮 | §2.2 |
| BUG-12 | desktop 凭据/IPC/子进程 env 复审 | P2 | 0.5 轮 | §2.2 |
| BUG-13~16 | CLI/MCP/SDK/registry-npm 专项复审 | P2 | 1 轮 | §2.3 |
| BUG-17 | nginx SSE 24h 长流验证 | P3 | 0.2 轮 | §2.4 |
| BUG-18 | 私服 npm/PyPI 端到端集成验证 | P2 | 0.5 轮 | §2.4 |
| BUG-19 | 大规模并发压测 | P2 | 1 轮 | §2.4 |
| BUG-20 | ARM64 multi-arch 镜像 | P3 | 0.3 轮 | §2.4 |
| FEAT-01 | 通知静默规则持久化 + UI | P1 | 0.8 轮 | §3 |
| FEAT-02 | 任务依赖 DAG 可视化 | P1 | 0.8 轮 | §3 |
| FEAT-03 | 执行对比入口强化 | P1 | done | §3 |
| FEAT-04 | 执行器指标趋势图 | P2 | done | §3 |
| FEAT-05 | 执行产物 artifacts 通道 | P2 | 1 轮 | §3 |
| FEAT-06 | 任务维护窗口 | P2 | 0.5 轮 | §3 |
| FEAT-07 | Webhook 出站事件 | P2 | 0.8 轮 | §3 |
| FEAT-08 | 配置历史回滚 | P2 | 0.3 轮 | §3 |
| FEAT-09 | 全局搜索/命令面板 | P3 | 0.6 轮 | §3 |
| FEAT-10 | 通知模板变量 | P3 | 0.4 轮 | §3 |
| FEAT-11 | 任务 runbook 字段 | P3 | 0.3 轮 | §3 |
| FEAT-12 | registry-pypi 索引页 | P3 | 0.2 轮 | §3 |
| CORE-01~06 | 调度内核增强六项 | P1 | 3 轮 | §4-A |
| OBS-01~05 | 可观测性 2.0 五项 | P1 | 2 轮 | §4-B |
| ECO-01~05 | SDK/CLI/MCP 生态五项 | P1 | 2 轮 | §4-C |
| AUTH-01~05 | 多租户/权限五项 | P2 | 3.5 轮 | §4-D |
| DSK-01~05 | 桌面/跨平台五项 | P2 | 2.5 轮 | §4-E |
| DEP-01~04 | 应用部署 2.0 四项 | P2 | 2.5 轮 | §4-F |
| ARCH-20~27 | 架构升级八项 | P2~P3 | 3 轮（穿插） | §5 |
| UI-01~14 | UI/UX 十四项（三期） | P1~P3 | 4 轮 | §6 |
| QA-01~10 | 质量工程十项 | P1~P3 | 3 轮（穿插） | §7 |
| SEC-01~09 | 安全加固九项 | P1~P3 | 2.5 轮（穿插） | §8 |
| DOC-01~06 | 文档/发布六项 | P1~P3 | 1.5 轮（穿插） | §9 |

> 合计约 60+ 独立任务点。P0×1 · P1×22 · P2×26 · P3×15+，按 §10 排期约 10 个轮次消化，P3 池自然滚入二期。

## 附录 B：审计方法与证据来源

- **代码走查**：codegraph 全仓符号索引（入口 main.ts / app.module / scheduler.service / task.service / execution-callback.controller / executor.controller / admin-web router+pages+api / executor-node main.ts / acf-cli commands）；未提交 diff 与未跟踪 spec 实地核对。
- **文档**：`AGENT_HANDOFF.md`（十五轮全量纪要）、`docs/optimization-notes.md`（§6~§13 历轮修复清单与方法论）、`docs/DEEP_REVIEW_73935fe.md`（DR-01~07）、`docs/DEEP_REVIEW_0beef76.md`（待补证五模块）、`docs/REVIEW_MASTER.md`、`design-system/autocodeflow/MASTER.md`。
- **CI/流程**：`.github/workflows/ci.yml` 18 job 定义、windows-findings.md（W-01~W-28 / P-1~P-20）。
- **未纳入本计划但需持续跟踪**：minio 上游发版、admin-api 残留 3 moderate、`GET /executors` 保持非 ADMIN 可见的姿态决策（N11 复核理由在 controller 注释，若 AUTH-01 落地需重审该决策）。
