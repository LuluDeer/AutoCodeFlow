# 跨网接入：frp + 域名（本机 ↔ 公网 VPS）

本机（`<LAN_IP>`）在局域网、无公网 IP；公网 VPS `<VPS_IP>` 上已有
frps 与 nginx + 域名。目标：**其它网段的执行器只出站**，以 pull 模式通过
`https://<域名>` 接入中台，不需要在执行器侧做任何端口映射。

```
执行器(任意网段) ──HTTPS──> VPS nginx :443 ──> 127.0.0.1:18809 (frps)
                                                   │  frp 隧道
                                                   ▼
本机 frpc ──> admin-web:80 (容器 nginx) ──> admin-api:3105
```

局域网执行器仍然直连 `http://<LAN_IP>:8088`，走 push（admin-api 主动拨入
执行器的 8001/8002）。

## 一、需要你提供的 4 个值

| 值 | 说明 | 示例 |
|---|---|---|
| `<域名>` | 已解析到 `<VPS_IP>` 的域名 | `<ACF_DOMAIN>` |
| `FRP_SERVER_PORT` | VPS 上 frps 的 `bind_port` | `7000` |
| `FRP_TOKEN` | frps 的 `auth.token`（没有就新建一个） | 32 位随机串 |
| `FRP_REMOTE_PORT` | frps 上给本机留的 remote_port，需在 `allowPorts` 内 | `18809` |

填进根 `.env`（已被 gitignore）：

```bash
FRP_SERVER_ADDR=<VPS_IP>
FRP_SERVER_PORT=7000
FRP_TOKEN=<与 frps auth.token 一致>
FRP_REMOTE_PORT=18809
```

同时把域名相关三项改成公网域名（admin-api 需重建容器才生效）：

```bash
CORS_ORIGINS=https://<域名>,http://<LAN_IP>:8088
ADMIN_WEB_ORIGIN=https://<域名>
ADMIN_API_URL=https://<域名>
API_BASE_URL=https://<域名>
```

## 二、VPS 侧 frps 需要放行 remote_port

`frps.toml` 里确认（改完 `systemctl restart frps` 或重启容器）：

```toml
bindPort = 7000
auth.method = "token"
auth.token = "<同一个 token>"
# 只放行规划内的端口，别开 1-65535
allowPorts = [{ start = 18809, end = 18809 }]
```

> 如果 VPS 的 frps 是宝塔/Docker 部署，`frps.toml` 一般在
> `/etc/frp/frps.toml` 或 `/opt/frp/frps.toml`，用 `ps -ef | grep frps` 定位。

## 三、VPS 侧 nginx 加站点（宝塔站点必改的三项）

宝塔生成的站点里 `location ^~ / { proxy_pass http://127.0.0.1:18809; }` 已经够
把流量转进来，但 ACF 有三个接口特征必须在 location 内补齐，否则会在具体场景炸：

| 缺什么 | 症状 | 加什么 |
|---|---|---|
| `client_max_body_size 510m` | 上传执行器包/应用包 413（宝塔默认 1m/50m） | location 或 server 级加一行 |
| `proxy_buffering off` | 执行日志 SSE 卡住、长时间不刷新 | location 内加，`proxy_cache off` 一起 |
| `ssl_early_data off` | 0-RTT 重放导致回调/触发重复执行 | server 级关掉 |

推荐 location 全量参数见 [vps-nginx.conf](vps-nginx.conf)（含 `proxy_request_buffering off`、
`proxy_set_header Connection ""`、`proxy_socket_keepalive on` 的原因注释）。

改完 `nginx -t && nginx -s reload`，然后跑：

```bash
curl -s https://<ACF_DOMAIN>/api/health/ready
curl -o /dev/null -w '%{http_code}\n' https://<ACF_DOMAIN>/uploads/packages/x.zip   # 期望 401/403，不是 200 text/html
curl -o /dev/null -w '%{http_code} %{time_total}\n' -X POST https://<ACF_DOMAIN>/api/executors/pull -d '{}' -H 'Content-Type: application/json'  # 期望 401 且 <2s
```

> 注：`location ^~ /` 会让站点里那些「敏感文件 404」正则 location 全部失效
> （`^~` 命中后不再匹配正则）。对 ACF 无影响（所有路径都交给 admin-web，
> 它本身不服务点文件），但如果你在该站点还挂别的静态站，别用 `^~ /`。

## 三、VPS 侧 nginx 加站点

把 `deploy/frp/vps-nginx.conf` 拷到 VPS，替换域名与证书路径后启用：

```bash
# 宝塔：面板 → 网站 → 添加站点（纯静态）→ 配置文件里粘贴上面内容
# 或裸 nginx：
cp deploy/frp/vps-nginx.conf /etc/nginx/conf.d/acf.conf
nginx -t && nginx -s reload
```

要点：`proxy_buffering off`、`proxy_read_timeout 3600s`、
`client_max_body_size 510m`、`proxy_pass` 不带 URI。

