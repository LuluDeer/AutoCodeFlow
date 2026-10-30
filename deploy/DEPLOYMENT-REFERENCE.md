# 单机部署 + 跨网接入参考方案

> 本文是**可复用的部署方案**，不含任何真实域名/IP/密钥。
> 具体环境的值放根 `.env` 与 `deploy/local/`（均已 gitignore）。

## 一、拓扑

```
                     ┌─────────────────────────── 公网 VPS ───────────────────────────┐
                     │  nginx :443 (TLS 终止, 域名反代)                                 │
  跨网执行器 ──HTTPS──▶  └─▶ 127.0.0.1:<FRP_VHOST_HTTP_PORT> (frps vhostHTTPPort)     │
  (NAT 后, pull)     │            │                                                    │
                     └────────────┼────────────────────────────────────────────────────┘
                                  │  frp 隧道（frpc 主动外连，无需入站端口）
                     ┌────────────▼──────────── 中台主机（内网）──────────────────────┐
  局域网执行器 ──HTTP─▶  frpc ──▶ admin-web:80 (容器 nginx)                              │
  (push)             │            ├─ /api      → admin-api:3105                        │
                     │            ├─ /uploads  → admin-api:3105                        │
                     │            ├─ /pypi     → registry-pypi:8003                    │
                     │            └─ /npm      → registry-npm:4873                     │
                     │  postgres / redis（仅容器网络）                                  │
                     └────────────────────────────────────────────────────────────────┘
```

**关键取舍**：中台只跑控制面与基础设施，**不在中台主机上跑执行器**；执行器全部是
外部机器，按网络位置分两类接入。

## 二、为什么这样分

| 执行器位置 | 接入方式 | 下载包走哪条路 |
|---|---|---|
| 与中台同局域网 | **push**（admin-api 主动拨入执行器 8001/8002） | 直连 `<LAN_IP>:8088` |
| 其它网段 / NAT 后 | **pull**（执行器长轮询 `POST /api/executors/pull`） | `https://<ACF_DOMAIN>` |

`push` 要求执行器接受入站连接；NAT 后的机器做不到，所以走 `pull`——执行器只出站，
中台把派发载荷 LPUSH 到 Redis `acf:pull:<executorId>`，执行器等长轮询取件。

## 三、端口规划

| 位置 | 端口 | 用途 | 暴露面 |
|---|---|---|---|
| 中台主机 | 8088 | admin-web（控制台 + 统一 API 入口） | 局域网可达 |
| 中台主机 | 3105 | admin-api | **仅回环** |
| 中台主机 | 8003 | registry-pypi | **仅回环** |
| 中台主机 | 5432 / 6379 | postgres / redis | **仅容器网络** |
| VPS | 443 | 域名反代入口 | 公网 |
| VPS | `<FRP_VHOST_HTTP_PORT>` | frps vhost | **仅回环** |
| VPS | 7000 | frps 控制端口 | 公网（需放行） |

> 宿主 `:80` 若已被宝塔/其它站点占用，admin-web 就改绑 8088，由 VPS 侧 nginx
> 或本机 nginx 按域名反代，不要和既有站点抢 80。

## 四、部署步骤

### 4.1 准备 `.env`

```bash
cp .env.example .env && chmod 600 .env
```

必填（`.env.example` 里有说明）：`POSTGRES_PASSWORD`、`DB_PASSWORD`、
`REDIS_PASSWORD`、`JWT_SECRET`、`JWT_REFRESH_SECRET`、`EXECUTOR_SECRET`、
`SEC_SECRETS_KEY`、`REGISTRY_PASS`、`INITIAL_ADMIN_PASSWORD`。

对外地址三件套必须与执行器可达性一致：

```bash
# 局域网部署（执行器都能访问这个地址）
ADMIN_API_URL=http://<LAN_IP>:8088
API_BASE_URL=http://<LAN_IP>:8088
ADMIN_WEB_ORIGIN=http://<LAN_IP>:8088
CORS_ORIGINS=http://<LAN_IP>:8088
```

