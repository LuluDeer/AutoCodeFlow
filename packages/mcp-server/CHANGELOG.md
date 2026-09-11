# Changelog

## [1.1.1](https://github.com/LuluDeer/AutoCodeFlow/compare/v1.1.0...v1.1.1) (2026-09-10)


### Bug Fixes

* **mcp-server:** VERSION/server version 常量对齐 1.1.0——v1.1.0 发布冒烟发现硬编码未随 release-please bump（--version 打 1.0.1）；cli.test 的 sync 断言防再犯 ([eca838e](https://github.com/LuluDeer/AutoCodeFlow/commit/eca838e05ac38706ac1b50c1cca417f27f85f93a))
* **mcp-server:** VERSION/server version 常量对齐 1.1.0——v1.1.0 发布冒烟发现硬编码未随 release-please bump（--version 打 1.0.1）；cli.test 的 sync 断言防再犯 ([1882b66](https://github.com/LuluDeer/AutoCodeFlow/commit/1882b668ebb84bab921cb95fb390d6a834a8569a))

## [1.1.0](https://github.com/LuluDeer/AutoCodeFlow/compare/v1.0.1...v1.1.0) (2026-09-09)


### Features

* **mcp-server:** ECO-03 工具面扩容——get_execution_timeline/list_dead_letters/create_task_from_template/get_scheduler_health 四工具（+10 测试 79/79） ([6297f21](https://github.com/LuluDeer/AutoCodeFlow/commit/6297f21cf65895ac15fc517dcb698c5a05247852))
* **nf-06:** MCP 写面扩容——retry_execution/deploy_app 两新工具 + deploy DEP-04 审批态透出 + 写面工具错误透出测试补齐（84→98 只增） ([9e76802](https://github.com/LuluDeer/AutoCodeFlow/commit/9e76802faec5fe1180f5d0757e2ac5d6dd19585c))


### Bug Fixes

* **mcp-server:** BUG-14 测试两处修复——afterEach 导入缺失致套件收集失败+无 token 用例的模块态隔离 ([0241b5a](https://github.com/LuluDeer/AutoCodeFlow/commit/0241b5a08fe009a29b0864742e7fc33d3bfcdcc5))
* **packages:** SEC-01 四模块复审+修复——CLI/MCP 401 刷新自愈、SDK 契约对称性、registry-npm/desktop 复审报告 ([8c9665e](https://github.com/LuluDeer/AutoCodeFlow/commit/8c9665e74ae22d1f14a17aaff0150280f9ce56e8))
* **packages:** 客户端包健壮性四项 ([ad80b75](https://github.com/LuluDeer/AutoCodeFlow/commit/ad80b756138c9217edaff418083be6ff1cc46c64))
* **packages:** 客户端包契约四项——非幂等不重试/SDK 信封拆包/CLI 字段/MCP 工具面 ([5defe21](https://github.com/LuluDeer/AutoCodeFlow/commit/5defe21a7dd8a44cd62c9673e9b17906f3501905))
* **windows:** R13/R15 生产兼容修复批——executor-python setsid/killpg/venv-bin/python3→sys.executable/entrypoint守卫/cmd.exe路径归一化（P1-P6，含 R13 全 mock 未暴露的三处真实阻断）+ executor-node killProcessTree 升级 taskkill 树杀（P7，消 R-03 孙进程残留）+ mcp-server token 告警移出 import 副作用（P8）+ 测试平台化（node 158/158、python 124+skip1）+ requirements-dev.txt（W-08）+ findings 修复落地回写 ([22767c2](https://github.com/LuluDeer/AutoCodeFlow/commit/22767c2efd21d900a50f3df3deb48664defca063))