## 三·五、容量：并发上限与 frps 连接池（重要）

**tcp 代理的并发上限 = frps 的 `Max Pool Count`（你这台是 30）。**

每个跨网执行器要占一条 25s 长轮询常驻连接，加上浏览器/上传/SSE，30 条很快
不够；池满后 frps 让新连接排队，超时即 **502**（实测 200 路并发后 18809 开始
5s 超时 502，frpc 日志出现 `connection write timeout`）。

| 同时在线执行器 | 建议 |
|---|---|
| ≤ 20 | 现状可用（实测 20 路并发 avg 6.5s/max 6.7s，窗口 5s） |
| 20 ~ 30 | 把 frps 面板 `Max Pool Count` 调到 ≥ 执行器数 + 10 |
| > 30 或不想反复调 | 换 tcpmux（见下） |

**调大池**：frps 面板改 `Max Pool Count`（如 200），本机把
`deploy/frp/frpc.toml` 的 `transport.poolCount` 改成同值，重启 frpc。
客户端设超过服务端上限会被钳制（实测 100 与 30 等效）。

**换 tcpmux（推荐，长期）**：一条 TCP 跑多路，不占池、并发无上限。

```bash
# VPS frps.toml 加一行后重启 frps
tcpmuxHTTPConnectPort = 18809
# 本机换配置并重建
cp deploy/frp/frpc.tcpmux.toml deploy/frp/frpc.toml
docker compose -p acf --env-file .env -f docker-compose.yml -f docker-compose.local.yml \
  -f docker-compose.no-executor.yml -f docker-compose.frp.yml --profile frp up -d --force-recreate frpc
deploy/frp/enable.sh
```

VPS nginx 不用改（`proxy_pass` 仍是 `127.0.0.1:18809`）。

## 四、本机启用 frpc（一条命令）

```bash
cd /home/yongsheng/project/AutoCodeFlow
# 切对外地址 + 起隧道 + 跑完六项验证
deploy/frp/enable.sh --domain <域名>

# 只起隧道（域名已切过）
deploy/frp/enable.sh

# 停隧道（主体服务不动）
deploy/frp/enable.sh --down
```

`enable.sh` 依次做：`set-domain.sh` 改四个地址键并重建 admin-api → 校验
`frpc.toml` 语法 → 起 profile `frp` → 等 `start proxy success` → 验
`/api/health`、`/uploads` 鉴权态、pull 端点 401、域名解析。任一项红都非零退出。

> 手动等价命令：
> `docker compose -p acf --env-file .env -f docker-compose.yml -f docker-compose.local.yml -f docker-compose.no-executor.yml -f docker-compose.frp.yml --profile frp up -d`

## 五、验证（按顺序，任何一步红都别往下走）

```bash
# 1) 公网域名打到 admin-api
curl -s https://<域名>/api/health | head -c 300

# 2) 上传路径没被 SPA 回退吃掉（应返回 401/403 而不是 text/html 200）
curl -sI https://<域名>/uploads/packages/nonexistent.zip | head -5

# 3) 反代 SSE 长流（BUG-17，需登录 token，60s 内不中断）
curl -N -H "Authorization: Bearer <token>" \
  https://<域名>/api/tasks/<taskId>/executions/<execId>/logs/stream

# 4) pull 长轮询（25s 窗口不被反代掐断；无 token 应 401 且耗时很短）
curl -s -o /dev/null -w '%{http_code} %{time_total}\n' \
  -X POST https://<域名>/api/executors/pull -d '{}' -H 'Content-Type: application/json'
```

## 六、跨网执行器接入（pull 模式）

执行器侧只要三件事：

```bash
ADMIN_API_URL=https://<域名>
EXECUTOR_PULL_MODE=true
EXECUTOR_ALLOW_PRIVATE_NETWORK=true   # 若 API_BASE_URL 用内网地址才需要；用域名可 false
```

注册后在中台「执行器」列表里应看到紫色 **Pull 回连** 徽标；派发任务时中台不再
向执行器地址拨入，而是把载荷 LPUSH 到 Redis `acf:pull:<executorId>`，执行器
长轮询取件（`POST /api/executors/pull`）。

## 七、排障

| 现象 | 原因 | 处理 |
|---|---|---|
| frpc 日志 `login to server failed` | token / 端口错，或 VPS 安全组没放 7000 | 核对 `.env` 与 frps.toml |
| `port already used` | `FRP_REMOTE_PORT` 被占或不在 allowPorts | 换端口并同步 nginx |
| 域名 502 | frpc 没连上，或 nginx 指向的端口与 `FRP_REMOTE_PORT` 不一致 | `docker logs acf-frpc-1` |
| pull 请求 60s 断开 | VPS nginx 读超时没放大 | 按第三节配 `proxy_read_timeout` |
| 日志流卡住不刷新 | 反代开了缓冲 | `proxy_buffering off` |
| 执行器下载包失败 `zip-guard [unparseable]` | `/uploads` 被 SPA 回退成 HTML | 检查 nginx 未改写路径 |
