# UI/UX 深度打磨轮（2026-10-25）

目标：细节深度打磨、全面改善功能体验；寻找功能缺陷、潜在漏洞、边界问题。范围不限于后端逻辑——中台（admin-web）与客户端（executor-desktop）的前端设计体验、使用场景、填充数据、触发类型、UI 元素全方位排查；真机 DOM 级验证优先，不只靠截图。方式：主会话编排 subagent 循环推进（同刻 ≤2 个）。

## 环境基线

| 项 | 值 |
| --- | --- |
| 被测中台（dev） | http://127.0.0.1:5176（vite dev，工作区代码） |
| demo API | http://127.0.0.1:3105（docker demo 栈，真 Postgres，种子 14 任务） |
| demo web（构建态验收用） | http://127.0.0.1:8088 |
| 登录 | `admin` / `.env.demo:INITIAL_ADMIN_PASSWORD` |
| 浏览器驱动 | playwright-core 1.64.1（apps/admin-web/node_modules）+ chromium-1243 |
| ⚠️ 邻项目 | 端口 5173/3001 属 GuardVault，禁触 |

## 轮次台账

### R1（发现轮，进行中）
- R1-A 真机 UI 深挖（subagent，/tmp/uiaudit/ui-findings.md）
- R1-B 代码级审计（subagent，/tmp/uiaudit/code-findings.md）

### R2（admin 修复轮，全部完成）
- W1：F-39/40/41/42（P0+P1×3，7 commit 39d7621d..1fd40140）
- W2：F-1/2/3/5/6/43（认证簇+竞态簇，6 commit 22cd94e0 之前的 c0bf62aa..1fdc36d0）
- W3a：F-4/5b/7/44/45/46/47（P2 余量，7 commit 46fdae2f..cd940c6f）
- W3b：F-8~17/19/20/48（P3 扫尾，14 commit 22cd94e0..497c9dd6）；F-18（88a7ca03+a3e570d0）；F-21（28b2556e）
- 裁定：F-49 未复现（17 路由 390px 全干净，疑过渡帧测量伪影）；F-50 非缺陷（NotificationBell BELL-01 设计）；F-51 wontfix(本轮)

### R2'（executor-desktop 客户端发现+修复轮，全部完成）
- 发现：R2'-C（/tmp/uiaudit/desktop/desktop-findings.md）F-22~F-38
- 修复：D1（aba49592..0b800c2a，8 commit）+ D2（822dbbaa..a25b314c + c9e57713，12 commit），基线五条全绿
- 二轮真机（subagent 配额中断，产物抢救于 /tmp/uiaudit/desktop2/）：配对全链路 PASS（5 步向导/连通双态文案/F-33 端口必填真机生效/错 token 文案可操作且不锁死/修正后 7s 在线/密钥轮换 201 持续在线）；延迟重启降级 UX 正确+token 落盘加密信封 ✓；托盘态启动 ✓；tray 脚本自身 bug 未完成、重启持久化被单实例锁挡（行为正确）；测试执行器已清理

### R3（后端边界轮，完成）
- 审计：admin-api 十面（/tmp/uiaudit/api-findings.md）——P0/P1 零条，正面结论为主
- 修复：B1（F-52~57，7 commit d487353d..fdcf89f8 + 00a403dd 收尾），约 3477 用例绿

### R4（收口轮）
- admin-api 全量套件：PASS（exit=0）
- admin-web 生产构建（tsc -b + vite build）：首轮抓到 W2/W3b 的 4 处类型回归（vitest/lint 均不查类型，批次门禁盲区）→ 已修（32f73337），重建过
- admin-web 全量 vitest 终验 + 本报告提交
- 8088 构建态验收：demo 容器为旧镜像（源码修复未部署），以 tsc+vite 生产构建 + dev 真机复验代位；下次部署 demo 栈后自然收敛（含 live 500 深链 7 条）
- 遗留：F-55 真分页（待拍板——响应形状变更打断四端消费方）；桌面语言默认值 OPEN-DECISIONS D5 待拍板

## 发现总表

