# gost 跨网接入（替代 frp）

本机（`<LAN_IP>`）在局域网、无公网 IP；公网 VPS `<VPS_IP>` 上跑 gost 服务端。
目标：其它网段的执行器只出站，以 pull 模式通过 `https://<域名>` 接入中台，
不需要在执行器侧做任何端口映射。

```text
执行器(任意网段) ──HTTPS──> VPS nginx :443 ──> 127.0.0.1:40801 (gost relay)
                                                   │  gost 隧道 (mux/smux)
                                                   ▼
本机 gost ──> admin-web:80 (容器 nginx) ──> admin-api:3105
```

局域网执行器仍然直连 `http://<LAN_IP>:8088`，走 push。

## 为什么换

frp v0.71 的 work connection **没有应用层心跳**，只能靠 TCP socket 层 keepalive
维持，而 `dialServerKeepalive` 默认 **7200 秒**——远晚于典型 NAT 空闲超时
（5~30 分钟）。空闲连接必然被 NAT 静默回收，形成僵尸连接；frps 取连接时
只做一次 `write` 探活（对僵尸连接会假性成功），真正收发时才 RST，
最终对外表现为 **489 字节的 frp 内置 404 页**（与「域名未注册」无法区分）。

gost 的反向隧道走 smux，**默认 10 秒一个应用层 NOP 帧心跳、30 秒判死**
（`xtaci/smux` `KeepAliveInterval/KeepAliveTimeout`），且**没有预建连接池**
——所有转发流复用一条会话，不存在「空闲池被 NAT 回收」这个面。

> 注：frp 侧也可用 `transport.dialServerKeepalive = 30` 达到同等保活效果
> （本仓库已改）。换 gost 的额外收益是：应用层心跳穿透性更好、客户端断链
> 自动重连与 rebind 已实测可用、无 frps dashboard 但有 Prometheus 指标。

## 迁移期架构（并行运行，可秒级回退）

```text
                    ┌─ VPS nginx :443 ─> 127.0.0.1:40800 ─> frps  ─> frpc ─┐
浏览器/执行器 ──────┤                                                          ├─> admin-web:80
                    └─ VPS nginx :443 ─> 127.0.0.1:40801 ─> gost  ─> gost ─┘
```

切换 = 改 nginx 的 `proxy_pass` **一行**；回退 = 改回**一行**。
frps 继续在 VPS 上服务 `RPA-JFC` 和 Windows 音频克隆服务，**暂时不要动**。

## 一、参数（根 `.env`，不落仓库）

```bash
GOST_SERVER_ADDR=<VPS_IP>
GOST_SERVER_PORT=7001          # gost relay 监听端口（避开 frps 的 7000）
GOST_BIND_PORT=40801           # 隧道在 VPS 上绑定的端口（避开 frps 的 40800）
GOST_USERNAME=acf
GOST_PASSWORD=<强密码>
GOST_DOMAIN=<ACF_DOMAIN>
```

## 二、VPS 上部署服务端

```bash
# 1. 拷贝配置模板
scp deploy/gost/gost-server.yml root@<VPS_IP>:/etc/gost/gost-server.yml

# 2. 在 VPS 上编辑 /etc/gost/gost-server.yml
#    - 填 password
#    - 证书路径确认（复用 nginx 的 Let's Encrypt，不额外签发）
mkdir -p /etc/gost/cert
ln -sf /www/server/panel/vhost/cert/<ACF_DOMAIN>/fullchain.pem /etc/gost/cert/fullchain.pem
ln -sf /www/server/panel/vhost/cert/<ACF_DOMAIN>/privkey.pem  /etc/gost/cert/privkey.pem

# 3. 安装并自检
bash deploy/gost/install-server.sh
```

## 三、本机启动客户端

```bash
bash deploy/gost/enable.sh
```

脚本会渲染 `deploy/local/gost-client.yml`（含密码，已 gitignore）、
启动容器、等待日志出现 `bind on 127.0.0.1:40801/tcp OK`，
再跑三项连通性验证（`/api/health`、`/uploads` 鉴权态、pull 端点 401）。

## 四、切换 nginx（在 VPS 上）

```nginx
# 改前
proxy_pass http://127.0.0.1:40800;
# 改后
proxy_pass http://127.0.0.1:40801;
```

```bash
nginx -t && nginx -s reload     # 宝塔：面板 → 网站 → 配置文件 → 保存
```

## 五、收尾（确认稳定后）

```bash
# 1. 停 frpc（frps 仍留着服务别的客户端）
bash deploy/gost/enable.sh --with-frp

# 2. 观察 24h，确认无异常后再考虑停 frps
#    —— 但 frps 上还有 RPA-JFC / Windows 音频克隆，必须先逐个迁移或确认不用了
```

## 端口对照

| 用途 | frp | gost |
|---|---|---|
| 隧道控制端口（VPS） | 7000 | 7001 |
| 隧道回源端口（VPS 回环） | 40800 | 40801 |
| 本机监听 | 无（frpc 是出站） | 无（gost 也是出站） |

## 已实测的行为（2026-11-03，本机验证）

| 项 | 结果 |
|---|---|
| 端到端 HTTP | 127.0.0.1:40801 → 隧道 → admin-web:80，200，内容正确 |
| 绑定位置 | **服务端**绑 `127.0.0.1:40801`（nginx 所在那台） |
| 严格 TLS 校验 | `secure:true` + `serverName` + `caFile` 可用；错误证书被拒 |
| 认证 | 错误密码 → 服务端 `relay: unauthorized`，客户端持续重试 |
| **断链自愈** | 服务端被杀 → 客户端按 1s→2s→4s→5s 退避重试；服务端恢复后**自动 rebind**，端到端自动恢复 200 |
| 性能（2s 延迟后端） | 20 并发：直连 2013ms / 经隧道 2019ms；60 并发：3468ms / 4125ms（+19% 队头阻塞） |

## 已知限制

- **rtcp 强制 mux 且不可关闭**（`listener/rtcp/listener.go` 硬编码
  `chain.MuxBindOption(true)`）。60 并发下约 19% 的队头阻塞，长轮询场景
  约 +0.6s。并发更高时调大缓冲：
  ```yaml
  listener:
    type: rtcp
    metadata: { mux.maxReceiveBuffer: 16777216, mux.maxStreamBuffer: 4194304 }
  ```
- **gost 没有 frps 那种 dashboard**，可观测性只有 JSON 日志 + Prometheus
  指标（`gost_service_status`、`gost_chain_errors_total` 等）。
- gost v2 已进入维护阶段，**只能用 v3**（本仓库用 v3.3.3）。
- v3.3.3 是 2026-11-02 发布的版本，其 changelog 首条即
  `fix: disable MPTCP by default (CVE-2026-98432)`——升级时留意新安全修复。

## 回退

nginx 的 `proxy_pass` 改回 `127.0.0.1:40800` 并 reload 即可。
并行运行期间 gost 与 frp 互不影响（端口错开），随时可切。
