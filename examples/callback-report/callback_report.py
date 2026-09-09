"""回调示例任务（Python SDK）

演示 autoflow-sdk 的主动回调能力：任务内部把阶段性结果（或失败原因）
通过 per-execution token 上报给 Admin API（POST /api/executions/callback）。

能力探测（必须先判断再上报）：
- 执行器注入 AUTOFLOW_ADMIN_API_URL + AUTOFLOW_CALLBACK_TOKEN（N23 起，
  N27 起另注入 AUTOFLOW_EXECUTOR_ADDRESS）时，ctx.callback.enabled 为 True；
- 旧版执行器不注入这些变量 → enabled=False，任何 report_* 调用都会抛
  CallbackDisabledError（fail-closed，与 Node SDK 的 HttpClient.disabledReason
  语义对齐）。本例选择：不可回调时记 warning 并继续干活，不让任务失败。

运行方式（二选一）：
1. 平台执行：admin 后台新建 python 任务，glue 脚本粘贴本文件全部内容，
   或 entrypoint 指向 examples/callback-report/callback_report.py；
2. 本地模拟执行器环境：
   export EXECUTION_ID=exec-local-001
   export TASK_ID=callback-demo
   export TASK_NAME=回调演示
   export AUTOFLOW_SOURCE_URL=https://httpbin.org/status/200   # 可选
   python callback_report.py
   （不注入 AUTOFLOW_* 凭证三件套时走"不可回调"降级分支，正好演示能力探测）

任务参数（AUTOFLOW_<KEY> 注入，ctx.get_param 读取，均为字符串）：
- mode: "success"（默认）或 "fail" —— 演示成功/失败两条上报路径
- summary: 自定义成功摘要，缺省用内置文案

对应任务配置样例见同目录 task.example.json。
"""
import json
import time

from autoflow_sdk import CallbackDisabledError, TaskContext


def fetch_records(ctx: TaskContext) -> list:
    """演示业务逻辑：若无 source_url 参数则生成模拟数据。"""
    source = ctx.get_param("source_url")
    if source:
        # 真实任务里这里是 requests/httpx 拉取；示例避免外部依赖，仅记录
        ctx.log.info(f"source_url={source}（示例任务不实际请求）")
    ctx.log.info("生成 3 条模拟记录")
    return [
        {"id": 1, "value": "alpha"},
        {"id": 2, "value": "beta"},
        {"id": 3, "value": "gamma"},
    ]


def main() -> dict:
    ctx = TaskContext.from_env()
    ctx.log.info(f"task={ctx.task_id} execution={ctx.execution_id} started")

    can_callback = ctx.callback.enabled
    if not can_callback:
        ctx.log.warning(
            "callback credentials absent on this executor "
            "(AUTOFLOW_ADMIN_API_URL / AUTOFLOW_CALLBACK_TOKEN missing); "
            "proceeding without proactive callbacks"
        )

    started = time.monotonic()
    mode = (ctx.get_param("mode") or "success").lower()

    try:
        if mode == "fail":
            # 演示失败路径：抛错 → except 分支 report_failure → re-raise
            # 让执行器仍按异常走标准失败回调（主动回调只是补充信息）。
            raise RuntimeError("mode=fail 触发的演示失败")
        records = fetch_records(ctx)
        duration_ms = int((time.monotonic() - started) * 1000)

        if can_callback:
            # 成功上报：executionId / executorAddress 由 SDK 自动补齐；
            # summary 写入回调项的 logs 字段（512 KB 截断）。
            # 等价的 Node SDK 写法：await ctx.reportSuccess({ summary, durationMs })
            ctx.report_success(
                summary=f"{len(records)} records processed",
                duration_ms=duration_ms,
            )
            ctx.log.info(f"success callback delivered (duration_ms={duration_ms})")

        return {
            "success": True,
            "count": len(records),
            "records": records,
            "callback_used": can_callback,
        }
    except Exception as e:
        duration_ms = int((time.monotonic() - started) * 1000)
        if can_callback:
            try:
                # 失败上报：error → errorMessage（4 KB 截断），
                # failure_reason 取 admin-api ExecutionFailureReason 枚举，
                # 默认 script_error；这里演示显式传枚举值。
                # 等价的 Node SDK 写法：await ctx.reportFailure(e, { failureReason: "script_error" })
                ctx.report_failure(e, failure_reason="script_error", duration_ms=duration_ms)
                ctx.log.info("failure callback delivered")
            except CallbackDisabledError:
                # 理论上 can_callback=True 时不会发生；防御兜底
                ctx.log.warning("callback became unavailable mid-run")
        # re-raise：执行器会把本次执行标为 FAILED（errorMessage 取本异常）
        raise


if __name__ == "__main__":
    result = main()
    print(json.dumps({"RESULT": result}, ensure_ascii=False, default=str))
