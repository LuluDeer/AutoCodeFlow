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

配置：`apps/registry-npm/config.yaml`（以单文件只读挂载进容器）；compose 镜像
pin 在 `verdaccio/verdaccio:5.31.1`（O-3，升级走显式改 tag）。要点：

| 项 | 值 | 说明 |
|---|---|---|
| `packages.'**'` | access/publish/unpublish = `$authenticated` | S-09：匿名不可读，避免暴露内部包与代理流量 |
| `packages.'@autoflow/*'` | `$authenticated` | 内部包仅登录用户可读写 |
| `auth.htpasswd.file` | `/verdaccio/storage/htpasswd` | 落在持久卷 `npm_data`，容器重建凭证不丢 |
| `auth.htpasswd.max_users` | `-1`（2026-10-26 N-3） | 禁自助注册；用户由运维离线写入 htpasswd |
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
| Anonymous | self-registration (`PUT /-/user/org.couchdb.user:*`) | ❌ Denied（2026-10-26 N-3 起） | `auth.htpasswd.max_users: -1`；用户由运维离线写入 htpasswd |
| Authenticated user | package metadata / tarball download | ✅ Allowed | `@autoflow/*` 与 `**` 均要求 `$authenticated` |
| Authenticated user | publish / unpublish | ✅ Allowed | 内部仓库按登录用户授权；如需分角色，后续接入外部 auth plugin |
| Public npm fallback | cache missing public package | ✅ Authenticated only | `packages.'**'.proxy = npmjs`，但 access 仍先要求 `$authenticated` |

### 已知豁免（2026-10-26 审计实测，N-2/N-6）

以下匿名可达面**经评估接受**，属 Verdaccio 5.x 内建行为，反代统一改写文案的
成本高于内网威胁模型下的收益；`scripts/registry-npm-demo-smoke.mjs` 把它们钉
成回归探针，漂移即红：

| 匿名请求 | 实测响应 | 接受理由 |
|---|---|---|
| `GET /-/v1/search?text=…` | 200（`access` 过滤后回空集；不回源 npmjs 公共数据） | 不泄漏私有包名，公共搜索语义无害 |
| `GET /-/all` | 200 `{"_updated":…}`（同样按权限过滤为空） | 同上，不含包名 |
| `GET /<pkg>` 对**不存在**的包 | 401，文案回显请求中的包名（`authorization required to access package <name>`） | 存在性枚举 oracle：攻击者需先持有网络位置（容器网/loopback），且枚举速度受日志观测约束；反代统一 401 文案是可选后续加固 |
| `GET /<pkg>` 对存在但无权的包 | 401，同上 | 与上一行同性质 |
| `GET /<非法名>`（`..%2f`、盘符等） | 400 `invalid package` | 名字合法性三态可辨，但不构成穿越（路径归一在路由层完成） |

网络面收敛：registry-npm 仅接入 `autoflow-internal`（N-3 起从 `autoflow-public`
摘除；调用方 admin-api 代理、executor-node 拉包、admin-web nginx `/npm/` 上游
全部在 internal）。凭据文件权限：容器启动 command 以 umask 077 + chmod 600
收敛卷内 `htpasswd` 与 `.verdaccio-db.json`（N-5）。

上述边界由 `npm run test:registry-npm` 静态校验：禁止 `$all`/`$anonymous` 包权限，确认 token 过期时间、持久化 htpasswd、只读配置挂载与默认 loopback 端口绑定。**运行中的 demo 栈**另由 `node scripts/registry-npm-demo-smoke.mjs` 做只读探针回归（匿名 ping/metadata/tarball/搜索豁免/穿越拒绝/自助注册关闭，需 demo 栈在跑，非 CI 必跑）。

加固建议（按需）：
- 保持 compose 的 `ports` 为 `'127.0.0.1:4873:4873'`，确需外部发布时通过环境覆盖或反向代理显式开放；
- 反向代理加 TLS 后，`listen` 可改为容器网络内地址；
- ~~禁止自助注册：`auth.htpasswd.max_users: -1`~~（2026-10-26 已落地，见配置表）。

### 运维：离线新增用户（max_users=-1 后的唯一通道）

宿主生成 htpasswd 行（bcrypt）后追加进卷文件，随后无需重启：

```bash
# 宿主（有 htpasswd 的机器或任意 openssl 形态）
docker run --rm httpd:alpine htpasswd -Bbn <user> '<pass>' >> <volume>/htpasswd
# 或用 python: python3 -c "import bcrypt;print(user+':'+bcrypt.hashpw(pw,bcrypt.gensalt()).decode())"
# 卷路径定位：docker volume inspect <project>_npm_data
```

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
