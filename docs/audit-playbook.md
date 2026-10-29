# AutoCodeFlow · 常态化审计/优化编排手册（可复用）

> 面向「不断循环推进」的全方位优化：每轮按本文跑一遍，产出**可验证的修复**而不是报告堆叠。
> 本文是**可复用编排**的事实源；轮次记录仍写 `docs/archive/reports/implementation-round-N-*.md`。
> 首次落地：2026-10-28（实施轮 #14 起）。

---

## 0. 硬纪律（每条都来自过去踩过的坑）

| 纪律 | 由来 |
|---|---|
| **auditor 只读，主控落地** | 子代理并行写同一工作区必然互相覆盖；且其"修好了"无法自动验证。审计交发现，修复由主控逐条复核后做。 |
| **每条发现必须有 file:line + 可复现判据** | 没有证据的"建议"一律丢弃（历史轮次里"报告很美、代码没动"的比例不低）。 |
| **主控必须亲自复核，禁止直接采信** | 轮 #11 实测：subagent 的 3 条 P1 中 1 条维度判定错到"绑错字段"，写测试才暴露。 |
| **修复必须带反证** | 新守卫/新断言要能"把修好的代码改回去 → 转红"。转不红 = 没有牙。 |
| **新增/修改守卫后跑它所在 job 的完整命令序列** | 轮 #29 教训：只跑自建守卫 → CI 同 job 的既有守卫当场红。 |
| **限时 + 分段交付** | 轮 #10 两次 50 分钟零产出；改成 25 分钟硬顶 + 先交结论。 |
| **认领前先复核任务前提** | 任务行写的"缺口"常已被前一版修掉或性质已变（N-02③ 从"缺口"变"能力扩张"）。 |
| **多会话仓库禁止 `git add -A`** | 轮 #15 实测：`git add -A` 把另一并发会话未完成的「推理质量轮」WIP（2 个新模块 + 运行时改写）卷进提交，而其配套改动（实体字段/预算解析/配置段）还没落盘 → **HEAD 变成不可编译**（`tsc` 5 错），只能再补一个 revert 提交撤回，并把那两个文件留回工作区。多会话共用工作区时一律 `git add <显式路径>`；提交前用干净 worktree（`git worktree add --detach`）验证 HEAD 自洽。 |

---

## 1. 每轮的标准动作（重复流水线）

```
① 基线体检（并行，5~10 min）
     npm run typecheck:all
     npm run test:guards            # 仓库守卫 + selftests 两组
     git status                     # 工作区必须干净或明确归属
② 选题（3 min）
     从上轮「遗留」清单 + 本轮审计发现里选，规则：
       · P0/P1 必做；P2 中「有真实用户后果」优先；
       · 同轮不超过 3 个修复主题（一个主题可含多条相关改动）——过散 = 每个都验不深。
③ 只读并发审计（workflow，4 路 × ≤25 min）
④ 主控复核（逐条：读源码 → 判真伪 → 判可修性）
⑤ 落地修复 + 反证测试
⑥ 受影响全量门禁（不是"只跑新测试"）
⑦ 提交（一主题一 commit，commit message 写清验证数字）+ 轮次报告
⑧ 更新遗留清单（本手册 §5 / 轮次报告 §遗留）
```

## 2. 审计分路（4 路，可按需替换）

| 路 | 范围 | 常见真缺陷形态 |
|---|---|---|
| A · Agent 运行时 | `apps/admin-api/src/modules/agent`、`apps/executor-desktop/src/main/agent` | 声明与实现不符（工具声明可审批但无批准面）、闸门在生产零调用、字段绑定维度错 |
| B · 安全/鉴权 | guards、条件写、SSRF、限流、凭据面 | 条件写缺唯一谓词、错误分流把 403 报成 404、限流键可被伪造头绕过 |
| C · 前端质量 | `apps/admin-web`（a11y/i18n/错误面/性能） | i18n 动态键、错误吞掉、竞态导致旧响应覆盖新选中、移动端布局塌陷 |
| D · 包与文档一致性 | `packages/*`、`docs/*`、guard 脚本自身 | 文档声称与实现不符、守卫扫不到自己的盲区（假绿）、跨包契约漂移 |

## 3. auditor 提示词模板（必须逐字包含以下要素）

