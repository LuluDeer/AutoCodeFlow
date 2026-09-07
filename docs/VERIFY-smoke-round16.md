# VERIFY-smoke-round16（2026-09-07 03:0x，真机冒烟）

> 依 ADR-008 / docs/VERIFY-MATRIX.md：本轮 admin-api 触达了 **迁移链 + 调度指标 + 日志存储** 三类必跑变更类型，凌晨在本地 Windows 栈（WSL2 PG16 + Redis7，localhost:5432/6379）做了真机冒烟。
> 冒烟脚本入库：`scripts/smoke-round16.mjs`（SMOKE_USER/SMOKE_PASSWORD 环境变量驱动，可复用于后续轮次）。

## 环境

- admin-api：develop @ 批八后（含 FEAT-01 silences 迁移 / CORE-06 直方图 / BUG-05 gauge / BUG-06 storeLogLines / BUG-10 枚举），`node dist/main.js`（nest build 后）
- DB：既有开发库（38 任务存量、队列 19 积压 job——非空库，恰好验证存量续跑）

## 迁移链

- `typeorm migration:run`：6 条 pending 全部成功——含本轮 `CreateNotificationSilences1789100000000`（真 PG 建表+双索引）与并行会话的 `AddTaskMaintenanceWindows1789200000000`
- 迁移序被 `migrations.spec` 时间戳守卫约束，1789100000000 > 1789200000000 是命名序非执行序——实际执行按时间戳升序，无冲突

## 运行时断言（13/13 PASS）

| 断言 | 结果 | 备注 |
|---|---|---|
| 登录换 accessToken | ✅ | 临时 smoke-admin（跑后即删，不动既有账号） |
| POST/GET/DELETE /notification/silences | ✅✅✅ | FEAT-01 真 DB 往返；scope=task + durationMinutes 折算 |
| fixed_rate 触发延迟 count > 0 | ✅ | **CORE-06 端到端生效**：新建 5s 任务经分钟级 reload 收编后触发，首批延迟落 50ms 桶 |
| triggerLatencyBuckets 8 桶对齐 | ✅ | [0,1,1,1,1,1,1,1]（首触发 50ms） |
| derived p99TriggerLatencyMs | ✅ | p99=50 |
| Prometheus 渲染 latency bucket/sum/count | ✅ | 含 le="+Inf" |
| Prometheus 渲染 sse_streams_active/limit | ✅ | BUG-05 gauge |
| manual 触发入队（无执行器 → 队列/补偿路径） | ✅ | PENDING 行产生，队列健康 |
| 清理：pause + 软删 smoke 任务 | ✅ | |

## 冒烟过程抓到的坑（脚本侧，已修）

1. **全局前缀**：`/health`、`/metrics/scheduler` 实际为 `/api/health`、`/api/metrics/scheduler`（setGlobalPrefix("api")）——文档/脚本写路径时必须带前缀。
2. **响应形状**：/api/metrics/scheduler 的快照在 `data.counters.*`（派生值在 `data.derived.*`）。
3. **Prom 端点是 text/plain**——用 res.json() 解析会静默变 null。
4. **新任务调度注册要等分钟级 reload**（scheduleOne 仅 Leader 执行；TaskService.update 直调，create 路径依赖 reload 收编）——轮询等待而非固定 sleep。

## 遗留

- 无执行器在线：任务执行全链（派发→回调→槽位释放）未在本轮冒烟覆盖，由既有 e2e-full（29 例）与后续带执行器真机轮覆盖。
- smoke 脚本可扩充：带一个 executor-node 注册后的全链断言（下一轮真机轮候选）。

## 二阶段：executor-python 全链（03:5x-04:1x）

拉起本地 executor-python（uvicorn :8001）对真 admin-api 注册，验证全链。**抓到两枚真 bug 并当轮修复**：

| # | 缺陷 | 根因 | 修复 |
|---|---|---|---|
| V16-1 | 裸机 `.env` 部署下 executor-python 静态 token **静默为空**（注册/心跳全 401，REQUIRE_TOKEN=true 下直接拒服） | `auth._get_static_token` 用 `os.environ` 直读——pydantic-settings 从 .env 读入的值**不进 os.environ**；Docker（真环境变量）一直正常，裸机 .env 部署必踩 | auth.py 优先级链改为：真环境变量 > settings（.env）> 空；conftest 补封闭性守卫（开发者本机 .env 不泄漏进用例）；executor-python 206/206 |
| V16-2 | 无 Authorization 头的心跳令 admin **500**（`validateTokenByAddress` 对 undefined 直接 `Buffer.from`） | presented 无空值守卫 | fail-closed 返回 false + 回归用例（undefined/空串）；admin-api 1228/1228 |

另一处环境语义发现（W-22 家族变体）：admin-api 的 dotenvx 注入为 **override:true**——`.env` 值会覆盖 shell 注入的同名环境变量，本地调试时 `EXECUTOR_SECRET=x node dist/main.js` 的显式注入会被 .env 空值清掉。已在 VERIFY 记录，容器部署不受影响。

## 全链断言

- 注册：executor-python → admin `Registered to admin-api` ✅（修复后）
- 派发→执行→回调：python glue 任务 `success`，日志回传 `smoke full chain` ✅
- gl ue 任务 requirements 清零语义确认（W-21）：坏 requirements 的 glue 任务跳过安装直接成功——BUG-10 依赖路径的真链验证需 entrypoint+git 仓库夹具，留下一轮真机轮
- runtime DTO 白名单（python/node/shell）拦住 runtime_missing 的 API 侧构造 ✅（分类器由单测覆盖）
- 清理：smoke 任务软删、probe 执行器行删除、smoke-admin 用户删除、进程停止

## 本轮变更（双修复提交）

- executor-python：auth.py + conftest.py + test_auth.py（3 例语义更新）
- admin-api：executor.service.ts presented 守卫 + spec +1
