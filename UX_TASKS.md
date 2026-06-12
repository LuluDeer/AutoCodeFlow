# AutoCodeFlow UX 改进任务追踪

> 基于 UX_REVIEW.md 的评审结论，将改进项拆分为可执行任务，按团队分配。
> 进度标记：🔲 待开始 / 🔄 进行中 / ✅ 已完成 / ⏸ 已搁置

---

## Team A — 执行器安装注册流程（高优先级）

> 负责模块：ExecutorInstallWizardPage、ExecutorListPage、executor-node/python 健康检查

| ID | 任务 | 优先级 | 状态 | 说明 |
|----|------|--------|------|------|
| A-01 | 安装向导 Step 0 空状态增加「上传安装包」跳转入口 | P0 | ✅ | 无安装包时显示 Alert + 跳转按钮，关联 UX-01 |
| A-02 | 安装向导增加 Step 3「等待执行器上线」验证页 | P0 | ✅ | curl 执行后轮询 /api/executors 检测新执行器，超时提示排查步骤，关联 UX-02 |
| A-03 | 执行器列表空状态添加居中 CTA | P1 | ✅ | Empty 组件 + 「安装第一个执行器」主按钮，关联 UX-05 |
| A-04 | executor /health 端点返回详细连通性状态 | P1 | ✅ | 返回 adminApiReachable、tokenValid、lastHeartbeat 字段，关联 UX-08 |
| A-05 | 移除 execCommand 降级代码，仅用 Clipboard API | P3 | ✅ | ExecutorInstallWizardPage copyText()，关联 UX-16 |

---

## Team B — 导航与全局体验

> 负责模块：MainLayout、router.tsx、DashboardPage

| ID | 任务 | 优先级 | 状态 | 说明 |
|----|------|--------|------|------|
| B-01 | 调整侧边栏菜单顺序 | P1 | ✅ | 新顺序：看板→任务→执行器→执行记录→应用→包仓库→通知→用户→审计，关联 UX-04 |
| B-02 | 仪表板空状态「快速开始」引导卡片 | P0 | ✅ | 全部数据为 0 时显示 3 步引导（创建任务/注册执行器/触发执行），关联 UX-03 |
| B-03 | 所有详情页添加面包屑导航 | P2 | ✅ | 使用 Ant Design Breadcrumb，ExecutorDetailPage、TaskDetailPage、ExecutionDetailPage，关联 UX-15 |
| B-04 | 后台顶部导航添加「文档」快捷链接 | P2 | ✅ | 链接到 /docs 目录或外部文档站，关联文档可达性问题 |

---

## Team C — 任务管理体验

> 负责模块：TaskFormPage、TaskListPage、ExecutionDetailPage

| ID | 任务 | 优先级 | 状态 | 说明 |
|----|------|--------|------|------|
| C-01 | TaskFormPage 表单字段分组折叠 | P1 | ✅ | 拆分为「基础配置」「调度设置」「执行器与依赖」三个 Collapse 面板，ghost 模式，关联 UX-06 |
| C-02 | 任务立即执行后跳转/链接到执行详情 | P2 | ✅ | notification.success 中添加「查看执行记录」链接，关联 UX-09 |
| C-03 | 执行日志自动滚动 + 实时刷新 | P2 | ✅ | running 时 3s 轮询、scrollTop 自动到底、Badge 显示「实时更新中」，关联 UX-10 |
| C-04 | 任务列表搜索框添加 300ms 防抖 | P3 | ✅ | useRef + setTimeout 300ms 防抖已实现，关联 UX-18 |

---

## Team D — 配置与用户管理体验

> 负责模块：NotificationSettingsPage、UserListPage、AuditPage

| ID | 任务 | 优先级 | 状态 | 说明 |
|----|------|--------|------|------|
| D-01 | 通知配置测试发送显示具体结果 | P2 | ✅ | 成功/失败均显示 Alert（可关闭），带渠道名或错误信息，关联 UX-12 |
| D-02 | 用户管理添加「重置密码」快捷入口 | P2 | ✅ | 操作列增加按钮，弹出 Modal 含二次确认，调用 PATCH /users/:id，关联 UX-13 |
| D-03 | 审计日志时间筛选改为 RangePicker | P2 | ✅ | 使用 DatePicker.RangePicker，添加 1天/7天/30天 快捷项，关联 UX-14 |
| D-04 | 包仓库 Tab 添加发布命令代码块 | P2 | ✅ | PyPI Tab 显示 twine upload 命令，npm Tab 显示 npm publish 命令，关联 UX-11 |

---

## Team E — 细节与 P3 优化

> 负责模块：各页面图表、登录页

| ID | 任务 | 优先级 | 状态 | 说明 |
|----|------|--------|------|------|
| E-01 | 执行器详情性能图表无数据空状态 | P3 | ✅ | 图表数据为空时渲染 Ant Design Empty 组件，关联 UX-17 |
| E-02 | 登录页添加「记住我」选项 | P3 | ✅ | Checkbox 勾选后 token 存 localStorage，未勾选存 sessionStorage，关联 UX-19 |
| E-03 | 执行器首次上线站内通知 | P1 | ✅ | 后端在首次注册时调用 notifyExecutorOnline 发送通知，关联 UX-07 |

---

## 进度总览

| 团队 | 总任务 | 待开始 | 进行中 | 已完成 |
|------|--------|--------|--------|--------|
| Team A | 5 | 0 | 0 | 5 |
| Team B | 4 | 0 | 0 | 4 |
| Team C | 4 | 0 | 0 | 4 |
| Team D | 4 | 0 | 0 | 4 |
| Team E | 3 | 0 | 0 | 3 |
| **合计** | **20** | **0** | **0** | **20** |

---

## 启动顺序建议

1. 第一周：A-01、A-02、B-02（解决新用户无法完成首次注册的 P0 问题）
2. 第二周：B-01、A-03、C-01、A-04（主流程体验对齐）
3. 第三周：B-03、B-04、C-02、C-03、D-01~D-04（全面打磨）
4. 第四周：E 组 + C-04（收尾细节）

---

## 完成后验收标准

- [ ] 新用户从登录到第一个执行器成功注册，操作步骤不超过 5 步，全程不需要查阅文档
- [ ] 任务创建到触发执行，全流程在后台完成，无需切换终端
- [ ] 执行器状态变化（上线/离线/失败）有明显的前台反馈
- [ ] 所有列表空状态有操作引导，不出现纯空白页面
