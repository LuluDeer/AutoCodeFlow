# 安全策略

## 支持的版本

安全修复只进入以下版本线。更早的版本请先升级。

| 版本 | 支持状态 |
|---|---|
| `v1.12.x`（当前主线） | ✅ 接受安全修复 |
| `desktop-v1.9.x` | ✅ 接受安全修复 |
| 更早的 `v1.11.x` 及以下 | ❌ 不再单独修复，请升级到主线 |

## 报告漏洞

**请不要通过公开 Issue 报告安全问题。**

优先使用 GitHub 的私密报告通道：

👉 https://github.com/LuluDeer/AutoCodeFlow/security/advisories/new

如果该通道不可用，请发邮件至仓库维护者（GitHub 主页可查），并在标题注明
`[SECURITY] AutoCodeFlow`。

### 报告时请尽量包含

- 受影响的版本 / 提交哈希，以及部署形态（Docker Compose / 源码模式 / 单机 / 多副本）
- 复现步骤或最小 PoC（脚本、HTTP 请求、配置片段）
- 影响面评估：能否越权、能否读到他人数据、是否需要已登录身份
- 若已知，附上建议的修复方向

### 我们承诺

| 阶段 | 时限 |
|---|---|
| 确认收到 | 3 个工作日内 |
| 初步定级（严重 / 高 / 中 / 低）与影响面说明 | 7 个工作日内 |
| 修复或缓解方案 | 严重 / 高：30 天内；中 / 低：下个常规版本 |

修复发布后，会在 [GitHub Security Advisories](https://github.com/LuluDeer/AutoCodeFlow/security/advisories)
公开致谢（除非你要求匿名）。

## 在范围内

- `apps/admin-api` —— 认证、授权（RBAC）、API Key、审计日志、SSRF 防护、注入面
- `apps/admin-web` —— XSS、CSRF、鉴权绕过、敏感信息泄露
- `apps/executor-*` —— 任务沙箱逃逸、任意代码执行边界、凭据落盘
- `apps/registry-*` —— 私有仓库的越权发布 / 拉取
- 部署配置（`docker-compose*.yml`、`deploy.sh`、`infra/`）—— 默认口令、端口暴露、权限过宽
- 依赖链上的已知漏洞（若本仓库的用法使其可利用）

## 不在范围内

- 需要物理接触设备、或需要 root / 管理员权限才能实施的攻击
- 针对**开发环境默认配置**的问题（除非它能带进生产）
- 自动化扫描器输出的、无实际利用路径的报告（请附可利用性说明）
- 上游依赖自身的问题（请报给上游；若本仓库用法放大了风险则属于范围内）
- 社会工程、钓鱼、拒绝服务（除非成本极低且影响面大）

## 安全相关的仓库约定

本仓库有一套长期维护的安全基线文档，提交 PR 前建议先读：

- [`docs/SECURITY-REDLINE-CHECKLIST.md`](docs/SECURITY-REDLINE-CHECKLIST.md) —— 安全红线路径回归清单
- [`docs/atlas/04-flows/security-model.md`](docs/atlas/04-flows/security-model.md) —— 认证与信任链
- [`docs/adr/`](docs/adr/README.md) —— 安全相关架构决策（令牌、SSO、审计防篡改等）

CI 中常驻以下安全门禁，PR 必须保持绿：

| 门禁 | 作用 |
|---|---|
| `secret-scan`（gitleaks） | 阻止凭据入库 |
| `npm-audit` / `pip-audit` | 依赖漏洞，豁免需在 `docs/DEPENDENCY-REVIEW-LOG.md` 登记复查日期 |
| `check-dependency-review` | 豁免到期自动失败，避免「挂账不还」 |
| RBAC 矩阵与安全红线 e2e | 防止重构重新打开已封堵的口子 |

## 已知的安全设计取舍

有些看似「缺陷」的行为是**有意为之**，已在 ADR 中记录，报告前请先确认：

- 错误响应不区分具体原因（防账号/资源枚举）
- 执行器令牌、任务密钥以密文落盘而非明文
- 审计日志采用 append-only 触发器而非哈希链（取舍见 ADR-025）
