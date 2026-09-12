# Changelog

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
