# deploy/local/ —— 本机真实部署值（**不入库**）

这个目录用于放**具体部署的真实值**，已被 `.gitignore` 忽略（见仓库根
`.gitignore` 的 `deploy/local/` 一行）。

## 为什么单独分出来

`deploy/` 下其余文件都是**模板**，所有环境相关值写成占位符：

| 占位符 | 含义 |
|---|---|
| `<ACF_DOMAIN>` | 公网域名（如 `acf.example.com`） |
| `<VPS_IP>` | 公网 VPS 地址 |
| `<LAN_IP>` | 中台所在主机的局域网地址 |
| `<FRP_VHOST_HTTP_PORT>` | frps 的 `vhostHTTPPort` |
| `<WEB_ROOT>` / `<SSL_CERT_PATH>` / `<SSL_KEY_PATH>` | 宝塔站点路径 |

真实值写在根 `.env`（同样不入库）与这个目录里，避免把内网拓扑、域名、
端口规划提交进公开仓库。

## 建议放什么

- `vps-site.conf` —— 由 `deploy/frp/vps-site.conf` 替换占位符后的成品，
  拷到 VPS 的宝塔站点配置里
- `notes.md` —— 本环境特有的事项（域名、证书续期方式、frps 版本等）

## 不要放什么

- 任何 token / 密码 / 私钥 —— 它们属于 `.env`，不属于这里
