# 实施轮 #18（2026-10-30）：十域并行审计 + 八路并行修复

> 编排：主控 + 2 波只读审计（10 个域）+ 7 个修复 writer。全程只读审计、写域不重叠，
> 主控统一复核与提交（7 个提交）。本轮首次实测：**运行时活跃子代理上限是 8**（用户允许
> 10 路并发），首次 10 路 `parallel()` 直接以 `subagent limit reached` 失败——改用池化
> 调度（`pool(domains, 8, …)`）后跑通。审计输出单次返回体过大时会被截断（首波 10 域
> 只剩 6 域），后续改为分批。
>
> 承接：[实施轮 #17](implementation-round-17-2026-10-28.md)。基线：develop @ 759fdea6
> （本轮开始前把上一会话留下的 metrics 三文件审计修复先收口成独立提交）。

---

## 0. 结果概览

| 维度 | 数字 |
|---|---|
| 审计域 | 10（运行时/数据/API/执行器 Node/Python+PyPI/前端/桌面/包与 SDK/安全/运维 DX） |
| 经逐字核对的发现 | 35 条（P1 × 4、P2 × 21、P3 × 10） |
| 本轮落地 | **30 条**（P1 × 4 全落）+ 3 条审计外的预存在红 |
| 提交 | 7（每个一个主题，见 §2） |
| 测试增量 | admin-api +21 例、admin-web +16 例、executor-node +6 例、desktop +9 例、CLI +12 例、Python +10 例 |
| 全量验证 | admin-api 6808 例（1 条红来自并行会话在途文件，见 §4）、admin-web 2193 例全绿、CLI 424 例全绿、executor-python 1541 例全绿、registry-pypi 205 例全绿、desktop `test:main` 全绿、仓库守卫 `test:guards:repo` 全绿 |

---

## 1. 四条 P1（都是「假成功」或「停服」）

| ID | 位置 | 缺陷形态 | 修复 |
|---|---|---|---|
| RT-A1 | `agent-runtime.service.ts` 终态判定 | AiService 在路由不可用（未配置/disabled/missing_key/能力不符）时 `return emptyResponse()` 而不抛错；循环把「无 toolCalls」读成「给出结论」⇒ 会话 `succeeded` + `conclusion:""` + tokens 0。而 `succeeded` + 空 summary 恰好是**静默**路径（不通知）——「AI 没跑」与「巡检后判定无事」在数据面同形 | 空 content + 无 toolCalls 收敛为 `failed`，errorMessage 按 usage 区分「路由不可用」/「模型返回空响应」；有 toolCalls 的正常路径不受影响 |
| EN-01 | `executor-node/src/routes/deploy.ts` | daemon 升级顺序是「先杀旧进程 + unregisterDaemon」→「再下载/解压/装依赖」；catch 只回滚 current 软链，**不重启旧进程**，restart 能力已被摘掉 ⇒ 包 URL 5xx / sha 不符 / registry 不可达 / npm install 超时 → 客户应用停服，只能人工重部署 | 内存表 `startedAppSpecs` 记录「上次怎么跑起来的」（不落盘：env 含密钥）；catch 用**旧 deployDir** 重新 startApp，并把「已回滚并重启 / 未自动恢复（缺描述）/ 重启失败」写进 statusMessage |
| EXEC-CANCEL-1 | `executor-python/routers/execute.py` | 停机窗口里取消落在 `run_task` 或产物上传段时，payload 从未构造（`except Exception` 接不住 `CancelledError`）⇒ admin 停在 RUNNING 到 stale sweep，killed/executor_restart 分类丢失；而 `main.py:266-270` 注释正宣称载荷会落盘 | 两段各补 `except asyncio.CancelledError`：构造最小终态载荷 → `_persist_giving_up` → re-raise（枚举复用 killed/executor_restart） |
| D-01 | `executor-desktop/src/main/updater.ts` | 更新取消归因挂在**永不发生**的事件上：electron-updater 取消时 emit `update-cancelled`（AppUpdater.js:634），而 `error` 永不到达；`cancelRequested` 因此长期为 true，**下一次真实失败**被当成「用户取消」静默吞掉（不广播 updater:error、不 resetSurface、日志错怪用户） | `update-cancelled` 成为取消唯一消费点，`error` 改纯错误路径；`downloadUpdate` 的 finally 兜底复位 |

---

## 2. 七个提交（主题 / 关键改动 / 反证）

### 2.1 `fix(agent)`: 空响应假成功 / 过期审批单钉死 / denied 吃预算

- **RT-A2(P2)**：审批单 TTL 过期后 `approvalKey` 永久钉死——resume 后模型重提同参数
  （buildKey 确定性）命中同一 expired 行 → 会话再挂 `waiting_input`，而 `decide` 只认
  `pending` ⇒ grant/deny 恒 409，每点一次烧一轮真实 LLM。`request()` 命中 expired 时用
  条件写复位为 pending（刷新 createdAt、清处置痕迹）；denied/consumed/granted 不复活。
- **RT-A3(P2)**：`denied` 行（因等审批/墙钟到期未执行）也累加 `totalToolCalls`，而预算
  闸门读的正是它；同一文件的 `countPriorCalls` 却刻意排除 denied——两边口径互相矛盾，
  一批 3 个调用只执行 1 个也能扣 3 格配额。改为 denied 只留审计、不累加。
- 反证：新增 11 例（A1×4、A2×5、A3×2），**改写 2 条把 bug 钉成期望的旧断言**
  （「被拒/待审批同样计数」、「空 content 也 succeeded」）。`jest src/modules/agent`
  18 套件 393 例全绿。

### 2.2 `fix(acf-cli)`: 受理≠成功 / `--json` 错误行 / `--json` 判定

- **PKG-01(P2)**：`approve/reject/cancel`、`deploy upgrade/stop` 无条件 `succeed` + exit 0，
  而服务端 `pushDeployToExecutor(...).catch(logger.error)` 是 fire-and-forget。执行器离线时
  「人已签字」的成功横幅比实际状态更强。现在文案锚在回包状态（+ stop 的
  `[Stop not delivered]` 前缀），未确认下发 → warn + exit 1。
- **PKG-02(P3)**：`emitError` 先 `console.error` 再 `process.exit`，管道下 stderr 可能整行
  丢弃——`--json` 的机读契约退化成「只有退出码」。改为 `fs.writeSync(fd 2)` 同步写后再 exit
  （保留 exit 是刻意的：`tasks.ts` 的 `--wait` 轮询靠它同步终止）。
- **PKG-03(P3)**：`argv.includes('--json')` 让**参数值**为 `--json` 时翻转整个 CLI 的错误面；
  改为跳过 `--opt=value` 与取值型选项的值。
- **审计外**：`error-code-coverage`（R108 覆盖闸）在干净 HEAD 上就是红的——11 个新码
  （AI_SOP_* / AI_VIDEO_* / TASK_IDEMPOTENCY_*）未归类。4 个补规则、4 个按既有先例入基线
  并逐条写理由。CLI 424 例全绿。

### 2.3 `fix(executor-node)`: 升级停服 / 日志三处静默缺口 / 信号退出码

- **EN-02(P2)**：8MiB 写盘缓冲溢出时 slice 掉最旧字节且无标记（同文件另三处丢数据都有
  marker），`trackedLogSizes` 还按未截断字节累加 → 64MiB 标记提前触发。
- **EN-03(P2)**：`LogStreamPusher.flushNow` 先 splice 走整批，失败片只 `logger.debug` 就丢弃
  ——实时流出现无标记缺口（背压有 marker，网络失败没有）。改为失败片回填队首且停止本轮
  后续推送、跨 flush 计数、3 次后推 `PUSH_FAILURE_MARKER`。
- **EN-04(P2)**：`close` 丢弃 `signal`，`code ?? 1` 把 OOM 的 SIGKILL / SIGSEGV / SIGTERM 与
  「用户代码 return 1」压成同一句。新增 `describeProcessExit()`（exitCode=128+signo，SIGKILL
  提示 OOM）。
- 反证：deploy 新增 `deploy-upgrade-rollback.spec.ts`（下载 503 → startApp 第二次调用的 cwd
  等于旧 release）；日志两处改写了把旧行为钉成期望的用例。

### 2.4 `fix(desktop)`: 权限零闸门 / GUI probe 重复 / build metadata 停更

- **D-02(P2)**：`src/main` 全量检索 0 处 `setPermissionRequestHandler` / `CheckHandler`，
  渲染层被注入后可直接申请摄像头/麦克风/文件系统写入/通知/openExternal，与 README
  「渲染层是不可信显示层」的姿态相反。新增 `decidePermission()` 纯函数 +
  `installSessionPermissionPolicy()`（幂等，在窗口创建路径调用——`index.ts` 在模块顶层
  就 `new WindowManager()`，早于 ready，构造器里读 `session.defaultSession` 会抛）。
  默认全拒（渲染层真实消费面检索为 0），拒绝只记 origin（不记可能带票据的 query）。
- **D-03(P2)**：Windows GUI 每个动作前重复 probe（2× PowerShell 冷启动 + `Add-Type` 编译），
  且把 `interactive_desktop_unavailable` / `foreground_window_unavailable` 塌缩成
  `windows_gui_unavailable` ⇒ 锁屏/服务会话与「平台不支持」同码，agent-host 据此静默摘掉
  gui 能力。现在复用会话内成功探测（失败不缓存——锁屏可恢复），`classifyProbeError()`
  透传 native 码。**旧 selftest 把「每动作重探」钉成契约，已按缺陷重写并注明理由。**
- **D-04(P3)**：版本正则不接受 `1.9.5+build.N` ⇒ 解析 null ⇒「不新于本地」⇒ 全量设备静默
  停更（只一条 info）。

### 2.5 `fix(admin-api)`: 省略 apiKey 清空密钥 / SOP 会话越权 / 产物双轨半写 / 分页文档

- **AI-PROVIDER(P2)**：`(input.apiKey ?? "")` 让「只改 model」的 PUT 走进「显式清空」分支 ⇒
  密钥被写成空串、三个用途一起回落「未配置」，HTTP 200 且无提示。
- **AI-SOP-OWNERSHIP(P2)**：列表按 `createdBy` 隔离，而 detail / turns / turns/stream /
  saved 四个端点零归属校验——任一 ADMIN 拿到 uuid 即可读他人录屏转写与未发布草稿、往他人
  会话追加一轮（烧额度并改写对方草稿）。统一 `requireOwned()`，不匹配按「不存在」回报。
- **DL-1(P2)**：产物双轨清理分两个独立 try/catch，注释却宣称「双轨恒同宽」；磁盘已 `rm -rf`
  后单侧失败即长期停在「详情列产物、下载 404」。同一 chunk 两个写进同一事务。
- **DL-2(P3)**：IN 列表直接取目录名与 uuid 列比较——一个非 UUID 子目录让整 chunk（≤1000 行）
  每晚永久 22P02。按 UUID 形状过滤并输出差值日志。
- **API-DOC(P3)**：Swagger 分页示例写 `{items,total,page,limit}`，实现是
  `{list,items,total,page,pageSize,totalPages}`——照文档传 `limit` 直接 400。

### 2.6 `fix(executor-python,registry-pypi)`: 下载面零审计 / 爆破不可归因

- **REG-AUDIT-1(P2)**：下载面三条 404（非法包名 / meta 或非法制品名 / stat OSError）直接
  raise、零审计，只有成功才落 download 行——而 README 与注释都称「三面双落痕」。SIEM 因此
  看不到「持凭据者对他人包名的批量 404 探测」这一外泄前置动作。
- **REG-AUTH-1(P3)**：Basic 退避告警无 ip、无 action；现在「新进入退避」与「退避期命中 429」
  各落一条 `registry.pypi.auth`（绝不记口令）。刻意不逐次 401 审计（量由攻击者控制）。
- 反证：改写了把「404 不落审计」钉成期望的旧用例，理由写进注释。

### 2.7 `fix(web)`: 未知渲染成空 ×2 / 断流旧快照覆盖新状态 / 换票 toast / 预设漂移

- **W1(P2)**：审批单拉取失败被当成「暂无审批单」——运维据此判断「没有待批」，而会话卡在
  等审批。三态化（错误态计数「—」+ 重试）。
- **W2(P2)**：执行器列表的 SSE 覆盖层无 liveness 门，断流后每 30s 的轮询新数据被断流时刻的
  旧快照覆盖 status/lastHeartbeat（最长到 gcTime 5 分钟）→ 已离线节点显示在线。
- **W3(P2，遗留 E3)**：换票失败按退避节奏弹 toast（去重窗 1.5s < 退避 3s）——一次滚动发布
  就是分钟级轰炸。加 `skipGlobalToast` 通道 + 页面级「只提示一次」。
- **W4(P3，遗留 E5)**：时间预设渲染期求值，SSE live 挂机数小时后点「最近 1 小时」查的是
  几小时前的窗口。
- **W5(P3)**：通知铃把「读取失败」渲染成「暂无失败」且红点归 0。
- 附带：`sse.ts` 的 `fetchSseTicket` 内部改为携带 `skipGlobalToast` 并继续作为
  `createSseClient` 的默认换票入口——保持既有 `vi.mock('../api/sse')` 的测试口径（首版把
  默认实现搬进 sse-client，导致 3 个 SSE 用例全红，已回退到单一入口）。

### 2.8 `fix(tooling)`: 本地开发入口三处假成功 + turbo 缓存键

- **OPS-DX-01(P2)**：`start-dev.sh` 的 `cd ../../apps/admin-web` 相对仓库根多跳一级
  （上一条 `cd … &` 在子 shell 里）⇒ admin-web 恒不启动，脚本仍打印「启动完成 +
  http://localhost:5176」。修路径 + `kill -0` 存活校验。
- **OPS-DX-02(P2)**：`Makefile:dev` 的裸 `@wait` 在独立 recipe shell 里空转 ⇒
  `make dev` / `./dev.sh start` 恒 exit 0，四个服务全挂也不报；子进程还被孤儿化。改为
  同一 shell 内 `wait -n` 监督。
- **OPS-DX-03(P3)**：固定 `sleep 5` 等 Postgres（清卷后 initdb 3~8s）→ 迁移撞
  ECONNREFUSED。改 pg_isready 轮询（与 `deploy.sh:798` 同源）。
- **turbo**：`build:web.env` 只声明 `VITE_API_URL`（源码已无消费方），实际消费 6 个 VITE_*
  ——照文档接上 turbo 后改注册表地址会命中旧缓存，产出指向旧地址的前端包。补全 + 新增
  `turbo-env-contract` 用例（源码新增未声明 → 红；声明已无消费 → 红）。
- **审计外（预存在红）**：`tsc -b`（= `npm run build` 第一步、CI 的 admin-web-build 同命令）
  在干净 HEAD 上就红——`tsconfig.app.json` 只声明 `types: ["node"]`，任何新增测试文件触发
  全 program 重检时报 `Cannot find name 'describe'`；另有三处夹具缺 `AgentSession.createdBy`。
  补 `types: ["vitest/globals","node"]` + 夹具字段后通过。

---

## 3. 未落地（下轮 backlog，已写入 audit-playbook §5）

| ID | 级别 | 内容 | 阻塞原因 |
|---|---|---|---|
| SEC-1 | P2 | 产物上传面缺「共享令牌 ≠ 行身份」收口：共享令牌命中即放行，任一执行器可向任意 execId 的产物目录写入/灌满上限；同体系的 execution-callback 已明令禁止共享令牌跨执行器使用 | 共享令牌**不携带执行器身份**，要补行归属必须改用 per-execution 票据或地址绑定——破坏性变更，需产品口径与升级路径 |
| SEC-2 | P2 | 执行器 artifact 下载仍接受 `?token=` 查询串（fleet 级凭据进 access log），仓库自己在 SSE 面已因同一理由撤销同类通道 | 需要同步改 `scripts/install.sh` 与已发布文档，属破坏性变更 |
| API-05 | P3 | 13 条 AI 端点缺响应 schema（生成类型退化为 `content?: never`，前端只能手写类型） | M 级工作量，收益是类型面而非运行时 |
| D-02b | P3 | Electron 权限闸门目前装在窗口创建路径（幂等），更正统的落点是 `app.whenReady` 里显式调用一次 | `index.ts` 不在该 writer 的写域，需单独一行改动 |
| OPS-DX-04b | P3 | `docs/ARCH-28b` 仍称 turbo「已接入弱形态」，而根 scripts 无任何 `turbo run` 调用 | 属历史报告口径，改它要连带 README/PLAN-CLAIMS，单独一轮 |

---

## 4. 环境事实（重要，避免下轮误判）

本轮期间**同一个工作区还有另一个会话在改代码**（`apps/admin-api/src/modules/{audit,task}/*`、
`apps/executor-node/src/zip-safety.*`）。因此：

- 本轮 7 个提交全部用**显式路径** `git add`，未用 `git add -A`（`audit-playbook §0` 的纪律）。
- 全量 `admin-api` 有 1 条红（`tasks-keyset-pagination`：`order` 多出 `id: DESC`）与全量
  `executor-node` 有 1 条红（`zip-safety` 驱动器相对条目），**都来自那些在途文件**——
  用 `git worktree` 在干净 HEAD 上跑同一用例为绿/红对照已确认。
- 下轮开工前先 `git status`：若这些文件仍在途，不要把它们卷进提交。

---

## 5. 方法论增量（写给下一轮）

1. **并发上限是 8，不是 10**：`parallel()` 一次性起 10 个会在第 9 个直接抛
   `subagent limit reached` 并**整脚本失败**（已起的 8 个也随之作废）。用池化：
   `pool(items, 8, fn)`，每个 worker 循环取下一个。
2. **审计返回体会被截断**：10 域一次性返回时，落盘文本超 50KB 后只剩前 6 域。要么分批
   （≤6 域/批），要么让 agent 把报告写到 `/tmp` 再返回路径。
3. **「改回去会红」必须真的做**：本轮 4 位 writer 报告了变异验证（含一位用 `Module._load`
   直接驱动真实 updater、一位用 `jest.requireActual('child_process')` 取真实
   `(code, signal)`）。没有这一步的修复一律视为未验证。
4. **既有用例可能是 bug 的共谋**：本轮改写了 6 条把错误行为钉成期望的旧断言
   （denied 计数、空 content=succeeded、每动作 probe、失败后继续推片、404 不落审计、
   索引删除失败仍置空 jsonb）。改断言必须在注释里写清「旧断言钉的正是要修的形态」。
5. **跨会话共享工作区**：`git status` 里出现自己没碰过的文件时，先假定是另一会话在途，
   用 `git worktree add --detach` 在 HEAD 上做对照，再决定归属。
