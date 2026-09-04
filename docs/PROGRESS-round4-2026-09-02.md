# 第四轮深度排查 — 进度追踪与 Agent 指派（2026-09-02）

> 前三轮已把 docs/review_*.md 已知问题清零（518/518 + 79/79 基线，8 commit）。
> 本轮为**全新对抗性排查**：不复用旧清单，从 4 个新维度重新深挖。
> 阶段一（当前）：4 个只读 audit agent 并行产出 findings；阶段二：负责人核实后派 fix agent。

## 基线与纪律

- 起点 commit：`ef635ef`（develop，工作区干净）
- 基线：admin-api 518/518（37 suites）、executor-node 79/79、executor-python 44/44、tsc 全过
- audit agent **只读代码，不改任何源文件，不 commit**；唯一允许写入自己的 findings 文档
- 只跑定向命令（grep/定向 jest），不跑全量 jest、不跑项目级 tsc（避免与并行 agent 干扰）
- 不动 `AGENT_HANDOFF.md` / `docs/review_*.md`（历史轮次文档）

## 阶段一：排查指派（并行 4 路）

| Agent | 维度 | 排查重点 | 输出 |
|-------|------|----------|------|
| R4-A | 安全与授权覆盖 | 全端点 guard 矩阵、@Public 逐个鉴权核实、IDOR/越权、mass assignment（`as any` update 面）、JWT 边界（type/轮换/撤销）、**admin-api 回调 executor address 的 SSRF**、路径穿越、时序安全比较、登录爆破限流、敏感信息落日志 | `docs/review_round4_security.md` |
| R4-B | 并发/事务/数据完整性 | 多表写事务边界、execution 状态机竞态（callback vs timeout vs cancel）、callback 幂等、乐观锁覆盖面、SSE 槽位泄漏（断连/异常路径释放）、无界 Map/定时器泄漏、热查询缺索引、JSONB 无界增长、enqueue 失败兜底覆盖面 | `docs/review_round4_concurrency.md` |
| R4-C | 执行器运行时健壮性 | 子进程组 kill/僵尸、stdout/stderr 洪泛上限、workdir/包/日志磁盘回收、超时强制、崩溃后状态上报、包更新校验-切换-回滚竞态、git 注入白名单回归核实、executor-python 监督、desktop 打包产物同步 | `docs/review_round4_executor.md` |
| R4-D | 跨端契约一致性与测试缺口 | admin-web/CLI/MCP 调用 vs 真实路由+DTO 逐一对账（404/400 风险）、响应 envelope 拆包一致性、枚举/类型漂移、admin-web lint 现状、关键路径测试缺口清单（auth/上传/leader/日志保留） | `docs/review_round4_contract.md` |

## Findings 格式要求（统一）

每条：`[P0-P3] 标题` + `file:line 证据` + 触发条件/推理链 + **confidence: verified/suspected** + 建议修复 + 测试影响。
负责人会逐条核实 verified 项后才派修复；suspected 项需给出验证方法。宁缺毋滥，误报有前科（第二轮曾有 2 项被推翻）。

## 状态板

| 阶段 | 状态 |
|------|------|
| R4-A 安全授权 | ✅ findings 12 条（0 P0 / 2 P1 / 5 P2 / 5 P3） |
| R4-B 并发完整性 | ✅ findings 16 条（2 P0 / 2 P1 / 7 P2 / 5 P3） |
| R4-C 执行器运行时 | ✅ findings 18 条（1 P0 / 5 P1 / 8 P2 / 4 P3） |
| R4-D 契约与测试 | ✅ findings 20 条（2 P0 / 8 P1 / 6 P2 / 4 P3）+ 端点对账全表 |
| 负责人核实 triage | ✅ 5 P0 + 关键 P1 全部坐实（heartbeat 有 per-address token 前置鉴权，F-2 定级维持 P1） |
| 阶段二 fix 派发 | ✅ 7 路（E/F1/F2/G1/G2/H）文件所有权不重叠，全部完成 |
| 集成 seam | ✅ pushToExecutors 接入 assertSafeExecutorUrl；后端删 curlCmd + ExecutorListPage 同步 |
| 回归 + commit | ✅ 5 个代码 commit + docs；基线提升见下 |

## 修复 commit（develop）

| Commit | 范围 | 内容 |
|--------|------|------|
| `d2613d6` | E 调度/任务链 | 触发锁 renew:false 修 watchdog 永久锁死（P0）；依赖链迁入 callback 赢家路径（P0）；backfill append 修丢页（P1）；COVER_EARLY 条件 UPDATE（P1） |
| `b0aa67f` | F1+F2 安全 | RolesGuard 全局 + config/packages ADMIN 收紧（F-1）；heartbeat/register 列注入白名单（F-2/F-7）；assertSafeExecutorUrl 覆盖 dispatch/broadcast/reload/push + 3 通知渠道（F-3）；登录时序（F-4）；callback 限流+token 缓存（F-5）；trust proxy 开关（F-6）；SSE ?access_token= 仅日志流路径；config/history 与 audit QueryDto |
| `f792e10` | G1 python | entrypoint 注入白名单+位置参数（P0）；日志 10MB/64MB 上限；回调重试退避；git 缓存盐；14 项 |
| `f0f61e5` | G2 node | callback ≤100 分片+dead-letter；env 白名单（token 不透传）；NODE_PATH；BoundedLogBuffer；TTL 磁盘回收；共享下载器（Bearer+deadline）；spawnSync→async；进程组 kill；13 项 |
| `75c8d2b` | H 客户端 | CLI accessToken；编辑不发 name；安装向导走 install-cmd；下载带 auth；AI 字段；SSE 参数名；trigger executorId 移除；9 项 |

新基线：admin-api **605/605（45 suites）**、executor-node **119/119**、executor-python **86/86**、三端 tsc ✓、admin-web lint 0 errors（5 warnings 基线不变）。

## 遗留（写入 AGENT_HANDOFF 供下轮）

- 依赖扇出双触发窗口（两上游同时成功时 checkDependencies 可双判满足，建议短窗 DB claim）；checkDependencies find 无 take
- storeLogLines 多行写无事务包裹（append 中途失败旧行清空风险与原实现同级）
- audit 端点是否 ADMIN-only 待产品决策；admin-web 无角色路由门控（普通用户可见 settings/packages 页但操作 403）
- install-token 端点成孤儿能力（无消费方）；install.sh 未实现（curlCmd 已删）
- executor-node 全量首跑出现 1 例时序 flake（后续 4 连跑全绿，疑 file-logger 200ms flush 或 download 本地服务器用例），待观察
- admin-web 包管理 type 筛选项含后端枚举外 java/shell（P3）
- 真机验证类（第三轮结转）：Leader Election 双实例、LOG-11 S3 E2E、负载均衡实测、桌面跨平台矩阵
