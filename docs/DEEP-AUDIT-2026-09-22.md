# AutoCodeFlow 深度工程审计（2026-09-22）

> 分支 `develop`。三路只读审计：packages/SDK/CLI/MCP/python 库；executor-python/desktop 主进程/CI/构建/部署；迁移/后端深水/前端深水。
> 前序 UX 44 / ENG 0P0·8P1·21P2 / DESIGN 0P0·2P1·16P2 已闭环，本轮不重复。

## 顶部进度表

| # | 级别 | 条目 | 状态 | commit |
|---|---|---|---|---|
| D2-P1-1 | P1 | bwrap 沙箱在 compose 部署路径实际未启用（文档承诺与安全姿态漂移） | ✅ | 54a1acba |
| D3-B-P1-1 | P1 | 项目写路由（建/改/删项目、成员）零审计落证 | ✅ | 7d533371 |
| D3-B-P1-2 | P1 | 应用 CRUD/部署触发零审计落证 | ✅ | ddbaa91f |
| D3-B-P1-3 | P1 | Webhook 订阅改向零审计落证 | ✅ | 6fecb804 |
| D1-P2-1 | P2 | python http 客户端 docstring 误称 node-sdk 无重试无熔断 | ✅ | 598c2db5 |
| D1-P2-2 | P2 | mcp-server 路径参数未做 UUID 校验 | ✅ | 9a50acdd |
| D1-P2-3 | P2 | acf-cli exec tail SSE 流无客户端空闲兜底 | ✅ | 77d177c9 |
| D1-P2-4 | P2 | registry-pypi 根/包索引未复用带 OSError 守卫的枚举 | ✅ | 43183157 |
| D1-P2-6 | P2 | autocodeflow-db 单进程默认连接池偏大 | ✅ | d2bddb04 |
| D1-P2-7 | P2 | mcp get_scheduler_health 残留 any | ✅ | 9a50acdd |
| D2-P2-1 | P2 | test:unit 伞未接入 desktop 测试 | ✅ | 50106830 |
| D2-P2-4 | P2 | updater generic feed 放行 http:（Linux 无签名兜底） | ✅ | 4bfa6702 |
| D3-M-P2-1 | P2 | CreateProjects 迁移注释与 ON CONFLICT 语义不符 | ✅ | a28a3a80 |
| D3-F-P2-1 | P2 | 前端无全局 unhandledrejection 兜底 | ✅ | ef14ffe6 |
| D3-B-P2-1 | P2 | 部署 stop/rollback 过渡未落证 | ✅ | 5788f723 |
| D3-B-P2-2 | P2 | 任务模板 delete / notification 静默增删未落证 | ✅ | 76526eb5 |

---

## P1（5 条）

### D2-P1-1 ｜ bwrap 沙箱在 compose 部署路径实际未启用
- **证据**：`apps/executor-python/config.py:258` 注释称生产容器由 compose 显式开启 bwrap，字段默认 `task_sandbox=''`（关闭）；全仓 `*.yml` grep `TASK_SANDBOX` 0 命中；`docker-compose.yml:289-330` executor-python env 块未设置。
- **问题**：最强隔离层（bwrap `--unshare-all` + ro-bind / + tmpfs）在生产 compose 路径默认关闭；叠加 `cap_drop: ALL`+`no-new-privileges` 未验证 unprivileged userns 前提。
- **改法**：executor-python env 显式 `TASK_SANDBOX=bwrap`（并在部署文档补 userns 前置验证），或修正注释消除「生产已开沙箱」误判。成本极小。

### D3-B-P1-1 ｜ 项目写路由零审计落证
- **证据**：`project/project.controller.ts:106/113/123/159/169/180`（建/改/删项目、加/改/删成员）全程不写 audit_logs；模块 grep 无 audit 引用（对照 task.controller 14 处落证）。
- **问题**：多租户边界操作（改成员角色=权限面、删项目=数据归属面）事后无痕迹。
- **改法**：remove/update/members 写路径补 `audit.log`，与 executor/user 落证同构。

### D3-B-P1-2 ｜ 应用 CRUD/部署触发零审计
- **证据**：`application/application.service.ts:347/384/474/814` create/update/remove/deployFromGit 无落证。
- **改法**：remove/deploy 补落证（applicationId+操作人+原因）。

### D3-B-P1-3 ｜ Webhook 订阅改向零审计
- **证据**：`event-subscriptions/event-subscription.service.ts:93/160/189/241` create/update/remove/deleteDeadLetter 无落证。
- **改法**：create/update/remove 落证（记录新旧 URL 哈希，不落密钥明文）。

---

## P2（12 条）

### D1-P2-1 ｜ python http 客户端 docstring 误称 node-sdk 无重试无熔断
- `packages/autocodeflow-http/.../client.py:26-30` 称 node-sdk `http-client.ts` 是「纯 axios 薄包装、无重试、无熔断」；实际 node 侧已实现完整 CircuitBreaker + 指数退避（B-4 对齐）。改 parity 描述。

