# 可复制模板

新建任务包时，按顺序落三个文件即可上传。以 `my-app` 为例。

## 1. manifest.yaml（根目录）

执行器**实际只读** `runtime / entrypoint / timeout / requirements` 四个字段（任务侧字段会覆盖 manifest）：

```yaml
runtime: python           # python | node
entrypoint: main.py       # 相对 zip 根的入口脚本；缺省 main.py
timeout: 300              # 秒；0=不限时

# 可选：把依赖写进 manifest（会与包内 requirements.txt 合并，任务级同名覆盖）
# requirements:
#   - requests>=2.31
```

> **版本不在 manifest 里声明。** 应用版本（`version`）由**上传/应用记录**承载并自动递增；
> Python 解释器版本（`runtimeVersion`）在**创建任务**时声明。二者都不写进 manifest.yaml。
>
> 单入口任务用 `entrypoint` 即可。多任务自动注册是 **git 仓库部署**时读根目录 **`manifest.json`**
> （JSON，任务项字段为 `entrypoint`）的能力，**zip 单入口任务不涉及**，勿在 manifest.yaml 里造 `tasks[]`。

## 2. main.py（无依赖，纯标准库版）

```python
"""AutoCodeFlow 任务入口。返回 dict=成功，抛异常=失败。"""
import json
import os


def main() -> dict:
    # 运行时参数以 AUTOFLOW_ 前缀注入；优先级 AUTOFLOW_* > 默认值
    target = os.environ.get("AUTOFLOW_TARGET", "prod")

    print(f"running: target={target}")
    result = do_something(target)
    return {"success": True, "result": result}


def do_something(target: str) -> dict:
    # === 业务逻辑写在这里 ===
    return {"target": target, "processed": 0}


if __name__ == "__main__":
    # 本地调试：set AUTOFLOW_TARGET=dev 后 python main.py
    print(json.dumps(main(), ensure_ascii=False, default=str))
```

## 2b. main.py（推荐：官方 SDK 版，带能力探测与主动回调）

```python
"""用 autoflow-sdk 的规范入口：先探测回调能力，再决定是否主动上报。"""
import json
import time

from autoflow_sdk import CallbackDisabledError, TaskContext


def main() -> dict:
    ctx = TaskContext.from_env()
    ctx.log.info(f"task={ctx.task_id} execution={ctx.execution_id} started")

    can_callback = ctx.callback.enabled          # 旧执行器不注入凭证 → False
    if not can_callback:
        ctx.log.warning("callback credentials absent; proceeding without callbacks")

    started = time.monotonic()
    target = ctx.get_param("target") or "prod"    # 读 AUTOFLOW_TARGET
    try:
        result = do_something(target)
        duration_ms = int((time.monotonic() - started) * 1000)
        if can_callback:
            ctx.report_success(summary=f"processed {target}", duration_ms=duration_ms)
        return {"success": True, "result": result, "callback_used": can_callback}
    except Exception as e:
        if can_callback:
            try:
                ctx.report_failure(e, failure_reason="script_error")
            except CallbackDisabledError:
                ctx.log.warning("callback became unavailable mid-run")
        raise                                     # re-raise → 执行器标 FAILED


def do_something(target: str) -> dict:
    return {"target": target}


if __name__ == "__main__":
    print(json.dumps({"RESULT": main()}, ensure_ascii=False, default=str))
```

> 用 SDK 版时，`requirements.txt` 需加一行 `autoflow-sdk`。

## 3. requirements.txt（仅在有第三方依赖时创建）

```text
# 只能写包规格；禁止以 - 开头的 option 行（如 --index-url，会被拒绝）
requests>=2.31
autoflow-sdk
# 私服源不用写在这里：由执行器侧 PYPI_REGISTRY_URL 配置统一注入
```

无第三方依赖时**可不建** `requirements.txt`，执行器不建 venv、直接以所选解释器运行。

## 4. 多入口 / 子目录布局（可选）

```
my-app/
├── manifest.yaml            # entrypoint 写 tasks/main.py
├── tasks/
│   └── main.py
├── lib/
│   └── helpers.py           # 业务拆分的辅助模块
└── requirements.txt
```

`lib` 能被 import 的前提是：执行器把包解压到 work_dir 后**以 zip 根为工作目录**运行入口脚本。
因此跨模块 import 要用**相对 zip 根的包路径**（如 `from lib.helpers import x`），不要用绝对路径。

## 5. 产物输出（artifacts，FEAT-05）

任务产生的文件要出现在执行详情页，**必须**写进 `AUTOFLOW_ARTIFACTS_DIR`：

```python
import os
from pathlib import Path


def main() -> dict:
    art_dir = Path(os.environ.get("AUTOFLOW_ARTIFACTS_DIR", "/tmp/artifacts"))
    art_dir.mkdir(parents=True, exist_ok=True)

    (art_dir / "report.csv").write_text("name,value\na,1\n", encoding="utf-8")
    return {"success": True, "artifact": "report.csv"}
```

Node 对等：`process.env.AUTOFLOW_ARTIFACTS_DIR`。

红线：≤20 个文件、单文件 ≤100 MB、文件名匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$`、
只扫顶层不递归。写到 `/tmp` 或只把路径放进返回值，UI 里看不到。

## 6. 失败语义

执行器只看**进程退出码**，不解析返回的 dict。`except` 里
`return {"success": False}` 会以退出码 0 结束 → 平台显示**成功**（假绿）。
要失败必须 **`raise`**：

```python
def main() -> dict:
    try:
        return do_work()
    except Exception:
        # 不要 return {"success": False} —— 那样会显示成功
        raise
```

## 打包与上传

```bash
python scripts/package.py my-app/          # 校验 + 产出 ../my-app-<version>.zip
# 然后：后台「应用管理 → 上传」或 POST /api/applications/upload（name/runtime=python，见 SKILL.md）
```

> 产物名的版本号来自包内可选的 `VERSION` 文件或 `--out` 参数（manifest 不再携 `version`）；
> 真正的版本递增由平台的应用记录维护。
