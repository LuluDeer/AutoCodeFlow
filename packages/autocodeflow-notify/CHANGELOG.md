# Changelog

所有对外可见的变更记录在本文件。格式参照 Keep a Changelog；版本遵循语义化版本。

## [0.3.2](https://github.com/LuluDeer/AutoCodeFlow/compare/autocodeflow-notify-v0.3.1...autocodeflow-notify-v0.3.2) (2026-10-26)


### Miscellaneous Chores

* **autocodeflow-notify:** Synchronize autocodeflow-py-libs versions

## [0.3.1](https://github.com/LuluDeer/AutoCodeFlow/compare/autocodeflow-notify-v0.3.0...autocodeflow-notify-v0.3.1) (2026-10-22)


### Bug Fixes

* **deps:** py-libs 三包 certifi 升到 2026.10.19（清 3 条 critical）+ uv.lock 漂移校正 ([a091617](https://github.com/LuluDeer/AutoCodeFlow/commit/a091617c293233e3be8e6d8421c81dc58503db88))
* **deps:** py-libs 四包 certifi 升到 2026.10.19，并修掉 uv.lock 的 editable 版本漂移 ([bbf3ad0](https://github.com/LuluDeer/AutoCodeFlow/commit/bbf3ad0d82fd8db6bc53e0fdbc301bb4cb9cae41))

## [0.3.0](https://github.com/LuluDeer/AutoCodeFlow/compare/autocodeflow-notify-v0.2.3...autocodeflow-notify-v0.3.0) (2026-10-21)


### Bug Fixes

* **autocodeflow-notify:** 渠道参数可分类报错并保留失败原因（R134-A1） ([16c2894](https://github.com/LuluDeer/AutoCodeFlow/commit/16c2894e5c82048c88c400dcbd09ef4111e975c1))

## [0.2.3](https://github.com/LuluDeer/AutoCodeFlow/compare/autocodeflow-notify-v0.2.2...autocodeflow-notify-v0.2.3) (2026-10-09)


### Miscellaneous Chores

* **autocodeflow-notify:** Synchronize autocodeflow-py-libs versions

## [0.2.2](https://github.com/LuluDeer/AutoCodeFlow/compare/v0.2.1...v0.2.2) (2026-10-02)


### Bug Fixes

* **packages:** NETOPT-F analyzer null-confidence 用例+定调注释补第 9 出站点（routers/execute.py 包下载 trust_env=False+follow_redirects=False）、http/notify/sdk trust_env 钉死测试、uv.lock 入库可重现构建 ([dfb965f](https://github.com/LuluDeer/AutoCodeFlow/commit/dfb965f1bce868eb7acc042c2efee09b810dad79))

## [0.2.1](https://github.com/LuluDeer/AutoCodeFlow/compare/v0.2.0...v0.2.1) (2026-10-01)


### Bug Fixes

* **packages:** NETOPT-F analyzer null-confidence 用例+定调注释补第 9 出站点（routers/execute.py 包下载 trust_env=False+follow_redirects=False）、http/notify/sdk trust_env 钉死测试、uv.lock 入库可重现构建 ([dfb965f](https://github.com/LuluDeer/AutoCodeFlow/commit/dfb965f1bce868eb7acc042c2efee09b810dad79))

## [0.2.0] - 2026-10-01

### 说明

- 首个纳入 release-please 版本治理的基线（此前 0.1.0 停留在初始占位，未进发版链路）。
- 版本跳至 0.2.0 以反映 0.1.0 之后的实质功能迭代（NF-05 飞书渠道、
  NETOPT-10-7 实例级懒客户端连接池复用、NETOPT-C P3 统一不走代理策略等
  已落地的能力），而非从 0.1.0 重新起算。

## [0.1.0]

- 初始版本：`NotifyClient`、`NotifyChannel`（经 admin-api 发送任务告警）。
