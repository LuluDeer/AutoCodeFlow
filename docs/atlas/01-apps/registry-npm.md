# registry-npm — Verdaccio 私有 npm 仓库
> 所属: docs/atlas/01-apps · 最后核对: 2026-09-13 · 对应代码: apps/registry-npm/config.yaml、apps/registry-npm/README.md、docker-compose.yml（registry-npm 服务）

## 一句话定位

AutoCodeFlow 的私有 npm registry：托管 `@autoflow/*` / `@autocodeflow/*` 内部包并缓存 npmjs 公共包。采用官方 **Verdaccio 5** 镜像部署，**非自研**（与自研 FastAPI 的 [registry-pypi](registry-pypi/README.md) 相反——npm 协议面大，Verdaccio 是成本最低的选择）。

## 配置要点（apps/registry-npm/config.yaml）

| 项 | 值 | 说明 |
|---|---|---|
| `storage` | `/verdaccio/storage` | 持久卷 `npm_data`（compose 挂载） |
| `auth.htpasswd.file` | `/verdaccio/storage/htpasswd` | R8：凭证放存储卷内，容器重建不丢（config.yaml 以只读单文件挂载） |
| `auth.htpasswd.max_users` | `100` | 自助注册上限；`-1` = 禁止自助注册（纯内网收紧场景，用户由运维离线写入） |
| `uplinks.npmjs` | `https://registry.npmjs.org/` | 公共包回源 |
| `max_body_size` | `100mb` | 发布包体积上限（显式声明防误改） |
| `security.api.jwt.sign.expiresIn` | `60d` | API token 有效期（web 端 7d） |
| `packages.'@autoflow/*'` | access/publish/unpublish = `$authenticated` | 内部包仅登录用户可读写 |
| `packages.'**'` | `$authenticated` + `proxy: npmjs` | S-09：**匿名一律 401**（连公共包代理流量也不暴露），缓存回源 npmjs |
| `web` | `enabled: true`，`darkMode: true` | 纯内网可关 Web UI，npm 协议不受影响 |
| `listen` | `0.0.0.0:4873` | 容器内监听（compose 端口映射的前提） |

compose 侧（docker-compose.yml `registry-npm` 服务）：镜像 `verdaccio/verdaccio:5`，端口默认 `127.0.0.1:4873:4873`（loopback-only，executor 走 Docker 内网服务名），config 只读挂载，healthcheck `wget http://127.0.0.1:4873/-/ping`（用 127.0.0.1 而非 localhost——verdaccio 5 仅 IPv4，容器内 localhost 优先 ::1 会恒失败）。

## 鉴权与权限矩阵

- 匿名：仅 `/-/ping`（compose healthcheck）放行；metadata / tarball / publish / unpublish 全部 401（`$authenticated`）。
- 登录用户：读写皆可（内部仓库按登录用户授权；分角色需后续接入外部 auth plugin）。
- 用户创建：`npm adduser --registry http://<host>:4873/`，凭证写入客户端 `~/.npmrc` 的 `_authToken`。
- 边界由 `npm run test:registry-npm` 静态校验（禁止 `$all`/`$anonymous`、确认 token 有效期/持久化 htpasswd/loopback 端口绑定）。

## 分工：谁上传、谁下载

```
开发者/CI                       admin-api                     executor-node
    │ npm publish                    │ registry 模块代理              │ npm install
    │ (packages/* 发布内部包)          │ GET /registry/npm/packages     │ 临时 .npmrc
    ▼                                │ POST /registry/npm/…           │ @autoflow/@autocodeflow
┌────────────────────────── registry-npm (Verdaccio 5) ───────────────┐
│  内部包存储 + npmjs 代理缓存（'**'.proxy = npmjs）                    │
└──────────────────────────────────────────────────────────────────────┘
```

