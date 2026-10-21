# 执行器桌面端 v2.0.0

状态：待发布（tag `desktop-v2.0.0`）

## 这次换掉了什么

- 渲染层整体切到 V2（React 19 + Tailwind v4 + Radix 组件体系），V1 渲染层仅保留为
  技术回退，不再作为产品界面维护。
- 应用管理：表格化 + 虚拟滚动（202 个应用只渲染 25 行）、搜索/状态筛选/排序、
  多选批量卸载（`apps:uninstall-many`，单次确认）、版本列表与按版本日志/目录/删除。
- 日志：统一 `LogPanel`（搜索、真实行号、跳到末尾、复制、放大），应用/执行/状态三处一致；
  长行动态测高，不再叠字。
- 状态页：视口内布局（右侧 340px + 日志占满剩余高度）、需要关注、失败任务一键跳历史。
- 无障碍：axe 13 项、表格 ARIA、焦点归还、对比度修复；视觉回归 5 页像素基线。
- 中英双语完整覆盖，语言切换保存后重载。

## 升级

- 安装身份不变：`appId` / `productName` / 包名 / userData 路径均未改，可直接覆盖安装
  已装 V1 的设备；配置、历史、应用目录保留，无数据迁移。
- 首次从 V1 升级需要版本号高于设备现有版本（本版 `2.0.0`）。
- Windows NSIS 保持 per-user；macOS 构建未签名，自动更新不可用，仅手动安装验证；
  Linux AppImage 依赖 `APPIMAGE` 环境替换文件。
- 回退：V1 渲染层仍在包内，`ACF_RENDERER=v1` 可切回（打包态暂无 UI 开关）。

## 验证

```
verify:v2   48/48 PASS
a11y:v2     13/13 PASS
visual:v2    5/5   PASS（0.000%）
```

打包链：`release-desktop.yml` 会先构建 V2、复制到 `dist/renderer-v2/`，出包后断言
`app.asar` 内存在 `dist/renderer-v2/index.html`。

## 已知边界

- Windows/macOS 打包未在本机验证，以 CI runner 为准；
- macOS 无签名，自动更新不可用；
- 真实更新下载/安装需要发布 feed 与签名；
- V1 中尚未搬过来的能力：配置导入/导出、Pull 回连、Agent 权限档位、跨天日志文件浏览。
