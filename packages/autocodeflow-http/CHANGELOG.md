# Changelog

所有对外可见的变更记录在本文件。格式参照 Keep a Changelog；版本遵循语义化版本。

## [0.3.2](https://github.com/LuluDeer/AutoCodeFlow/compare/autocodeflow-http-v0.3.1...autocodeflow-http-v0.3.2) (2026-10-26)


### Bug Fixes

* **packages:** 共享包层审计 8 项收口——acf-cli 错误码覆盖活红修复（CORS_ORIGIN_NOT_ALLOWED/EXECUTOR_PACKAGE_STORAGE_PATH_ESCAPED 按 catalog 语义入基线，6 类规则会给误导建议；vitest 410/410）/autocodeflow-http 文档-实现漂移改 parity 地图（四端对齐虚假声称→本包↔node-sdk 两端+互指注释）/熔断 open 类型化 CircuitBreakerOpenError（对齐 node-sdk）/响应体 50MB cap 双包同构（流式双闸+构造参数出口+ResponseTooLargeError）/退避加性均匀 jitter（封顶防短退避被抖动支配）/ProtocolError 保持熔断不重试评估钉死（瞬时形态已被 5xx/429/网络/超时三路覆盖，落到协议错=确定性缺陷）/AI prompt XML 定界+同名闭合标签中和防逃逸（token 预算不变）/db statement_timeout 30s 可配置（PG 方言变体覆盖，短生命周期进程堵死面防护）/mcp-server·node-sdk /api 归一方向互指注释；各包套件 55/178/67/30/302/142/410 全绿 ([59b5ebe](https://github.com/LuluDeer/AutoCodeFlow/commit/59b5ebe49262275af5addda0957094dd52d8c75a))

## [0.3.1](https://github.com/LuluDeer/AutoCodeFlow/compare/autocodeflow-http-v0.3.0...autocodeflow-http-v0.3.1) (2026-10-22)


### Bug Fixes

* **deps:** py-libs 三包 certifi 升到 2026.10.19（清 3 条 critical）+ uv.lock 漂移校正 ([a091617](https://github.com/LuluDeer/AutoCodeFlow/commit/a091617c293233e3be8e6d8421c81dc58503db88))
* **deps:** py-libs 四包 certifi 升到 2026.10.19，并修掉 uv.lock 的 editable 版本漂移 ([bbf3ad0](https://github.com/LuluDeer/AutoCodeFlow/commit/bbf3ad0d82fd8db6bc53e0fdbc301bb4cb9cae41))

## [0.3.0](https://github.com/LuluDeer/AutoCodeFlow/compare/autocodeflow-http-v0.2.3...autocodeflow-http-v0.3.0) (2026-10-21)


### Features

* **errors:** 三端透出 admin-api errorCode/params（python http / python sdk / MCP） ([e6513f9](https://github.com/LuluDeer/AutoCodeFlow/commit/e6513f95b88cce5bc7b1f48f6d9839bc347199c8))


### Bug Fixes

* **autocodeflow-http:** Retry-After 支持可选上限，README 示例修正（R134-A1） ([c194619](https://github.com/LuluDeer/AutoCodeFlow/commit/c194619947240184c36797df3eab4ff837223877))

## [0.2.3](https://github.com/LuluDeer/AutoCodeFlow/compare/autocodeflow-http-v0.2.2...autocodeflow-http-v0.2.3) (2026-10-09)


### Documentation

* **http:** 修正 node-sdk parity 说明为四端对齐（深审 D1-P2-1） ([8332e0d](https://github.com/LuluDeer/AutoCodeFlow/commit/8332e0db2e19ea788b7cb268a8dec7a3db62c1ec))

## [0.2.2](https://github.com/LuluDeer/AutoCodeFlow/compare/v0.2.1...v0.2.2) (2026-10-02)


### Bug Fixes

* **packages:** NETOPT-F analyzer null-confidence 用例+定调注释补第 9 出站点（routers/execute.py 包下载 trust_env=False+follow_redirects=False）、http/notify/sdk trust_env 钉死测试、uv.lock 入库可重现构建 ([dfb965f](https://github.com/LuluDeer/AutoCodeFlow/commit/dfb965f1bce868eb7acc042c2efee09b810dad79))


### Documentation

* **http:** 修正 node-sdk parity 说明为四端对齐（深审 D1-P2-1） ([96c9c5a](https://github.com/LuluDeer/AutoCodeFlow/commit/96c9c5a559c180f5c27a114fe2dcd9469841727c))

## [0.2.1](https://github.com/LuluDeer/AutoCodeFlow/compare/v0.2.0...v0.2.1) (2026-10-01)


### Bug Fixes

* **packages:** NETOPT-F analyzer null-confidence 用例+定调注释补第 9 出站点（routers/execute.py 包下载 trust_env=False+follow_redirects=False）、http/notify/sdk trust_env 钉死测试、uv.lock 入库可重现构建 ([dfb965f](https://github.com/LuluDeer/AutoCodeFlow/commit/dfb965f1bce868eb7acc042c2efee09b810dad79))


### Documentation

* **http:** 修正 node-sdk parity 说明为四端对齐（深审 D1-P2-1） ([96c9c5a](https://github.com/LuluDeer/AutoCodeFlow/commit/96c9c5a559c180f5c27a114fe2dcd9469841727c))

## [0.2.0] - 2026-10-01

### 说明

- 首个纳入 release-please 版本治理的基线（此前 0.1.0 停留在初始占位，未进发版链路）。
- 版本跳至 0.2.0 以反映 0.1.0 之后的实质功能迭代（PK-09 连接池复用、PK-32
  错误契约、U4 安全方法重试约束等已落地的能力），而非从 0.1.0 重新起算。

## [0.1.0]

- 初始版本：`AutoFlowHttpClient`（重试/鉴权/熔断）、`RetryConfig`、`CircuitBreaker`、`SAFE_METHODS`。
