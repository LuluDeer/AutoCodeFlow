/**
 * 私服依赖示例任务（Node SDK）
 *
 * 演示任务级依赖声明（requirements，W-21）+ 私服 npm registry 的完整链路：
 * admin 下发任务 → executor-node 在任务隔离目录 npm install → 依赖经
 * NODE_PATH 注入 → 任务代码 require 私有 scoped 包。
 *
 * 执行器侧前置条件（任一满足即可安装依赖）：
 * - 私服模式：executor-node 启动环境配置 NPM_REGISTRY_URL（如
 *   http://registry-npm:4873，apps/registry-npm 即平台内置 verdaccio 私服），
 *   可选 NPM_REGISTRY_TOKEN（私服 access=$authenticated 时必配）；
 * - 网络直连模式：executor 可访问公共 npm，无需配置。
 *
 * 注意：
 * - requirements 仅对 entrypoint（打包）任务生效；glue 脚本任务忽略；
 * - 包名由执行器按 npm name 正则校验（@scope/name 支持良好）；
 * - 私服 .npmrc 由执行器生成（@autoflow/@autocodeflow 双 scope 行 +
 *   非 scoped 包的 registry 行），任务代码无需自建。
 *
 * 本地试跑（不依赖执行器）：
 *   npm install                     # 或 npm link @autocodeflow/sdk
 *   export EXECUTION_ID=exec-local-001
 *   export TASK_ID=private-dep-node
 *   export TASK_NAME=私服依赖演示Node
 *   node private_dep_task.js        # 私有包缺席时自动降级演示
 *
 * 任务参数（AUTOFLOW_<KEY> 注入）：
 * - pkg_name: 要查询的私有包名（默认 @autocodeflow/sdk）
 *
 * Python 版对应示例：../private-registry-deps/
 */

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

/** 动态 require 私有包：缺失时抛出可识别错误，由 main 捕获降级。 */
function requirePrivatePackage(pkgName) {
  try {
    return require(pkgName);
  } catch (e) {
    const err = new Error(
      `private package '${pkgName}' not installed — check that the executor ` +
        `has NPM_REGISTRY_URL pointing at the private registry and that the ` +
        `task requirements list '${pkgName}'`,
    );
    err.cause = e;
    throw err;
  }
}

async function main() {
  const ctx = TaskContext.fromEnv();
  ctx.logger.info(`task=${ctx.taskId} execution=${ctx.executionId} started`);

  let result;
  const pkgName = getParam('pkg_name', '@autocodeflow/sdk');

  try {
    const mod = requirePrivatePackage(pkgName);
    const version =
      (mod && (mod.version || (mod.default && mod.default.version))) || 'unknown';
    ctx.logger.info(`private package resolved: ${pkgName}@${version}`);
    result = {
      success: true,
      source: 'private-package',
      package: { name: pkgName, version },
      finished_at: new Date().toISOString(),
    };
  } catch (e) {
    // 私服/包缺席时的降级演示：任务本身失败无意义，改为标注降级并成功返回
    ctx.logger.warn(`falling back to degraded demo: ${e.message}`);
    result = {
      success: true,
      source: 'degraded (package unavailable)',
      hint: e.message,
      finished_at: new Date().toISOString(),
    };
  }

  if (ctx.http.enabled) {
    if (result.source === 'private-package') {
      // 等价 Python 写法：ctx.report_success(summary=...)
      await ctx.reportSuccess({
        summary: `private pkg ${result.package.name}@${result.package.version} loaded`,
      });
    } else {
      // 降级不算失败，但仍用原生 post 把 hint 带给平台
      // （等价 Python 写法：ctx.callback.report([...])）
      await ctx.http.post('/api/executions/callback', [
        { status: 'success', logs: `degraded: ${result.hint}`.slice(0, 512_000) },
      ]);
    }
    ctx.logger.info('callback delivered');
  } else {
    ctx.logger.warn('callback disabled on this executor; skipping proactive report');
  }

  console.log(`RESULT: ${JSON.stringify(result)}`);
  return result;
}

// 平台以 module.exports 方式调用；直接 node 本文件时自执行（对齐既有示例）
if (require.main === module) {
  main().catch((e) => {
    console.error('Fatal:', e.message);
    process.exit(1);
  });
}

module.exports = { main };
