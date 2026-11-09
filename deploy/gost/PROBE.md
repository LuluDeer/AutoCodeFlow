# 跨网入口外部哨兵

`scripts/probe-acf-tunnel.sh` —— 从外部探测跨网入口，隧道静默失效时自动自愈。

## 为什么需要

2026-11-03 那次故障的教训：frp 的隧道会「**进程活着、隧道已死**」——
客户端日志一片正常（control 连接有心跳，数据面没有），只有从**外部**访问才会
撞到 489 字节的 frp 内置 404 页。那次拖了 3 天没人发现。

gost 同样没有 dashboard（只有 Prometheus 指标），静默失效只能靠外部探测。

## 三层探测信号（核心设计）

| 层 | 探测对象 | 说明什么 |
|---|---|---|
| **L1** | 公网 HTTPS 入口 `/health` | 隧道 + 网络 + 应用，全都健康才算通 |
| **L2** | TCP 到 VPS 隧道端口 | 只说明「网络能到 VPS」，与隧道死活无关 |
| **L3** | 本机应用健康端点 | 只说明「应用本身活着」，与隧道死活无关 |

**只在「L1 失败 且 L2 通 且 L3 通」时才重启 gost 客户端。** 这样能区分：

| 现象 | 判定 | 动作 |
|---|---|---|
| L1 挂 + L2 通 + L3 通 | 隧道断了 | **重启 gost**（自愈） |
| L1 挂 + L2 不通 | 网络/VPS 挂了 | 不动，重启无用 |
| L1 挂 + L3 不通 | 应用挂了 | 不动，重启无用 |

避免在网络抖动或应用故障时误重启隧道。

## 用法

```bash
# 单次探测（cron 用）
bash scripts/probe-acf-tunnel.sh

# 打印每层探测细节
bash scripts/probe-acf-tunnel.sh --verbose
```

退出码：`0` = 通（或已成功自愈）；`1` = 隧道异常且未自愈；`2` = 配置缺失。

## 安装（本机 cron）

```bash
# 每 2 分钟一次
echo '*/2 * * * * /home/yongsheng/project/AutoCodeFlow/scripts/probe-acf-tunnel.sh >> /var/log/acf-tunnel-probe.log 2>&1' \
  > /etc/cron.d/acf-tunnel-probe
```

连续失败 `ACF_FAIL_THRESHOLD`（默认 3）次才动手，避免瞬时抖动误触发。

## 与 VPS 侧探针的分工

两处探针**互补，不重复**：

| 位置 | 探测路径 | 覆盖不到的 |
|---|---|---|
| **本机**（本脚本） | 公网 → VPS nginx → gost → 隧道 → 内网 | 本机自身网络断了也测不到（但那时探针也跑不了） |
| **VPS**（`check-cert-renewal.sh` 的每日自检） | VPS 本机 nginx → 40801 → gost → 隧道 → 内网 | VPS 整体网络断了测不到 |

注意 VPS 侧的 `http://127.0.0.1/api/health` **实际是穿过隧道的**
（nginx → 40801 → gost → 隧道 → 内网 admin-web），不是只探 VPS 本机。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `ACF_PUBLIC_URL` | `https://<DOMAIN>/health` | 公网入口 |
| `ACF_DOMAIN` | 从 `.env` 的 `GOST_DOMAIN`/`FRP_DOMAIN` 读 | 域名 |
| `ACF_VPS_ADDR` | 从 `.env` 的 `GOST_SERVER_ADDR`/`FRP_SERVER_ADDR` 读 | VPS 地址 |
| `ACF_VPS_PORT` | 从 `.env` 的 `GOST_SERVER_PORT`/`FRP_SERVER_PORT` 读 | VPS 隧道端口 |
| `ACF_LOCAL_HEALTH` | `http://127.0.0.1:8088/health` | 本机应用健康端点 |
| `ACF_GOST_CONTAINER` | `acf-gost-1` | gost 客户端容器名 |
| `ACF_PROBE_TIMEOUT` | `15` | 单次探测超时（秒） |
| `ACF_FAIL_THRESHOLD` | `3` | 连续失败多少次才动手 |
| `ACF_STATE_FILE` | `/tmp/acf-tunnel-probe.state` | 连续失败计数 |
| `ACF_PROBE_LOG` | `/tmp/acf-tunnel-probe.log` | 历史记录 |

## 实现注意

- **必须 `--noproxy '*'`**：本机常设 `http_proxy=127.0.0.1:7897`，不绕过的话
  测的是本地代理而不是真实公网链路。
- 状态文件放在 `/tmp`，重启机器会清零（重新累计 3 次），这是安全的默认值。
- 自愈动作是 `docker restart <gost 客户端>`，内网客户端会自动重连并重新
  BIND（2026-11-03 实测：VPS 侧 gost 恢复后客户端自动 rebind）。

## 已验证的四种场景（2026-11-03 本机实测）

| 场景 | L1 | L2 | L3 | 判定 | 动作 |
|---|---|---|---|---|---|
| 一切正常 | 200 | — | — | 通 | 无 |
| 隧道断（停 gost 客户端） | 502 | 通 | 200 | 隧道断 | 第 3 次触发重启，10s 内恢复 200 |
| 网络/VPS 挂 | 502 | 不通 | 200 | 网络问题 | **不动** |
| 应用挂 | 502 | 通 | 000 | 应用问题 | **不动** |
