# 全链 E2E 测试（根级 Playwright）
> 所属: docs/atlas/07-testing · 最后核对: 2026-09-13 · 对应代码: e2e-full.spec.js、e2e-ui09-mobile.spec.js、playwright.e2e.config.js、scripts/e2e-full.sh、apps/admin-web/e2e/

## 场景分组清单（2026-09-13 逐行核实）

`e2e-full.spec.js` 实际含 **45 个 `test()`**（注意：ci.yml 注释仍写"43 例"，已滞后；其中用例 44 默认条件跳过，默认实跑 44）。

### 顶层业务用例（无 describe，编号 1–29）

| # | 场景 |
|---|---|
| 1 | 登录与仪表盘 |
| 2 | 应用管理 — 新建应用 |
| 3 | 任务管理 — 新建定时任务 |
| 4 | 手动触发任务 & 查看执行 |
| 5 | 执行日志 — 列表与详情 |
| 6 | 运行机 — 列表、详情、安装向导 |
| 7 | 运行机包管理 & 私有仓库 |
| 8 | 应用部署管理 |
| 9 | 并发调度状态查询 |
| 10 | 中断/终止运行中的任务 |
| 11 | 任务启停控制 |
| 12 | 通知渠道设置 |
| 13 | 用户管理 |
| 14 | 审计日志 |
| 15 | AI 配置检查 & Swagger API 文档 |
| 16 | Prometheus 指标端点 |
| 17 | RBAC — admin 访问 /notifications 正常且菜单入口可见 |
| 18 | RBAC — 普通用户 /notifications 被拦(403)且菜单无入口 |
| 19 | RBAC — 普通用户 /users /audit /executor-packages /executors/install 均被拦 |
| 20 | settings AI Tab — 普通用户降级提示且零 /ai/config 请求 |
| 21 | settings AI Tab — admin 正常发起 GET /ai/config 并渲染表单 |
| 22 | TaskFormPage — auto/group/pinned/broadcast 四模式切换与 pinned 选择器绑定 |
| 23 | executorId 残留清理 — 编辑页还原 pinned，切 broadcast 后 pin 被清空 |
| 24 | executorId 残留清理 — 切 auto 提交后 executorId 显式置空 |
| 25 | 创建向导 pinned 提交应携带完整字段与 executorId（R8 P0 回归守卫） |
| 26 | pinned 全链 — 详情页绑定可见、UI 触发、执行记录 executorAddress=目标执行器 |
| 27 | pinned 离线语义 — 目标执行器离线 trigger FAILED，错误消息与失败分类 UI 可读 |
| 28 | pinned 目标不存在 — executorId 幽灵 uuid trigger FAILED，UI 错误展示可读 |
| 29 | UI 向导建 pinned 任务 → 触发执行 executorAddress=绑定执行器（全 UI 闭环） |

### describe 分组（4 个）

| describe | 用例 | 内容 |
|---|---|---|
| `security-redline-approval` | 30–36 | DEP-04 审批红线：审批冻结零派发、第二人规则 403、并发双审批恰一 200 一 409（原子认领）、reject/cancel 语义、审批 RBAC、第二人 approve 正向闭环 |
| `security-redline-rbac` | 36–40 | 执行器写面（patch/reload-config/rotate-token/set-offline/delete）、应用与部署写面、审计/配置/AI/用户管理面、事件订阅契约对齐、任务属主写面——全部 403（编号从 36 重新起算，与上一组重复编号，spec 内如此） |
| `security-redline-ssrf` | 41–43 | webhook 订阅六出站点恶意 URL 全 400、DNS 重绑定域名形态与非 http scheme 全 400、形状校验对照 + 未带 token 401 |
| `private-registry (BUG-18)` | 44 | 私服依赖由 executor 装到任务依赖目录、凭据不落任务树；**默认 `test.skip`，`E2E_PRIVATE_REGISTRY=1` 才跑** |

`e2e-ui09-mobile.spec.js`：describe `UI-09 移动端真机走查（375×812）`，用例 45–46（Dashboard / 执行详情在 375px 无横向溢出）。根配置 `testMatch: '**/e2e-*.spec.js'` 使两个 spec 同套跑。

## 怎么起环境跑

```bash
bash scripts/e2e-full.sh                  # 默认：docker 一次性 PG/Redis，全自动
SKIP_DOCKER=1 bash scripts/e2e-full.sh    # 复用本机已有 PG/Redis（CI 即此形态）
```

