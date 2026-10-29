# 八域并行审计（2026-10-29 · 第 6 轮）

> 由 8 个子代理并行只读审计产出（运行时并发上限 8）。原始返回见 `raw-workflow-output.txt`（末尾被工具输出截断，agent 域最后几条缺失）。

共 43 条发现：
P1 4 / P2 26 / P3 13

## apps/admin-api/src — task / executor / application / auth / guards（并发·事务·幂等·鉴权·错误处理·资源泄漏）

| 严重度 | 发现 | 位置 |
|---|---|---|
| P2 | 任务 webhook 的幂等键在「触发之前」占位：trigger 失败后上游重投被静默吞成 deduplicated，任务永久不执行 | `apps/admin-api/src/modules/task/task-webhook.service.ts:323` |
| P2 | 广播执行的槽位冲销在重复回调分支不幂等：同一台执行器的 runningTaskCount 会被重试回调重复减 1 | `apps/admin-api/src/modules/task/task.service.ts:5911` |
| P2 | 按地址冲销槽位走标量子查询，ADR-017 同址多行时抛 PG 21000 并打断 COVER_EARLY 触发与回调终态主链 | `apps/admin-api/src/modules/task/block-strategy-gate.ts:161` |
| P3 | ExecutionWakeService.waiters 在等待超时后不删除 Map 条目，执行 id 键无界增长 | `apps/admin-api/src/modules/task/execution-wake.service.ts:145` |
| P3 | 机器面限流桶键取客户端可控的 x-executor-address：每个请求换一个值即得无限 60/min 桶，限流形同不存在 | `apps/admin-api/src/common/guards/executor-aware-throttler.guard.ts:136` |

## apps/admin-web（React 18 + antd + vitest）— UX / 可访问性 / 性能 / i18n 审计

| 严重度 | 发现 | 位置 |
|---|---|---|
| P2 | SOP 详情抽屉切换条目时残留上一条的版本/指派/澄清，失败时永久串数据 | `apps/admin-web/src/pages/SopsPage.tsx:241` |
| P2 | URL 续跑/切换会话后草稿表单不回填：保存的是空白或上一个会话的内容 | `apps/admin-web/src/pages/SopFromVideoPage.tsx:100` |
| P2 | 日志 JSON 行的「点开美化」只有鼠标可达：role=button + tabIndex 却无键盘激活 | `apps/admin-web/src/components/LogWindow.tsx:138` |
| P3 | 翻译词条后的全角标点写死在 JSX：英文界面渲染出中文冒号/括号 | `apps/admin-web/src/pages/UserManagementPage.tsx:547（同型 15 处）` |
| P3 | 产物清单把加载失败渲染成「没有产物」：整段静默消失，无错误态无重试 | `apps/admin-web/src/components/ArtifactsList.tsx:34` |
| P3 | 每次重渲染都把整份日志重新 split：搜索框每敲一个字就切一遍 MB 级文本 | `apps/admin-web/src/components/ExecutionLogSection.tsx:400` |

## executor（node + python）健壮性与跨端一致性审计（只读）

| 严重度 | 发现 | 位置 |
|---|---|---|
| P2 | git prepare 超时只杀直接子进程：孙进程成孤儿并继续写共享 .git_cache（node 侧走整树杀） | `apps/executor-python/routers/execute.py:386-395` |
| P2 | packageUrl 重定向复检忽略 allow_private_network：内网拓扑在同主机 302 后必然失败（node 同场景成功） | `apps/executor-python/routers/execute.py:2085-2088` |
| P2 | 内存上限语义分叉：python RLIMIT_AS 是每进程、node 看门狗是整棵进程树，fork 即可突破 2GB 预算 | `apps/executor-python/sandbox.py:147-149` |
| P3 | gitRepo 的 SSRF 闸仍只有裸正则：169.254.169.254 / [::1] / 0.0.0.0 / 100.64 全部放行（两端同款） | `apps/executor-python/routers/execute.py:4137-4145` |
| P3 | zip 驱动器相对条目两端结论不一致：python 判 drive_letter_path，node 放行或判 zip_slip | `apps/executor-python/zip_safety.py:186` |
| P3 | secret 名闸用 .match + `$`，尾随换行可通过：python 注入一个带 \\n 的 env 名，node 同载荷拒绝并 warn | `apps/executor-python/secret_env.py:71` |

