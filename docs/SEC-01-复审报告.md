# SEC-01 复审报告（DEEP_REVIEW_0beef76 待补证五项）

> 对应 [DEVELOPMENT-PLAN-2026-09.md](./DEVELOPMENT-PLAN-2026-09.md) §8 SEC-01 / §2.3 BUG-13~16 + BUG-12。
> 复审对象是 0beef76 报告 B 节「低覆盖模块专项」的待补证检查项；方法 = 调用链走读 + 契约核对 + 修复/测试补强。基线 develop @ 43d42c8（会话 B 在途前）。

## 结论总表

| 模块 | 审项 | 结论 | 动作 |
|---|---|---|---|
| acf-cli | BUG-13 认证传递/降级/重试 | **2 项缺陷已修**（F1 refreshToken 丢弃、F2 token 创建时烘焙）| 客户端刷新自愈落地 + 6 专项测试 |
| mcp-server | BUG-14 鉴权链 | **1 项缺陷已修**（access token 15m 过期 = 长驻进程死透）| 可选 refresh 自愈 + 6 专项测试 |
| node-sdk / autoflow-sdk | BUG-15 降级/重试/错误传播 | **2 项不对称已修**（文档谎称 retry、failureReason 白名单缺 stale_recovered）| 修正 + 回归 100/100 |
| registry-npm | BUG-16 下载路由/token 边界 | **无缺陷**（S-09/R8 姿态完整）| 2 条注记（死配置键 / JWT 60d）|
| executor-desktop | BUG-12 凭据存储/IPC/子进程 env | **1 项新发现**（executorToken 明文落盘）| 登记为新任务 SEC-NEW-1，见下 |

## 详细发现与处置

### F13-1 / F13-2（acf-cli，已修 @ 本批 commit）

- **F13-1 refreshToken 丢弃（P2）**：`login.ts` 拿到 `{ accessToken, refreshToken }` 后只存前者——access token 默认 `JWT_EXPIRES_IN=15m`，此后全部命令 401，唯一出路是重新 `acf login`。CLI 是脚本化工具，CI/定时场景下等于"每 15 分钟必坏"。
- **F13-2 token 创建时烘焙（P2）**：`client.ts` 在 `axios.create` 时把 `getToken()` 写死进默认头——同进程内任何凭据轮换（login 切换、未来刷新）都不会生效。
- **处置**：config 新增 refreshToken 存储与 `clearAuth()`；client 改为**逐请求读取 token**（request 拦截器）+ **401 单飞刷新自愈**（`/auth/refresh` 换发双 token → 重放原请求一次；并发 401 共享单次刷新；`/auth/*` 自身不触发；刷新失败 `clearAuth` 后抛 401 文案）。与 DR-06「非幂等不自动重试」不冲突：重放只发生在请求从未进入业务层的认证态。
- 测试：`client.test.ts` 重构拦截器捕获 harness，+6 用例（刷新重放/双 token 轮换入库/刷新失败清凭据/无 refreshToken 快速失败/auth 路径豁免/并发单飞/非 401 不动）。acf-cli **59/59**。

### F14-1（mcp-server，已修 @ 本批 commit）

- **长驻进程 token 过期死锁（P2）**：MCP server 常驻（stdio），`AUTOCODEFLOW_API_TOKEN` 是 15m 寿命的 access token——过期后所有工具永久 401，只能人工重启换 token。AI Agent 集成场景下这是最长的失效窗口。
- **处置**：`AUTOCODEFLOW_API_REFRESH_TOKEN`（可选）启用后，401（`/auth/*` 除外）触发单飞刷新 + 单次重放；admin refresh 是原子轮换（DR-07），轮换出的新 refreshToken **保存在内存**供进程生命周期内持续自愈（不落盘，重启重新注入 env）。`--help` 已补 env 说明；`AUTOCODEFLOW_API_TOKEN` 仍为必填（缺省 fail-fast 姿态不变，W-07 保留）。
- 测试：+6 用例（含"第二轮过期必须用内存中轮换后的 refreshToken"的关键断言）。mcp-server **46/46**。