> `API_BASE_URL` 用于拼 `packageUrl`。若同时有跨网执行器，这里填公网域名也
> 可以——执行器侧会把 `packageUrl` 同源改写回它自己配置的 admin 地址
> （见「六、已知陷阱」第 3 条）。

### 4.2 启动

```bash
DC="docker compose -p acf --env-file .env \
  -f docker-compose.yml -f docker-compose.local.yml -f docker-compose.no-executor.yml"

$DC up -d --build
$DC exec -T admin-api npm run migration:run:prod
```

`docker-compose.local.yml` 负责：admin-web 绑 8088、挂自愈上游的 nginx 配置、
挂执行器 artifact 目录。`docker-compose.no-executor.yml` 把两个执行器服务收进
profile，默认不启动。

### 4.3 生成执行器安装产物

```bash
bash scripts/bundle-executor-artifact.sh     # → artifacts/executor-node.tar.gz
```

admin-api 通过只读卷读到它，`GET /api/executors/artifact/executor-node.tar.gz`
才能下发（缺了就是 404 `EXECUTOR_ARTIFACT_MISSING`）。

### 4.4 接入执行器

先预检（不改任何东西）：

```bash
bash deploy/executor-preflight.sh https://<ACF_DOMAIN>   # 跨网
bash deploy/executor-preflight.sh http://<LAN_IP>:8088   # 局域网
```

六项全绿再装：

```bash
# 局域网（push）
curl -fsSL 'http://<LAN_IP>:8088/api/executors/install.sh' | bash -s -- \
  --api-url 'http://<LAN_IP>:8088' --secret '<EXECUTOR_SECRET>'

# 跨网（pull）
curl -fsSL 'https://<ACF_DOMAIN>/api/executors/install.sh' | bash -s -- \
  --api-url 'https://<ACF_DOMAIN>' --secret '<EXECUTOR_SECRET>' --pull
```

### 4.5 跨网入口（frp）

前置：VPS 上 frps 已运行，`.env` 填好：

```bash
FRP_SERVER_ADDR=<VPS_IP>
FRP_SERVER_PORT=7000
FRP_TOKEN=<与 frps auth.token 一致>
FRP_DOMAIN=<ACF_DOMAIN>
```

VPS `frps.toml` 关键项：

```toml
bindPort = 7000
vhostHTTPPort = <FRP_VHOST_HTTP_PORT>
auth.method = "token"
auth.token = "<同一个 token>"

[transport]
# 实测：tcpMux=true 时 60 执行器并发长轮询 12.24s，false 时 6.04s（与直连持平）
tcpMux = false
# frps 实际池 = min(frpc poolCount, 本值) + 10，两边要同步
maxPoolCount = 200
```

VPS nginx 用 [vps-site.conf](frp/vps-site.conf) 模板，替换占位符后启用。

本机启动隧道并自检：

```bash
deploy/frp/enable.sh --domain <ACF_DOMAIN>
```

## 五、验证清单

| 检查 | 期望 |
|---|---|
| `curl https://<ACF_DOMAIN>/api/health/ready` | `status: ready` |
| `curl -o /dev/null -w '%{http_code}' https://<ACF_DOMAIN>/uploads/packages/x.zip` | 401/403（**不是** 200 text/html） |
| `curl -X POST https://<ACF_DOMAIN>/api/executors/pull -d '{}'` | 401，耗时 < 2s |
| `curl https://<ACF_DOMAIN>/` | 200，控制台标题 |
| 控制台「执行器」页 | 局域网行无徽标、跨网行带 **Pull 回连** 徽标 |

`deploy/frp/enable.sh` 会自动跑完前四项。

## 六、已知陷阱（都踩过）

**1. 域名返回 frps 内置的 "powered by frp" 404**
这个 404 的准确含义是：**请求打到了 frps，但该域名没有已注册的 http 代理**。
它既可能是 frps 重启清了路由表，也可能是 **frpc 自己退出了**（后者更常见）。

