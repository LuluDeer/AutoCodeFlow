# Changelog

所有对外可见的变更记录在本文件。格式参照 Keep a Changelog；版本遵循语义化版本。

## [0.3.2](https://github.com/LuluDeer/AutoCodeFlow/compare/autocodeflow-db-v0.3.1...autocodeflow-db-v0.3.2) (2026-10-26)


### Bug Fixes

* **ci:** develop 首推九红收口——executor-node lint void 表达式+三 POSIX 语义用例显式平台门（chmod 0700/rename 覆盖在 Windows 语义不可达，由 Windows runner desktop-e2e 兜底，有名有姓不假绿）/admin-web build 补 afterEach import/format-latency/pypi 清扫节流测试改 monotonic 基准推回节流窗前（裸置 0 在刚启动进程仍窗内——本地长跑绿 CI 短跑红的时序依赖根因）/desktop-e2e 通道白名单补 onConfigChanged（v8 config 广播合法新增）/audit 文档表补 registry.npm.list/openapi.json+en-map 补 16 词条重导出（O/AC/E/AE 各批 DTO 描述累积缺英文注入，inject 步骤静默断链致导出物停在未注入态）/api-types 再生/bundle 双摘要回填（executor-node C 批+agent-worker S 批源码漂移，追加式历史记录含变更注释） ([b975cdf](https://github.com/LuluDeer/AutoCodeFlow/commit/b975cdfd1e9cdb045de2cfa8ff549664cc7fde44))
* **packages:** 共享包层审计 8 项收口——acf-cli 错误码覆盖活红修复（CORS_ORIGIN_NOT_ALLOWED/EXECUTOR_PACKAGE_STORAGE_PATH_ESCAPED 按 catalog 语义入基线，6 类规则会给误导建议；vitest 410/410）/autocodeflow-http 文档-实现漂移改 parity 地图（四端对齐虚假声称→本包↔node-sdk 两端+互指注释）/熔断 open 类型化 CircuitBreakerOpenError（对齐 node-sdk）/响应体 50MB cap 双包同构（流式双闸+构造参数出口+ResponseTooLargeError）/退避加性均匀 jitter（封顶防短退避被抖动支配）/ProtocolError 保持熔断不重试评估钉死（瞬时形态已被 5xx/429/网络/超时三路覆盖，落到协议错=确定性缺陷）/AI prompt XML 定界+同名闭合标签中和防逃逸（token 预算不变）/db statement_timeout 30s 可配置（PG 方言变体覆盖，短生命周期进程堵死面防护）/mcp-server·node-sdk /api 归一方向互指注释；各包套件 55/178/67/30/302/142/410 全绿 ([59b5ebe](https://github.com/LuluDeer/AutoCodeFlow/commit/59b5ebe49262275af5addda0957094dd52d8c75a))

## [0.3.1](https://github.com/LuluDeer/AutoCodeFlow/compare/autocodeflow-db-v0.3.0...autocodeflow-db-v0.3.1) (2026-10-22)


### Miscellaneous Chores

* **autocodeflow-db:** Synchronize autocodeflow-py-libs versions

## [0.3.0](https://github.com/LuluDeer/AutoCodeFlow/compare/autocodeflow-db-v0.2.3...autocodeflow-db-v0.3.0) (2026-10-21)


### Bug Fixes

* **autocodeflow-db:** rollback/close 不再掩盖原始异常，build() 并发只建一个 engine（R134-A1） ([a107ed9](https://github.com/LuluDeer/AutoCodeFlow/commit/a107ed9540f178eb8fcc471eb31bd212ee1db098))

## [0.2.3](https://github.com/LuluDeer/AutoCodeFlow/compare/autocodeflow-db-v0.2.2...autocodeflow-db-v0.2.3) (2026-10-09)


### Bug Fixes

* **db:** 收窄连接池默认值为 pool_size=2/overflow=0（深审 D1-P2-6） ([600a513](https://github.com/LuluDeer/AutoCodeFlow/commit/600a513d70f58749c86abf790b6f6a97f8e40d63))

## [0.2.2](https://github.com/LuluDeer/AutoCodeFlow/compare/v0.2.1...v0.2.2) (2026-10-02)


### Bug Fixes

* **db:** 收窄连接池默认值为 pool_size=2/overflow=0（深审 D1-P2-6） ([37fff76](https://github.com/LuluDeer/AutoCodeFlow/commit/37fff763349c8a8f02777edaedeeb299349ba90e))

## [0.2.1](https://github.com/LuluDeer/AutoCodeFlow/compare/v0.2.0...v0.2.1) (2026-10-01)


### Bug Fixes

* **db:** 收窄连接池默认值为 pool_size=2/overflow=0（深审 D1-P2-6） ([37fff76](https://github.com/LuluDeer/AutoCodeFlow/commit/37fff763349c8a8f02777edaedeeb299349ba90e))

## [0.2.0] - 2026-10-01

### 说明

- 首个纳入 release-please 版本治理的基线（此前 0.1.0 停留在初始占位，未进发版链路）。
- 版本跳至 0.2.0 以反映 0.1.0 之后的实质功能迭代（PK-08 池回收/ping/
  `DatabaseConfig.from_env()`、D1-P2-6 短进程池收敛、无凭据默认 URL
  fail-fast 等已落地的能力），而非从 0.1.0 重新起算。

## [0.1.0]

- 初始版本：`DatabaseConfig`、`DatabaseSession`、`get_session`、`dispose_engine`。
