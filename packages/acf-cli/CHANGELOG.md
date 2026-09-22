# Changelog

## [1.5.2](https://github.com/LuluDeer/AutoCodeFlow/compare/v1.5.1...v1.5.2) (2026-09-22)


### Bug Fixes

* **cli:** exec tail 增加 60s 无数据帧空闲看门狗（深审 D1-P2-3） ([77d177c](https://github.com/LuluDeer/AutoCodeFlow/commit/77d177c9a34d731799a1a6bd8abc8d0a7aae5bd8))

## [1.5.1](https://github.com/LuluDeer/AutoCodeFlow/compare/v1.5.0...v1.5.1) (2026-09-20)


### Bug Fixes

* **cli:** --wait 轮询超时与 exec tail SSE 断流不再静默 exit 0 ([ffed6cc](https://github.com/LuluDeer/AutoCodeFlow/commit/ffed6cc4b5d248f545b30b99247b9d33da8ead83))
* **mcp-server,acf-cli:** analyze/suggest 类调用带 120s per-call 预算，消除与 admin 同步 AI 预算的结构性倒挂（NETOPT-6④） ([d4f3bd2](https://github.com/LuluDeer/AutoCodeFlow/commit/d4f3bd22f43394dfcc95fa2328cf868277b6fe39))

## [1.5.0](https://github.com/LuluDeer/AutoCodeFlow/compare/v1.4.3...v1.5.0) (2026-09-19)


### Features

* **optimize:** 全量优化落地——性能/可扩展/安全/可靠性/CI 门禁 ([a4dad9b](https://github.com/LuluDeer/AutoCodeFlow/commit/a4dad9b56e5277b6b75be62958882fcc408d163b))
* **release:** CLI 改名 @autocodeflow/cli 并接入发布链路 + 发布配置一致性守卫 ([b049272](https://github.com/LuluDeer/AutoCodeFlow/commit/b0492724b49b152a510a8840cc51ac7f1ab4cd41))


### Bug Fixes

* **ci:** windows-node-tests 漏了 acf-cli 的 build，版本号守卫 MODULE_NOT_FOUND ([b03b236](https://github.com/LuluDeer/AutoCodeFlow/commit/b03b23611f3114d9c0c24b087d376008b01ad0a4))
* **desktop:** 发布包自带 uv + 修复 Windows 能力探测（desktop-v1.5.2） ([0c41ec2](https://github.com/LuluDeer/AutoCodeFlow/commit/0c41ec29962f75553de3a2e7f15c338835a057b6))

## Changelog

本文件的版本条目由 release-please 在下次发布时自动生成（G-2：acf-cli 已纳入 release-please 独立 component 管理）。
