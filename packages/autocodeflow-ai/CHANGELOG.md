# Changelog

所有对外可见的变更记录在本文件。格式参照 Keep a Changelog；版本遵循语义化版本。

## [0.2.2](https://github.com/LuluDeer/AutoCodeFlow/compare/v0.2.1...v0.2.2) (2026-10-02)


### Bug Fixes

* **packages:** NETOPT-F analyzer null-confidence 用例+定调注释补第 9 出站点（routers/execute.py 包下载 trust_env=False+follow_redirects=False）、http/notify/sdk trust_env 钉死测试、uv.lock 入库可重现构建 ([dfb965f](https://github.com/LuluDeer/AutoCodeFlow/commit/dfb965f1bce868eb7acc042c2efee09b810dad79))

## [0.2.1](https://github.com/LuluDeer/AutoCodeFlow/compare/v0.2.0...v0.2.1) (2026-10-01)


### Bug Fixes

* **packages:** NETOPT-F analyzer null-confidence 用例+定调注释补第 9 出站点（routers/execute.py 包下载 trust_env=False+follow_redirects=False）、http/notify/sdk trust_env 钉死测试、uv.lock 入库可重现构建 ([dfb965f](https://github.com/LuluDeer/AutoCodeFlow/commit/dfb965f1bce868eb7acc042c2efee09b810dad79))

## [0.2.0] - 2026-10-01

### 说明

- 首个纳入 release-please 版本治理的基线（此前 0.1.0 停留在初始占位，未进发版链路）。
- 版本跳至 0.2.0 以反映 0.1.0 之后的实质功能迭代（NETOPT-C P3 错误分类
  `error_kind`、PK-17 出站脱敏钩子、R22 base_url 归一化等已落地的能力），
  而非从 0.1.0 重新起算。

## [0.1.0]

- 初始版本：`AIAnalyzer`、`AnalysisResult`（OpenAI / Ollama 双后端）。
