# 升级战役台账（2026-10-05 · 编排者主导多轮推进）

> 形态：项目总监编排 + 每轮 ≤2 subagent 并行 + 文件所有权互斥 + 轮间编排者复验门禁。
> 同源纪律见 UX-UPGRADE-2026-10-05-STATE.md 头部。基线：develop @ c46d88c6。

## 战役三（同日三续：能力补全 + 维护性 + 治理面）

| 轮 | 内容 | 提交 |
|----|------|------|
| R11 | acf-cli 剩余五组命令：app upload（multipart/300s 预算）/app upgrade-all 灰度（canary 1-100，缺省零 body 全量语义逐字节保持）/task webhook 四动作/task glue 热更新（js→javascript 推断对齐执行器白名单）/approval 四子命令（DEP-04），30 新用例，叶子护栏 50→58；admin-web TaskFormPage 拆分 2170→889 行（11 新文件，机器级行为保持：键集/testid/aria diff 为空），顺带记录 4 个既有疑似 bug | 44667f91 / 7d66a9b0 |
| R12 | 第四批审计（infra/scripts/examples/docs-site/CI）：7 发现 0 P0/P1；admin-web 既有 bug 四连修——**语言切换重灌编辑态可冲掉未保存修改（P1，修前三断言面实测全红）**/t 遮蔽/setTimeout(50) 魔法延时/注释自引 | 82966e19 |
| R13 | 观测栈：同源守卫三面化（alerts+dashboard PromQL+阅读版走同一指标清单，修提取器数字字面量负例）/grafana 看板自动 provisioning；治理：compose-sandbox+install-sha256 进 CI gates、control-plane-pull 进 selftests、docs-site 版本漂移 1.5.3→1.8.0+sync-check 纳入 acf-cli、删 2 死脚本、scripts.md 32→78 | cf284212 / 5d507426 |

战役三门禁：acf-cli vitest 243 绿+双 typecheck；admin-web vitest 201 文件/1561 用例绿+lint/i18n/build 绿；test:alerts 三面全绿；docs-site sync-check 七面无 drift；ci.yml yaml 解析通过（36 jobs）。

## 全天总结（三战役 13 轮 / 22 提交）

覆盖八层：admin-web UI/UX→desktop→admin-api→双执行器→协议 SSOT→CLI/MCP/SDK→部署面→可观测性/CI 治理。
新增测试 250+（admin-api 4567 / admin-web 1561 / CLI 243 / MCP 152 / python cov 93.9% / node 1045+）。
关键真 bug 修复：HA 触发配置漂移不生效（F-1）、py 超长行僵尸槽位、CLI TOTP 登录死角、语言切换冲掉未保存修改、deploy.sh python 探测 45s 白等。

## 战役三遗留（下轮候选）

> **2026-10-07 状态标注**（防按旧文档重复排任务）：#1 已在 5969565d 清掉
> （幂等复跑零 diff 复核）；#3 已文档化登记（40bd93a8，deployment.md Windows
> §4b）；#4 已实施（1514b91b，history-watcher）；#5 已真机收口
> （VERIFY-2026-10-07-cli-totp-pty-smoke.md——顺带抓出并修复 CLI/mcp 默认
> URL 缺 /api 前缀的 P1）；#6 已升级实施（8aa98dfb，实扫抓出 2 条真漂移并
> 修正）。仍开放：#2（需产品拍板）、#7（破坏性需 deprecation 周期）。

1. **openapi.json 重导出**（需 DB+Redis 环境；导出后必须 `check-openapi-response-schema.mjs --update`，否则 CI drift 红）——战役一遗留，仍是首项。
2. **升级灰度的 --version 语义**：UpgradeAllDto 不收 version（CLI 已在 help 注明）；若产品需要「指定版本灰度」，服务端先立 DTO 任务。
3. **python win32 内存上限**（Job Object，L）或文档化登记。
4. **desktop getHistory 推送化**（M，收益中低）。
5. **CLI TOTP 交互路径**一次真机 smoke（vitest 无法驱动 TTY）。
6. docs/observability/alerting-rules.yml 阅读版若要语义级对账需升级解析器（现只做存在性+指标名）。
7. `--json` 语义冲突（task create 的 --json=载荷 vs 全局输出 JSON）——破坏性需 deprecation 周期。

## 战役二（同日续推：协议生态 + 末层 + UX 拓展）

