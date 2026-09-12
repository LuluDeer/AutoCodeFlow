# 三执行器测试（node / python / desktop）
> 所属: docs/atlas/07-testing · 最后核对: 2026-09-13 · 对应代码: apps/executor-node/、apps/executor-python/、apps/executor-desktop/package.json 与 src/main/*.selftest.ts

## executor-node（Jest）

- **怎么跑**：`cd apps/executor-node && npx jest`（根目录 `npm run test:node`）；CI 里先 `npm run build`（executor-node 无独立 typecheck 脚本，**build 即 tsc 全量类型检查**）再 `npm test`。
- **配置**：package.json `"jest"` 键内联：`preset: ts-jest`、`testRegex: ".*\\.spec\\.ts$"`、testEnvironment=node。**未配置 coverage 门槛**。
- **规模**：`src/` 下 21 个 `*.spec.ts`（2026-09-13 find 核实），`it/test` 约 276 处（静态统计，实跑数以 CI 输出为准）。

### spec 全清单（守护什么）

| spec | 守护点 |
|---|---|
| `task-worker.spec.ts` | 任务执行主循环（领任务→跑→上报） |
| `scheduler.spec.ts` | 定时任务拉取与调度窗口 |
| `callback.spec.ts` | 执行回调上报 |
| `callback.sharding.spec.ts` | 回调分片写（大结果集切批） |
| `file-logger.spec.ts` | 本地文件日志写入与轮转 |
| `routes/logs.spec.ts` | 日志查询路由 |
| `middleware/auth.spec.ts` | 共享密钥（EXECUTOR_SECRET）认证中间件 |
| `env-whitelist.spec.ts` | 任务环境变量白名单（防注入面） |
| `zip-guard.spec.ts` | 压缩包/路径防护 |
| `execution-callback-token.spec.ts` | 回调 token 生成与校验 |
| `admin-client.spec.ts` | 与 admin-api 通信的客户端封装 |
| `artifacts.spec.ts` | 产物上传 |
| `lib/download.spec.ts` | 下载（运行机包等） |
| `config.spec.ts` | 配置解析/默认值 |
| `routes/execute.spec.ts` | 执行入口路由 |
| `routes/execute.traceparent.spec.ts` | 执行入口的 traceparent 链路追踪 |
| `routes/health.spec.ts` | 健康检查端点 |
| `routes/config.spec.ts` | 配置下发/热更新路由 |
| `routes/update-package.spec.ts` | 运行机包自更新 |
| `routes/deploy.spec.ts` | 应用部署接收面 |
| `routes/prepare-failure-reason.spec.ts` | 失败原因归类准备 |

- **失败时先看**：先跑 `npm run build` 排除类型错误；POSIX 假设类失败（taskkill 树杀、SIGBREAK、.cmd glue）看 CI `windows-node-tests` job——那是 R13 轮 Windows 兼容修复的防回退闸（含 executor-node / acf-cli / mcp-server 三包矩阵），深挖见 [WINDOWS-TESTING-PLAN](../../WINDOWS-TESTING-PLAN.md)。执行链路语义背景见 [executor-node README](../01-apps/executor-node/README.md) 与 [execution-pipeline](../01-apps/executor-node/execution-pipeline.md)。

## executor-python（pytest）

- **怎么跑**：`cd apps/executor-python && python -m pytest -q`（根目录 `npm run test:python`）；CI 装 `pytest pytest-cov httpx pytest-asyncio` 后 `python -m pytest --tb=short`。
- **配置**：`apps/executor-python/pytest.ini`——`testpaths = tests`、`addopts = -v`、**`filterwarnings = error`（全量 strict）**：自身代码 datetime 弃用点已修（auth.py 用 timezone-aware now），仅对 starlette.testclient / anyio 两条三方库噪声精确豁免（QA-11 裁定，升级三方库后应复核回收）。`tests/conftest.py` 的 autouse fixture `_close_asyncio_loops` 在用例结束当场 close loop + gc.collect，支撑 ResourceWarning strict。
- **规模**：`tests/` 下 16 个 `test_*.py`（2026-09-13 核实），`def test_` 共 237 个（静态，含类内方法；parametrize 展开后的实跑数以 CI 输出为准）。

### test 文件全清单（守护什么）

| 文件 | 守护点 |
|---|---|
| `test_registration.py` | 注册与身份初始化 |
| `test_re_register.py` | 重注册与身份延续（[executor-registration](../04-flows/executor-registration.md)） |
| `test_execute.py` | 任务执行主体 |
| `test_kill.py` | 终止（进程树杀） |
| `test_concurrency.py` | 并发上限与队列行为 |
| `test_callback_persistence.py` | 回调持久化 |
| `test_execution_callback_token.py` | 回调 token |
| `test_auth.py` | 鉴权 |
| `test_health.py` | 健康端点 |
| `test_logs.py` | 日志上报 |
| `test_artifacts.py` | 产物上传 |
| `test_scheduler.py` | 定时拉取 |
| `test_config_reload.py` | 配置热更新 |
| `test_maintenance.py` | 维护窗口语义 |
| `test_admin_api.py` | 对 admin-api 的客户端调用 |
| `test_traceparent.py` | 链路追踪头透传 |

- **失败时先看**：`ResourceWarning`/`DeprecationWarning` 升级为报错时，先分辨是自身代码还是三方库（对照 pytest.ini 豁免清单注释）；执行语义改动要跑真机验证（[VERIFY-MATRIX](../../VERIFY-MATRIX.md)）。执行器契约背景见 [executor-contract](../01-apps/executor-contract.md) 与 [executor-python README](../01-apps/executor-python/README.md)。

## executor-desktop（自测脚本 + Electron 冒烟）

无 jest/vitest，全部走 package.json scripts：

| 命令 | 内容 |
|---|---|
| `npm run test:main`（根 `test:desktop` 前半） | `tsc -p tsconfig.selftest.json` 把 `src/main/*.selftest.ts` 编译到 `dist-selftest/`，依次跑 **path-domain / token-crypto / updater / notifier-rules** 四个自测 |
| `npm run test:renderer` | `node src/renderer/renderer.selftest.mjs`（渲染层纯逻辑自检） |
| `npm run test:e2e` | `playwright test --config=e2e/playwright.config.js` → `e2e/desktop-smoke.spec.js`，QA-12 共 **3 例**（首启渲染无白屏 / preload 桥脱敏 token 恒 `******` 且通道白名单不漂移 / 干净退出 close 后进程结束），Playwright `_electron` 驱动 |

- 四个主进程自测的源码位置（2026-09-13 核实）：`src/main/path-domain.selftest.ts`（路径域：安装目录/数据目录/工作目录边界）、`src/main/token-crypto.selftest.ts`（令牌加解密）、`src/main/updater.selftest.ts`（自动更新链）、`src/main/notifier-rules.selftest.ts`（通知规则匹配）。**自测文件与被测代码同目录就近放置**是该应用既定模式（无独立 test 目录）；`dist-selftest/` 是编译产物目录（如 `path-domain.selftest.js`）。
- CI 挂载：
  - `desktop-linux-bundle` job：跑 `test:main` 后打 AppImage/deb（仅 PR/手动）。
  - `desktop-e2e-smoke` job：跑 `test:e2e`（仅 PR/手动，windows-latest，`ELECTRON_DISABLE_GPU=1` 软渲染兜底）。
  - `desktop-bundle-drift` job：离线重打 ncc bundle 与入库产物 `git diff`，防 `resources/executor-node` 与 executor-node 源码漂移（W-18）。
- 失败时先看：`test:main` 失败看 dist-selftest 某一个自测的断言输出（tsc 编译失败则看 `tsconfig.selftest.json` 是否漏了新自测文件）；`test:e2e` 失败看 Playwright 截图与 GPU 兜底变量。桌面端结构见 [executor-desktop README](../01-apps/executor-desktop/README.md) 与 [ipc-and-security](../01-apps/executor-desktop/ipc-and-security.md)。
