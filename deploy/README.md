# 本机部署 Runbook（<LAN_IP>）

> 2026-10-30 全新部署。项目名 `acf`，数据卷前缀 `acf_`。
> 凭据在 `/home/yongsheng/.acf-credentials`（600）与仓库根 `.env`（600，已 gitignore）。

## 一、部署形态

- **中台只跑控制面 + 基础设施**，本机**不运行任何执行器**（用户要求）。
  根 compose 里的 `executor-node` / `executor-python` 用
  `docker-compose.no-executor.yml` 的 profile 关掉，默认 `up` 不会创建。
- 宿主 `:80` 归宝塔 nginx，`admin-web` 改绑 `:8088`（全接口，局域网可达）。
- `admin-api` 仍只绑 `127.0.0.1:3105`；外部一律经 admin-web 内置 nginx 的
  `/api`、`/uploads`、SSE 入口，避免多开一个入站面。

| 服务 | 宿主端口 | 说明 |
|---|---|---|
| admin-web | `0.0.0.0:8088` | 控制台 + 统一 API 入口（局域网执行器用它） |
| admin-api | `127.0.0.1:3105` | 仅本机/容器网络 |
| registry-pypi | `127.0.0.1:8003` | 私有 PyPI |
| registry-npm | 未发布 | 仅容器网络（admin-web 代理） |
| postgres / redis | 未发布 | 仅 internal 网络 |

数据卷：`acf_postgres_data`、`acf_redis_data`、`acf_admin_uploads`、
`acf_npm_data`、`acf_pypi_data`。

## 二、访问入口

| 入口 | 地址 | 用途 |
|---|---|---|
| 公网域名 | <https://<ACF_DOMAIN>> | 跨网执行器 pull、远程运维（经 VPS nginx → frp → 本机 8088） |
| 局域网 | <http://<LAN_IP>:8088> | 同网段执行器 push、内网访问 |
| API 健康 | `/api/health/ready` | `ready` 才是探针口径；`/api/health` 的 `degraded` 仅表示暂无在线执行器 |

- 账号：`admin`（密码见凭据文件；首次登录后请改）
- 隧道对端：VPS `<VPS_IP>:18809`（frps remote_port，对应 `.env` 的
  `FRP_REMOTE_PORT`）

## 三、常用命令

```bash
cd /home/yongsheng/project/AutoCodeFlow
DC="docker compose -p acf --env-file .env \
  -f docker-compose.yml -f docker-compose.local.yml -f docker-compose.no-executor.yml"

$DC ps
$DC logs -f --tail=100 admin-api
$DC restart admin-api
$DC up -d --build            # 改代码/镜像后
$DC down                     # 停（保留卷）
docker compose -p acf ... down -v   # ⚠ 连数据一起删

# 数据库
$DC exec postgres psql -U autoflow -d autoflow
$DC exec -T admin-api npm run migration:run:prod

# 备份（宿主机）
docker run --rm -v acf_postgres_data:/var/lib/postgresql/data -v "$PWD/logs/db-backups:/backup" \
  postgres:16-alpine sh -c 'pg_dump -U autoflow autoflow | gzip > /backup/acf-$(date +%F).sql.gz'
```

## 四、执行器接入（全部外部机器）

> 依赖 artifact 通道：`artifacts/executor-node.tar.gz`（4MB，含 dist + 生产
> node_modules）由 `bash scripts/bundle-executor-artifact.sh` 生成，已在
> `docker-compose.local.yml` 里以只读卷挂到 admin-api 的 `/app/artifacts`。
> 改了 executor-node 代码后要**重新生成 artifact**，否则目标机装到的是旧版本：
> `bash scripts/bundle-executor-artifact.sh && docker compose ... up -d admin-api`
> （不挂载或产物缺失时该端点 404 `EXECUTOR_ARTIFACT_MISSING`）。

**第 0 步：在目标机跑连通性预检（不改任何东西）**

```bash
# 跨网（pull）
bash deploy/executor-preflight.sh https://<ACF_DOMAIN>
# 局域网（push）
bash deploy/executor-preflight.sh http://<LAN_IP>:8088
```

六项全绿再装：DNS、TCP、TLS 证书有效期、`/api/health/ready`、`install.sh`
可下载、`/api/executors/pull` 返回 401（证明反代没拦 POST）。

安装脚本由 admin-api 下发，`--api-url` 必须填执行器**能访问到**的地址。

**局域网（push）**：