### D1-P2-2 ｜ mcp-server 路径参数未做 UUID 校验
- `packages/mcp-server/src/tools.ts` 各工具 `z.string()` 裸接 id 并模板插值（/tasks/:id 等），无 refinement。加 `.uuid()` 或字符白名单 regex。

### D1-P2-3 ｜ acf-cli exec tail SSE 流无客户端空闲兜底
- `packages/acf-cli/src/commands/exec.ts:148` `timeout:0` 永不超时，对端半开时 CLI 永久挂起。加空闲定时器（60s 无数据帧则 exit 1）。

### D1-P2-4 ｜ registry-pypi 根/包索引未复用带 OSError 守卫的枚举
- `apps/registry-pypi/main.py:444/459` 直接 `iterdir()`，未复用带 try/except OSError 的 `_all_package_dirs()`。权限异常时 500 而非空列表。

### D1-P2-6 ｜ autocodeflow-db 单进程默认连接池偏大
- `packages/autocodeflow-db/.../connection.py:44-45` pool_size=5+overflow=10=15/进程；任务短生命周期，极端并发 N 进程顶 max_connections。默认降到 1-2。

### D1-P2-7 ｜ mcp get_scheduler_health 残留 any
- `packages/mcp-server/src/tools.ts:1242` `Record<string, any>` → `Record<string, unknown>`。

### D2-P2-1 ｜ test:unit 伞未接入 desktop 测试
- `package.json:39` test:unit 串联 13 项不含 test:desktop，而 typecheck:all 含。本地 make test 有覆盖错觉（CI 另有 desktop job 跑，非覆盖缺口）。test:unit 追加 test:desktop。

### D2-P2-4 ｜ updater generic feed 放行 http:
- `apps/executor-desktop/src/main/updater.ts:1070` generic feed 接受 http:；Linux 无签名兜底，中间人可换包。限制 https:。

### D3-M-P2-1 ｜ CreateProjects 迁移注释与 ON CONFLICT 语义不符
- `migrations/1790000000007-CreateProjects.ts:39-44` 注释称同名 Default 行 DO NOTHING，实则只按主键 id 冲突。注释改为「仅按 id 幂等」。

### D3-F-P2-1 ｜ 前端无全局 unhandledrejection 兜底
- admin-web 全仓无 `window.onerror`/`unhandledrejection` 注册，事件处理器异步 rejection 只进 console。main.tsx 注册监听聚合。

### D3-B-P2-1 ｜ 部署 stop/rollback 过渡未落证
- `application.service.ts:1179/2332` stop/rollbackDeploymentToPrevious 无落证（审批门有痕，执行门无痕）。补 deployment.stop/rollback。

### D3-B-P2-2 ｜ 任务模板 delete / notification 静默增删未落证
- `task-template.controller.ts:129` delete、`notification.service.ts:41/133` channel/silence 增删无落证。补。

---

## 证伪记录（查过不报）

- **密钥不泄漏**：config showConfig 只打 [set]、python callback_token repr=False、node token private；错误串不含 Authorization 头。
- **VALID_FAILURE_REASONS 三端无漂移**：protocol.json executorReportable(12) 与 python/node 逐值相等，两侧测试读同一份 protocol.json 断言。
- **无命令注入**：全 packages/executor-python/desktop 无 shell:true；spawn 全 argv 数组。
- **pypi 路径穿越**：is_safe_package_name + Path.name 剥目录双闸，HTML 全 escape；上传 os.link 原子 CAS + 幂等/冲突。
- **迁移幂等/种子污染**：83 迁移 up 全 IF [NOT] EXISTS，down 对称；demo-seed 未被 bootstrap 引用；admin 种子有 count 守卫。
- **限流覆盖**：全局 ThrottlerGuard + 四档分桶；SSE @SkipThrottle 有文档化理由；写面无漏网。
- **事务/锁**：outbox FOR UPDATE SKIP LOCKED、users 悲观写、@VersionColumn 三处；N+1/死 GIN 已修。
- **CI 泄密**：无 pull_request_target/workflow_run；顶级 contents:read；release 仅 tag + environment 审批；PyPI OIDC 免长期 token；无 continue-on-error。
- **bundle/错误边界**：全路由 React.lazy、monaco 不进 manualChunks（有 perf 守卫）；无 moment/lodash/echarts。
- **代码健康**：admin-web src 零 TODO/any/@ts-ignore。

## 建议（偏好/架构级，不擅改）
- pypi Basic 认证爆破限速（部署侧 nginx limit_req）。
- packageUrl/gitRepo SSRF DNS rebinding TOCTOU（连接前钉死解析）。
- 前端错误上报通道（自托管可接受；补则复用 hidden sourcemap）。
- aria-live 长异步结果播报（设计建议）。
- 跨代 TIMESTAMP/timestamptz 漂移：新表一律 timestamptz，旧表不强行迁移。

## 证据强度声明
- 三路均逐文件读码；B-P1-1/2/3 的零落证经模块级 grep 双向验证。
- P2-2/P2-3 等标注「推演」（竞态/半开窗口未实测）；其余为读码/grep 直接确证。
