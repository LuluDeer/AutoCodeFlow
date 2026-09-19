# Changelog

## 1.0.0 (2026-09-19)


### Features

* **mcp,cli:** R18 项目域消费——MCP 只读三工具 + acf project 只读命令 ([6b42f54](https://github.com/LuluDeer/AutoCodeFlow/commit/6b42f54744538ed422667e31c519a58664eb17e8))
* **nf-07:** acf-cli 执行器管理命令——executor rotate（name|id 解析+reason 留痕+新 token 一次性展示）/offline（ADMIN set-offline 语义）（74→82 只增） ([11b349e](https://github.com/LuluDeer/AutoCodeFlow/commit/11b349e0bf4366f0aabd30dca9ba6acd39e47057))
* **optimize:** 全量优化落地——性能/可扩展/安全/可靠性/CI 门禁 ([a4dad9b](https://github.com/LuluDeer/AutoCodeFlow/commit/a4dad9b56e5277b6b75be62958882fcc408d163b))
* **release:** CLI 改名 @autocodeflow/cli 并接入发布链路 + 发布配置一致性守卫 ([b049272](https://github.com/LuluDeer/AutoCodeFlow/commit/b0492724b49b152a510a8840cc51ac7f1ab4cd41))
* **sec-new-4:** acf-cli 凭据落盘硬化——0600 + 存量权限收紧 + env 注入免落盘路径文档化 ([a8542c7](https://github.com/LuluDeer/AutoCodeFlow/commit/a8542c74a8cf3f1c7dd7c9c41c1b3f7de49e1acb))


### Bug Fixes

* **ci:** windows-node-tests 漏了 acf-cli 的 build，版本号守卫 MODULE_NOT_FOUND ([b03b236](https://github.com/LuluDeer/AutoCodeFlow/commit/b03b23611f3114d9c0c24b087d376008b01ad0a4))
* **cli:** acf exec tail 两条路径全部不可用（撤销的令牌通道 + 错误的响应字段） ([3884793](https://github.com/LuluDeer/AutoCodeFlow/commit/38847933acd2db7bb75f1e964e9cf2a84943ae23))
* **cli:** harden config store construction against Windows parallel-load throw ([b87e99a](https://github.com/LuluDeer/AutoCodeFlow/commit/b87e99a05a61c6ef85ed6a95aa9b7993cd712cb0))
* **cli:** unwrap 判据对齐 mcp-server——data+数值 code 才解包 ([86cc939](https://github.com/LuluDeer/AutoCodeFlow/commit/86cc9393d9afdb9ecd2ea5c70e079bba06a4442d))
* **desktop:** 发布包自带 uv + 修复 Windows 能力探测（desktop-v1.5.2） ([0c41ec2](https://github.com/LuluDeer/AutoCodeFlow/commit/0c41ec29962f75553de3a2e7f15c338835a057b6))
* **review:** DEEP_REVIEW 批次4 P3 打磨 56 项清偿——后端/前端/执行器/packages 四域 ([67cad65](https://github.com/LuluDeer/AutoCodeFlow/commit/67cad657a8ed8278686ed4be8f7834efd3272ce5))

## Changelog

本文件的版本条目由 release-please 在下次发布时自动生成（G-2：acf-cli 已纳入 release-please 独立 component 管理）。
