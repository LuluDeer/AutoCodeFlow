# 官方示例库（examples/）

> 本页聚合 [examples/](https://github.com/LuluDeer/AutoCodeFlow/tree/develop/examples)
> 四个 ECO-01 官方示例的 README 精要并回链仓库路径。每个示例自包含：
> 入口脚本（与双 SDK 源码逐行核对的真实 API）+ README（executor 侧前置
> 条件）+ `task.example.json`（最小任务配置）。

| 示例 | 语言 | 演示内容 | 仓库路径 |
|------|------|---------|---------|
| 回调示例 | Python | 能力探测（`ctx.callback.enabled`）+ `report_success`/`report_failure` 双路径 + `CallbackDisabledError` 降级 | [`examples/callback-report`](https://github.com/LuluDeer/AutoCodeFlow/tree/develop/examples/callback-report) |
| 回调示例 | Node | 同上对等实现（`ctx.http.enabled` + `ctx.reportSuccess`/`reportFailure`） | [`examples/callback-report-node`](https://github.com/LuluDeer/AutoCodeFlow/tree/develop/examples/callback-report-node) |
| 私服依赖示例 | Python | 任务 `requirements` + executor `PYPI_REGISTRY_URL` → per-task venv `uv pip install --index-url` | [`examples/private-registry-deps`](https://github.com/LuluDeer/AutoCodeFlow/tree/develop/examples/private-registry-deps) |
| 私服依赖示例 | Node | 任务 `requirements` + executor `NPM_REGISTRY_URL`（可选 `NPM_REGISTRY_TOKEN`）→ 隔离目录 `.npmrc` + `npm install --prefix` | [`examples/private-registry-deps-node`](https://github.com/LuluDeer/AutoCodeFlow/tree/develop/examples/private-registry-deps-node) |

另有 [`examples/desktop-automation`](https://github.com/LuluDeer/AutoCodeFlow/tree/develop/examples/desktop-automation)
（桌面自动化/RPA 任务集合，浏览器与 GUI 自动化多脚本，非 ECO-01 四例）。

---

## 回调示例（callback-report / callback-report-node）

演示主动回调：任务运行中把阶段性成功/失败信息，用执行器注入的
per-execution token 上报给 Admin API。

**executor 侧前置条件**（平台自带执行器均已注入）：

| 变量 | 注入版本 | 说明 |
|------|---------|------|
| `AUTOFLOW_ADMIN_API_URL` | N23 起 | Admin API 基地址（非机密路由信息） |
| `AUTOFLOW_CALLBACK_TOKEN` | N23 起 | 一次性 `v1.` HMAC token，绑定本次 executionId，随任务超时+15 分钟宽限过期 |
| `AUTOFLOW_EXECUTOR_ADDRESS` | N27 起 | 执行器注册地址；SDK 自动补进回调项，缺省时不发送该字段 |

旧版自建执行器不注入 → `ctx.callback.enabled`（py）为 `False` /
`ctx.http.enabled`（node）为 `false`，上报调用抛
`CallbackDisabledError`（py）/ rejects `Error("HttpClient is disabled…")`
（node），fail-closed。示例在不可回调时降级为「只打日志、继续执行」，
正是能力探测的正确姿势。

**本地模拟（不注入凭证 → 降级分支）**：

```bash
cd examples/callback-report          # 或 callback-report-node
pip install autoflow-sdk             # node: npm install @autocodeflow/sdk
export EXECUTION_ID=exec-local-001
export TASK_ID=callback-demo
export TASK_NAME=回调演示
python callback_report.py            # 输出 callback_used: false
```

**本地模拟（注入凭证 → 成功/失败双路径）**：需要一个可达的 Admin API
（本地默认 `http://localhost:3105`），再
`export AUTOFLOW_ADMIN_API_URL / AUTOFLOW_CALLBACK_TOKEN / AUTOFLOW_EXECUTOR_ADDRESS`
（token 用 admin-api 签发的 `v1.` 回调 token）。完整步骤见示例 README。

---

## 私服依赖示例（private-registry-deps / -node）

演示**任务级依赖声明（requirements，W-21）+ 私服 registry** 的完整链路：

```
admin 下发任务(requirements)
  → executor-python 建 per-task venv → uv pip install --index-url <PYPI_REGISTRY_URL>
  → executor-node 在任务隔离目录生成 .npmrc → npm install --prefix <隔离目录>
  → 任务代码 import / require 私有包
```

**executor 侧前置条件**：

| 配置 | 位置 | 说明 |
|------|------|------|
| `PYPI_REGISTRY_URL` | executor-python 启动环境 | 私服 PyPI 地址（如 `http://registry-pypi:3110/simple`）。未配置走公共 PyPI；平台内置私服见 `apps/registry-pypi` |
| `NPM_REGISTRY_URL` | executor-node 启动环境 | 私服 npm 地址（如 `http://registry-npm:4873`）。未配置走公共 npm；内置私服见 `apps/registry-npm`（verdaccio） |
| `NPM_REGISTRY_TOKEN` | 同上（可选） | 私服对 `**` 的 access 是 `$authenticated`（匿名安装必 401）时必配 |
| 私有包已发布 | 私服 | pypi 侧演示包 `acfdemopkg` / `example_pkg`；npm 侧为任务引用的 scoped 包 |

**执行器侧安装细节（源码证据）**：

- executor-python `apps/executor-python/routers/execute.py` 的 `ensure_venv()`：
  `settings.pypi_registry_url` 非空时给 `uv pip install` 追加
  `--index-url <私服>`；`_validate_requirements()` 拒绝以 `-` 开头的
  option 形条目（防 `--index-url http://evil` 劫持包索引）。
- executor-node `apps/executor-node/src/routes/execute.ts`：生成 `.npmrc`
  （`@autoflow`/`@autocodeflow` 双 scope 行 + 非 scoped 包 `registry=` 行 +
  `_authToken` 行）后 `npm install --prefix <隔离目录>`，`NODE_PATH` 指向
  隔离目录。**scoped 包注意**：scope 行只覆盖平台双 scope，你们自己的
  scope 依赖私服回源行为或把 `NPM_REGISTRY_URL` 指向能解析该 scope 的私服。
- requirements 仅对 **entrypoint（打包）任务**生效，glue 脚本任务忽略。

**本地试跑（跳过执行器）**：

```bash
cd examples/private-registry-deps        # 或 -node
pip install -r requirements.txt          # node: npm install
export EXECUTION_ID=exec-local-001
export TASK_ID=private-dep-demo
export TASK_NAME=私服依赖演示
python private_dep_task.py               # 包缺席时输出 degraded 分支
```

---

## 双语言关键 API 对照

| 动作 | Python | Node |
|------|--------|------|
| 读参数 | `ctx.get_param("pkg_name")` | `getParam('pkg_name')`（示例内 JSON 容错 helper，读 `AUTOFLOW_*`） |
| 能力探测 | `ctx.callback.enabled` | `ctx.http.enabled` |
| 成功上报 | `ctx.report_success(summary=...)` | `await ctx.reportSuccess({ summary })` |
| 失败上报 | `ctx.report_failure(e, failure_reason=...)` | `await ctx.reportFailure(e, { failureReason })` |
| 自定义回调 | `ctx.callback.report([{...}])` | `await ctx.http.post('/api/executions/callback', [{...}])` |

> 示例的真机端到端验证（平台触发 + 私服真装）在真机轮执行；本地降级路径
> 烟测已通过（ECO-01）。