（编号 F-xx；来源 R1-A/R1-B/R2'；状态：open / fixed / wontfix(附裁定)）

| # | 严重度 | 面 | 摘要 | 根因位置 | 状态 |
| --- | --- | --- | --- | --- | --- |
| F-1 | P1 | admin-web 认证 | 401 拦截器未排除 `/auth/login`、`/auth/totp/verify`：输错密码→走会话过期链→整页 reload+「会话已过期」误报，输入/TOTP 第二步被清空 | `apps/admin-web/src/api/client.ts:327-341`（LoginPage.tsx:62-95 联动） | fixed(c0bf62aa：排除公开认证端点，错密码不再整页 reload) |
| F-2 | P2 | admin-web 竞态 | AgentSessionsPage.openDetail 无竞态守卫：连点两行，B 抽屉 steps/toolCalls/children 被 A 旧响应覆盖（列表已用 useRaceGuard，详情没有；SopsPage 同型已修 SOPS-RACE-01） | `pages/AgentSessionsPage.tsx:174-188` | fixed(65c8f860：detailSeq 模式) |
| F-3 | P2 | admin-web 竞态 | SopsPage.load 三入口（翻页/手动刷新/15s 轮询）无 seq 守卫，旧页响应可覆盖新页 | `pages/SopsPage.tsx:137-168` | fixed(f5e66700：useRaceGuard 复用) |
| F-4 | P2 | admin-web UX | LogWindow 无条件吸底（useEffect([text]) 每次追加 scrollTop=scrollHeight），流式期间无法上翻看早前日志；应改 stick-to-bottom 判定 | `components/LogWindow.tsx:156-160` | fixed(46fdae2f：stick-to-bottom≤40px+回底浮钮，流式真机验证) |
| F-5 | P2 | admin-web 网络 | 上传/下载吃全局 30s axios 超时：执行器包/PyPI 包上传与 blob 下载无 timeout 覆盖，弱网必超时误报且服务端可能仍在收 | `api/client.ts:30`；`api/registry.ts:29-33`；`api/executor-packages.ts:163-187` | fixed(98382954+87d72394：上传/下载 timeout:0 含 applications.ts) |
| F-6 | P2 | admin-web 认证 | 多标签页 refresh 互踢竞态：① TOCTOU 读到已轮换旧 RT→误登出；② `getState().refreshToken !== refreshToken` 守卫会把已成功刷新丢弃并登出 | `api/client.ts:252-292` | fixed(11eb1924：__superseded 判据重构，四路径单测) |
| F-7 | P2 | admin-web 校验 | SecretsEditor 零键名校验：后端拒绝非 `[A-Za-z_][A-Za-z0-9_]*`/保留名 25 个/`AUTOFLOW_`/`PYTHON_` 前缀，前端照单全收→整批保存 400 裸报 | `SecretsEditor.tsx` vs `secret-key-map.constraint.ts:47-68` | fixed(4409e548：utils/secretKeyPolicy.ts 逐字镜像+vitest 源码守卫) |
| F-8 | P3 | admin-web 安全 | 错误码插值把后端 params 原样传 i18next（escapeValue:false，$t(nesting 面） | client.ts | fixed(W3b 22cd94e0：$t( 中和，深度递归) |
| F-9 | P3 | admin-web 校验 | 事件订阅 URL 规则松于后端 @IsUrl 且缺 2048 上限 | 事件订阅表单 | fixed(W3b 5c7f3aa0：isValidWebhookUrl+2048) |
| F-10 | P3 | admin-web 校验 | 任务 params 64KB 上限前端零预检 | TaskForm | fixed(W3b 6f6d44b9：TextEncoder 64KB 预检+滚到分区) |
| F-11 | P3 | admin-web 校验 | TOTP 输入允许非数字，后端 `^\d{6}$` 裸 400 | LoginPage/TOTP | fixed(W3b 86f5f7dd：数字过滤+pattern+one-time-code) |
| F-12 | P3 | admin-web 状态 | client.ts storage 同步 `user !== persisted.user` 恒真（每次跨 tab 写入都 setUser） | client.ts | fixed(W3b 6fe936f0：JSON.stringify 判据) |
| F-13 | P3 | admin-web 状态 | 跨 tab 换账号不重载已挂载页面 | client.ts/auth | fixed(W3b ede12101：user.id 变化即 reload) |
| F-14 | P3 | admin-web 显示 | formatDuration 负数原样渲染 `-123ms` | utils | fixed(W3b 4da8fc32：clamp 0+非有限值 —) |
| F-15 | P3 | admin-web 显示 | artifactSize 封顶 GB（1TB 显示 1024.0 GB） | utils | fixed(W3b b532d804：TB 档) |
| F-16 | P3 | admin-web 轮询 | ExecutorPackagesPage 轮询 effect 依赖 loading 致节拍漂移 | ExecutorPackagesPage | fixed(W3b 4de01c25：pollGateRef 锚定节拍) |
| F-17 | P3 | admin-web 轮询 | ExecutionsPage 15s refetch 不按 SSE 收敛（refetch() 不受 staleTime 节流，注释与实现不符，现成 sseFallbackRefetchInterval 未用） | ExecutionsPage | fixed(W3b b7bb8eb8+7500734d：sseFallbackRefetchInterval+守卫对齐) |
| F-18 | P3 | admin-web 校验 | 用户名长度前后端都无上限（一致地松；登录 DTO 有 1-1 硬规则可循） | 注册/用户管理 + DTO | fixed(88a7ca03+a3e570d0：后端 @MaxLength(128)+前端镜像+契约再生成) |
| F-19 | P3 | admin-web 竞态 | ExecutionLogSection SSE effect 依赖不全（eslint-disable 压制，当前因引用稳定实际无害） | ExecutionLogSection | fixed(W3b 86e1da77：依赖补全去 disable，语义零变化) |
| F-20 | P3 | admin-web 路由 | useUrlStateSync 回写会抹掉 URL 非受控参数 | hooks | fixed(W3b 74ada95b：受控键逐个 set/delete) |
| F-21 | P3 | admin-web 测试 | vitest 运行期 4 个 unhandled errors（api-keys-settings.test.tsx，疑似卸载后 setState） | `__tests__/api-keys-settings.test.tsx` | fixed(28b2556e：scheduler 捕获时序根因——零 import setupFiles[0] 包裹+teardown 伪影白名单吞除；全量 unhandled 9~14→0) |
| F-22 | P1 | desktop 日志 | 大文件首读全量过桥：`readLogIncremental` fromLine=0 无游标分支读 0..size 全文件无上限序列化（10.6MB/30000 行实证 1.0s），渲染层仅留最后 1500/2400 行；数百 MB 日志打开即主进程内存尖峰 | `src/main/ipc-handlers.ts:280-350`（对照 readLastLines:370-408 尾窗） | fixed(aba49592：log-tail-scan 尾窗 3000 行 + truncated 降级汇总，9+2 组自测) |
| F-23 | P1 | desktop 向导 | 重跑向导静默重置 executorHost(127.0.0.1→0.0.0.0 安全姿态降级)/autoStartExecutor/autoStart，且 autoStart 复位不清 OS 自启项 → 托盘勾选态与设置页开关互相矛盾、下次开机仍自启 | `Wizard.tsx:47-57,144-157`；`ipc-handlers.ts:528-549`；`index.ts:200` vs `autolaunch.ts:44-54` | fixed(09c87230：预填三项 + autoStart 对称 disable) |
| F-24 | P1 | desktop 日志 | 历史页执行日志缓冲用数组下标当行 id：缓冲超 1500 行后 id 平移 → 整窗到达动画每次闪 1.5s + 未读胶囊一次 +~1500（正确对照：AppsPage 文件全局行号、StatusWindow 自增 id） | `HistoryPage.tsx:270-273`；`LogViewer.tsx:142-160` | fixed(5c27de65：id=linesRef 换算全局行号) |
| F-25 | P2 | desktop 向导 | 重跑向导对「需重启字段」只调 executorProcess.start()（对运行中进程 no-op），与 config:save 的 finalizeConfigSave 重启判据不同源 → 新配置落盘不生效且提示误导 | `Wizard.tsx` vs `executor-process.ts:168-175` | fixed(c4b76bc3：共享收口 reloadExecutorAfterConfigSave) |
| F-26 | P2 | desktop UX | 主进程 R105 确认框用户「取消」返回 {ok:false,canceled:true}，AppsPage 卸载/删版本、HistoryPage 清历史无 canceled 分支 → 取消原生框却报「删除失败」红条 | `destructive-actions.ts:81`；AppsPage/HistoryPage | fixed(0f5c5f1f：三处 canceled 分支) |
| F-27 | P2 | desktop i18n | 系统通知与主进程原生对话框文案硬编码中文（notifier/ipc-handlers 多处），托盘已有语言回调未接入 | `notifier.ts:162,177-181,238-247`；`ipc-handlers.ts:110-129,245-258,610-632,680-684` | fixed(6a03480b：ui-texts.ts 双语纯模块+语言注入+反证钉) |
| F-28 | P2 | desktop 向导 | 向导窗口固定 660×780 不随工作区钳制且不可 resize（同文件 openStatus 有钳制标准不一）→ ≤768p 矮屏底部按钮被任务栏裁切 | `window-manager.ts:213-226` | fixed(3af59e4c+4f9512f8：workArea 钳制+resizable+锚点) |
| F-29 | P2 | desktop 状态 | 向导打开期间托盘「查看状态」可唤回主窗（focusOrOpenStatus 无向导守卫）→ 双窗并发编辑，向导完成以旧配置快照整包提交静默覆盖 | `window-manager.ts` focusOrOpenStatus | fixed(03a661b0+0b800c2a：向导守卫+wizardClosing 让路) |
| F-30 | P3 | desktop 状态 | 未知执行器状态时 hero 描述行空白（label 有兜底 desc 没有） | `StatusWindow.tsx:711-718` | fixed(822dbbaa：status.desc.unknown 双语兜底) |
| F-31 | P3 | desktop 轮询 | 状态页 2s Agent 轮询/60s 兜底不受 document.hidden 门控 + 主进程 2s 托盘快照定时器 Agent 关闭时常驻（最小化空转） | StatusWindow/主进程定时器 | fixed(b78b3dfe：document.hidden 门控+快照定时器随托管启停) |
| F-32 | P3 | desktop 状态 | getTodayLogs/LogFilesPanel 失败静默冒充空态（与 History/Apps 错误态口径不一） | LogFilesPanel | fixed(3927668f：三处失败态+重试) |
| F-33 | P3 | desktop 向导 | 向导端口清空得 NaN（React value=NaN 告警 + 下一步静默禁用无反馈） | Wizard 端口字段 | fixed(955c6f27：草稿字符串受控+portRequired) |
| F-34 | P3 | desktop 设置 | 设置页数值字段清空即回填默认的 controlled-clamp 毛刺 | ConfigPage | fixed(3ec3e179：键入草稿+blur 夹紧) |
| F-35 | P3 | desktop 交互 | ConfirmBar Esc 用 stopPropagation 隔离不了同挂 document 的查看器 Esc（应 stopImmediatePropagation） | ConfirmBar | fixed(128498f5：捕获阶段+stopImmediatePropagation) |
| F-36 | P3 | desktop i18n | main.tsx:33-34 注释称「读配置失败默认中文」与实际 UI_LANGUAGE_DEFAULT='en' 相反（zh 系统配置损坏整窗英文） | `main.tsx:33-34` | fixed(d4f473d5：注释对齐；默认值待拍板登 OPEN-DECISIONS D5) |
| F-37 | P3 | desktop 更新 | 更新下载无取消入口 + quitAndInstall no-op 仍返回 ok:true | updater UI | fixed(eb40bd56+c9e57713：原生 CancellationToken 取消+quitAndInstall 如实失败) |
| F-38 | P3 | desktop 杂项 | ConfigPage checkUpdate 6s setTimeout 未清理；AppsPage handleOpenFolder 无 try/catch | ConfigPage/AppsPage | fixed(a25b314c：定时器清理+try/catch) |
| F-39 | P0 | admin-web 任务 | 草稿恢复后「创建任务」100% 失败且自锁：TaskFormPage 恢复草稿 setFieldsValue 把自持 state executorMode 种进表单，提交 getFieldsValue(true) 带出，后端 forbidNonWhitelisted 400 `should not exist`；草稿仅在成功/手动丢弃时清除→永久卡死无线索 | `TaskFormPage.tsx:486,513-517,594`；`executor-mode.ts buildExecutorPayload` 不剥离；后端 main.ts:380 | open |
| F-40 | P1 | dev 链路 | dev 端口（5176）一切带 Origin 写请求 500：demo 栈 CORS_ALLOWED_ORIGINS 钉死 8088，CORS 拒绝冒泡成 Unhandled exception 500/「服务器内部错误」而非 403；vite proxy 未清洗 Origin（同源浏览器 POST 也带 Origin 并被透传） | 后端 `main.ts:292-301`+`cors-origin.util.ts:33`；dev 侧 `vite.config.ts` proxy | fixed(f972842d+8a47941a：proxy 改写 Origin+后端 403 封套 CORS_ORIGIN_NOT_ALLOWED) |
| F-41 | P1 | 全栈 | 非法/不存在 ID 深链（/tasks/999999、/applications/abc 等）后端 500（errorCode null）而非 404；前端 react-query 每秒重放整组子请求（10 秒 10 请求不停） | 后端 ID 解析校验；前端查询 retry/错误态 | fixed(df08597c+693b6895：ParseUuidShapePipe+22P02→400+重试收窄 10发→5发) |
| F-42 | P1 | admin-web i18n | 运行时切语言→侧边栏渲染原始 key（nav.group.executions 等）；冷启动 EN→侧边栏整块中文主内容英文；时序敏感双形态（en 动态 import + autoflow-lang/i18nextLng 双存储键竞态） | `i18n/index.ts` + 侧边栏订阅 | fixed(7f58b225：en 静态 import+双键收敛+html lang 同步，真机 allOk=true) |
| F-43 | P2 | admin-web 表单 | 创建任务连点提交不禁用：4 连点=4 个 POST（1×201+3×409），仅靠后端唯一名兜底，用户看到 3 条「任务名已存在」toast | TaskFormPage 提交防重 | fixed(1fdc36d0：同步 ref 互斥，连点 3 次=1 POST) |
| F-44 | P2 | admin-web 错误态 | 列表 API 错误被吞成空态：pageSize=1000/非法 sort 后端 400，UI 显示「共 0 个任务」空表零提示，数据像全丢 | TaskListPage 等列表错误分支 | fixed(37bec15e：错误态退场 StateError+重试，真机 400 验证) |
| F-45 | P2 | admin-web 错误态 | 断网切页触发 chunk 失败兜底文案「版本已更新，请刷新」——断网中刷新不可能成功，误导 | RouteErrorBoundary chunk 判定 | fixed(cf580ff5：navigator.onLine 探测分流) |
| F-46 | P2 | admin-web 表单 | 编辑不存在任务渲染空白新建表单（/tasks/999999/edit，完成度 33%），无错误提示 | TaskFormPage 详情失败分支 | fixed(6ea0b479：404/5xx 分流错误态+失败期草稿禁写) |
| F-47 | P2 | admin-web 草稿 | 草稿「改完立刻关页不丢」承诺失效：<800ms 内关页丢失（页面卸载不执行 effect cleanup flush） | TaskFormPage 草稿防抖 | fixed(cd940c6f：pagehide/beforeunload 同步 flush，324ms reload 实测) |
| F-48 | P3 | admin-web 文案 | /executions?page=999 显示「暂无执行记录 共 17452 条」矛盾 | ExecutionsPage 空态文案 | fixed(W3b 497c9dd6：越界页「当前页无数据（共 N 条）」+回第一页) |
| F-49 | P3 | admin-web 布局 | 390×844 下侧边栏溢出（right=-1px） | 布局窄屏 | 未复现（390×844 全 17 路由扫描：侧边栏精确 off-canvas left:-220/right:0、零横向溢出；原 right=-1px 疑为 0.25s 过渡态中间帧测量伪影） |
| F-50 | P3 | admin-web 轮询 | 离开 dashboard 后 40s 内 1 次残留 metrics 轮询（待复现） | DashboardPage | 非缺陷（裁定 wontfix：/metrics/failures 30s 轮询来自全局顶栏 NotificationBell BELL-01 设计——SSE 流不含 failures，轮询是唯一新鲜度源，queries.ts:188 注释明确） |
| F-51 | P3 | admin-web 空态 | 空态一律 antd 默认「暂无数据」，缺场景化引导（打磨项） | 各列表页 | wontfix(本轮)——打磨向大，留后续 |
| F-52 | P2 | admin-api 契约 | users(ParseIntPipe)/task-templates(原生 ParseUUIDPipe) 的 ID 形态错误仍 errorCode null+英文原生文案（GET /api/users/not-a-uuid 实测），与 F-41 后的 INVALID_VALUE_FORMAT 统一语义三态漂移 | `users.controller.ts:105,124,198`；`task-template.controller.ts:87,142,166` | fixed(B1：ParseIntShapePipe 新增+ParseUuidShapePipe 升级 AppError 封套，7 commit) |
| F-53 | P2 | admin-api 契约 | 全局 forbidNonWhitelisted 在所有「非 class @Body」面静默豁免：auth/totpDisable 内联类型、notification testChannel Record、executor rotate/set-offline reason 无上限、alerts webhook interface（live 实测多余字段 201 收下） | `auth.controller.ts:319`；`notification-config.controller.ts:124`；`executor.controller.ts:1345,1524`；`alerts.controller.ts:132` | fixed(B1：class DTO+ChannelConfigOverridePipe+alerts expectedType 白名单剥离保 HMAC；勘误：1524 实为 DELETE removeExecutor) |
| F-54 | P3 | admin-api 分页 | agent/sop 列表缺 page @Max(10000)，?page=99999999 深 OFFSET 200（ADMIN-only 小表，与 events 已修标准不一致） | `agent-session.service.ts:161`；`sop.service.ts:1776` | fixed(B1：clamp 链 Math.min(10000)——端点头注钉死「绝不 400」契约，未按 @Max 方案，偏差已记录) |
| F-55 | P3 | admin-api 分页 | GET /api/executors 静默忽略 page/pageSize（内部 listLimit 截断，超限「第 2 页」返回相同前缀行；前端有兜底告警，CLI/MCP 没有） | `executor.controller.ts:815` | fixed(B1：按 API-07 先例 OpenAPI 如实化+截断信号；真分页待拍板——改响应形状打断四端消费方) |
| F-56 | P3 | admin-api 契约 | DELETE /api/auth/sessions/abc → 200 {success:false}，错误走成功封套，与全站 4xx+errorCode 形态不一致 | `auth.controller.ts:398` | fixed(B1：400 INVALID_VALUE_FORMAT+SESSION_NOT_FOUND 401→404（避免触发前端登出链），前端零改动) |
| F-57 | P3 | admin-api 校验 | alerts webhook 载荷无 schema 校验（HMAC 正确时任意形状进入映射层），补 AlertmanagerWebhookDto（容忍未知键，勿破坏外部源） | `alerts.controller.ts` | fixed(B1：并入 F-53，见上) |

R1-A 覆盖：28 路由全遍历（含 7 坏深链）、表单边界（空/空格/1200 字符/300 汉字/XSS/SQLi/Cron/emoji/CRLF）、竞态（连点/乱序/删除/Enter）、失败态（offline/3s 延迟/401）、分页极值 5 组、i18n 双语 17 页、视口 3 档×4 页、键盘可达性。正面：XSS/SQLi 全转义、乱序竞态有守卫、401 自愈无死循环、Tab 可达 40+ 控件、全程 pageerror 0 次。详情：/tmp/uiaudit/ui-findings.md（测试数据已清理，种子任务未动）

R2'-C 基线：test:renderer / test:main（61 组）/ test:e2e（11 条）/ audit:ui（0 issues）/ audit:visual 全绿。安全红线复检未发现 UI 侧绕过（navigation-policy、ipc-sender-guard fail-closed、token 恒掩码不过桥真机验证、preload↔renderer↔main IPC 三面对齐）。详情：/tmp/uiaudit/desktop/desktop-findings.md

### R5（二轮深挖轮，主会话直落完成——subagent 双限流不可用）
- R5-A admin-web 二轮（主会话切片）：修复密集区回归抽查 9/9 全过（F-1 错密码无 reload+文案正确 / F-41 深链错误态+10s 5 请求封顶 / F-42 无裸 key / F-43 连点 ≤1 POST / 0 pageerror）；TaskForm 校验面（cron 非法拦+合法过、F-7 三类非法键名文案精确、F-10 64KB 预检键值齐全时正确拦截 0 POST——此前「创建成功」为测试伪影：空键名行不构成参数）
- R5-B 桌面三轮：基线五条全绿（新构建，D1/D2 再回归 PASS）；**优雅重启持久化验证通过**（config.json 保真 logLevel/notifyEnabled/executorName、token enc:ss: 加密落盘、重启后执行器自动拉起+控制面 online 心跳新鲜）；「重启不开窗」确认为托盘常驻设计（index.ts:276 configured 分支只拉执行器+心跳）
- 环境注记：两个 subagent 均被 model concurrency limit 打断（与配额耗尽不同的限流形态），按降级纪律主会话接管

### R7（demo 栈重建 + 构建态验收，全绿）
- `./scripts/demo.sh --build`：镜像含全部 ~60 commit 修复，seed 幂等复用、demo-hello-fixed 跑通 SUCCESS、双执行器重新注册
- API 收敛确认：原 live 500 深链 7 条全部 → 400 INVALID_VALUE_FORMAT 统一封套；users/sessions 非法 id → 400；CORS 恶意 Origin → 403 CORS_ORIGIN_NOT_ALLOWED
- 8088 构建态 UI 全链：登录/Dashboard/任务列表/草稿恢复→创建任务（F-39 构建态）/非法深链错误态（文案+CTA）/模板预填（5 卡片+名称回填）/EN 切换（侧边栏全英 html lang=en；内容区中文为失败任务日志数据非 UI）/暗色主题（data-theme=dark）/0 pageerror
- 验收中三疑点均判非缺陷：创建后 URL 停留（时序断言过严，任务实际创建）；模板页空（URL 应为 /task-templates，误入 :id 路由反而验证了错误态）；语言入口（在 header 图标钮 data-testid=lang-toggle，非用户菜单）

## 总结（2026-10-25）

发现 **57 条**（P0×1 / P1×8 / P2×14 / P3×34），处置：**修复 54 条**、未复现 1（F-49）、非缺陷 1（F-50）、wontfix 1（F-51）。桌面端 F-22~F-38 全清；admin-web F-1~21/F-39~48 全清；admin-api F-52~57 全清。累计提交 ~60 commit（develop，未 push）。

验证基线：admin-web vitest 242 文件/2050 用例全绿且 unhandled 0、lint/lint:i18n 0 错、tsc+vite build 过（R4 抓到并修复 4 处类型回归后重建）；admin-api 全量套件 PASS + 批内定向 ~3477 用例绿 + lint 0 错；executor-desktop 五条基线全绿（53 组自测/11 e2e/UI 审计 0 issues/视觉审计）。

方法论沉淀：真机 DOM 级验证 > 截图；修复批次须等占用同文件/同端口的前批完成；e2e 前必须完整重建（旧 dist 假象已两次实证）；契约变更走 swagger:export+gen:api-types 再生成；scheduler 类「模块加载期捕获」的库必须在零 import 的 setupFiles[0] 包裹。
