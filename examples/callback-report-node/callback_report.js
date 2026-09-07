/**
 * 回调示例任务（Node SDK）
 *
 * 演示 @autocodeflow/sdk 的主动回调能力：任务内部把阶段性结果（或失败
 * 原因）通过 per-execution token 上报给 Admin API
 * （POST /api/executions/callback）。
 *
 * 能力探测（必须先判断再上报）：
 * - 执行器注入 AUTOFLOW_ADMIN_API_URL + AUTOFLOW_CALLBACK_TOKEN（N23 起，
 *   N27 起另注入 AUTOFLOW_EXECUTOR_ADDRESS）时，ctx.http.enabled 为 true；
 * - 旧版执行器不注入这些变量 → enabled=false，任何请求方法都会 rejects
 *   "HttpClient is disabled..."（fail-closed，与 Python SDK 的
 *   CallbackDisabledError 语义对齐）。本例选择：不可回调时记 warning 并
 *   继续干活，不让任务失败。
 *
 * 运行方式（二选一）：
 * 1. 平台执行：admin 后台新建 node 任务，glue 脚本粘贴本文件全部内容，
 *    或 entrypoint 指向 examples/callback-report-node/callback_report.js；
 * 2. 本地模拟执行器环境：
 *    export EXECUTION_ID=exec-local-001
 *    export TASK_ID=callback-demo-node
 *    export TASK_NAME=回调演示Node
 *    node callback_report.js
 *    （不注入 AUTOFLOW_* 凭证时走"不可回调"降级分支，正好演示能力探测）
 *
 * 任务参数（AUTOFLOW_<KEY> 注入，getParam 读取，均为字符串）：
 * - mode: "success"（默认）或 "fail" —— 演示成功/失败两条上报路径
 * - summary: 自定义成功摘要，缺省用内置文案
 *
 * 对应任务配置样例见同目录 task.example.json。
 * Python 版对应示例：../callback-report/callback_report.py
 */

// 依赖安装由平台完成：任务配置 requirements: ["@autocodeflow/sdk"]，
// executor-node 会装到任务隔离目录并注入 NODE_PATH（见 README）。
const { TaskContext } = require('@autocodeflow/sdk');

/** JSON 容错解析任务参数（执行器把参数字符串化注入；对齐既有示例 getParam）。 */
function getParam(key, defaultValue) {
  const envValue = process.env[`AUTOFLOW_${key.toUpperCase()}`];
  if (envValue !== undefined) {
    try {
      return JSON.parse(envValue);
    } catch (e) {
      return envValue; // 纯字符串不是合法 JSON，原样返回
    }
  }
  return defaultValue;
}

async function fetchRecords(ctx) {
  const source = getParam('source_url');
  if (source) {
    ctx.logger.info(`source_url=${source}（示例任务不实际请求）`);
  }
  ctx.logger.info('生成 3 条模拟记录');
  return [
    { id: 1, value: 'alpha' },
    { id: 2, value: 'beta' },
    { id: 3, value: 'gamma' },
  ];
}

async function main() {
  const ctx = TaskContext.fromEnv();
  ctx.logger.info(`task=${ctx.taskId} execution=${ctx.executionId} started`);

  const canCallback = ctx.http.enabled;
  if (!canCallback) {
    ctx.logger.warn(
      'callback credentials absent on this executor ' +
        '(AUTOFLOW_ADMIN_API_URL / AUTOFLOW_CALLBACK_TOKEN missing); ' +
        'proceeding without proactive callbacks',
    );
  }

  const startedAt = Date.now();
  const mode = (getParam('mode', 'success') || 'success').toLowerCase();

  try {
    if (mode === 'fail') {
      // 演示失败路径：抛错 → except 分支 reportFailure → re-throw
      // 让执行器仍按异常走标准失败回调（主动回调只是补充信息）。
      throw new Error('mode=fail 触发的演示失败');
    }
    const records = await fetchRecords(ctx);
    const durationMs = Date.now() - startedAt;

    if (canCallback) {
      // 成功上报：executionId 固定为本次执行，executorAddress 由 SDK 自动补齐
      // （N27，显式书写值不会被覆盖）；等价 Python 写法：
      //   ctx.report_success(summary=..., duration_ms=...)
      await ctx.reportSuccess({
        summary: `${records.length} records processed`,
        durationMs,
      });
      ctx.logger.info(`success callback delivered (durationMs=${durationMs})`);
    }

    return {
      success: true,
      count: records.length,
      records,
      callback_used: canCallback,
    };
  } catch (e) {
    const durationMs = Date.now() - startedAt;
    if (canCallback) {
      // 失败上报：error → errorMessage（4 KB 截断），failureReason 默认
      // script_error；等价 Python 写法：
      //   ctx.report_failure(e, failure_reason="script_error")
      await ctx.reportFailure(e, { failureReason: 'script_error', durationMs });
      ctx.logger.info('failure callback delivered');
    }
    // re-throw：执行器会把本次执行标为 FAILED（errorMessage 取本异常）
    throw e;
  }
}

// 平台以 module.exports 方式调用；直接 node 本文件时自执行（对齐既有示例）
if (require.main === module) {
  main()
    .then((r) => {
      console.log(`RESULT: ${JSON.stringify(r)}`);
    })
    .catch((e) => {
      console.error('Fatal:', e.message);
      process.exit(1);
    });
}

module.exports = { main };
