# 实施轮 #16（2026-10-28）：让「调用了、成功了」不再等于「什么都没发生」

> 本轮把上一轮三路审计里三条 **P1** 收口：MCP 写工具静默丢字段、停机排水闸从未
> 置位，外加 CLI 两条「输出与事实相反」。共同点不是"功能缺失"，而是**失败被伪装
> 成成功**——这正是自动化系统里最难被人发现的一类。

## 1. 修了什么

### 1.1 MCP 写工具：少声明的字段 = 永远传不进去（F1）

MCP SDK 把工具注册的原始 shape 归一成 `z.object(shape)` 再 parse，zod 默认
**剥掉未声明的键**。于是缺字段不是"可选"，而是**永远进不了 handler**：

| 调用 | 实际发出 | 后果 |
|---|---|---|
`update_application{mutexGroupId}` | `PUT /applications/:id body={}` | 后端对空 patch 跳过写入 + 200 + 一条审计；而 `list_mutex_groups` 的描述逐字教用户这么用 |
`create_application{approvalRequired:true}` | `{name,version,runtime}` | 审批门落库为 false → 之后每次部署直接下发，第二人审批被静默取消 |
`update_task{projectId,alarmChannels,runbook,…}` | 只剩已声明的那几个 | PATCH 是本包唯一任务写入口，"挪项目/配告警/写 runbook"一件没发生；`projectId` 还决定归属与写权限 |

修法：补 9 个字段（约束逐个对齐后端 DTO：`runtimeVersion` 必须 `major.minor`、
`retryDelay` 0..86400、`retryableErrors`/`alarmChannels` 元素不得含逗号——
simple-array 以逗号 join 落库，含逗号读回会被劈成两条），并给
`update_application` / `update_task` 加**空 patch 拒绝**（`isError:true` +
`NO_UPDATABLE_FIELDS` + 可写字段清单），不再发那个必然空转的请求。

### 1.2 CLI：把「待审批」当部署成功（F2）/ `--wait-timeout 1m` 吞成 1 秒（F5）

- DEP-04 审批门打开时后端返回 `status=pending` + `approvalStatus=pending_approval`
  且**不下发**；旧实现照样 `✔ Deployment triggered` + exit 0，
  `acf app deploy && 验证部署` 把"冻结待审批"读成"已部署"，该行还占着 in-flight
  槽位使后续部署 409。现在明说 `NOT dispatched yet` + 指路 `acf approval`，
  并置 `exitCode=1`（"未完成"，与"参数错=2"区分）。
- `--wait-timeout` 用 `parseInt`：`1m` → 1 秒，用户本意 60 秒却立刻"假超时"，
  提示语还让人以为任务卡住。改为只接受纯数字（与同文件 `intOption` 同口径）。

### 1.3 executor-python：停机排水闸从未置位（G1）

`_shutting_down = True` 只出现在 `if __name__ == '__main__'` 的 signal 处理器里，
而生产镜像是 `CMD ["uvicorn","main:app",…]` —— 那段不执行；即便 `python main.py`，
uvicorn 的 `capture_signals()` 也会覆盖处理器。于是 `routers/execute.py` 首行的
503 排水闸恒为假：停机窗口内的在途领取仍被 200 接受，随后 30s 宽限到期被树杀推成
`failed/executor_restart`，而中台已收 200、不会改派。

修法：`install_signal_drain_gate()` 在 **lifespan 启动时**把 SIGTERM/SIGINT
**链式**接到 uvicorn 原处理器上——先置位（在途领取立刻 503），再调用 uvicorn 的
处理器把真正的优雅停机交还给它。`__main__` 里的重复注册删掉并留注释说明。

## 2. 反证（每条都实测改回旧行为会红）

| 修复 | 反证动作 | 结果 |
|---|---|---|
MCP `mutexGroupId` / `approvalRequired` | 从 shape 删掉 | 3 条用例红 |
MCP 空 patch 拒绝 | 删掉守卫 | 1 条红（重新发出 `body={}`） |
CLI 待审批分支 | 删掉 `awaitingApproval` 分支 | 待审批用例红（打印 triggered + exit 0） |
CLI `--wait-timeout` | 换回 `parseInt` | `1m` 用例红（被接受为 1 秒） |
executor 信号注册 | 删掉 lifespan 里的 `install_signal_drain_gate()` | 用例红 |
executor 链式转发 | 删掉 `previous(signum, frame)` | 用例红（uvicorn 停机被吞） |

## 3. 验证矩阵

- `packages/mcp-server`：**8 files / 316 tests**（新增 10 例，全部走
  `z.object(shape).parse` 再进 handler——直接把 args 塞 handler 会让这个缺陷永远绿）。
- `packages/acf-cli`：**12 files / 414 tests**（新增 4 例）。
- `apps/executor-python`：pytest 全绿，覆盖率 **87.47%**（门槛 86%，新增 3 例）。
- `packages/mcp-server` / `packages/acf-cli` `tsc --noEmit` 0 错。

### 1.4 MCP 部署目标机被静默替换（F4）

后端在 `executorId` 查不到时（stale id / 手抄错一位 / 行已删除）**只 warn 一句就
改投最低负载的另一台**，而工具把响应原样返回：调用方读到一个陌生 id，很容易当成
「正常自动选择」，实际代码已经装到别的机器上并启动。修法：`executorId` 收窄为
uuid（非 id 形态解析期即拒），并在 `deploy_application` / `deploy_app` 的响应里比对
请求与实际，不一致时补 `executorReassigned` / `requestedExecutorId` /
`actualExecutorId` + 说明。部署本身成功，故不置 `isError`，但这句话必须结构化可见。
反证：删掉比对块 → 对应用例红。

## 4. 仍开着的（下一轮）

- **E1（P1）** 部署页把「当前页 20 行」当全量：升级覆盖面低报、第 21 台起占用校验
  失效、翻到全 failed 页时「升级所有」按钮消失。
- **F3（P2）** 出参脱敏哨兵 `[redacted]` 与后端掩码 `******` 不一致 → 读-改-写会把
  `[redacted]` 当真实值写回 `params`。
- **G2/G3（P2）** 停机时丢日志分片、丢已出队的回调批次（与「durability is the file」
  注释相反）。
- **E2/E3/E4/E5、G4**：部署页 loading 卡死、SSE 换票失败 toast 风暴、webhook 状态
  误读为「未启用」（再启用会轮换密钥）、时间预设渲染期求值、config reload 部分生效。
