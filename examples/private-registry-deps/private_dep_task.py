"""私服依赖示例任务（Python SDK）

演示任务级依赖声明（requirements，W-21）+ 私服 PyPI registry 的完整链路：
admin 下发任务 → executor-python 建 per-task venv → `uv pip install
--index-url <PYPI_REGISTRY_URL> <requirements>` → 任务代码 import 私有包。

执行器侧前置条件（任一满足即可安装依赖）：
- 私服模式：executor-python 启动环境配置 `PYPI_REGISTRY_URL`
  （如 http://registry-pypi:3110/simple，apps/registry-pypi 即平台内置
  私服）；未配置时走公共 PyPI。
- 网络直连模式：executor 所在主机可访问公共 PyPI，无需任何配置。

任务配置里的 requirements 会被执行器校验（R4-C P3）：拒绝以 `-` 开头的
option 形条目（如 `--index-url http://evil` 会劫持包索引），示例中的
`requirements.txt` 内容只能写**包规格**（名称[extras][版本约束]）。

注意：requirements 仅对 **entrypoint（打包）任务**生效；glue 脚本任务用
系统 Python/node，忽略该字段。本示例按 entrypoint 形态编写。

本地试跑（不依赖执行器）：
    pip install -r requirements.txt      # 私网环境加 --index-url <私服>/simple
    export EXECUTION_ID=exec-local-001
    export TASK_ID=private-dep-demo
    export TASK_NAME=私服依赖演示
    python private_dep_task.py           # acfdemopkg 缺席时自动降级演示

任务参数（AUTOFLOW_<KEY> 注入）：
- pkg_name: 要查询的私有包名（默认 acfdemopkg）
"""
import json
from datetime import datetime, timezone

from autoflow_sdk import TaskContext


def read_private_package(ctx: TaskContext) -> dict:
    """import 任务声明的私有包并读取其元数据。

    import 写在函数内（而非文件顶部），缺失时抛出的 ImportError 能被
    main() 捕获并转成结构化失败上报，而不是让进程直接崩溃。
    """
    pkg_name = ctx.get_param("pkg_name") or "acfdemopkg"
    try:
        # 与 requirements.txt 声明的包名保持一致；example_pkg 依赖 acfdemopkg
        import example_pkg  # noqa: F401  (存在性由 requirements 安装保证)
    except ImportError:
        pass  # 允许直接跑公共 PyPI 上不存在的演示包：走降级分支

    try:
        import importlib

        mod = importlib.import_module(pkg_name.replace("-", "_"))
    except ImportError as e:
        raise ImportError(
            f"private package {pkg_name!r} not installed — check that the "
            f"executor has PYPI_REGISTRY_URL pointing at the private index "
            f"and that requirements.txt lists {pkg_name}"
        ) from e

    return {
        "package": pkg_name,
        "version": getattr(mod, "__version__", "unknown"),
        "file": getattr(mod, "__file__", "unknown"),
    }


def main() -> dict:
    ctx = TaskContext.from_env()
    ctx.log.info(f"task={ctx.task_id} execution={ctx.execution_id} started")

    try:
        info = read_private_package(ctx)
        ctx.log.info(f"private package resolved: {info}")
        result = {
            "success": True,
            "source": "private-package",
            "package": info,
            "finished_at": datetime.now(timezone.utc).isoformat(),
        }
    except ImportError as e:
        # 私服/包缺席时的降级演示：任务本身失败无意义，改为标注降级并成功返回
        ctx.log.warning(f"falling back to degraded demo: {e}")
        result = {
            "success": True,
            "source": "degraded (package unavailable)",
            "hint": str(e),
            "finished_at": datetime.now(timezone.utc).isoformat(),
        }

    if ctx.callback.enabled:
        if result["source"] == "private-package":
            ctx.report_success(summary=f"private pkg {result['package']['version']} loaded")
        else:
            # 降级不算失败，但仍用 report([...])自定义字段把 hint 带给平台
            ctx.callback.report([
                {
                    "status": "success",
                    "logs": f"degraded: {result['hint']}"[:512_000],
                }
            ])
    else:
        ctx.log.warning("callback disabled on this executor; skipping proactive report")

    print(json.dumps({"RESULT": result}, ensure_ascii=False, default=str))
    return result


if __name__ == "__main__":
    main()
