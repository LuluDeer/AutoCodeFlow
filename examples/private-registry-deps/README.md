# 私服依赖示例任务（Python SDK）

演示**任务级依赖声明（requirements，W-21）+ 私服 PyPI registry** 的完整链路：

```
admin 下发任务(requirements)
  → executor-python 建 per-task venv
  → uv pip install --index-url <PYPI_REGISTRY_URL> <requirements>
  → 任务代码 import 私有包
```

- 入口脚本：[private_dep_task.py](./private_dep_task.py)
- 依赖清单：[requirements.txt](./requirements.txt)
- 任务配置样例：[task.example.json](./task.example.json)
- Node 版对应示例：[../private-registry-deps-node/](../private-registry-deps-node/)

## 前置条件（executor 侧）

| 配置 | 位置 | 说明 |
|------|------|------|
| `PYPI_REGISTRY_URL` | executor-python 的 `.env` / 启动环境 | 私服 PyPI 地址（如 `http://registry-pypi:3110/simple`）。**未配置时走公共 PyPI**；平台内置私服见 `apps/registry-pypi` |
| 网络可达 | executor 容器/主机 | 需能访问私服地址；内网部署时确认防火墙放行 |
| 私有包已发布 | registry-pypi | 私服中需存在 `acfdemopkg` / `example_pkg` 等示例包（BUG-18 链路攻坚轮已在 registry-pypi 侧准备演示包素材） |

执行器侧的安装细节（源码证据）：

- `apps/executor-python/routers/execute.py` 的 `ensure_venv()`：
  `settings.pypi_registry_url` 非空时给 `uv pip install` 追加
  `--index-url <私服>`；
- `_validate_requirements()`：拒绝以 `-` 开头的 option 形条目
  （防止 `--index-url http://evil` 劫持包索引）——所以
  `requirements.txt` / 任务配置里只能写**包规格**；
- requirements 仅对 **entrypoint（打包）任务**生效，glue 脚本任务忽略。

## 运行

### 方式一：平台执行（完整链路）

1. 确认 executor-python 已配置 `PYPI_REGISTRY_URL` 且私服内有示例包；
2. admin 后台新建 python 任务，entrypoint 填
   `examples/private-registry-deps/private_dep_task.py`；
3. 任务依赖（requirements）填：`acfdemopkg`、`example_pkg>=1.0`、
   `autoflow-sdk`（与 `task.example.json` 一致）；
4. 触发执行：执行日志会先出现 `Installing N packages into <venv>`，
   任务结果里 `source=private-package` 即链路打通。

### 方式二：本地试跑（跳过执行器）

```bash
cd examples/private-registry-deps
pip install -r requirements.txt        # 内网环境追加 --index-url <私服>/simple
pip install autoflow-sdk

export EXECUTION_ID=exec-local-001
export TASK_ID=private-dep-demo
export TASK_NAME=私服依赖演示
python private_dep_task.py             # 包缺席时输出 degraded 分支
```

## 示例包说明

`acfdemopkg` / `example_pkg` 是私服演示包名：`acfdemopkg` 对应
registry-pypi 链路验证用演示素材；`example_pkg` 为占位规格示例。替换成
你们真实的私有包时，同步改三处：`requirements.txt`、`task.example.json`
的 `requirements` 数组、`private_dep_task.py` 的 `pkg_name` 参数缺省值。

## 关键 API 对照（与 Node SDK 等价）

| 动作 | Python | Node |
|------|--------|------|
| 读参数 | `ctx.get_param("pkg_name")` | `getParam('pkg_name')`（见对应示例） |
| 能力探测 | `ctx.callback.enabled` | `ctx.http.enabled` |
| 成功上报 | `ctx.report_success(summary=...)` | `await ctx.reportSuccess({ summary })` |
| 自定义回调 | `ctx.callback.report([{...}])` | `await ctx.http.post('/api/executions/callback', [{...}])` |
