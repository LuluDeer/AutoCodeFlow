# Changelog

## [1.10.0](https://github.com/LuluDeer/AutoCodeFlow/compare/v1.9.0...v1.10.0) (2026-10-08)

### 版本对齐

* **本包 1.9.0 从未发布**（npm 最新仍为 1.8.0）——1.9.0 段列出的三条 feat 实际随本版首发。1.9.0 的 tag/Release 停在 Draft 且 release PR 被 version-guard 拦下（半拉子发布）。

### Features

* **cli+api:** 拍板立项两项——①版本定向灰度（渐进回滚）②task 载荷旗标 --json→--body deprecation ([c6e4592](https://github.com/LuluDeer/AutoCodeFlow/commit/c6e45925b1fd73f50cb356c6e33e1c8b8e1471a7))
* **cli:** 应用与运维命令包——acf app upload(multipart/300s 预算/白名单字段)/acf app upgrade-all 灰度(canary 1-100/缺省零 body 全量语义逐字节保持/受理≠完成提示)/acf task webhook enable|rotate|disable|status(secret 一次性提示)/acf task glue 热更新(js→javascript 推断对齐执行器白名单)/acf approval list|approve|reject|cancel(DEP-04)；30 新用例,叶子护栏 50→58 ([6efa130](https://github.com/LuluDeer/AutoCodeFlow/commit/6efa1303bf65844a0cba7ad3489af24959e986a5))
* **cli:** 末层审计能力包——login 支持 TOTP 二段验证(--code 供 CI,此前 TOTP 用户完全无法用 CLI)/acf task export|import(导出物逐字透传)/acf task batch 四动作(--ids 1..500,部分失败 exit 1)/acf apikey create|list|revoke(plaintext 一次性回显)/config set-token 安全提示；32 新用例,ux-uniform 叶子护栏 44→50 ([f55f309](https://github.com/LuluDeer/AutoCodeFlow/commit/f55f3097449c3454b2b28c50d15cde1adf162e9e))

### Bug Fixes

* **acf-cli:** 收口无人值守语义（非交互假绿 / 示例 payload / Windows lint） ([8b75be9](https://github.com/LuluDeer/AutoCodeFlow/commit/8b75be97e4d9b2eb763285ccae53cfdb826fcfa6))

## [1.9.0](https://github.com/LuluDeer/AutoCodeFlow/compare/v1.8.0...v1.9.0) (2026-10-07)


### Features

* **cli+api:** 拍板立项两项——①版本定向灰度（渐进回滚）②task 载荷旗标 --json→--body deprecation ([c6e4592](https://github.com/LuluDeer/AutoCodeFlow/commit/c6e45925b1fd73f50cb356c6e33e1c8b8e1471a7))
* **cli:** 应用与运维命令包——acf app upload(multipart/300s 预算/白名单字段)/acf app upgrade-all 灰度(canary 1-100/缺省零 body 全量语义逐字节保持/受理≠完成提示)/acf task webhook enable|rotate|disable|status(secret 一次性提示)/acf task glue 热更新(js→javascript 推断对齐执行器白名单)/acf approval list|approve|reject|cancel(DEP-04)；30 新用例,叶子护栏 50→58 ([6efa130](https://github.com/LuluDeer/AutoCodeFlow/commit/6efa1303bf65844a0cba7ad3489af24959e986a5))
* **cli:** 末层审计能力包——login 支持 TOTP 二段验证(--code 供 CI,此前 TOTP 用户完全无法用 CLI)/acf task export|import(导出物逐字透传)/acf task batch 四动作(--ids 1..500,部分失败 exit 1)/acf apikey create|list|revoke(plaintext 一次性回显)/config set-token 安全提示；32 新用例,ux-uniform 叶子护栏 44→50 ([f55f309](https://github.com/LuluDeer/AutoCodeFlow/commit/f55f3097449c3454b2b28c50d15cde1adf162e9e))


### Bug Fixes

* **cli+mcp:** 默认 API URL 缺 /api 前缀的 P1——TOTP 交互路径 PTY 真机 smoke 抓出并修复（战役遗留 [#5](https://github.com/LuluDeer/AutoCodeFlow/issues/5) 收口） ([a3c20b3](https://github.com/LuluDeer/AutoCodeFlow/commit/a3c20b3d76917de4c2ba4177d5b55f0c28f50701))

## [1.8.0](https://github.com/LuluDeer/AutoCodeFlow/compare/v1.7.0...v1.8.0) (2026-10-04)

### Features

* **acf-cli:** UX 打磨 R12-C——终端 UX 统一(help示例/分类退出码/统一错误出口/config损坏恢复/Ctrl+C假死) ([5330549](https://github.com/LuluDeer/AutoCodeFlow/commit/5330549fae0b369eb683c801a918529b93d919e4))


## [1.6.0](https://github.com/LuluDeer/AutoCodeFlow/compare/v1.5.3...v1.6.0) (2026-10-01)


### Features

* **mcp-server,acf-cli:** SOP/Agent 工具面(sop_list/get/assignments_pending、agent_session_list/get、clarification_reply)+get_execution 剥离全量日志+z.enum 收紧+CLI sop/agent 命令与四条 --json 补面 ([ba74462](https://github.com/LuluDeer/AutoCodeFlow/commit/ba7446266b0bde70c2524188bce341483e90095f))

## [1.5.3](https://github.com/LuluDeer/AutoCodeFlow/compare/v1.5.2...v1.5.3) (2026-09-29)


### 版本对齐

* lockstep 随 autocodeflow-mcp-server 1.5.3 同批发布（ip-address@10.7.2 SSRF 安全补丁），本包无功能变更。

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
