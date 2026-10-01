# Changelog

所有对外可见的变更记录在本文件。格式参照 Keep a Changelog；版本遵循语义化版本。

## [0.2.0] - 2026-10-01

### 说明

- 首个纳入 release-please 版本治理的基线（此前 0.1.0 停留在初始占位，未进发版链路）。
- 版本跳至 0.2.0 以反映 0.1.0 之后的实质功能迭代（PK-08 池回收/ping/
  `DatabaseConfig.from_env()`、D1-P2-6 短进程池收敛、无凭据默认 URL
  fail-fast 等已落地的能力），而非从 0.1.0 重新起算。

## [0.1.0]

- 初始版本：`DatabaseConfig`、`DatabaseSession`、`get_session`、`dispose_engine`。
