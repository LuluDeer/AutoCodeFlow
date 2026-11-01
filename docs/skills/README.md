# 技能规范（Skills）

面向 AI 编码助手与脚本作者的**可复用任务规范**。每份 skill 自带模板与校验脚本，
可直接复制使用。

| Skill | 用途 |
|---|---|
| [python-task-package/](python-task-package/README.md) | 生成能被平台接受、可打包上传并支持版本迭代的 Python 自动化任务包 |

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
