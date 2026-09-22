# Changelog

## [1.5.2](https://github.com/LuluDeer/AutoCodeFlow/compare/v1.5.1...v1.5.2) (2026-09-22)


### 版本对齐

* lockstep 随 `@autocodeflow/cli` / autocodeflow-mcp-server 1.5.2 同批发布，本包无功能变更。

## [1.5.1](https://github.com/LuluDeer/AutoCodeFlow/compare/v1.5.0...v1.5.1) (2026-09-20)


### Bug Fixes

* **node-sdk:** 熔断器 half-open 探测槽遇不可熔断错误永久卡死（NETOPT-6①） ([9b1d01c](https://github.com/LuluDeer/AutoCodeFlow/commit/9b1d01c6bf2592a31a78ec88598f2175eed2ee8e))
* **packages:** NETOPT-F analyzer null-confidence 用例+定调注释补第 9 出站点（routers/execute.py 包下载 trust_env=False+follow_redirects=False）、http/notify/sdk trust_env 钉死测试、uv.lock 入库可重现构建 ([037b8c2](https://github.com/LuluDeer/AutoCodeFlow/commit/037b8c254d34d8aabc62596084baf2295bb40538))

## [1.5.0](https://github.com/LuluDeer/AutoCodeFlow/compare/v1.4.3...v1.5.0) (2026-09-19)


### Features

* **optimize:** 全量优化落地——性能/可扩展/安全/可靠性/CI 门禁 ([a4dad9b](https://github.com/LuluDeer/AutoCodeFlow/commit/a4dad9b56e5277b6b75be62958882fcc408d163b))

## [1.4.0](https://github.com/LuluDeer/AutoCodeFlow/compare/v1.3.0...v1.4.0) (2026-09-16)


### Bug Fixes

* **sdk-node:** base URL 双写 /api 致回调全 404 + logger 遇不可序列化 meta 抛错打崩任务 ([7c2e1c0](https://github.com/LuluDeer/AutoCodeFlow/commit/7c2e1c0))
* **pkg/ci:** DEEP_REVIEW 批次2 PK-06/07/08/11/12/13/16/17/18/22/23/24/28 + E-13/PK-15——信封判据统一/DATABASE_URL/唯一约束/渠道枚举/查询索引/AI 脱敏/日志环形/自检进 CI/空 schema 守卫 ([342bb75](https://github.com/LuluDeer/AutoCodeFlow/commit/342bb75))

## [1.4.1](https://github.com/LuluDeer/AutoCodeFlow/compare/v1.4.0...v1.4.1) (2026-09-16)

*No user-facing changes (lockstep version alignment)*

## [1.4.2](https://github.com/LuluDeer/AutoCodeFlow/compare/v1.4.1...v1.4.2) (2026-09-16)

*No user-facing changes (lockstep version alignment)*

## [1.4.3](https://github.com/LuluDeer/AutoCodeFlow/compare/v1.4.2...v1.4.3) (2026-09-16)

*No user-facing changes (lockstep version alignment)*

## [1.3.0](https://github.com/LuluDeer/AutoCodeFlow/compare/v1.2.0...v1.3.0) (2026-09-13)


### Features

* **auth:** AUTH-04 OIDC SSO 单点登录——授权码模式 + 无状态 state + oidcSub 三级身份绑定 + JIT 建号开关（含组→角色映射，仅 JIT 建号生效）([584b45e](https://github.com/LuluDeer/AutoCodeFlow/commit/584b45e), [82c70c6](https://github.com/LuluDeer/AutoCodeFlow/commit/82c70c6))
* **auth:** AUTH-02 后续——项目列表按成员过滤读面 + admin-web 项目管理页（ADR-013 §6）([14fc883](https://github.com/LuluDeer/AutoCodeFlow/commit/14fc883))
* **notification:** R17 通知渠道出站私网豁免开关——NOTIF_ALLOW_PRIVATE_NETWORK（五渠道共用）([c7ef8eb](https://github.com/LuluDeer/AutoCodeFlow/commit/c7ef8eb))
* **mcp,cli:** R18 项目域消费——MCP 只读三工具 + acf project 只读命令 ([6b42f54](https://github.com/LuluDeer/AutoCodeFlow/commit/6b42f54))


### Bug Fixes

* **admin-api:** R15 出站 SSRF 私网豁免开关 + 双 wrapper 双 init 导致 webhook 事件双投的生产级缺陷修复（真机套件 test:arch31-outbox-dup 实证）([e4bed26](https://github.com/LuluDeer/AutoCodeFlow/commit/e4bed26))


### 本轮实际变更源

三包本包内无行为变更，lockstep 版本对齐随平台 v1.3.0（详见根仓库 AGENT_HANDOFF 第十五~二十一轮）。

## [1.2.0](https://github.com/LuluDeer/AutoCodeFlow/compare/v1.1.1...v1.2.0) (2026-09-12)


### 说明

* **lockstep 版本对齐**：本包本轮无行为变更，按 DOC-05 三包 lockstep 纪律与 `autocodeflow-mcp-server` / `autoflow-sdk` 同版本发布（本轮实际变更源为 MCP server 新增 DEP-04 部署审批工具组）。

## [1.1.1](https://github.com/LuluDeer/AutoCodeFlow/compare/v1.1.0...v1.1.1) (2026-09-11)


### 说明

* **lockstep 版本对齐**：本包本轮无行为变更，按 DOC-05 三包 lockstep 纪律与 `autocodeflow-mcp-server` / `autoflow-sdk` 同版本发布（本轮实际变更源为 mcp-server 的 VERSION 常量对齐修复 + release-please 配置固化）。

## [1.1.0](https://github.com/LuluDeer/AutoCodeFlow/compare/v1.0.1...v1.1.0) (2026-09-09)


### Features

* **sdk:** ECO-01 缺失对等能力补齐——node 端 reportSuccess/reportFailure 回调便捷方法（python 端 ctx.report_* 的对等孪生：4KB/512KB 截断上限常量、executorAddress 缺省不发送、failureReason 默认 script_error）+ py 端 HttpClientError 可识别错误子类（httpx.HTTPStatusError 子类零破坏）；node +8 / py +5 测试 ([e2574bd](https://github.com/LuluDeer/AutoCodeFlow/commit/e2574bdc623d2b16f983364c22855d60d7751f98))


### Bug Fixes

* **packages:** 客户端包健壮性四项 ([ad80b75](https://github.com/LuluDeer/AutoCodeFlow/commit/ad80b756138c9217edaff418083be6ff1cc46c64))
* **packages:** 客户端包契约四项——非幂等不重试/SDK 信封拆包/CLI 字段/MCP 工具面 ([5defe21](https://github.com/LuluDeer/AutoCodeFlow/commit/5defe21a7dd8a44cd62c9673e9b17906f3501905))
