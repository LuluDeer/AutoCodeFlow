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
| I 并发收尾+可观测性 | ⏳ |
| J flake 加固 | ⏳ |
| K RBAC 收尾+清理 | ⏳ |
| L CLI/MCP 补全 | ⏳ |
| V 真机验证 | ⏳ |
| 负责人集成回归 + commit | ⬜ |
| 文档同步 + memory | ⬜ |