## executor-desktop 主进程（apps/executor-desktop/src/main：agent-host / requeue-ledger / agent-worker 托管 / updater / package-candidate / ipc）

| 严重度 | 发现 | 位置 |
|---|---|---|
| P2 | claim ledger 对账把「本轮没返回」一律当终态：被 resend 的 id 或 payload 构造失败的单会被静默抹掉锚点 | `apps/executor-desktop/src/main/agent/agent-host.ts:411 (配合 :222、:412 与 agent/requeue-ledger.ts:137)` |
| P2 | updater 的 cancelRequested / installRequested 是只由 error 事件复位的模块级标志，任一路径漏事件就永久粘住并吞掉后续真实错误 | `apps/executor-desktop/src/main/updater.ts:425 (声明 :290 / 置位 :527、:552 / downloadUpdate :492-511)` |
| P2 | AgentWorkerHandle.withdraw() 没有超时，卡住会把 agentHostReady 与 agentTickPromise 永久钉死——托管静默变砖 | `apps/executor-desktop/src/main/agent-worker-process.ts:221 (配合 index.ts:392、:456-463 与 src/agent-worker/main.ts 的 withdraw 分支)` |
| P2 | 候选包 manifest.yaml 的 entrypoint 直接拼接 LLM 可控文件名：换行即可向平台清单注入 YAML 键（绕过「LLM 不可覆盖 manifest」的闸） | `apps/executor-desktop/src/main/agent/package-candidate.ts:71 (rel 来源 :54/:66；写入面 workspace.ts:206)` |
| P3 | config:import 绕过了 config:save 的 workDir 落盘校验（P3-5 的闸只装在两处写入面之一） | `apps/executor-desktop/src/main/ipc-handlers.ts:829 (对照 config:save 的 :637-643)` |
| P3 | log:read / apps:log:read 的增量读按「整段新增字节」一次性 allocUnsafe，没有单次读取窗口上限 | `apps/executor-desktop/src/main/ipc-handlers.ts:396 (length 计算 :389)` |

## 数据库/查询层（apps/admin-api：migrations、entities、modules/*/*.service.ts 查询）

| 严重度 | 发现 | 位置 |
|---|---|---|
| P1 | execution_log_lines 按 createdAt 分区，但所有读路径都只按 executionId 过滤 → 无分区裁剪，日志读成本 × 分区数 | `apps/admin-api/src/modules/task/task.service.ts:4255` |
| P2 | GET /tasks/executions/all 的 taskName / executorAddress 过滤器是 %…% ILIKE，全库无 pg_trgm，等于对 90 天执行历史做全表扫 + JOIN + Sort + 重复 COUNT | `apps/admin-api/src/modules/task/task.service.ts:3538` |
| P2 | sop_clarifications 无 resolution 索引，5 分钟一次的兜底扫描在永久增长的澄清表上做全表扫 + Sort | `apps/admin-api/src/modules/sop/sop.service.ts:1578` |
| P2 | sweepStuckClarifications 是 2×N 串行点查（N≤100）：逐行 agent_sessions.findOne + 逐行 sop_assignments.findOne，同一 tick 最多 200 次串行往返 | `apps/admin-api/src/modules/sop/sop.service.ts:1595` |
| P2 | 包引用计数按 jsonb `snapshot ->> 'packageUrl'` 与未索引的 applications.packageUrl 做全表扫（application_versions 无保留期） | `apps/admin-api/src/modules/application/application.service.ts:522` |
| P3 | 改名别名重写用 `dependencies @> {...}`，命中不了 0053 建的表达式 GIN 索引，且 getMany 无界取整行 | `apps/admin-api/src/modules/task/task.service.ts:1800` |