```bash
curl -fsSL 'http://<LAN_IP>:8088/api/executors/install.sh' | bash -s -- \
  --api-url 'http://<LAN_IP>:8088' \
  --secret '<EXECUTOR_SECRET>'
```

**跨网（pull，NAT 后无需入站）**：

```bash
curl -fsSL 'https://<域名>/api/executors/install.sh' | bash -s -- \
  --api-url 'https://<域名>' \
  --secret '<EXECUTOR_SECRET>' \
  --pull
```

`<EXECUTOR_SECRET>` 取 `.env`，或用管理员登录后
`GET /api/executors/install-cmd?type=node` 直接拿整条命令（内含 secret，
只给管理员看）。

接入成功后「执行器」页应看到在线行；pull 模式带紫色 **Pull 回连** 徽标。

## 五、跨网域名入口（frp，vhost 模式）

链路：`https://<ACF_DOMAIN>` → VPS nginx:443 → `127.0.0.1:40800`（frps
vhostHTTPPort）→ frp 隧道 → 本机 `acf-frpc-1` → `admin-web:80`。

关键配置（VPS `frps.toml` 与本机 `deploy/frp/frpc.toml` 必须成对）：

| 参数 | 值 | 为什么 |
|---|---|---|
| `vhostHTTPPort` | 40800 | frps 按 Host 头路由，不需要 remotePort |
| `tcpMux` | **false** | true 时走 yamux（窗口硬编码 6MB），60 执行器并发实测 12.24s vs 关闭后 6.04s |
| `maxPoolCount` / `poolCount` | **200** | frps 实际池 = min(两侧) + 10；池空时现场建连会阻塞到 `UserConnTimeout`(10s) |

VPS nginx 关键参数：`proxy_pass http://127.0.0.1:40800;`、`proxy_set_header
Host $host;`（vhost 靠它路由）、`client_max_body_size 510m`、
`proxy_buffering off`、`proxy_cache off`、`proxy_request_buffering off`、
`ssl_early_data off`。完整文件见 [deploy/frp/<ACF_DOMAIN>.conf](frp/<ACF_DOMAIN>.conf)。

自检：`deploy/frp/enable.sh`（六项全过才返回 0）。

## 五·五、故障：域名显示 "powered by frp" 的 404 页

**现象**：访问 `https://<ACF_DOMAIN>` 出现 frp 自己的错误页：

```
The page you requested was not found.
Sorry, the page you are looking for is currently unavailable.
The server is powered by frp.
```

而 `http://<LAN_IP>:8088` 正常、`docker logs acf-frpc-1` 也一切正常
（`start proxy success`）。

**根因**：frps 重启（改配置 / 面板重启 / 崩溃）后 **vhost 路由表被清空**，但
frpc 侧的 proxy 仍停在 `Phase=Running`——`client/control.go` 的
`handleNewProxyResp` 只在收到 frps 回执时才置 Running，重连后**不会主动重发
`NewProxy`**。于是请求进 frps 后按 Host 匹配不到任何 proxy，落到内置 404 页。

**立即恢复**（一条命令，秒级生效）：

```bash
docker restart acf-frpc-1
```

**已加的防护**：`deploy/frp/frpc.toml` 配了 `healthCheck`（探测
`admin-web:80/health`，30s 间隔、5s 超时、连续 3 次失败即重发注册）。实测：
停掉 admin-web → 域名转 404；恢复 admin-web → 40s 内自动回到 200，无需人工。

**什么时候还会遇到**：

| 触发动作 | 是否自动恢复 |
|---|---|
| 改 `frps.toml` 后重启 frps | ✅ healthCheck 兜住（若 admin-web 一直健康，需手动重启一次 frpc） |
| 面板里重启 frps | 同上 |
| 重建 `acf-admin-web-1` | ✅ 自动 |

> 注意：healthCheck 探测的是**本地服务**，不是 frps 的路由表。若 frps 重启但
> admin-web 全程健康，healthCheck 不会失败、也就不会触发重注册。这种情况请
> **改完 frps 配置后顺手 `docker restart acf-frpc-1`**，或执行
> `deploy/frp/enable.sh`（它会重建 frpc 并跑完六项验证）。

## 六、admin-api 上游自愈（已修，2026-10-30）

镜像内 `apps/admin-web/nginx.conf` 是静态 `proxy_pass http://admin-api:3105;`，
nginx 只在**启动期**解析一次。`docker compose up -d admin-api` 重建容器换 IP 后，
`/api` 会全部 502（页面能开、登录报错），直到 admin-web 重启——本次部署实测踩到。

