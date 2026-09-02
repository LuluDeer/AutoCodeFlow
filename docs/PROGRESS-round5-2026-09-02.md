# 第五轮 — 修复收尾 + 真机验证 进度追踪与 Agent 指派（2026-09-02）

> 第四轮（5 P0 全修，605/605+119/119+86/86 基线，见 [[PROGRESS-round4-2026-09-02]]）后，
> 本轮消化 AGENT_HANDOFF「下一步建议」中可自动化的 8 项：3 项并发收尾、可观测性、
> RBAC 收尾、install-token 处置、CLI/MCP P1 补全、flake 加固，外加首次真机验证。

## 基线与纪律

- 起点 commit：`3e81ad7`（develop，工作区干净）
- 基线：admin-api 605/605（45 suites）、executor-node 119/119、executor-python 86/86、三端 tsc ✓、admin-web lint 0 errors
- 各 agent 只改所有权内文件；不 commit；不动 AGENT_HANDOFF.md / docs/*.md（V 例外见下）
- 只跑定向 jest/pytest；V agent 用 `git worktree add /tmp/acf-r5 HEAD` 隔离，不碰主工作区源码

## 指派

| Agent | 范围 | 任务 | 文件所有权 |
|-------|------|------|-----------|
| I | admin-api 并发收尾+可观测性 | ① 依赖扇出双触发窗口：下游触发加短窗 DB claim（复用 claimTaskTrigger 思路）+ checkDependencies find 补 take；② storeLogLines DB 路径事务包裹（delete+insert 原子）；③ 调度 tick histogram / claimed-skipped-failed counter / 队列深度 gauge 接入（优先零新依赖：进程内计数 + metrics.controller 新端点暴露；若加 prom-client 需说明理由） | modules/task/**、modules/scheduler/**、modules/metrics/**、common/services/redis-lock（如需） |
| J | executor-node flake | 定位第四轮全量首跑 1 例时序失败（疑 file-logger 200ms flush / lib/download 本地服务器 / callback 循环），加固为确定性测试（fake timers / 显式等待），连跑 5 次全绿证明 | apps/executor-node/src/** |
| K | RBAC 收尾+面清理 | ① audit GET/export 收紧 @Roles(ADMIN)（负责人决策：审计含敏感操作数据，与 config 写端点同级）；② admin-web 角色门控：非 ADMIN 隐藏/禁用 settings 写操作、executor-packages、install-wizard、audit 入口（读 auth store 的 role，403 兜底提示）；③ 删除孤儿 install-token 端点（controller+service+spec+前端调用点），AGENT_HANDOFF roadmap 记录未来随 install.sh 一起实现 | modules/audit/**、modules/executor-package/**、apps/admin-web/**（router/menu/layout/store） |
| L | CLI/MCP P1 补全 | acf-cli + mcp-server 补：applications CRUD、deploy upgrade/stop、task versions/rollback/compare、executors 详情、audit 列表；严格对齐 docs/review_round4_contract.md 端点对账表与后端真实 DTO 白名单（camelCase！第四轮教训）；每命令补测试 | packages/acf-cli/**、packages/mcp-server/** |
| V | 真机验证（首次） | worktree HEAD 起 docker compose：① Leader Election 双实例——高频 cron 确认**按周期重复触发**（d2613d6 回归验证）+ kill Leader ≤30s 接管无重复；② LOG-11 S3 E2E——真 executor（host 进程连容器 admin-api）跑一次任务，mc 验证 execution-logs/<id>.log.gz 存在 + getExecutionLogs 读到；③ 负载均衡实测——2 executor 并发任务看 runningTaskCount 均衡与 callback 释放。注意端口冲突（metabase 8111 在跑），用独立 COMPOSE_PROJECT_NAME 与改映射端口。产出 docs/VERIFY-round5-e2e.md（唯一可写主仓文件），失败项如实记录不粉饰 | /tmp/acf-r5 worktree + docs/VERIFY-round5-e2e.md |

## 状态板

| Agent | 状态 |
|-------|------|
| I 并发收尾+可观测性 | ✅ `0a7ebcb`：依赖扇出 10s DB claim + take 兜底；storeLogLines 事务；SchedulerMetricsService + GET /metrics/scheduler（零新依赖）；+25 测试 |
| J flake 加固 | ✅ `1864597`：元凶坐实——file-logger spec 用 UTC 日期而生产按本地时区，超前时区机器每天 8 小时确定性失败；4 spec 确定性化，5 连跑 119/119 + 5 种 TZ 交叉 |
| K RBAC 收尾+清理 | ✅ `51469d6`：audit 两端点 ADMIN；删孤儿 install-token；admin-web 角色门控（role 唯一来源 /auth/profile，MainLayout 补齐 + RequireAdmin + 菜单隐藏 + settings 写禁用） |
| L CLI/MCP 补全 | ✅ `9e8f2ae`：10 组命令/tool（applications CRUD、deploy upgrade/stop、task versions/rollback/compare、executor get、audit list）+ 5 个既有契约 bug 顺带修 + vitest 基建（CLI 41 + MCP 40） |
| V 真机验证 | ✅ `b2be111`：Leader Election 双实例 80 execution 无重复无丢失、kill Leader 35s 接管；LOG-11 S3 对象+读取闭环；负载均衡精确 2+2。**新发现 N1-N6**（N2 P0 调度入队 100% 失败、N1 P1 全新 DB 迁移链断裂） |
| W1 调度缺陷修复 | ✅ `2642293`：N2 normalizeTaskPriority 入队边界归一化（PG enum 运行时字符串根因，无需迁移）+ N3 readyClient 消假 Leader + N4 register 幂等 + N5 动态 cutoff + N6 去重 TTL 按周期；+40 测试 |
| W2 迁移链修复 | ✅ `d2be430`：2691/2693/1788 幂等化 + CreateAppDeploymentsTable 补偿迁移 + migrations.spec describe 守卫（第 4 断点）；docker postgres 空库 24/24 + 存量续跑数据无损 |
| V2 真机复验 | ✅ `docs/VERIFY-round5v2-n2.md`：N2 首轮 80/80 FAILED → 96/96 success；N6 隔离实证 300s 12 触发（旧 ~3）；N3 同秒 acquired 零降级告警；N1 compose 全新 volume 24/24 |

最终基线：admin-api **669/669（47 suites）** · executor-node **119/119**（5 连跑稳定）· executor-python **86/86** · admin-web vitest 15 + lint 0 errors · acf-cli 41 / mcp-server 40 · 三端 tsc ✓

## 遗留（写入 AGENT_HANDOFF）

- N6 残留：fixed_rate TTL=周期的亚秒竞态致 15s/30s 节奏抖动（V2 如实记录，建议 TTL=周期×0.9 或双保险窗口收紧）
- `POST /api/tasks` 传字符串 id 报 500（DTO 缺 uuid 校验，V2 附带发现）
- 首轮报告勘误：DB 默认 timeout=0（非 300s）；cron 5 字段 `*/30` 为每 30 分钟
- 桌面执行器跨平台矩阵、通知渠道真机、私有仓库集成（未覆盖验证项不变）
- prom-client/OTel 正式指标导出（当前为进程内计数 + JSON 端点）