| 轮 | 内容 | 提交 |
|----|------|------|
| R8 | 协议 SSOT 补全：ExecutionCallback/CallbackArtifact 收编 protocol.json（双端分歧如实收编零语义改动），双生成器接线为唯一入队口 warn-only 对账闸，补 secrets 16 条运行时语义向量/LogsResponse unicode·CRLF·空行样本/回调 6 valid·12 invalid/日志切分 6 条字节级向量；bundle 重打回填；PROTOCOL_VERSION 不 bump（纯增量登记） | 01137b88 |
| R8 | 末层审计（acf-cli/mcp-server/双 SDK/deploy 面）：P1=CLI login 不支持 TOTP（TOTP 用户完全无法用 CLI）；P2=CLI/MCP 双缺任务导入导出、批量面、api-keys、应用包上传、灰度发布；P3=level 过滤、模板绕开 CORE-03、webhook CLI、deploy.sh health 陷阱等 8 项；compose 52 变量确认零残留漂移 | — |
| R9 | acf-cli 能力包：login TOTP 二段验证（--code 供 CI）/task export\|import（逐字透传）/task batch 四动作（部分失败 exit 1）/apikey create\|list\|revoke/set-token 安全提示，32 新用例，ux-uniform 叶子 44→50；mcp-server：export_task/import_task/get_execution_logs level 过滤/create_task_from_template 改走 CORE-03（删本地硬编码副本）+list_task_templates，49→52 工具 | b90d2d6a / b4f06ca7 |
| R10 | deploy.sh：health 补 executor-python 探测并设退出码（可作 CI 闸）/logs 组件白名单/**verify_phase python 探测改真实存在的 /health（旧 /health/live 恒 45s 超时白等）**，selftest 34→47；admin-web：useGlobalHotkeys（? 速查/g+键五路跳转，输入态/弹层全护栏）+ShortcutHelpModal+TaskListPage 列设置（localStorage 隐藏集，列宽契约不动），25 新用例 | b99fbe3e / ee50b673 |

战役二门禁：check:desktop-bundle-drift 绿（c6f06940…）；check-failure-reasons 绿（15/12）；acf-cli vitest 212 绿+mcp vitest 152 绿+双 typecheck；deploy selftest 47/47；admin-web vitest 199 文件/1553 用例绿。

## 战役二遗留（下轮候选）

1. **应用包上传 CLI**（`acf app upload`）与**灰度发布 CLI**（`acf app upgrade-all --strategy canary`）——P2 审计项，M 工作量，本轮未排。
2. **webhook 管理/glue 热更新 CLI 面**（P3/S）与 **DEP-04 审批 CLI**（P3/S，MCP 已闭环）。
3. **`--json` 语义冲突**（task create 的 --json=载荷 vs 全局输出 JSON）——破坏性需 deprecation 周期。
4. **python win32 内存上限**（Job Object，L）或文档化登记。
5. **desktop getHistory 推送化**（'history:changed' 替代双页 10s 轮询，M，收益中低）。
6. **openapi.json 重导出**（战役一遗留，需 DB+Redis 环境；导出后必须 `check-openapi-response-schema.mjs --update` 刷基线）。
7. CLI TOTP 交互路径（TTY 真人输码）建议一次手工 smoke（vitest 无法驱动）。

## 战役一（上午轮次）

## 战役范围

以点带面四层推进：admin-web 前端 → executor-desktop → admin-api 服务端 → 双执行器/协议生态。
每轮先审计（只读 Explore）后实施（general-purpose），实施 agent 自跑门禁，编排者复验后提交。

## 战役一轮次与提交

| 轮 | 内容 | 提交 |
|----|------|------|
| R1 | 双审计：admin-web（UI/UX+代码健康+i18n+性能）、desktop（遗留核对+死代码+拓展点） | — |
| R2 | admin-web 体验包：monaco 懒加载独立 chunk（≈2.6MB 移出首屏，PERF-01 守卫绿）/ExecutorDetailPage 补 PageHeader/四列表页 PageSkeleton/执行记录 CSV 导出/formatBytes 收敛；desktop 修复包：更新可用即 notifyUpdate+同版本去重/托盘「检查更新+打开日志文件夹」/隐藏页轮询门控（Apps 2s/History 1.5s+5s）/heartbeat 停止后在飞探针不误报离线（真实行为面自测）/托盘启停互斥/死样式两组+失真注释/preload 补 previouslyDownloaded | fb9cdfcb / d1ce05cb |
| R3 | admin-web a11y 包：useDrawerA11y 焦点管理落四页/STATUS_COLOR 七张映射收敛 utils/status-color.ts（取值零变化）/图标按钮 aria-label 3 处残留（其余经核已覆盖，dashboard 硬编码 hex 审计快照过时——实读零命中未动）；desktop i18n 二期：真实残留 27 处迁双语表（此前 STATE 估计已过期），N-04 守卫泛化，zh 逐字节零变化 | 0466348e / 9599920f |
| R4 | 双审计：admin-api（TODO 零债/吞错均有对账出口；真缺口 6 项+拓展 2 项）、双执行器+协议（双端 8 处不一致+协议 SSOT 盲区） | — |
| R5 | admin-api 修复包：F-1 HA 触发配置漂移对账（SCHEDULER_RECONCILE_EVERY 指纹重排，spec 钉第 N 轮才重排）/F-2 keyset 游标防漏扫/F-3 NEVER_DISPATCHED/F-4 日志行 512KB 上限/F-5 env 14 键+AGENT_MEDIA_RETENTION_DAYS 收口/F-6 openaiMaxTokens 可配；执行器双端一致性：py 超长行收尸(limit=1MB 对齐 node BoundedLogBuffer)+停机排水守卫 503+uv 树杀(+setsid)+背压 warn 对齐，node timeoutSeconds 三键别名+sandbox_unavailable 归因+spawn 期分类+截断 marker 对齐 admin 正则；bundle 同 commit 重打回填（①② 双闸） | 06e1f983 / eebd854f |
| R6 | admin-api 任务定义导入/导出（E-1）：export 快照 JSON+secrets 三层红线（白名单整键剔除/递归扫描 fail-closed/脱敏读路径）/import 重名后缀不覆盖+paused 创建+审计 task.import，25 用例+api-reference 契约节；desktop 配置导入/导出+执行日志导出：掩码配置落盘（明文误喂运行时炸出）/导入走既有 sanitize 链+掩码 token 不覆盖（双层自测钉住）/查看器日志 copyFile（200MB 上限引导） | a2150d73 / e86c0549 |
| R7 | 文档收尾：本台账 + STATE.md 落地偏差勘误 | 本提交 |

## 门禁记录（编排者复验）

- R2：typecheck:web/desktop 绿；desktop test:main+test:renderer EXIT=0；admin-web vitest 196 文件/1528 用例全绿。
- R3：typecheck 双绿；lint:i18n 绿（zh/en 2777 对齐）；desktop test:main/renderer EXIT=0。
- R5：check:desktop-bundle-drift 绿（digest e9742d8d…）；admin-api 4542 测试绿（覆盖率 branches 78.59/functions 82.82/lines 90.1 全超线）；executor-python pytest 全绿（cov 93.85%）；executor-node jest 1005 绿+build 绿。
- R6：typecheck:api/desktop 绿；check-openapi-response-schema 绿（70/219 无倒退）；admin-api 4567 测试+cov 全绿；desktop 全 selftest EXIT=0。

## 已知遗留（下轮候选，按价值排序）

1. **openapi.json 重导出**：R6 新端点注解已齐，swagger:export 需 DB+Redis；下次导出后须 `check-openapi-response-schema.mjs --update` 刷基线（70→72），否则 CI drift 闸红。
2. **协议 SSOT 补全（P2/M）**：ExecutionCallback 载荷不在 protocol.json（双端手写）；secrets/unicode 日志向量盲区。
3. **admin-web 列自定义**：TaskListPage 16+ 列收纳（需自研 columnSetting，M）；TaskFormPage 2170 行拆分（P3 渐进）。
4. **CommandPalette 快捷键拓展**：`?` 速查/g+d 跳转（已有 command 注册结构）。
5. **python win32 内存上限**：Job Object（L）或先文档化登记。
6. **desktop getHistory 推送化**：'history:changed' 替代双页 10s 轮询（M，收益中低）。

## 纪律注记

- R5 的 F-4 上限取 512KB 而非审计建议的 65536：LogStreamPusher 按 stdout 原始行推送、
  无单行截断，>64KB 行合法且 400 会拒整片丢 99 邻居行——对齐既有 CallbackItemDto.logs 量级。
- 执行器 agent 附带修复 3 个既有 _FakeUvProc 用例（树杀需 pid）；node 失败分类新增
  failureReason 来源会改变 admin 侧按该字段的聚合口径（BUG-10 对齐的正向副作用）。
- 桌面 i18n 迁移零 zh 字节变化是 e2e 安全的充要条件，已用 esbuild 全仓扫描+18 处抽查双证。