### F15-1 / F15-2（双 SDK，已修 @ 本批 commit）

- **F15-1 文档谎言（P3）**：py `HttpClient` docstring 声称 "with basic retry logic"，实现**从未有过重试**——sdk-guide 教训（python 判据照写即 AttributeError）同型缺陷，照抄文档的任务代码会误信重试语义。已改为如实描述（无自动重试 + 非幂等方法永不隐式重试）。
- **F15-2 failureReason 白名单不对称（P3）**：admin 枚举 P2 起新增 `stale_recovered`（DTO `@IsIn(Object.values(...))` 接受），py SDK `VALID_FAILURE_REASONS` 白名单未跟进——py 侧上报该分类会被客户端拒绝而 node 侧放行（node 无白名单，passthrough）。已补齐并标注同步义务。
- **降级语义核对（无缺陷）**：`enabled/disabled_reason` 双端对等（U14 后）；py `report` 失败抛 `_status_error`（HTTPStatusError + envelope 明细），node 抛 axios 错误——错误类型各有文档；信封拆包双端对等。
- 回归：autoflow-sdk **100/100**。

### BUG-16 registry-npm（无缺陷，注记 2 条）

- `access: $authenticated` 覆盖 `@autoflow/*` 与 `**` 全部 pattern（S-09）——匿名拉取/元数据探测均 401；publish/unpublish 同收紧。
- htpasswd 落持久卷（R8），`max_users: 100` 上限；`max_body_size: 100mb` 显式；对外暴露面收敛在 compose ports/防火墙（README 有加固章）。
- 注记 ①：`security.api.jwt.verify.someProp: []` 是 verdaccio 文档示例残留的死配置键，无行为影响，建议下次维护窗口顺手删除（未动，避免无 verdaccio 运行时验证的配置漂移）。
- 注记 ②：API JWT `expiresIn: 60d` 偏长（web 7d）——内网私服可接受；若 registry 暴露面扩大应缩短并配 token 轮换手册。
- 任务侧消费链（`.npmrc` 凭据注入）round-12 已修并有测试，本轮抽查无回归。

### BUG-12 executor-desktop（1 项新发现 → SEC-NEW-1）

- **IPC 面（无缺陷）**：`path-domain.ts` 路径域校验 + selftest 基建（round-15 bbb93de 闭合任意读/executionId 逃逸/任意启动三口子）复核在位。
- **子进程 env（无缺陷）**：desktop → 内置 executor-node 的 spawn 用 `...process.env` 全量继承 + 注入 `EXECUTOR_SHARED_TOKEN`（executor-process.ts L63-74）；被管应用子进程的 env 由 executor-node 白名单收敛（round-4），共享 token 不再二跳泄漏——链路完整。
- **F12-1（P3，新发现）**：`config-store.ts` 用 electron-store 把 `executorToken`（共享 token）**明文**存于 `%APPDATA%/<app>/config.json`。W2 后该 token 的获取已收紧 ADMIN，但本地落盘面未变：磁盘/备份/同步盘可读。建议改用 Electron `safeStorage`（Win=DPAPI / macOS=Keychain / Linux=kwallet-gnome 回退明文开关）加密存储并做存量明文迁移——登记为认领板新任务 **SEC-NEW-1**（涉三平台差异，独立认领）。

## 测试基线（本批）

acf-cli 59/59 · mcp-server 46/46 · autoflow-sdk 100/100 · node-sdk 未改动（43 基线）· registry-npm 无代码改动。

## 遗留

- SEC-NEW-1（desktop safeStorage 凭据加密）→ 认领板新条目。
- BUG-16 注记 ①（someProp 死键清理）→ 随下次 registry-npm 维护窗口。
