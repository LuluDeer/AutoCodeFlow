# 技能规范（Skills）

> **受众**：要复用或新写 AI 任务规范的开发者 · **状态**：稳定 · **最后核对**：2026-11-22

面向 AI 编码助手与脚本作者的**可复用任务规范**与**官方任务模板清单**。每份 skill 自带模板与校验脚本，
可直接复制使用。

## Skill 清单

| Skill | 用途 |
|---|---|
| [python-task-package/](python-task-package/README.md) | 生成能被平台接受、可打包上传并支持版本迭代的 Python 自动化任务包 |

## 官方任务模板清单（`templates/`）

以下 5 个官方模板的声明式清单均登记于 [`registry.json`](registry.json)，并与 `admin-api` / `mcp-server` 预置模板同源（由 `npm run check:template-manifest` 双向守卫）：

| 模板 Key | 清单 | 能力域 | 用途 |
|---|---|---|---|
| `data_sync` | [templates/data_sync/manifest.json](templates/data_sync/manifest.json) | — | 开箱即跑的 Python 确定性示例数据生成脚本（参数：`rows`） |
| `health_check` | [templates/health_check/manifest.json](templates/health_check/manifest.json) | `http` | Node 脚本对目标 URL 发起 GET 巡检并校验 2xx 响应（参数：`url`） |
| `log_cleanup` | [templates/log_cleanup/manifest.json](templates/log_cleanup/manifest.json) | `filesystem` | Node 脚本按保留天数清理演示日志目录，默认 `dryRun=true`（参数：`dir`、`maxAgeDays`、`dryRun`） |
| `scheduled_backup` | [templates/scheduled_backup/manifest.json](templates/scheduled_backup/manifest.json) | `filesystem` | Node 脚本只读扫描目录并将 manifest JSON 写入 `AUTOFLOW_ARTIFACTS_DIR`（参数：`dir`） |
| `webhook_ping` | [templates/webhook_ping/manifest.json](templates/webhook_ping/manifest.json) | `http` | Node 脚本向目标 URL POST JSON 探活，未配 URL 时安全打印 payload（参数：`url`） |

## 分发契约（清单 / 登记表）

每个技能目录与每个任务模板目录各带一份 `manifest.json`（`name` 必须等于目录名），
`registry.json` 由这些清单**派生**、双向比对——不是手写登记表。字段、安全判据
（`entrypoints` 越界即拒）、以及「为什么清单里不放可执行 hook」，见
[manifest-contract.md](manifest-contract.md)。

```bash
node scripts/check-template-manifest.mjs            # 校验 + 双向比对
node scripts/check-template-manifest.mjs --write    # 只重新生成 registry.json
node scripts/check-template-manifest.mjs --selftest # 守卫自检
```

> 这些规范原先只存在于本地编辑器目录（`.qoder/`，已被 `.gitignore` 忽略），
> 导致文档链接在他人 clone 后必然失效。现已纳入版本控制。
