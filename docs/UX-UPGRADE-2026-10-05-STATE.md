# 桌面端 UI v3 升级——执行状态（配合 UX-AUDIT-DESKTOP-2026-10-05.md）

> 用途：多轮 agent 编排的进度事实源。每完成一轮由编排者更新。
> 纪律：每轮 ≤2 个 subagent 并行；文件所有权互斥；轮间门禁=build:renderer + test:renderer
> +（涉 main 时）build:main/test:main 子集 + node e2e/screenshots.cjs 全页面实拍。

## 审计结论勘误（实施中修正）

- C-03 修正：通知点击已有接线（`notifier.ts:175` → 聚焦状态窗）。剩余缺口只是
  「任务类通知点击应到历史页」（`window-manager.openHistory()` 已存在）与正文信息量
  （错误摘要因 notifier-rules 安全约束刻意不含，保留）。
- A-11 定位：`tray.ts getIcon` 的 dev 路径 `app.getAppPath()/assets` 在裸 electron
  （e2e harness）形态下解析到 `dist/main/assets`——QA-12 同款双路径探测即可修；
  打包形态（resourcesPath/assets）本来就对。
- e2e 依赖文案清单（改动必须同步）：smoke 依赖 `欢迎使用`、`AutoCodeFlow Executor`、
  titlebar aria `最大化窗口/还原窗口/关闭窗口`；screenshots.cjs 依赖 `查看日志/关闭/
  日志文件/配置/历史/应用/网络地址/Python 运行环境/Agent（实验性）/基本设置/卸载应用/
  删除 v1.4.2 的本地部署/确定删除本地版本/未知应用名/每日报表生成与汇总推送` 等；
  `renderer.selftest.mjs` 直接读 `styles/app.css` 断言按钮/开关样式。

## 分期进度

| 期 | 任务 | 状态 |
|----|------|------|
| R1-0 | CSS 拆分 tokens/base/components/pages + selftest 读入口 | ✅ 完成（646 规则逐字校验） |
| R1-0 | 托盘图标 dev 双路径探测 + design-system 覆盖文档 | ✅ 完成 |
| R1-1 | 视觉基建（焦点环/disabled/badge-blue/pulse/发光/Icon 清理/agent 点修复） | ✅ 完成（遗留发光由编排者补修） |
| R1-2 | PageHeader 组件 + 历史/应用/配置标题统一 | ✅ 完成（含 running→badge-blue、running 已运行时长） |
| R1-3 | 向导打磨（文案/eye/IP 推荐/步进器对比度） | ✅ 完成 |
| R1 门禁 | build:renderer + test:renderer + screenshots 全页面 | ✅ 全绿（2026-10-05），过图确认页头/徽章/disabled 生效 |
| R2-1 | LogViewer 共享组件 + StatusWindow 迁移 + trace 合并 + lineArrive + 预览加载更早 | ✅ 完成（22 项功能自测+21 图） |
| R2-2 | HistoryPage 查看器迁移（真全屏） | ✅ 完成（selftest 锚点最小同步，语义保留） |
| R2-3 | AppsPage 查看器迁移 | ✅ 完成（遗留：components.css:455 .log-window-summary 死规则待 R5 清） |
| R2 门禁 | build + selftest + screenshots + 过图 11 | ✅ 全绿，真全屏确认 |
| R3-1 | StatusWindow 重排（hero 矮化 + 今日概览条 + 右栏降级） | ✅ 完成 |
| R3-2 | HistoryPage 日期分组 + 僵死标记 | ✅ 完成（:has→sparse 类迁移，3 列网格过图确认） |
| R3-3 | AppsPage 宽屏双列 + 折叠卡升格 + scrollIntoView | ✅ 完成（夹具补 current 软链由编排者落） |
| R3-4 | ConfigPage 分区重组 + hint 折叠（含 i18n 键 + e2e 同步） | ✅ 完成（ui-audit.cjs 同步由编排者落） |
| R3 门禁 | build + selftest + screenshots + 过图 02/12 | ✅ 全绿 |
| R4-1 | 通知双路由 + X 首次关闭提示（main + App.tsx） | ✅ 完成（临时 playwright 自证 3 项 PASS） |
| R4-2 | 停机二次确认（running>0 才确认）+ 托盘一次性提示 + 向导完成页说明块 | ✅ 完成（临时 playwright 自证含确认/取消两路、持久化） |
| R4 门禁 | build:main + build:renderer + test:renderer + screenshots | ✅ 全绿 |
| R5-1 | 动效令牌统一（--anim-in ×11 处 + 面板类 ease-out）+ pulse 全 1.2s + 徽章过渡 + 死样式清扫 4 条 | ✅ 完成（378 类全量扫描，逐条零引用证据） |
| 终验 | test:main 全链 EXIT=0（40+ 自测）+ test:renderer 全 guard + build×2 + screenshots 21/21 + 过图 01/02/03/04/06/09/11/12 | ✅ 全绿（2026-10-05） |

## 轮间门禁记录

- 2026-10-05 R1-0：CSS 拆分（646 规则逐字校验）+ 托盘双路径 + 覆盖文档 → 合并门禁全绿。
- 2026-10-05 R1-1/2：视觉基建 + PageHeader 三页 → 门禁全绿，过图 09/04 确认。
- 2026-10-05 R1-3：向导打磨 → 门禁全绿。
- 2026-10-05 R2-1：LogViewer 共享组件 + trace 合并 + lineArrive → 22 项功能自测 + 21 图。
- 2026-10-05 R2-2/3：History/Apps 查看器迁移 → 门禁全绿，11 号过图确认真全屏。
- 2026-10-05 R3-1/2：状态页重排 + 历史日期分组 → 门禁全绿，02/09 过图确认。
- 2026-10-05 R3-3/4：应用双列 + 配置重组 → 门禁全绿，12/06/08 过图确认（ui-audit.cjs 同步、夹具补 current 软链由编排者落）。
- 2026-10-05 R4-1/2：通知路由 + X 提示 + 停机确认 + 托盘提示 + 向导说明块 → 门禁全绿，02 过图确认提示条。
- 2026-10-05 R5-1：动效统一 + 死样式清扫 → 门禁全绿。
- 2026-10-05 终验：test:main 全链 EXIT=0；test:renderer 全 guard；build×2；screenshots 21/21；关键页过图。

## 落地偏差（与审计报告 §2/§3 的差异，均已评审接受）

1. ConfirmBar 共享组件未抽出：四处确认（清历史/卸载/删版本/保存影响 + 新增停机确认）的视觉与行为规范已一致（红/琥珀横条 + 右置主钮 + role=alertdialog），组件化留作后续代码健康项。
2. E-01 折叠高度过渡只做到入场动画统一（runsIn 220ms ease-out 双页一致），grid-template-rows 0fr→1fr 结构级过渡未做（需把条件渲染改常驻挂载，风险/收益不划算）。
3. Agent 分区 nav 保持「Agent（实验性）」未改「高级」——「实验性」是成熟度信号，保留。
4. 历史页「按应用/版本过滤」未实施（历史记录无 releaseKey 维度，数据不可达；已在报告标注为数据可达后实施）。
5. i18n：新增键全部 zh/en 成对（N-04 guard 钉住）；旧 4 页存量硬编码中文迁移仍为二期专项（与审计 §3.1 口径一致）。
6. 审计勘误（实施中发现）：C-03 通知点击原本已路由状态窗（notifier.ts:175），本次补的是「任务通知→历史页」双路由；A-11 托盘图标缺失为 e2e 裸 electron 形态特有（QA-12 同源），真实 dev/打包形态正常，仍按双路径探测加固。
