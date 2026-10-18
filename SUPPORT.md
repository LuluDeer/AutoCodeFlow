# 获取帮助

## 我该去哪里？

| 你想做的事 | 去哪里 |
|---|---|
| **报告 Bug** | [新建 Bug Issue](https://github.com/LuluDeer/AutoCodeFlow/issues/new?template=bug_report.yml) |
| **提功能需求** | [新建 Feature Issue](https://github.com/LuluDeer/AutoCodeFlow/issues/new?template=feature_request.yml) |
| **问「怎么用」** | [GitHub Discussions](https://github.com/LuluDeer/AutoCodeFlow/discussions) |
| **报告安全漏洞** | **不要开 Issue**，见 [SECURITY.md](SECURITY.md) |
| **贡献代码** | [CONTRIBUTING.md](CONTRIBUTING.md) |
| **看文档** | [文档中心](docs/README.md) |

## 提问前请先自查

大多数问题在文档里已有答案，按这个顺序找一遍能省下往返时间：

1. [快速上手](docs/quickstart.md) —— 环境是否按文档起起来了
2. [部署指南](docs/deployment.md) —— 环境变量、端口、反代配置
3. [运维手册·故障排查](docs/operations.md) —— 常见故障的定位步骤
4. [已知问题](docs/atlas/08-workflows/troubleshooting/known-issues.md) —— 是否已登记
5. [FAQ / Discussions](https://github.com/LuluDeer/AutoCodeFlow/discussions) —— 是否已有人问过

## 提问时请附上

没有这些信息的问题通常无法定位，会被要求补充：

- **版本**：`cat version.txt` 或镜像 tag，以及执行器版本（桌面端在「关于」里）
- **部署形态**：Docker Compose / 源码模式 / 单机 / 多副本
- **复现步骤**：最小可复现路径
- **报错原文**：完整的错误信息与堆栈，不要只截一句
- **相关日志**：`docker compose logs admin-api --tail 200` 等

> ⚠️ 贴日志前请先脱敏：**不要**粘贴 JWT、执行器令牌、数据库口令、任务密钥、
> 内网地址。需要贴配置时用 `.env.example` 的结构 + 占位值。

## 响应预期

本项目由维护者利用业余时间维护，**不承诺 SLA**。请：

- 给 Issue 至少 3–5 个工作日的响应窗口
- 不要重复开 Issue 或在多个渠道同时催促
- 修复优先看影响面，不按「谁先提」排序

安全问题的时限承诺见 [SECURITY.md](SECURITY.md)。
