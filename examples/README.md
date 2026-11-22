# 官方示例库

> **受众**：找可直接运行示例的开发者 · **状态**：稳定 · **最后核对**：2026-11-22

仓库提供 **8 组**自包含的可运行官方示例，覆盖「定时导出 / 内网巡检 / 桌面填报」三类常见业务场景、双 SDK 主动回调、私有 npm/PyPI 依赖安装以及桌面 GUI/浏览器自动化。每个目录均附带 `README.md` 与可直接复制运行的命令。

| 目录 | 场景 | 语言 | 运行入口 |
|------|------|------|---------|
| [daily-report/](daily-report/README.md) | 定时跑批导出 CSV 报表文件产物 + 告警占位（零依赖 TTFV 首跑） | Node.js | `daily_report.js` · `task.example.json` |
| [intranet-inspection/](intranet-inspection/README.md) | 批量 TCP 连通性巡检 + 结果汇总回调（零依赖） | Node.js | `intranet_inspection.js` · `task.example.json` |
| [desktop-data-entry/](desktop-data-entry/README.md) | 桌面执行器标签路由 + 本地 CSV 校验与 JSON 产物输出 | Node.js | `desktop_data_entry.js` · `task.example.json` |
| [callback-report/](callback-report/README.md) | `autoflow-sdk` 能力探测 + 成功/失败主动回调 + `CallbackDisabledError` 降级 | Python | `callback_report.py` · `task.example.json` |
| [callback-report-node/](callback-report-node/README.md) | `@autocodeflow/sdk` 能力探测 + `reportSuccess`/`reportFailure` 双路径主动回调 | Node.js | `callback_report.js` · `task.example.json` |
| [private-registry-deps/](private-registry-deps/README.md) | 任务级 `requirements` + `PYPI_REGISTRY_URL` 私服依赖隔离安装 | Python | `private_dep_task.py` · `requirements.txt` · `task.example.json` |
| [private-registry-deps-node/](private-registry-deps-node/README.md) | 任务级 `requirements` + `NPM_REGISTRY_URL` 私服 `.npmrc` 隔离安装 | Node.js | `private_dep_task.js` · `package.json` · `task.example.json` |
| [desktop-automation/](desktop-automation/README.md) | 浏览器（Selenium / Puppeteer）、桌面 GUI、文件系统与系统集成 RPA 脚本集 | Python / Node.js | `browser_automation.*` · `desktop_gui_automation.*` 等多脚本 |

## 契约校验

带 `task.example.json` 的 7 组示例均可直接用于 `acf task create --file <path>` 或 `POST /api/tasks`，其字段合法性与代码入口一致性由两条守卫自动检验：

```bash
npm run check:task-examples   # 校验 task.example.json 键集与必填项对齐 CreateTaskDto
npm run check:examples-code   # 校验 entrypoint 存在、runtime 匹配且 .js 语法通过
```