```
仓库根：/home/yongsheng/project/AutoCodeFlow
先用 CodeGraph MCP 探查（projectPath 传上面绝对路径）；MCP 不可用则用
`codegraph explore "<符号>"` CLI。禁止先 grep/find。

你是**只读审计员**：不得修改任何文件。时限 25 分钟，到点立刻交付已确认部分。

范围：<路> 的 <具体目录/模块>
找出**真实缺陷**：必须是「会产生错误后果」的问题，不是风格偏好。
每条给出：
  - file:line（逐字核对过的行号）
  - 现状（贴 3~10 行真实源码）
  - 后果（谁在什么路径上被影响）
  - 修复方向（一句话；不要写代码）
  - 判据（如何证明修好了 / 如何反证）
排除：已登记在 docs/archive/reports/implementation-round-11-*.md §3 且已修复的项。
```

## 4. 复核清单（主控逐条过）

- [ ] 打开 file:line，源码与描述一致？（行号漂移极常见）
- [ ] 后果链是否真的可走通？有没有上游拦截使它不可达？
- [ ] 是否已被既有测试/守卫覆盖（那就不是缺陷，是文档问题）？
- [ ] 修复是否触碰共享契约（DTO/错误码/迁移/schema）？需要同批改哪些文件？
- [ ] 反证怎么写？（把修复改回去，哪条断言会红）

## 5. 滚动遗留清单

> 每轮从这里取，修完就删；新增的按同样格式追加。

| ID | 级别 | 内容 | 阻塞原因 |
|---|---|---|---|
| B1 | P2 | `dependency_install` 闸在生产零调用（`checkGate(..., 'dependency_install')` 仅 selftest 调用） | 需产品口径：试跑是否允许装依赖 |
| B2 | P2 | `AgentHostDeps.limits` 生产恒空（15 轮/2h/5 澄清/30 试跑不可配） | 需托管配置快照注入 + 热更新链路 |
| B3 | P2 | 执行器澄清上限与中台 SOP `maxRounds` 不协商 | 需把 poll 载荷 maxRounds 注入 loop limits |
| B4 | P2 | 预算只按轮判，轮内 N 个 toolCalls 串行无闸 | 改推理循环内层，回归面较大 |
| C1 | P2 | `deploy_application`/`deploy_app` 是 write 但无 `approvalRequired`（依赖 DEP-04 平台级审批） | 需先确认 DEP-04 默认开关 |
| C3 | P2 | 澄清回复归属校验在执行体而非闸门 | 需 sop 侧投影数据做 pre-resolve hook |
| E1 | **P1** | `AppDeploymentPage` 多处派生量（升级覆盖面 / 占用机集合 / 自定义 startCommand 告警 / 升级入口门 / 待审批计数）只按**当前页 20 行**算，而 `upgradeAll` 是后端全行执行 → 弹窗低报影响范围、第 21 台起的占用校验失效、翻到全 failed 页时「升级所有」按钮消失 | 需先有「本应用覆盖统计」的数据面（后端聚合端点或前端全量拉取），四处派生量必须同源 |
| SEC-1 | P2 | 产物上传面缺「共享令牌 ≠ 行身份」收口：`verifyUploadAuth` 先试共享令牌、命中即放行（`artifacts.service.ts:278-284`），任一执行器可向任意 execId 的产物目录写入或灌满上限，导致他人执行产物被替换 / 后续上传静默失败；同体系的 execution-callback 已明令「共享令牌不得跨执行器确认」（`execution-callback.controller.ts:126-133`） | 共享令牌**不携带执行器身份**：要补行归属必须改用 per-execution 票据或地址绑定，属破坏性变更（需升级路径 + 产品口径） |
| SEC-2 | P2 | 执行器 artifact 下载仍接受 `?token=` 查询串（`executor.controller.ts:1109-1150`，openapi 还把它文档化成推荐替代方式）：fleet 级凭据会进 nginx/ALB access log、shell history、`ps`；仓库自己在 SSE 面已因同一理由撤销了同类通道（`apps/admin-web/src/api/sse.ts:9-17`） | 需同步改 `scripts/install.sh`（改 `-H`）与已发布文档，并给存量部署升级说明；属破坏性变更 |
| API-05 | P3 | 13 条 AI 端点缺响应 schema（`check:response-schema:report` 缺口全在 AI tag 下），生成类型退化为 `content?: never`，admin-web 只能手写 `AiProviderAdminView`——后端改字段前端零编译期告警 | M 级工作量（逐端点补具名 DTO 并上探基线），收益在类型面而非运行时 |
| D-02b | P3 | Electron 权限闸门目前装在窗口创建路径（`openWizard`/`openStatus`，幂等）——行为等价但不够正统；更清晰的落点是 `app.whenReady` 里显式调用一次 `installSessionPermissionPolicy()` | `index.ts` 当时不在该 writer 的写域，需单独一行改动 |
| OPS-DX-04b | P3 | `docs/ARCH-28b-turbo-adoption.md` 仍称 turbo「以弱形态接入落地」，而根 `package.json` 没有任何 `turbo run` 调用（turbo 依赖也未安装）——配置是死配置，env 面本轮已修并加守卫 | 属历史报告口径，改它要连带 README / PLAN-CLAIMS 的表述，单独一轮 |
| G4 | P3 | `/api/config/reload` 在 400 之前已部分赋值（并发上限 / admin_api_url）→ 调用方以为整批未生效；pull 模式每 25s 重复同一半应用 | 先全量校验再统一赋值 |