- **上传（写）**：开发者/CI 用 npm CLI 直接 publish 内部包（如 `packages/autocodeflow-node-sdk` 构建产物）；admin-api 的 `registry` 模块（JWT 保护，`@Controller("registry")`）以代理身份读包列表/转发上传，凭据来自 env `NPM_REGISTRY_USER` / `NPM_REGISTRY_PASS` / `NPM_REGISTRY_TOKEN`（未配置时匿名——在 `$authenticated` 策略下会失败）。
- **下载（读）**：executor-node 任务安装是主力消费方——`NPM_REGISTRY_URL` 指向私服（compose 默认 `http://registry-npm:4873`），`NPM_REGISTRY_TOKEN` 写入每次安装的临时 .npmrc（`_authToken` 行）。因为 `'**'` 也要求 `$authenticated`，**匿名安装必 401**，执行器必须配 token（apps/executor-node/src/routes/execute.ts `buildNpmRcContent` 注释）。
- **公共包**：私服无缓存时自动回源 npmjs 并缓存（需容器可出网）；仅内部 scope 的任务会只写 scoped registry 行，公共包走客户端默认源。

## 健康检查与运维

- 健康端点：`GET /-/ping` → 200 + `{}`（compose healthcheck 同源，30s 间隔）。
- Web UI：`http://<host>:4873/`（登录后可浏览包；`web.enabled: false` 可整体关闭，npm 协议不受影响）。
- 数据备份：整库状态都在 `npm_data` 卷（包存储 + htpasswd），备份该卷即备份全部；`config.yaml` 本身无状态、只读挂载。
- 常见故障：
  - **执行器安装 401** → `NPM_REGISTRY_TOKEN` 未配置或 htpasswd 用户被删（`'**'` 均要求 `$authenticated`）；
  - **healthcheck 恒 unhealthy** → 见上文 127.0.0.1 vs ::1 说明（verdaccio 5 仅 IPv4）；
  - **公共包拉不下来** → 容器无出网且缓存未命中（`proxy: npmjs` 需要出网）。

## 端到端链路（以"任务装依赖"为例）

```
1. 开发者: cd packages/autocodeflow-node-sdk && npm publish --registry http://<host>:4873/
2. admin-web/CLI: 创建任务 requirements=["@autoflow/sdk", "lodash"]
3. admin-api: BullMQ 派发 POST /api/execute → executor-node
4. executor-node routes/execute.ts:
     mkdtemp 临时目录写 .npmrc（@autoflow/@autocodeflow scope 行 + 全局 registry 行
     + _authToken 行）→ npm install --prefix .node_modules/<taskId> → npm 退出即删临时目录
5. Verdaccio: @autoflow/sdk 命中内部存储；lodash 未命中则回源 npmjs 并缓存
6. 任务运行（NODE_PATH 指向安装目录）→ 终态回调
```

## 与其他组件的关系

- **被 executor-node 依赖**：任务依赖安装（见 [executor-node 执行管线](executor-node/execution-pipeline.md)）与应用部署 `npm install --production --registry=`（routes/deploy.ts）。
- **被 admin-api registry 模块依赖**：管理台"npm 包管理"页面的列表/上传代理（见 [admin-api registry 模块](admin-api/modules/registry.md)）。
- **`@autoflow/*` scope 的生产者**：`packages/` 下各 Node 包发布至此，任务 `requirements` 可直接引用。

## 常见改动场景

- **收紧注册**：`max_users: -1` + 运维离线写 htpasswd；改后需同步 README 的权限矩阵。
- **换/加 uplink**：`uplinks` 段 + `packages.'**'.proxy`；私有化无外网场景删除 proxy 行。
- **放开匿名读**：不建议（S-09 明确禁止 `$all`）；确需时改 `packages.'**'.access` 并同步 `test:registry-npm` 校验规则。
- **发布新内部包**：包 `package.json` 的 `name` 用 `@autoflow/` 或 `@autocodeflow/` 前缀，`npm publish --registry http://<host>:4873/`；执行器侧 scope 行已双覆盖。

## 相关文档

- [PyPI 私服](registry-pypi/README.md)（对照：自研方案）· [registry-pypi 内部实现](registry-pypi/internals.md)
- [executor-node 执行管线](executor-node/execution-pipeline.md) —— .npmrc 生成细节
- [admin-api registry 模块](admin-api/modules/registry.md) —— 管理台代理面
- [部署与 CI](../06-infra/deployment-and-ci.md) —— compose 服务全景
