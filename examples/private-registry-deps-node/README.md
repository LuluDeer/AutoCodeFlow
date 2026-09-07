# 私服依赖示例任务（Node SDK）

演示**任务级依赖声明（requirements，W-21）+ 私服 npm registry** 的完整链路：

```
admin 下发任务(requirements)
  → executor-node 在任务隔离目录 .node_modules/<taskId> 生成 .npmrc
  → npm install --prefix <隔离目录> <requirements...>
  → NODE_PATH 指向隔离目录，require() 命中私有包
```

- 入口脚本：[private_dep_task.js](./private_dep_task.js)
- 任务配置样例：[task.example.json](./task.example.json)
- 本地依赖清单：[package.json](./package.json)
- Python 版对应示例：[../private-registry-deps/](../private-registry-deps/)

## 前置条件（executor 侧）

| 配置 | 位置 | 说明 |
|------|------|------|
| `NPM_REGISTRY_URL` | executor-node 的 `.env` / 启动环境 | 私服 npm 地址（如 `http://registry-npm:4873`）。**未配置时走公共 npm**；平台内置私服见 `apps/registry-npm`（verdaccio） |
| `NPM_REGISTRY_TOKEN` | 同上（可选） | 私服对 `**` 的 access 是 `$authenticated`（匿名安装必 401）时必配；token 不会出现在日志里 |
| 私有包已发布 | registry-npm | 私服中需存在任务引用的 scoped 包（如 `@yourco/your-pkg`） |

执行器侧的安装细节（源码证据）：

- `apps/executor-node/src/routes/execute.ts` 的依赖安装块：生成
  `.npmrc`（`buildNpmRcContent`：`@autoflow`/`@autocodeflow` 双 scope 行 +
  非 scoped 包的 `registry=` 行 + `_authToken` 行），随后
  `npm install --prefix <隔离目录> ...`；
- 包名按 npm name 正则校验（`@scope/name` 支持良好）；
- requirements 仅对 **entrypoint（打包）任务**生效，glue 脚本任务忽略；
- **scoped 包注意**：`.npmrc` 的 scope 行只覆盖 `@autoflow` /
  `@autocodeflow` 两个平台 scope——你们自己的 scope（如 `@yourco/`）依赖
  私服对非 scoped 请求的回源/兜底行为，或把 `NPM_REGISTRY_URL` 直接指向
  能解析该 scope 的私服。

## 运行

### 方式一：平台执行（完整链路）

1. 确认 executor-node 已配置 `NPM_REGISTRY_URL`（及需要时的
   `NPM_REGISTRY_TOKEN`）且私服内有引用的包；
2. admin 后台新建 node 任务，entrypoint 填
   `examples/private-registry-deps-node/private_dep_task.js`；
3. 任务依赖（requirements）填：`@autocodeflow/sdk`（示例默认，真实场景
   换成你们的私有包，见 `task.example.json`）；
4. 触发执行：执行日志会出现 `Installing N packages for task <taskId>` 与
   `Using npm registry: <地址（已脱敏）>`，任务结果里
   `source=private-package` 即链路打通。

### 方式二：本地试跑（跳过执行器）

```bash
cd examples/private-registry-deps-node
npm install                       # 公共 npm 拉 @autocodeflow/sdk；私网走 .npmrc 配置
export EXECUTION_ID=exec-local-001
export TASK_ID=private-dep-node
export TASK_NAME=私服依赖演示Node
node private_dep_task.js          # 包缺席时输出 degraded 分支
```

## 关键 API 对照（与 Python SDK 等价）

| 动作 | Node | Python |
|------|------|--------|
| 读参数 | `getParam('pkg_name')` | `ctx.get_param("pkg_name")` |
| 能力探测 | `ctx.http.enabled` | `ctx.callback.enabled` |
| 成功上报 | `await ctx.reportSuccess({ summary })` | `ctx.report_success(summary=...)` |
| 自定义回调 | `await ctx.http.post('/api/executions/callback', [{...}])` | `ctx.callback.report([{...}])` |