生产排查实证（2026-10-30，VPS 侧指标）：frps `RestartCount=0`、容器自
`2026-08-20` 未重建、`OOMKilled=false`、conntrack 0.7%、12h 内仅 1 次启动
（人为改配置）。**frps 本身没有任何频繁重启**——问题全在客户端侧。

真正的原因：frp 的 `loginFailExit` **默认 `true`**，首次登录失败即退出进程。
frps 一重启，客户端撞上那 1 秒窗口就永久退出。证据：acf 客户端 12h 内出现
**6 个不同 hostname**（容器被反复重建）；`09:13:23` 掉线 → `09:21:46` 才回来，
中间 8 分钟整段 404，而 frps 当时完全正常。

**修法（已在 `frpc.toml` 落地）**：

```toml
loginFailExit = false       # 登录失败不退出，按 backoff 持续重试
transport.heartbeatInterval = 10   # 比默认 30 更早发现链路 RST
transport.heartbeatTimeout = 30    # 比默认 90 更早重连
transport.tcpMux = false           # mux 断一次会带走所有代理；且 mux 下应用层心跳默认关闭
```

配套：容器 `restart: unless-stopped`（compose 已有）。

> **在客户端还没升级到本配置之前，不要去重启 frps**——会再次打死客户端。
> 同一台 VPS 上另一台 Windows 客户端（音频克隆服务）就是这么被打死的。

另有 `healthCheck` 兜底本地服务故障（探测 `admin-web:80/health`），实测停掉
admin-web → 404，恢复后 40s 内自动回到 200。

**2. 重建 admin-api 后 `/api` 全部 502**
admin-web 内置 nginx 若用静态 `proxy_pass http://admin-api:3105`，只在启动期
解析一次。`docker-compose.local.yml` 已挂载变量形态的配置
（`resolver 127.0.0.11 valid=10s` + `set $admin_api_upstream`），每请求解析、
10s 收敛。兜底仍是 `docker restart acf-admin-web-1`。

**3. 局域网执行器绕公网下包**
`packageUrl` 由 admin-api 用全局单一 `API_BASE_URL` 拼出。若填公网域名，局域网
执行器每次下包都要绕 VPS + frp 隧道（实测 1300ms vs 直连 1.3ms），且握手中断
会记成 `package_fetch_failed`。执行器侧已实现同源改写：把 `packageUrl` 的
scheme+host 换成本执行器 `ADMIN_API_URL` 的地址（仅 `/uploads/` 路径、
路径与查询串逐字节保留）。跨网执行器的 `ADMIN_API_URL` 本就是域名，改写恒等。

**4. 执行器令牌校验的冷启动成本**
`bcrypt.compare` 单次约 190ms 且**并发不扩展**（实测 n=1..16 单次等效恒为
~195ms；调 `UV_THREADPOOL_SIZE` 无效，bcrypt 的异步实现被序列化）。
`TOKEN_CACHE_TTL_MS` 已从 60s 调到 15 分钟，冷缓存从「每 60s 一次」变成
「每 15min 一次」。撤销语义不受影响——`rotateToken`/`removeById` 会立即清缓存。

**5. 上传大包 413 / 日志流卡住**
反代必须设 `client_max_body_size 510m`、`proxy_buffering off`、`proxy_cache off`。
模板里都有，别删。

## 七、运维速查

```bash
DC="docker compose -p acf --env-file .env \
  -f docker-compose.yml -f docker-compose.local.yml -f docker-compose.no-executor.yml"

$DC ps
$DC logs -f --tail=100 admin-api
$DC exec postgres psql -U autoflow -d autoflow
deploy/frp/enable.sh            # 隧道 + 六项验证
deploy/frp/enable.sh --down     # 只停隧道
```

数据库备份：

```bash
docker run --rm -v acf_postgres_data:/var/lib/postgresql/data \
  -v "$PWD/logs/db-backups:/backup" postgres:16-alpine \
  sh -c 'pg_dump -U autoflow autoflow | gzip > /backup/acf-$(date +%F).sql.gz'
```