> 记录口径：**修完就删行**，并在下面「已收口」留一行可追溯的结论（含提交号与反证方式），
> 否则下一轮会把同一件事再查一遍。

### 复核后判定「不是问题」（本仓实测，勿重跑）

- `ExecutionsPage` / `ExecutionDetailPage` 的「终止」按钮**已按执行态收敛**
  （`running|waiting|pending` 才渲染 Popconfirm），不是「恒可点」；审计提法来自
  未读源码的猜测，实测两处都有状态判据（含 KILL-WAITING 对 waiting 的补齐）。
- `ExecutorPackagesPage` 的轮询节拍**不会**随 `loading` 翻转重建（F-16 已用
  `pollGateRef` 镜像修掉）；本轮只是补了 silent/失焦，节拍本身无需再改。

### 已收口（滚动，最近在上）

- 2026-10-30 · 实施轮 #18 · **四个 P1「假成功/停服」**（详见
  [implementation-round-18](archive/reports/implementation-round-18-2026-10-30.md)）：
  ① agent 空 LLM 响应被当结论 → `succeeded`+空结论+静默（`fix(agent)` 31f15a43）；
  ② daemon 升级失败只回滚软链不重启旧进程 → 客户应用停服（`fix(executor-node)`
  c5d83f8e）；③ python 停机取消不落终态载荷 → 执行停在 RUNNING 到 stale sweep
  （`fix(executor-python,registry-pypi)` 30e8cd7a）；④ 桌面更新取消归因挂错事件 →
  下一次真实失败被静默吞掉（`fix(desktop)` afd822f3）。四者都补了「改回去会红」的用例。
- 2026-10-30 · 实施轮 #18 · **未知渲染成空 / 旧快照覆盖新状态**（同族第三、四例）：
  审批单读取失败显示「暂无审批单」（会让人以为没有待批）、通知铃失败显示「暂无失败」、
  执行器列表断流后旧 overlay 把轮询新状态覆盖成「在线」。`fix(web)` 13d34c9e。
- 2026-10-30 · 实施轮 #18 · **E3 换票 toast 轰炸 / E5 时间预设渲染期求值**（两条遗留
  销账）：换票请求加 `skipGlobalToast` + 页面级只提示一次；预设改为展开时重建锚点。
  反证：连续失败 3 次只弹 1 次；fake timers 下 t+5h 点预设必须查到 t+5h-1h 的窗口。
- 2026-10-30 · 实施轮 #18 · **本地入口三处假成功**：`start-dev.sh` 路径错一级（前端
  不启动却打印「启动完成」）、`Makefile:dev` 的裸 `@wait` 恒 exit 0、固定 `sleep 5`
  等 PG。`fix(tooling)` feb34ff9。
- 2026-10-30 · 实施轮 #18 · **审计外的三条预存在红**：CLI R108 覆盖闸（11 个新码未归类）、
  admin-web `tsc -b`（缺 vitest 全局类型 + 3 处夹具缺 `createdBy`，CI 的 admin-web-build
  同命令）、turbo `build:web.env` 缺 6 个 VITE_*（接上 turbo 后会命中旧缓存产出旧地址的包）。