- 编排链路：PG(:15432)+Redis(:16379) → admin-api(:3105，空库跑完整迁移链) → executor-node(:8002 注册在线) → admin-web vite(:5176) → Playwright chromium。前置：bash + docker + node>=20 + 各 apps/*/node_modules 已装（chromium 由脚本兜底 install）。
- 可覆盖环境变量：`E2E_DB_HOST/PORT/USER/PASS/NAME`、`E2E_REDIS_HOST/PORT/PASS`、`E2E_API_BASE`、`E2E_WORK_DIR`（Windows 须给盘符路径如 `C:/tmp/acf-e2e-tasks`）、`E2E_LOG_ROOT`。
- 脚本显式钉住的关键 env（防 flake，见脚本头注）：
  - `LOGIN_THROTTLE_LIMIT/THROTTLE_LIMIT=10000` —— 45 例约 60 次登录 + 高频 API 轮询，默认 20/60 必级联 429（W-22 同根）；
  - `EXECUTION_CALLBACK_SECRET` 两端显式同值 —— 消除 fallback 语义漂移；
  - `EXECUTOR_ALLOW_PRIVATE_NETWORK=true` —— 派发目标 localhost:8002 是回环地址，SSRF 守卫默认拦回环；
  - 每次全新库 —— docker 模式 drop+create，SKIP_DOCKER 模式要求空库，断言不漂移。
- 私服场景：设 `E2E_PRIVATE_REGISTRY=1` 且本地有 verdaccio/verdaccio:5 镜像时，脚本起一次性 Verdaccio 并置 `E2E_PRIVATE_REGISTRY_ENABLED=1`（用例 44 才执行）；未启用会打印"用例 44 将跳过"。
- 全部子进程 exec 化 + trap 清理，容器/三服务/日志不落残留。
- CI：`e2e-full` job（ubuntu，services 提供 PG/Redis + `SKIP_DOCKER=1`）每次 PR/push 跑；`e2e-full-windows`（windows-latest，原生 PG 服务 + portable redis 下载）仅 PR / 手动 / schedule（W-28，盲区恰是 Windows：W-22/W-26 都是 Windows runner 抓出 Linux 漏掉的 bug）。
- 配置文件 `playwright.e2e.config.js`：baseURL `http://localhost:5176`、headless、timeout 60000、actionTimeout 15000、navigationTimeout 20000、`testIgnore: '**/apps/**'`（排除 apps 下同名列副本，其 `type:module` 会炸 CJS require）。
- 本地单跑某用例：`npx playwright test --config=playwright.e2e.config.js -g "pinned"`（`-g` 按标题 grep），但仍需脚本起好的环境或自行起栈。

## apps/admin-web/e2e/ 与根 e2e 的分工

| | 根 `e2e-full.spec.js` | `apps/admin-web/e2e/`（6 个 spec：auth / functional / login_real / navigation / pages / application-versions） |
|---|---|---|
| 驱动 | `scripts/e2e-full.sh` 起全栈真环境 | 手动 `npx playwright test`（apps/admin-web 下，`playwright.config.ts`，testDir `./e2e`，baseURL 5176） |
| 环境 | 全新库全链，含执行器与安全红线 | 需自备已在跑的栈（`login_real` 用真实凭据登录） |
| CI | `e2e-full` / `e2e-full-windows` | **不在 CI**（admin-web CI 只有 lint+build） |
| 定位 | 回归门禁 + 安全红线 | 页面级走查/探索性补充 |

## 失败时先看什么

1. 先分清**环境问题**还是**回归**：vite/3105/8002 端口是否被占、docker 是否可用、`SKIP_DOCKER` 模式下给的库是否为空库（脚本要求空库，残留种子会毒化断言）。
2. 失败截图在 `/tmp/e2e-*.png`、日志在 `/tmp/acf-e2e-logs*/`（CI 上由 `e2e-artifacts` artifact 收集，retention 7 天；Windows job 另收 `C:/tmp/acf-e2e-tasks/` 与 `test-results/`）。
3. 429 级联：确认节流放大 env 已生效（脚本默认设置，绕过脚本手工单跑 spec 时要自备）。
4. 定位到具体用例后，对照上表找同域文档：审批流见 [approval-flow](../04-flows/approval-flow.md)、安全模型见 [security-model](../04-flows/security-model.md)、回调见 [execution-callback](../04-flows/execution-callback.md)、私服见 [registry-npm](../01-apps/registry-npm.md) 与 [registry-pypi](../01-apps/registry-pypi/README.md)。
