# 下一批（P2 首批 3 项）排期建议

> 背景：2026-11-15 产品/UI 评审的 9 个 P1 已全部落地并回归（详见同目录各切片 report 与 `apps/admin-web/test-results/ux-walkthrough/report.md`）。
> P2 共 16 项，**不整体开工**。本文只排下一批 3 项，等负责人确认后再动。
> 原则沿用本轮：以评审报告为唯一事实源；每片独立可验收；真实浏览器走查（1280/375/暗色）；不 push、不动 main。

## 排序与理由

| 顺序 | 项 | 为什么排这个位置 | 前置依赖 | 预估 |
|---|---|---|---|---|
| 1 | Dashboard 指标分离（口径与数据源） | 项目上下文已贯通，但 Dashboard 目前把「机队/调度全局」与「当前项目」两类指标混在同一屏，用户无法判断哪个数字随项目切换而变。这是**口径正确性**问题，优先级高于纯视觉 | P1-2（已完成） | 1 片 |
| 2 | 执行列表筛选补齐（运行时/触发方式/状态/时间） | 执行记录是排障主入口，现在只能按项目/任务筛；缺时间范围与状态会让「找那次失败」退化成翻页 | P1-1/P1-2（已完成） | 1 片 |
| 3 | 1280 全站视觉回归（间距/字号/密度基线） | 前两项会改动页面结构，视觉回归放在它们之后做，避免返工 | 1、2 完成后 | 1 片 |

## 项 1：Dashboard 指标分离

- **范围**：把 Dashboard 指标区分为「随项目过滤」与「全局口径」两组，逐卡标注口径徽章（全局卡 hover 显示"该指标为机队/调度全局统计，不随当前项目过滤"）；`/metrics/summary` 已支持 `projectId`，全局类指标走不带 `projectId` 的调用。
- **验收口径**：切换顶栏项目后，标注为"随项目"的卡片数值变化、标注为"全局"的卡片保持不变且徽章可见；两组在同一屏内视觉上分区清晰（不靠颜色单一维度区分）。
- **证据**：切换前后同屏截图各一张（1280 亮/暗）+ 数值记录 JSON。
- **风险/回滚**：纯前端分组与文案；后端已有 `projectId` 支持，无需改契约。回滚 = 还原 DashboardPage。

## 项 2：执行列表筛选补齐

- **范围**：执行记录页补「状态、运行时、触发方式、时间范围（起止）」筛选，与项目/任务筛选可组合；筛选进 URL（可分享）；后端 `ExecutionQueryDto` 视需要补 `runtime`/`triggerType`/`from`/`to`（与 P1-2 加 `projectId` 同一条链路）。
- **验收口径**：四种筛选各自单独生效、两两组合生效；清空恢复默认；URL 深链复现同一筛选结果；后端 `findAndCount` 的 `total` 为过滤后总数（不能是"本页行数推断"）。
- **证据**：筛选结果截图（1280/375）+ 组合筛选的行数记录 JSON + 后端 spec。
- **风险/回滚**：后端 query DTO 增量（additive，无破坏性）；openapi 同步需 canonical `swagger:export`（若 WSL 仍不可用，走离线注入并在提交信息里标注待复校）。回滚 = 还原 DTO/service/controller 与前端筛选条。

## 项 3：1280 全站视觉回归

- **范围**：在 1280×800 与 1280×720 两个高度下，对全部页面做间距/字号/密度基线检查，输出「异常页 + 具体偏差（px/字号档位）」清单；只修**明确偏差**，不重排已验收的布局。
- **验收口径**：清单里每条偏差都有前后截图对照；修完复跑全站走查 `pageerror = 0`、body 级横溢 = 0；`check:size-caps` 不新增基线条目。
- **证据**：`report.md` + 前后对照截图目录。
- **风险/回滚**：视觉改动面广但均为样式层；按页面粒度提交，便于单页回滚。

## 未排入本批（P2 其余 13 项）

移动端筛选抽屉、注册中心版本管理、桌面单次终止/版本切换、审计人话化、调度日历/SLA、执行器详情的批量操作、通知中心聚合、SOP 编辑体验、Agent 会话回放、应用详情部署历史、模板市场分类、国际化术语统一、空态插画体系 —— 待本批完成后按"用户痛感 × 改动面"重排。

## 环境备注

- 后端 jest 现可在 **Windows + `E:\software\codingSoft\nodejs\node.exe`（v24.21.0）** 直跑（本轮实测 task 78 套件/1710 例、metrics 12/147、project 3/100、task-template 8/110 全过），不再依赖 WSL。
- **e2e 已跑通**（本轮实测 4 套件全过：auth 12 / executors 11 / tasks 14 / openapi-export 1）。复现方式：
  1. WSL 侧起服务并保持 WSL 存活（`wsl -d Ubuntu -- bash -lc "...; sleep 100000"` 放后台，否则 WSL 空闲回收会带走 PG/Redis）：
     - PG：`pg_ctl -D /home/kirdeer/pgsrv/data -o "-p 5432 -k /home/kirdeer/pgsrv/sock -c listen_addresses=127.0.0.1" start`
     - Redis：`redis-server --bind 0.0.0.0 --protected-mode no --port 6379 --daemonize yes --dir /tmp --save ''`
     - 建库：`psql -h 127.0.0.1 -U postgres -c "CREATE DATABASE autoflow_test"`
  2. Windows 侧（`apps/admin-api`）设 `DB_HOST=127.0.0.1 DB_PORT=5432 DB_USERNAME=postgres DB_DATABASE=autoflow_test REDIS_HOST=127.0.0.1 REDIS_PORT=6379 JWT_SECRET/JWT_REFRESH_SECRET/EXECUTOR_SECRET INITIAL_ADMIN_USERNAME=admin INITIAL_ADMIN_PASSWORD=admin123 AI_PROVIDER=disabled NODE_OPTIONS=--experimental-vm-modules NODE_ENV=test`，先 `npm run migration:run` 建表。
  3. **逐个 spec 跑**（4 个一起跑会把宿主打死，实测一次 exit=-529697949）：
     `& "E:\software\codingSoft\nodejs\node.exe" node_modules\jest\bin\jest.js --config ./test/jest-e2e.json --runInBand test/auth.e2e-spec.ts`（executors / tasks / openapi-export 同理）。
  4. canonical openapi 复校：`ACF_OPENAPI_EXPORT=1` 跑 `test/openapi-export.e2e-spec.ts` 落盘，再 `node scripts/api-i18n/inject-openapi-en.mjs`，最后 `npm run gen:api-types`；本轮实测与已入库版本**语义零差异**（仅键序重排），已按 canonical 形态提交。
- 宿主曾出现 MCE 硬件级错误，WSL 内跑 jest 会崩核，不推荐；Windows 侧跑动态校验（typecheck/单测）应串行、避免多进程并发。