- 2026-10-28 · 实施轮 #17 · **webhook 状态读取失败被当成「未启用」**：`catch(() =>
  setStatus(null))` 让「未知」与「未启用」同形，而后端对已启用任务再次 enable 会
  **轮换密钥** → 一次网络抖动变成一次误轮换。改为三态，未知态不渲染启用按钮。
- 2026-10-28 · 实施轮 #17 · **部署页 loading 被轮询抢序号**：`fetchAll` 与 3s 轮询共用
  `fetchSeq`，翻页请求的 finally 被判过期 → 表格永久转圈。loading 改用独立序号。

- 2026-10-28 · 实施轮 #17 · **MCP 写面拒绝脱敏哨兵回传**：读路径把敏感值写成
  `[redacted]`，agent「读-改-写」会把它当真实值写回 `params`（后端对 params 无掩码
  语义）或**覆盖** `secrets`（保留哨兵是 `******`，不是 `[redacted]`）。现在写前
  有界递归检查整个 body，命中即 `REDACTION_SENTINEL_IN_PAYLOAD` + 命中路径 + 下一步。
- 2026-10-28 · 实施轮 #17 · **executor-python 停机两条静默丢弃**：`flush()` 取消正在
  发网络的定时 flush（尾部日志分片随协程销毁、无 marker）；排水 `wait_for` 超时取消
  已出队的回调批次（不落盘，与「durability is the file」相反）。两处都在
  CancelledError 里先把数据放回缓冲/落盘，再抛。

- 2026-10-28 · 实施轮 #16 · **MCP 部署目标机被静默替换**：后端 `executorId` 查不到时
  只 warn 一句就改投最低负载的另一台；两个 deploy 工具现在比对请求/实际，补
  `executorReassigned` + 实际机器 id，并把 `executorId` 收窄为 uuid。

- 2026-10-28 · 实施轮 #16 · **MCP 写工具少声明的字段 = 永远传不进去**：MCP SDK 把
  shape 归一成 `z.object(shape)` 再 parse，zod 剥掉未声明键。补 9 个字段
  （`approvalRequired` / `mutexGroupId` / `runtimeVersion` / `retryDelay` /
  `retryableErrors` / `alarmChannels` / `codeSource` / `runbook` / `projectId`），
  并给 `update_application` / `update_task` 加空 patch 拒绝。测试**必须**走
  `z.object(shape).parse` 再进 handler，否则这类缺陷永远绿。
- 2026-10-28 · 实施轮 #16 · **CLI 把「待审批」当部署成功**（`status=pending` 时旧实现
  仍打印 `✔ Deployment triggered` + exit 0）+ `--wait-timeout 1m` 被 `parseInt`
  吞成 1 秒（长任务假超时）。
- 2026-10-28 · 实施轮 #16 · **executor-python 排水闸从未置位**：置位者在
  `if __name__ == '__main__'` 内，而镜像是 `uvicorn main:app`。改为 lifespan 里
  链式接管信号（先置位、再转发给 uvicorn 的处理器）。

- 2026-10-28 · 实施轮 #15 · `keyset` 翻页的 total 越翻越小：typeorm 的
  `executeCountQuery` 只清 orderBy/limit、**保留 WHERE**，两条 keyset 路径都在
  加游标之后取 total。改为「先 count 再游标」，并修掉两个「mock 比生产更正确」
  的测试桩（那正是缺陷活过一轮的原因）。反证：改回旧顺序 → 3 条用例红。
- 2026-10-28 · 实施轮 #15 · executor-python 心跳**谎报健康**：`retry_error_callback`
  返回 None 让 tenacity 耗尽重试后**不抛异常**，`record_heartbeat(True)` 于是在
  admin 不可达时执行。删掉回调 + 把循环体抽成可测的 `_heartbeat_once()`，
  新增「真路径」用例（改回旧写法即红）。同轮修掉 `_prepare_rlimit_pre_exec`
  里 try 之外的裸 `import resource`（win32 守卫是死代码）。
- 2026-10-28 · 实施轮 #15 · 审批单补 `consumedAt`（迁移 068）并纳入 retention
  （只删「已处置 + 会话终态 + 超 180 天」，pending 永不删）。

- 2026-10-28 · 实施轮 #14 · 审批闭环**执行侧**：确定性审批键、一次性消费
  （granted→consumed，副作用前领取）、闸门接受通行证但保留 scope/速率/硬禁用/
  策略闸、遇审批停轮、`rebuildMessages` 补 `tool` 应答、拒绝不自动恢复、
  `resume` 有 pending 即 409。守卫 `agent-boundary-check.mjs` 新增 4 条执行侧断言。
  报告：`docs/archive/reports/implementation-round-14-2026-10-28.md`。
- 2026-10-28 · 实施轮 #14 · 守卫自身的假绿：`check-interface-maps.mjs` 的
  `escapeRe` 替换串被写坏（含元字符的前缀永久假绿）+ 运行时自检；
  `check-guards-wired.mjs` 扫描面扩到 `apps/<pkg>/scripts`、`packages/<pkg>/scripts`。

## 6. 轮次记录模板

```markdown
# 实施轮 #N（YYYY-MM-DD）：<一句话主题>

## 1. 选题依据（上轮遗留 + 本轮审计）
## 2. 修复（每条：现状 → 修法 → 反证 → 验证数字）
## 3. 复核后判定「不是问题」的发现（附理由，防后人重跑）
## 4. 验证矩阵（套件/例数/守卫/真机）
## 5. 遗留（按优先级，回填本文 §5）
```
