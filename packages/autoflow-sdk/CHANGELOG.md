# Changelog

## [1.2.0](https://github.com/LuluDeer/AutoCodeFlow/compare/v1.1.1...v1.2.0) (2026-09-12)


### 说明

* **lockstep 版本对齐**：本包本轮无行为变更，按 DOC-05 三包 lockstep 纪律与 `autocodeflow-mcp-server` / `@autocodeflow/sdk` 同版本发布（本轮实际变更源为 MCP server 新增 DEP-04 部署审批工具组）。

## [1.1.1](https://github.com/LuluDeer/AutoCodeFlow/compare/v1.1.0...v1.1.1) (2026-09-11)


### Bug Fixes

* **release:** release-please 固化 lockstep + 硬编码版本常量纳入 extra-files ([e67750e](https://github.com/LuluDeer/AutoCodeFlow/commit/e67750efbfa736410bd04820776b19dd1bf64931))
* **release:** 回退未发布的 mcp-server 1.1.1 部分发布，恢复 1.1.0 lockstep ([5a98f10](https://github.com/LuluDeer/AutoCodeFlow/commit/5a98f10c144a76e9135e26bc5702b28037954153))

## [1.1.0](https://github.com/LuluDeer/AutoCodeFlow/compare/v1.0.1...v1.1.0) (2026-09-09)


### Features

* **executors,admin:** BUG-10 失败分类细化——git 拉取/依赖安装/运行时缺失三分类 ([5d8c0dc](https://github.com/LuluDeer/AutoCodeFlow/commit/5d8c0dc9dbe917bb9cd31a46e434f9f623f737d0))
* **sdk:** ECO-01 缺失对等能力补齐——node 端 reportSuccess/reportFailure 回调便捷方法（python 端 ctx.report_* 的对等孪生：4KB/512KB 截断上限常量、executorAddress 缺省不发送、failureReason 默认 script_error）+ py 端 HttpClientError 可识别错误子类（httpx.HTTPStatusError 子类零破坏）；node +8 / py +5 测试 ([e2574bd](https://github.com/LuluDeer/AutoCodeFlow/commit/e2574bdc623d2b16f983364c22855d60d7751f98))


### Bug Fixes

* **packages:** SEC-01 四模块复审+修复——CLI/MCP 401 刷新自愈、SDK 契约对称性、registry-npm/desktop 复审报告 ([8c9665e](https://github.com/LuluDeer/AutoCodeFlow/commit/8c9665e74ae22d1f14a17aaff0150280f9ce56e8))
* **packages:** 客户端包契约四项——非幂等不重试/SDK 信封拆包/CLI 字段/MCP 工具面 ([5defe21](https://github.com/LuluDeer/AutoCodeFlow/commit/5defe21a7dd8a44cd62c9673e9b17906f3501905))