修法：`docker-compose.local.yml` 把 `deploy/nginx/admin-web.conf` 挂进容器覆盖
`/etc/nginx/conf.d/default.conf`。该文件在镜像配置基础上**只加两行**：

```nginx
resolver 127.0.0.11 valid=10s ipv6=off;
set $admin_api_upstream admin-api:3105;
```

并把 4 处 `proxy_pass http://admin-api:3105;` 换成 `http://$admin_api_upstream;`
（其余安全头、gzip、SSE、/uploads、registry 逐字未动）。效果：每请求解析、
10s 收敛，重建 admin-api 不再需要动 admin-web。

验证：`nginx -t` 通过；强制重建 admin-api 后 8088 在 6s 内恢复 200。
兜底：若仍见 `/api` 502 且 error.log 指向旧 IP，`docker restart acf-admin-web-1`。

## 七、部署时发现并修复的缺陷

`POST /api/executors/pull` 的长轮询此前**一秒都不等**：控制器把
`isClientGone`（true=已断开）当作 `pullWork` 的 `opts.isConnected`（true=仍连接）
传入，健康连接的第一次循环就被判「断开」直接 break。

- 实测：修复前 `waitMs=6000` 恒 `~5ms` 返回；修复后 `6.21s`。
- 影响：长轮询退化为短轮询（`EXECUTOR_PULL_WAIT_MS` 失效、空闲执行器空转拉高
  请求量），真正断开的连接反而继续空转。
- 修法：`executor.controller.ts` 增加 `isClientConnected = () => !isClientGone()`
  并传入；新增回归用例
  `P3-1 回归：传给 pullWork 的 isConnected 是存活谓词`
  （反证实测：换回旧调用即转红）。
- 验证：`executor.controller.spec.ts` 63/63 通过；重建镜像后经域名
  `waitMs=3000` 实测 `4.03s`（含网络往返），证明 VPS 反代未缓冲/未断流。

## 七·五、执行器扩容的性能特性（2026-10-30 实测）

执行器令牌校验走 `bcrypt.compare`（cost 12），**单次约 190ms 且并发完全不扩展**
（实测 n=1/2/4/8/16 的单次等效耗时恒为 ~195ms）。因此：

| 场景 | 60 台并发 | 说明 |
|---|---|---|
| 局域网直连 8088 | 6.06s | 热缓存基线 |
| 域名（frp vhost） | 7.64s | 热缓存，多约 1.5s = 180ms RTT × 往返 |
| 域名（frp vhost） | 13.33s | **冷缓存**（60 台全新执行器首拉，60 次 bcrypt 串行） |
| 10 台稳态（每 25s 一轮） | 2.05s | 真实生产形态，窗口 1s |

**已做的优化**：`TOKEN_CACHE_TTL_MS` 从 60s 调到 **15 分钟**
（`executor.service.ts`，可用 `EXECUTOR_TOKEN_CACHE_TTL_MS` 覆盖）。冷缓存因此
从「每 60 秒一次」变成「每 15 分钟一次」，且只影响**尚未校验过的新令牌**。

**明确排除的方案**：调 `UV_THREADPOOL_SIZE` **无效**——实测 4 与 16 的 16 并发
耗时相同（~3s），bcrypt 的异步实现被序列化，不走 libuv 线程池。

**撤销语义不受影响**：`rotateToken` / `removeById` 会调 `evictTokenValidationsFor`
**立即**清掉该地址的正缓存，不依赖 TTL（有回归用例钉住）。

**结论**：≤ 50 台执行器的稳态场景无感知；大规模冷启动（如整机队同时重启）会有
一次性 10~15s 的认证排队，属可接受。

## 八、当前已知状态

- `/api/health` 的 `status` 在**没有任何在线执行器**时是 `unhealthy`
  （`HEALTH_EXECUTOR_ONLINE_RATIO_MIN=0.5`），`/api/health/ready` 仍为
  `ready`。这是预期，不是故障——第一台执行器上线后自动转 healthy。
- `admin-web` 镜像构建时 `VITE_API_URL_INTERNAL` 指向容器内 `admin-api:3105`，
  前端走同源 `/api`，因此换域名**不需要重建前端**。
- 改 `CORS_ORIGINS` / `ADMIN_WEB_ORIGIN` / `ADMIN_API_URL` / `API_BASE_URL`
  后要重建 admin-api 容器：`$DC up -d admin-api`。