## 可观测性审计（只读）：apps/admin-api/src/modules/metrics + common/metrics + config/monitoring/alerts.yml + docs/observability + SSE 控制器

| 严重度 | 发现 | 位置 |
|---|---|---|
| P1 | cronSlotsMissed 从未导出到 Prometheus 且无告警——10-28 丢点事故的唯一直接信号仍是 JSON-only | `apps/admin-api/src/modules/metrics/prometheus-metrics.service.ts:421` |
| P2 | 汇总流槽位（/metrics/stream + /executions/stream）拒绝不计数、limit 延迟发布、且无任何告警——32 槽打满时监控面全静默 | `apps/admin-api/src/modules/metrics/metrics-stream-slot.service.ts:49` |
| P2 | 两条 SSE 控制器 catch 块为空、logger 声明后从未使用：流死亡零日志、错误帧无原因 | `apps/admin-api/src/modules/metrics/metrics-stream.controller.ts:160` |
| P2 | 快照单飞 TTL 从「开始」计时：慢查询下并发累积，SSE 连接数级 30 天聚合重新打回 PG | `apps/admin-api/src/modules/metrics/metrics-snapshot.service.ts:47` |
| P2 | autoflow_agent_tokens_total 的 provider/model 是用户可配的任意字符串，无钳制 → 无界基数 | `apps/admin-api/src/modules/metrics/runtime-metrics.ts:269` |
| P3 | AUTOFLOW_ALL_EXECUTORS_OFFLINE 的 description 用了聚合后不存在的 $labels.instance，$value 被当成总数 | `config/monitoring/alerts.yml:434` |

## CI / 守卫 / AI 文档真实性（.github/workflows、scripts/check-*.mjs、docs/*.md、docs/atlas）

| 严重度 | 发现 | 位置 |
|---|---|---|
| P1 | check-guards-wired 判据①② 用整份 workflow 文本做子串匹配（不是 run: 段），守卫「只出现在 step name / env / artifact path 里」即被判为已接线 —— 可构造误绿 | `scripts/check-guards-wired.mjs:511` |
| P2 | docs/atlas/07-testing/admin-api-testing.md 的覆盖率地板数字比真实配置低一整档（75/69/84/84 vs 76/81/88/87），无守卫覆盖 | `docs/atlas/07-testing/admin-api-testing.md:26` |
| P2 | 测试规模数字严重过期：admin-api 147 个 spec（实际 390）、admin-web 74 个测试文件（实际 256），且这两页不在任何计数守卫的扫描面内 | `docs/atlas/07-testing/admin-api-testing.md:31` |
| P2 | atlas 的「索引页/侧页」自述数字整体过期（MCP 40 个工具→实际 56、acf 39 个子命令→实际 69、e2e-full.sh 43 例→实际 51、scripts/ 78 个文件→实际 125），守卫只钉详情页 | `docs/atlas/05-interfaces/README.md:79` |
| P2 | scripts/reset-admin-password.selftest.sh 从未被任何门禁执行（唯一调用方 demo.selftest.sh 也没接线），check-guards-wired 看不见非 check-*.mjs 的自检 | `scripts/reset-admin-password.selftest.sh:1` |
| P3 | admin-web-lighthouse job 级 continue-on-error 永久静音 lighthouserc 里的 error 级无障碍/控制台断言（注释承诺「建立基线后收严」，无可追踪的到期项） | `.github/workflows/ci.yml:638` |

## Agent 运行时（apps/admin-api/src/modules/agent）对照 langgraph/langchain 的架构差距审计

| 严重度 | 发现 | 位置 |
|---|---|---|
| P1 | 写/危险工具在执行前没有任何在途台账，且调用无幂等键：崩溃恢复后必然重放同一副作用 | `apps/admin-api/src/modules/agent/tools/tool-executor.service.ts:507-528` |
| P2 | 恢复时的上下文是「有损重渲染」：工具结果按字符前缀截断（截断行的 full 被切成非法 JSON），因审批跳过的调用被重渲染成 denied | `apps/admin-api/src/modules/agent/runtime/agent-runtime.service.ts:1073-1078` |

