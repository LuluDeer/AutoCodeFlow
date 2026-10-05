# 升级战役台账（2026-10-05 · 编排者主导多轮推进）

> 形态：项目总监编排 + 每轮 ≤2 subagent 并行 + 文件所有权互斥 + 轮间编排者复验门禁。
> 同源纪律见 UX-UPGRADE-2026-10-05-STATE.md 头部。基线：develop @ c46d88c6。

## 战役范围

以点带面四层推进：admin-web 前端 → executor-desktop → admin-api 服务端 → 双执行器/协议生态。
每轮先审计（只读 Explore）后实施（general-purpose），实施 agent 自跑门禁，编排者复验后提交。

## 轮次与提交

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
