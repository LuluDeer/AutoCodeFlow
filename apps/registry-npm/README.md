# registry-npm — 私有 npm 仓库（Verdaccio）

AutoCodeFlow 的私有 npm registry，用于托管 `@autoflow/*` 内部包并缓存
npmjs 公共包。采用官方 [Verdaccio](https://verdaccio.org/) 镜像部署，
**非自研**（与 `apps/registry-pypi` 的自研 FastAPI 方案不同——npm 生态
协议面大，verdaccio 是成本最低且久经考验的选择）。

## 部署

服务已集成在仓库根 `docker-compose.yml`（`registry-npm`，随全栈默认启动；
executor-node 的 `NPM_REGISTRY_URL` 默认指向 `http://registry-npm:4873`）。

```bash
# 全栈（含 registry-npm）
docker compose up -d

# 仅启动 registry-npm
docker compose up -d registry-npm

# 健康检查（compose healthcheck 同源）
curl http://localhost:4873/-/ping     # 期望 200 + {}
```

配置：`apps/registry-npm/config.yaml`（以单文件只读挂载进容器）。
要点：

| 项 | 值 | 说明 |
|---|---|---|
| `packages.'**'` | access/publish/unpublish = `$authenticated` | S-09：匿名不可读，避免暴露内部包与代理流量 |
| `packages.'@autoflow/*'` | `$authenticated` | 内部包仅登录用户可读写 |
| `auth.htpasswd.file` | `/verdaccio/storage/htpasswd` | 落在持久卷 `npm_data`，容器重建凭证不丢 |
| `max_body_size` | `100mb` | 发布包体积上限 |
| `web.enabled` | `true` | 纯内网可置 `false` 关 Web UI（npm 协议不受影响） |
| `listen` | `0.0.0.0:4873` | 容器内监听；对外暴露面在 compose `ports` / 防火墙收敛 |
| compose `ports` | `127.0.0.1:4873:4873` | 默认仅宿主本机可访问；executor 走 Docker 内网服务名 |

## 权限矩阵（BUG-16 复审）

| 主体 | 操作 | 预期 | 配置依据 |
|---|---|---|---|
| Anonymous | ping / healthcheck | ✅ Allowed | Verdaccio `/-/ping` 用于 compose healthcheck，不暴露包内容 |
| Anonymous | package metadata / tarball download | ❌ Denied | `packages.'**'.access = $authenticated` |
| Anonymous | publish / unpublish | ❌ Denied | `packages.'**'.publish/unpublish = $authenticated` |
| Authenticated user | package metadata / tarball download | ✅ Allowed | `@autoflow/*` 与 `**` 均要求 `$authenticated` |
| Authenticated user | publish / unpublish | ✅ Allowed | 内部仓库按登录用户授权；如需分角色，后续接入外部 auth plugin |
| Public npm fallback | cache missing public package | ✅ Authenticated only | `packages.'**'.proxy = npmjs`，但 access 仍先要求 `$authenticated` |

上述边界由 `npm run test:registry-npm` 静态校验：禁止 `$all`/`$anonymous` 包权限，确认 token 过期时间、持久化 htpasswd、只读配置挂载与默认 loopback 端口绑定。

加固建议（按需）：
- 保持 compose 的 `ports` 为 `'127.0.0.1:4873:4873'`，确需外部发布时通过环境覆盖或反向代理显式开放；
- 反向代理加 TLS 后，`listen` 可改为容器网络内地址；
- 禁止自助注册：`auth.htpasswd.max_users: -1`，用户由运维离线写入 htpasswd。

## 使用

### 1. 创建用户（首次，自助注册开启时）

```bash
npm adduser --registry http://<host>:4873/
# 交互式输入 username / password / email；凭证写入 ~/.npmrc（_authToken）
```

### 2. 安装

```bash
# 项目级 .npmrc（推荐）：内部 scope 走私服，其余走官方源
@autoflow:registry=http://<host>:4873/

# 或全局替换默认 registry
npm config set registry http://<host>:4873/
```

`'**'` 配了 `proxy: npmjs`：私服没有的包自动回源 npmjs 并缓存，
因此全局替换默认 registry 也能正常安装公共包（需容器可出网）。

### 3. 发布

```bash
cd packages/<pkg>
npm publish --registry http://<host>:4873/
# 仅发布内部 scope 时：确认 package.json name 为 @autoflow/...
```

### 4. 验证

```bash
npm view @autoflow/<pkg> --registry http://<host>:4873/
curl -s -u <user>:<pass> http://<host>:4873/-/user/org.couchdb.user:<user>  # 取 token
```

## 与 executor-node 的关系

executor-node 部署任务时若配置了 `NPM_REGISTRY_URL`，会在任务环境里
注入 `registry=<NPM_REGISTRY_URL>`，使 `npm install` 走私服（离线/加速）。
CI 的 `npm-audit` 仍显式 `--registry=https://registry.npmjs.org`，不受私服影响。

## 故障排查

- `curl /-/ping` 无响应：`docker compose logs registry-npm`；多为
  config.yaml 语法错误或 4873 端口占用。
- 发布 401/403：确认 `npm adduser` 成功、`.npmrc` 中 token 对应
  registry 地址与 `--registry` 完全一致（含末尾斜杠与协议）。
- 容器重建后用户丢失：历史配置曾把 htpasswd 放在 conf 下（不持久）；
  现指向 storage 卷，若仍复现请检查 `npm_data` 卷是否存在。
