# 控制面运行时性能与资源 审计（2026-10-29 · 第 3 轮）

## 1 范围与方法

**范围**：`apps/admin-api` 的运行时热路径——HTTP 请求链（回调、日志、指标）、`@Cron` 扫描器、
BullMQ worker、SSE 长连接、outbox 派发、连接池/缓存、进程日志与指标开销。
**不含** `apps/admin-api/src/modules/agent/**` 内部逻辑（并发 agent 的域），仅在其与主链交互处
（终态事件总线、SSE 转发）取证。

**探查路径（按 AGENTS.md 纪律）**：

1. `codegraph explore "Cron scheduled tasks in admin-api"` → 定位 8 个文件的 76 个相关符号；
   `codegraph explore "streamExecutionLogs polling loop"` → 拿到日志流轮询体逐字源码；
   `codegraph callers put` → 确认 `S3LogStorage.put` 唯一调用点。
2. CodeGraph 覆盖不到的部分（装饰器全量枚举、常量值、文档口径）用 `grep`/`read` 补齐：
   - `@Cron` 全量枚举（26 个方法，排除 spec/`__tests__`），并用一次性脚本 `/tmp/cronscan.mjs`
     对每个 cron 方法体做「有无 try/catch、有无 leader 门」的机械扫描（只读，不改仓库）。
   - 逐字读：`scheduler.service.ts`(1580-1760, 1818-1900)、`executor.service.ts`(6135-6280)、
     `outbox-dispatcher.service.ts`(60-530)、`metrics-stream.controller.ts`(全文)、
     `metrics.service.ts`(全文)、`executions-stream.controller.ts`(全文)、
     `execution-events-relay.service.ts`(120-230)、`task.service.ts`(4029-4260, 4700-4780,
     4900-4950, 5120-5160)、`s3-log-storage.ts`(40-140)、`prometheus-metrics.service.ts`(100-180,
     440-600, 649-705)、`main.ts`(360-420, 580-615)、`ip-ceiling.middleware.ts`、
     `executor-aware-throttler.guard.ts`、`http-metrics.interceptor.ts`、`domain-event-bus.service.ts`。
3. 去重面先读：`docs/AGENT-SWARM-PLAYBOOK.md` §7、`docs/CAPACITY-WHITEPAPER.md`、
   `docs/QA-05-capacity-boundaries.md`、`docs/ARCH-MULTI-INSTANCE-MATRIX.md`、
   `docs/archive/audits/audit-ledger-2026-10.md`、`docs/PLAN-CLAIMS.md`、`docs/AGENT_HANDOFF.md`。
   每条 finding 在 §4 末尾写明与既有条目的关系。

**已排除的「看起来像问题但其实已修好」**（避免噪音，列出以证明探过）：
- `scheduler.service.ts` 四个扫描 cron 已有 `guardTick`（顶层异常闸）+ R126-A1 重入闸；
- `detectLostExecutions` 之外的 retention 类 cron 均已 `cappedBatchedDelete`（轮数/墙钟双闸）；
- `HttpMetricsInterceptor` 的 route label 用路由模板而非原始 URL，且 SSE 被排除（基数有界）；
- `prometheus-metrics.service.ts` 的 `render()` 有 `renderInFlight` 串行化，抓取才重建 Registry（埋点零成本）；
- `ExecutorService` 的 bcrypt 正缓存（TTL 60s / 上限 1000 / 轮换即驱逐）与
  `ip-ceiling.middleware.ts`（`maxTrackedKeys` 20000 有界）均已有界；
- DB 池已有 `connectionTimeoutMillis: 5000` / `statement_timeout: 30000`（无限等待类缺陷不成立）。

## 2 未覆盖 / 未实测（如实写）

1. **无真机 profiling**：本轮为静态审计，未跑 `node --prof`/`--cpu-prof`、未跑压测、
   未跑 `EXPLAIN ANALYZE`。所有「毫秒/秒」量级均为**按代码常量 + 行数假设的估算**，
   每条都标了「未实测」及验证方式。
2. **`@nestjs/schedule` 未安装在本工作区**（`node_modules` 里无该包，`apps/admin-api/package.json:43`
   声明 `^12.0.2`），因此**无法逐字核对库侧是否 await 回调**。§4-⑤ 的结论建立在「仓库自身
   的既有结论」上（`scheduler.service.ts:1726-1760` 的注释 + `main.ts:591` 的 `unhandledRejection`
   处理），并给出可执行的反证方式；库侧行为标「未验证」。
3. **并发未测**：未验证 32/300 条 SSE 连接同时在线时 PG 池 waiting 的真实水位（白皮书只测了
   连接建立与保持，见 §4-④）；未验证 S3 append 背填在真实 40 万行日志上的时长。
4. **未审**：`apps/executor-*` 侧、`packages/*`；`notification` 渠道实现的出站重试节奏只看了
   监听器侧（digest 聚合已存在，未深挖）；`registry` 上传面（非高频）。

## 3 发现总表

| id | 优先级 | 一句话 | 落点 |
|---|---|---|---|
| rt-1 | P2 | 丢失执行清扫每 5min 无异常闸无重入闸，一次物化 2 万条含 `logs` 全实体 + 2 万次串行终态写 | `apps/admin-api/src/modules/executor/executor.service.ts:6135-6246` |
| rt-2 | P2 | S3 日志背填每页「读回整对象→拼全量→`gzipSync` 全量」，O(页数²) 且同步压缩在回调请求内 | `apps/admin-api/src/modules/task/task.service.ts:4728-4737`、`.../log-storage/s3-log-storage.ts:84` |
| rt-3 | P2 | 终态事件载荷带 ≤512KB `logs`，逐实例 Redis 广播 + 每条 SSE 连接各自再 `JSON.stringify`；唯一消费方只取首行 | `apps/admin-api/src/modules/task/task.service.ts:5155`、`.../metrics/executions-stream.controller.ts:112-115` |
| rt-4 | P2 | `/metrics/stream` 每条连接每 3s 各自重跑 7 个 SQL（含 2 条 30 天全窗口聚合）+ 一组 Redis 计数，无跨连接快照复用 | `apps/admin-api/src/modules/metrics/metrics-stream.controller.ts:130-178` |
| rt-5 | P2 | CRON-GUARD 只覆盖 scheduler 一个模块：5 处 cron 无顶层异常闸，一次 DB 抖动按 `main.ts` 语义 = 整实例退出 | `.../auth/auth.service.ts:656`、`.../audit/audit.service.ts:151`、`.../executor/executor.service.ts:6256`、`.../executor/executor.service.ts:6135`、`.../application/app-deployment.service.ts:2913` |
| rt-6 | P2 | outbox 恢复吞吐 5 行 / 5s（慢下游 5 行 / ~25s），与千级事件/分的入队面差 1~2 个数量级；且矩阵文档写 `OUTBOX_BATCH_SIZE = 1`（实为 5） | `.../event-subscriptions/outbox-dispatcher.service.ts:68,77,82`、`docs/ARCH-MULTI-INSTANCE-MATRIX.md:191` |
| rt-7 | P3 | 日志 SSE 每次轮询 `findOne` 整行执行记录（含 `logs` text），只为读 `status` | `apps/admin-api/src/modules/task/task.service.ts:4084` |
| rt-8 | P3 | `/executions/stream` 每条连接常驻 1s 定时器只为 30s 一次的空闲 ping | `apps/admin-api/src/modules/metrics/executions-stream.controller.ts:136-143` |

## 4 逐条证据

### rt-1 `detectLostExecutions`：无闸扫描器 + 2 万条全实体物化 + 串行写风暴（P2）

**现象**：`@Cron("0 */5 * * * *")` 的丢失执行清扫，方法体（106 行）**没有 try/catch**、
**没有重入闸**，分页用 `OFFSET`、`getMany()` 取全实体（含 `logs` 列），单轮上限 20 000 行，
随后**逐行** `transitionToTerminal` + `releaseExecutorSlot`。

**逐字代码**（`apps/admin-api/src/modules/executor/executor.service.ts`）：

```ts
6135:  @Cron("0 */5 * * * *")
6136:  async detectLostExecutions() {
6137:    // ARCH-31 §5: 多实例下仅 cron Leader 执行（下同，详见 LeaderGateService）
6138:    if (this.leaderGate && !this.leaderGate.isLeader) return;
```
```ts
6164:        .take(LOST_SWEEP_PAGE)
6165:        .skip(pageOffset)
6166:        .getMany();
6167:      lostExecs.push(...page);
```
```ts
6215:      const { rows } = await transitionToTerminal(this.execRepo, {
6216:        ids: [exec.id],
...
6235:      for (const row of rows) {
6236:        await this.releaseExecutorSlot(row.executorAddress);
```
分页常量与注释自相矛盾（注释说改成 keyset 双键，代码仍是 OFFSET）：
```ts
6152:    const LOST_SWEEP_PAGE = 1000;
6153:    const LOST_SWEEP_MAX = 20_000;
```

**触发路径**：`@nestjs/schedule` 每 5 分钟触发 → 取 `status=RUNNING AND startTime < now-5min`
的行（全机队离线/回调通道故障时这类行成批出现，正是该扫描器存在的场景）→ 循环 20 页
`getMany()` 把最多 20 000 条 `TaskExecution` 全列（含 `logs`，单条上限 512KB，见
`dto/execution-callback.dto.ts:159`）连同其 `taskRepo.findBy(In(20k taskIds))` 的**全列 `Task`
实体**（含 `params`/密文列）驻留内存 → 再对每行 2 次串行 UPDATE。

**影响与量级估计（未实测，给出算法）**：
- 内存：20 000 ×（`logs` 均值按 5KB 估）≈ 100MB；均值 50KB 则 ≈ 1GB，叠加同量级 `Task` 实体
  ⇒ 与「执行器大批掉线」这一事故场景同时发生的 OOM 尖峰。`docs/CAPACITY-WHITEPAPER.md:54`
  记录的正常水位 RSS 为 394MB，故 1GB 量级增量足以触发容器 OOMKill。
- 写放大：20 000 × 2 条串行 UPDATE ≈ 4 万次往返。按同机 PG ~0.3ms/语句估 ≈ 12s 纯等待，
  实测只会更差（每次 UPDATE 都带 RETURNING + 槽位释放）。
- 重入：若单轮 > 5min（上一条的量级下成立），下一拍 cron **与上一拍并发**，Double 计算 =
  内存 2×、写放大 2×。scheduler 的四个 tick 为此刻意加了 R126-A1 重入闸
  （`scheduler.service.ts:1740-1780` 注释），本方法没有。
- 异常：`transitionToTerminal` 或 `releaseExecutorSlot` 在循环中途抛错（死锁/语句超时/序列化
  失败，在池排队 280 的水位下是常态）→ cron 回调的 Promise reject → `main.ts:591`
  `process.on("unhandledRejection")` → `gracefulFatalShutdown()` → `exit(1)`。见 rt-5。

**最小修法**：
1. 用 scheduler 的 `guardTick` 同款模式包一层（或抽到 `common/utils/cron-guard.util.ts`
   供全仓复用，见 rt-5）：`try { … } catch (e) { logger.warn(...) }`。
2. 加重入闸（`private lostSweepRunning = false`），重叠轮直接 return。
3. 分页改 keyset（`startTime,id` 双键游标，与 `scheduler.service.ts` STALE_SWEEP 同款），
   并把 `LOST_SWEEP_MAX` 从 20 000 降到 2000，余量交下一拍（5min 后自收敛——谓词仍成立）。
4. `getMany()` 加 `select` 白名单（`id/taskId/executorAddress/startTime/status`）。注意
   `:6226-6228` 的 `patch.logs` 会拼接 `exec.logs`（把执行器原日志 + 一行系统注记写回
   `logs` 列）——两条路：(a) 只写系统注记那一行（**行为变更**：被判死的执行不再保留原日志，
   需产品确认）；(b) 保持行为不变，但把 `logs` 的读取从「2 万行批量」改成「对已通过
   `perExecThreshold` 过滤、真正要终态化的那批 id 定向补读一列」——后者才是纯优化，推荐 (b)。
5. `taskRepo.findBy(In(…))` 收窄 `select: { id, timeout }`（此处只用到 `t.timeout`）。

**可借鉴的 OSS 做法**：BullMQ 的 `worker.concurrency` + `limiter` 与「chunked sweeps」
（`bullmq` 的 `getJobs(start,end)` 游标推进）把长扫描切成有界批；Temporal 的 activity
heartbeat + `continueAsNew` 同样把无界历史扫描切段。核心纪律：**扫描器单轮的行数上限应由
「内存预算 × 单行大小」反推，而不是拍一个 20000**。

**与既有条目的关系**：`AGENT_HANDOFF.md:210` 记录同一方法的 NETOPT-1⑧/NETOPT-E P3-3 两次修补
（加 take、改分页），但**遗留未收口的正是**：OFFSET 未真正换成 keyset、无 `select` 收窄、
无重入闸、无异常闸。本条是那两次修补的**未完成面**，不是重复报告。

---

### rt-2 S3 日志背填：每页「读回整对象→拼接→`gzipSync` 全量」＝ O(P²) + 同步压缩（P2）

**现象**：多页日志回填对第 2 页起用 `append: true`，而 S3 驱动下 `append` 的实现是
**把已有对象整段读回（gunzip 到字符串）→ 拼上新页 → 整段 `gzipSync` → 覆盖写回**。
每页一次，页数上限 200。

**逐字代码**：

`apps/admin-api/src/modules/task/task.service.ts`
```ts
4728:        let content = lines.join("\n");
4729:        if (append) {
4732:          existing = await this.s3GetExistingLog(s3, executionId);   // 整对象读回
4734:            content = `${existing}\n${content}`;                     // 全量字符串拼接
4737:        const key = await s3.put(executionId, content);              // 整段 gzipSync
```
`apps/admin-api/src/modules/task/log-storage/s3-log-storage.ts`
```ts
81:  async put(executionId: string, content: string): Promise<string> {
84:    const body = gzipSync(Buffer.from(content, "utf-8"));   // ← 同步压缩，阻塞事件循环
```
调用方（每页一次，同一请求内）：
```ts
4922:      const MAX_PAGES = 200; // 400k-line backfill ceiling
4925:      for (let page = 0; page < MAX_PAGES; page++) {
4944:        await this.storeLogLines(execution.id, chunk, fromLine, {
4945:          append: page > 0,
```

**触发路径**：执行器回调带 `[… truncated]` 标记（`task.service.ts:224` 的
`LOG_TRUNCATION_MARKER`）→ `handleCallback` / `persistCallbackLogsIfMissing` → **同步 await**
`backfillFullLogsFromExecutor`（不是 fire-and-forget，回调 HTTP 连接在整个背填期间保持打开）
→ 200 页 ×（executor HTTP 取 2000 行 + S3 整对象读回 + 全量 `gzipSync` + 覆盖写）。
`LOG_STORAGE_DRIVER=s3` 的部署才会走这条路。

**影响与量级估计（未实测，给出算法）**：
- 数据量 O(P²)：第 p 页处理 p×2000 行。总处理行数 = 2000 × (200×201/2) = **4020 万行**；
  40 万行日志按 100 字节/行 = 40MB 终值，累计压缩量 ≈ 200 × 平均 20MB ≈ **4GB**。对比
  「一次性流式 gzip」的 40MB，即 **100 倍放大**（页数线性增长时是二次放大）。
- 事件循环阻塞：`gzipSync` 吞吐量级 50-100MB/s（未实测），压缩 40MB 文本 ≈ **0.4-0.8s
  单次同步阻塞**；这 0.4-0.8s 期间整个 admin-api 的所有请求（含回调面）停摆。200 次累计
  ≈ 数十秒的进程级停摆，摊在一次背填里。
- 峰值内存：`existing`(40MB) + `content` 拼接(80MB) + `Buffer.from`(80MB) + gzip 输出，
  单请求 ≈ 200MB 瞬时，两条并发背填即触容器内存线。`MAX_LOG_BYTES = 100MB`（
  `s3-log-storage.ts:21`）是唯一上限，即最坏单次 `gzipSync(100MB)` ≈ 1-2s 阻塞。
- 附带后果：回调请求被拖长 → 执行器侧 `AUTOFLOW` 回调重试 → 重试再触发一次背填（幂等但
  成本翻倍），与 `docs/operations.md` 的「回调重试」面叠加。

**最小修法**（按风险递增）：
1. **一行止血**：`gzipSync` → `await promisify(gzip)(buf)`（`node:zlib` 的异步版走线程池），
   把同步阻塞变成线程池占用。同步阻塞是这条链里唯一"一秒级卡死全进程"的因素。
2. 背填不再 append-in-place：改成**每页独立对象**（`execution-logs/<id>/part-<n>.log.gz`）
   或写临时分段对象，最后一次 `putObject` 只写 manifest；读面 `getStream` 按分段顺序流式拼接。
   彻底消除 O(P²) 与全量驻留。
3. 保守版（不动存储布局）：把 `MAX_PAGES` 从 200 降到 ~20（4 万行），超出部分显式标记
   「日志仅保留前 N 行」，并让 `storeLogLines` 的 append 用 `pipeline(readStream, gzip,
   uploadStream)` 直接落流（S3 SDK 支持流式 body），不做字符串拼接。

**可借鉴的 OSS 做法**：Loki/Vector 的 chunked log storage 一律「append 到新 chunk + 索引
manifest」，从不 rewrite 已落对象；AWS SDK v3 的 `Upload` 支持 `Readable` body（边压边传）。
`zlib.gzip` 的异步版本就是 Node 官方给「大 payload 不阻塞 loop」的推荐用法。

**与既有条目的关系**：`s3-log-storage.ts:96-110`（W-5）已记录**读面**深翻页 O(n×页数) 并明示
「已知限制」；`PLAN-CLAIMS.md:26`（BUG-06）修的是 append 的**正确性**（内容并集/指针收回）。
**写面的 O(P²) 成本与同步 gzip 从未登记**——本条是同一代码路径的新轴，不是重复。

---

### rt-3 终态事件载荷携带 ≤512KB `logs`：Redis 广播 + 每条 SSE 连接各自重新序列化（P2）

**现象**：`ExecutionTerminalEventPayload.logs` 直接放**回调原始日志**（DTO 上限 512 000 字符），
而这个载荷被（a）序列化后 PUBLISH 到 Redis、（b）每个 `/executions/stream` 连接各自
`JSON.stringify` 一遍写 socket。全仓唯一消费方只取**第一行**。

**逐字代码**：

载荷构造（`apps/admin-api/src/modules/task/task.service.ts:5146-5156`）：
```ts
5146:    const payload: ExecutionTerminalEventPayload = {
...
5154:      errorMessage: cb.errorMessage,
5155:      logs: cb.logs,            // ← 回调原始日志，DTO 上限 512_000 字符
5156:      aiAnalysis: execution.aiAnalysis ?? null,
```
上限来源（`apps/admin-api/src/modules/task/dto/execution-callback.dto.ts:159`）：
```ts
159:  @MaxLength(512_000)
160:  logs?: string;
```
跨实例广播（`apps/admin-api/src/common/services/execution-events-relay.service.ts:199-202`）：
```ts
199:      await this.publisher.publish(
200:        EXECUTION_EVENTS_RELAY_CHANNEL,
201:        JSON.stringify(envelope),
```
每条 SSE 连接各序列化一次（`apps/admin-api/src/modules/metrics/executions-stream.controller.ts:112-115`）：
```ts
112:      const sendEvent = (event: string, payload: unknown) => {
113:        write(`event: ${event}\n`);
114:        write(`data: ${JSON.stringify(payload)}\n\n`);
```
唯一消费方（`apps/admin-api/src/modules/notification/execution-events.listener.ts:88`）：
```ts
88:      (event.logs ? event.logs.split("\n")[0] : "") ||
```

**触发路径**：任一次执行终态（`handleCallback` winner 分支，见 `task.service.ts:5013` 与
`:5806`）→ `eventBus.emit` → ① relay 监听器 `JSON.stringify(512KB payload)` + Redis PUBLISH；
② `/executions/stream` 的每个 `forwarders` 监听器 `sendEvent` → 每连接一次
`JSON.stringify(512KB)` + 写 socket。1000 次终态/分（白皮书第 2 档 1321 任务/分）时，
`logs` 只占 10%、均值 100KB，即 100 次/分 × 100KB = 10MB/分 Redis，SSE 侧 × 连接数
（槽位默认 32，白皮书 §5 建议扩到 300）。

**影响与量级估计（未实测）**：
- CPU：`JSON.stringify` 处理 100KB 字符串 ≈ 0.1-0.3ms（未实测）。32 条连接 = 每次终态
  **串行** 3-10ms 事件循环占用；终态突发（一批 100 条回调）即 0.3-1s 同步积压，与
  rt-2 同类的「非 DB 的纯 CPU 阻塞」。
- 带宽/内存：单条终态帧 100KB × 32 订阅者 = 3.2MB/事件写向浏览器；对端
  `useMetricsStream` 系 hook 还要 parse。Redis 侧每事件每副本一份。
- `.split("\n")` 在 listner 里对 512KB 字符串切全量数组只为取 `[0]`，额外分配数万子串。

**最小修法**：
1. 在 `emitTerminalEvent` 里把 `logs` 换成派生字段 `logHead: string`（首行，硬切 500 字符，
   与 `errorSummary` 的 500 上限一致）：`payload.logHead = (cb.logs ?? "").slice(0, 500)`；
   `logs` 字段从 `ExecutionTerminalEventPayload` 删除。同步改
   `execution-events.listener.ts:88` 用 `event.logHead`（顺带干掉 `.split("\n")`）。
   注意 `viaRelay` 载荷、admin-web 消费方、既有单测断言三处要一起改。
2. 若要保留完整日志给未来消费方，走**一次性拉取**（`GET /tasks/:id/executions/:execId/logs`）
   而不是事件广播——事件总线只传「事实 + 句柄」。
3. 附带：relay 的 `JSON.stringify` 可移到 `publish` 之外的 `try` 里并加 payload 大小护栏
   （>8KB 时 warn，防回归）。

**可借鉴的 OSS 做法**：CloudEvents 规范明确要求事件体是「notifications, not data dumps」；
Kubernetes watch 的 `PartialObjectMetadata` 与 GitHub webhook 的「payload 摘要 + 详情链接」
都是同一纪律：**事件带 id，数据面另取**。

**与既有条目的关系**：未见于 playbook §7 / ledger / PLAN-CLAIMS。`executions-stream.controller.ts`
的头注说「载荷为 common 层 `ExecutionTerminalEventPayload`（全原始类型），JSON 序列化后直接
透传」——即该成本是**设计时未计入**的，不是回归。

---

### rt-4 `/metrics/stream`：每条连接每 3s 各自重跑 7 个 SQL（含 2 条 30 天聚合）+ Redis 计数（P2）

**现象**：SSE 快照按**连接**生成，没有任何跨连接复用/合并。白皮书 §5 给出的扩容公式
（`METRICS_STREAM_MAX_GLOBAL ≥ 300/实例数`）会把这条成本**线性放大**，而其推荐的首个调参项
恰好是与它抢同一个 DB 池的东西。

**逐字代码**（`apps/admin-api/src/modules/metrics/metrics-stream.controller.ts:155-177`）：
```ts
155:        while (!ac.signal.aborted) {
...
165:          const snap = await snapshot();          // ← 每连接每 3s 全量重算
...
176:          const wake = await this.waitCancellable(ac.signal, interval);   // interval 默认 3000
```
`snapshot()` 的三段（:130-146）分别落到：
```ts
130:        const [summary, executors, scheduler] = await Promise.all([
131:          this.metrics.getSummary().catch(...),
136:          this.metrics.getExecutorStats().catch(...),
141:          this.metrics.getSchedulerMetrics().catch(...),
```
`getSummary()` 的成本（`apps/admin-api/src/modules/metrics/metrics.service.ts:55-86`）：
```ts
55:    const [totalTasks, totalExecutors, onlineExecutors, todayRuns] =
56:      await Promise.all([ this.taskRepo.count(), ... ]);      // 4 个 COUNT
65:    const execStats = await this.execRepo.createQueryBuilder("e")
69:      .where("e.createdAt >= :windowStart", { windowStart })  // 30 天窗口
70:      .groupBy("e.status").getRawMany();                       // GROUP BY
81:    const avgDuration = await this.execRepo.createQueryBuilder("e")
83:      .select("AVG(e.duration)", "avg")                        // 第二个全窗口聚合
```
`getExecutorStats()` 是**无投影**的全表 `find()`（:141-143）——`Executor` 全列（含 `tokenHash`
等凭据列）物化后只取 8 个字段。
`getSchedulerMetrics()` 每次都打 Redis（`scheduler.service.ts:2447`
`this.queue.getJobCounts("waiting","active","delayed","failed","completed")`）。

**触发路径**：每个浏览器 Tab 打开 Dashboard → `useMetricsStream` 建一条 `/metrics/stream`
→ 服务端 while 循环每 3s 调 `snapshot()`。槽位 `MetricsStreamSlotService` 默认 32。

**影响与量级估计（未实测，给出算法）**：
- 每拍 7 条 SQL（`getSummary` 6 条 = 4×COUNT + GROUP BY + AVG，`getExecutorStats` 1 条），
  其中 2 条是 30 天窗口的全量聚合。
- 32 连接：32 × 7 ÷ 3s ≈ **75 SQL/s**；Redis 侧 `getJobCounts(5 个 state)` 每拍一次
  ⇒ 32 × 1 ÷ 3s ≈ **11 次调用/s（≈55 条 ZCARD/LLEN 命令/s）**。
- 30 天窗口行数：按 1 万执行/天 → 30 万行；`@Index(["createdAt"])` 只是非覆盖索引，
  GROUP BY 需回表取 `status`、AVG 需取 `duration` ⇒ 索引区间扫 + 大量堆取（或直接 seq scan）。
  单次按 **30-300ms** 估（未实测，验证方式：`EXPLAIN (ANALYZE, BUFFERS)` 跑 `getSummary` 的两条 SQL）。
  32 连接下即 **~0.6-6 核秒/秒** 的 DB 侧开销——单实例会直接吃掉整台 PG 的 CPU，
  而白皮书 §4 的实测 CPU 只有 7%，说明当时**没有并发 SSE 订阅叠加在这个面上**。
- 扩到白皮书建议的 300：600 SQL/s（含 200 条全窗口聚合）→ 必然复现白皮书自己观测到的
  `DB 池 waiting 280` 并把它放大一个数量级，而这次**不是业务流量造成的**，是监控自己造成的。
- 两处细节还会放大：`getExecutorStats()` 无 `select`（千台机队 × 全列 × 每 3s × 每连接）；
  `getSummary` 的 4 个 `count()` 中 `taskRepo.count()` 是全表 count（tasks 表无 retention）。

**最小修法**：
1. **单一快照泵**：进程内起一个 3s 的 `setInterval`（Leader 无关，每实例各自一份），
   算出 `snapshot` 后 `for (conn of connections) conn.write(...)`；连接只订阅、不取数。
   成本从 O(连接) 降到 O(1)。这是本条的**唯一必要修改**。
2. `getSummary` 的 `execStats` + `avgDuration` 两条 SQL 合并为一条
   （`AVG(duration) FILTER (WHERE status='success')` + `COUNT(*) GROUP BY status` 一次扫描）。
3. `getExecutorStats()` 加 `select` 白名单（8 列）。
4. 给快照泵加「本拍查询耗时」metric；当 `lastSnapshotMs > interval/2` 时退化为 2×interval 并 warn
   （现在没有任何机制发现「SSE 快照把 DB 打满」）。

**可借鉴的 OSS 做法**：Grafana 的 datasource `LiveChannel` 与 Prometheus 的 scrape 模型都是
「服务端单一轮询 → 扇出到 N 个订阅者」；`graphql-ws`/`subscriptions-transport-ws` 的
`withFilter` + 共享 source 同理。前端订阅数绝不进入后端取数次数。

**与既有条目的关系**：`docs/CAPACITY-WHITEPAPER.md` §3/§4 只测了 SSE **建连与保活**（500 条、
RSS +14MB），**未计入每连接的服务端取数成本**；`PLAN-CLAIMS.md:105`（UI-14）自述「复用既有三读面
零新 SQL」——即认为零成本，实为「零新 SQL 种类、N 倍执行次数」。本条是对白皮书容量结论的
**补充修正**（不推翻「瓶颈是 DB 连接池」的结论，恰恰是它的一个新成因）。

---

### rt-5 CRON-GUARD 只覆盖了 scheduler 一个模块（P2）

**现象**：`scheduler.service.ts:1726-1760` 用一整段注释论证「cron 回调不 await 返回的 Promise
⇒ 未捕获异常 = 未处理 rejection ⇒ 进程退出」，并为该文件的 4 个 `@Cron` 加 `guardTick`，
注释里写「**现在所有 cron 体都经本方法包裹**」——但那只在**本文件内**成立。全仓 26 个
`@Cron` 方法中仍有 5 个方法体无 try/catch（机械扫描结果，见 §1）：

**逐字代码**（四处代表）：

`apps/admin-api/src/modules/auth/auth.service.ts:656-674`
```ts
656:  @Cron(CronExpression.EVERY_DAY_AT_3AM)
657:  async cleanupExpiredTokens(): Promise<void> {
659:    if (this.leaderGate && !this.leaderGate.isLeader) return;
660:    await this.refreshTokenRepo.delete({ expiresAt: LessThan(new Date()) });
...
667:    await this.refreshTokenRepo.delete({ revoked: true, ... });
668:  }
```
`apps/admin-api/src/modules/audit/audit.service.ts:151-164`
```ts
151:  @Cron("0 5 2 * * *")
152:  async cleanupOldAuditLogs(): Promise<void> {
154:    if (this.leaderGate && !this.leaderGate.isLeader) return;
159:    const affected = await this.retentionDelete(oneEightyDaysAgo);
```
`apps/admin-api/src/modules/executor/executor.service.ts:6256-6280`
```ts
6256:  @Cron("0 0 2 * * *")
6257:  async cleanupOldRecords(): Promise<void> {
6258:    if (this.leaderGate && !this.leaderGate.isLeader) return;
6274:    const deleted = await this.cleanupOldTaskExecutions(cutoff);
```
对照物：**同一个类的下一个 cron 就有闸**
```ts
6398:  @Cron("0 15 3 * * *")
6399:  async cleanupMetricsHistory(): Promise<void> {
6402:    try {
6403:      const deleted = await this.cleanupExpiredMetricsHistory();
6404:      if (deleted > 0) { ... }
6406:    } catch (err) {
6407:      this.logger.error(`R-09: 执行器指标历史 retention 清理失败: ${...}`);
```
另两处：`executor.service.ts:6135`（每 5 分钟，见 rt-1）、
`application/app-deployment.service.ts:2913`（`@Cron("0 */2 * * * *")`，每 2 分钟）。

机械扫描的完整口径（26 个 `@Cron`）：无 try/catch 的共 **6** 处，其中
`modules/agent/trigger/agent-trigger.service.ts:424`（`sweepAggregator`，7 行）属并发 agent 的域，
本文只记「与本域交互」不展开；scheduler 的 4 处（`:790/:827/:1031/:1600`）方法体是
`await this.guardTick(...)` 一行，异常在 `guardTick` 内兜住，不计入缺口。

**触发路径**：cron 到点 → 方法体内某次 `await` 的 DB 操作 reject（连接池排队 + `statement_timeout
30s`、序列化冲突、PG 重启、failover）→ 无人 catch → `main.ts:591` 的
`process.on("unhandledRejection")` → `gracefulFatalShutdown(...)` → `app.close()` → `exit(1)`。
频率决定暴露面：`detectLostExecutions`(5min) 与 `detectStuckDeployments`(2min) 每天分别触发
288 / 720 次。

**影响与量级估计（未实测；库侧行为见 §2-②）**：一次瞬态 DB 错误 = 一次**全实例**优雅退出
（所有 API 一起 503、所有 SSE 断流、BullMQ worker 全部重连）。这与 `scheduler.service.ts:1733`
记的缺陷现场是同一形态（「一次短暂的数据库抖动就能把整个 admin-api 打挂」），只是发生在
另外 5 个模块。定级取与 CRON-GUARD 相同口径（P2）；若现场已发生过 5xx 风暴式重启，应按
P1 处理。

**最小修法**：把 `guardTick` 的语义提升为公共设施（`common/utils/cron-guard.util.ts`，
导出 `guardedCron(name, logger, body)`），5 处套上；并在守卫脚本里加一条**机械闸**：
`scripts/check-cron-guard.mjs` 扫描 `@Cron` 方法体，要求「有 try/catch 或调用 guardedCron」，
把它挂进 `test:guards:repo`（该仓已有 40+ 守卫脚本的先例，`scripts/check-metric-docs.mjs` 就是
同一手法）。这样以后新增 cron 不可能漏。

**可借鉴的 OSS 做法**：`@nestjs/schedule` 生态里通行的做法是**自己包一层**
`runGuarded(name, fn)`（因为库不 await 回调）；Python 的 APScheduler 提供
`misfire_grace_time` + `coalesce` 并在 `EVENT_JOB_ERROR` 里集中处理异常——即**框架级**统一闸，
而不是每个任务体各自 try。

**与既有条目的关系**：与 playbook/ledger 里的 **CRON-GUARD（2026-10-17 P2）同源**，
但那次只落了 scheduler 一个文件；本条是**覆盖不全**（5 个站点），并新增一条可维护的守卫脚本建议。
不重复报告 scheduler 内的四个 tick（已修）。

---

### rt-6 outbox 恢复吞吐与文档口径（P2，含 1 条 P3 文档漂移）

**现象**：outbox 扫描器 `OUTBOX_BATCH_SIZE = 5` / `OUTBOX_SCAN_INTERVAL_MS = 5000` /
`OUTBOX_PROCESS_CONCURRENCY = 3`，且上一轮未结束则整轮跳过（`scanning` 闸）。健康路径由
**快速路径**在进程内直接投递并 `markFastPathDelivered` 收口，扫描器只负责「宽限窗后仍未结清」
的恢复；但**一旦下游故障**，恢复速率就是上面这三个常量的乘积，与入队速率无关。
同时 `docs/ARCH-MULTI-INSTANCE-MATRIX.md:191` 仍写「批次固定 1 行（`OUTBOX_BATCH_SIZE = 1`）」。

**逐字代码**：

`apps/admin-api/src/modules/event-subscriptions/outbox-dispatcher.service.ts`
```ts
68: export const OUTBOX_SCAN_INTERVAL_MS = 5_000;
77: export const OUTBOX_BATCH_SIZE = 5;
82: export const OUTBOX_PROCESS_CONCURRENCY = 3;
```
```ts
281:  async scanOnce(): Promise<number> {
282:    if (this.scanning) return 0;      // ← 上一轮未结束则整轮丢弃
283:    this.scanning = true;
```
```ts
303:            ORDER BY "createdAt" ASC
304:            LIMIT $2
```
文档漂移（`docs/ARCH-MULTI-INSTANCE-MATRIX.md:191`）：
```
批次固定 1 行（`OUTBOX_BATCH_SIZE = 1`），避免批内行共享租约导致重复投递窗扩大。
```
而代码注释已**反向**论证过（`outbox-dispatcher.service.ts:71-76`）：「行数调大让积压不再按
『每 5s 一行』的速率消耗」。

**触发路径**：订阅方 webhook 挂起（TCP 建连但不应答）→ 快速路径每次投递吃满
`OUTBOUND_TIMEOUT_MS = 10_000`（`event-subscription.util.ts:35`）→ 行留未派发 + 指数退避
（封顶 5min）→ 扫描器每 5s claim 5 行、3 路并发，单行最坏
`OUTBOX_MAX_ROW_PROCESSING_MS = 15s`（= 10s 超时 + 5s）。

**影响与量级估计（未实测，纯常量推导）**：
- 正常恢复速率上限 = 5 行 / 5s = **1 行/s**（60 行/min）。
- 下游挂起时单轮耗时 ≈ ⌈5/3⌉ × 10s ≈ 20s > 5s 间隔 ⇒ 后续 3-4 拍被 `scanning` 丢弃 ⇒
  实际 **≈ 5 行 / 20s = 0.25 行/s**。
- 入队面：白皮书第 2 档 1321 任务/分 ⇒ 终态事件 ≥ 1321/min ≈ **22 行/s**（若配了订阅）。
  即恢复能力比入队面低 **1.5~2 个数量级**。一次 10 分钟的下游故障积压 ≈ 1.3 万行，
  按 0.25-1 行/s 需要 **3.6-14 小时**才排空；期间 `docs/CAPACITY-WHITEPAPER.md:124` 那条
  「outbox 未投递行数持续增长」告警会一直响，却**没有对应的「恢复中，速率 X」信号**。
- 内存/表膨胀：未派发行由每日 retention 兜（`dispatchedAt < now-30d`），不涉及删除未派发行
  ⇒ 积压期间表只增。

**最小修法**：
1. 让恢复吞吐与「队列深度」挂钩：`batchSize = clamp(backlogDepth / 100, 5, 100)`
   （深度用一次 `COUNT(*) WHERE dispatchedAt IS NULL` 的 5s 节流缓存值），并发上限同步提到
   `min(batchSize, 10)`；租约窗口已由 `OUTBOX_LEASE_MS=60s` 与单行 15s 上界保证安全，
   `OUTBOX_MAX_ROW_PROCESSING_MS` 的构造期断言会自动拦住不匹配的配置。
2. 暴露 `autoflow_outbox_undispatched_total`（gauge）与 `autoflow_outbox_drain_rate_per_s`，
   让「积压 × 恢复速率」可算出 ETA（现在只有 `docs/CAPACITY-WHITEPAPER.md:124` 的人工观察）。
3. 改 `ARCH-MULTI-INSTANCE-MATRIX.md:191` 为「批次 5 行 / 3 路并发，租约 60s > 单行最坏 15s
   ⇒ 批内共享租约的重复投递窗为零」，并把「为什么从 1 调到 5」的取舍写进去。

**可借鉴的 OSS 做法**：Sidekiq 的 `concurrency` + 动态 `fetch` 批量、Debezium/Outbox 模式的
`pollIntervalMs` + `maxBatchSize` 都允许**按积压自适应批量**；AWS SQS 消费者的
`MaxNumberOfMessages` 与 `WaitTimeSeconds` 组合也是同一手法（低延迟靠长轮询而非短间隔）。

**与既有条目的关系**：`ARCH-MULTI-INSTANCE-MATRIX.md` §3.6 已记录 claim/租约/快速路径收口
（正确性面）并**声称**批次=1；本条报的是（a）**吞吐与入队面不匹配**（从未登记），
（b）**文档与代码不一致**（`OUTBOX_BATCH_SIZE` 1→5 未同步文档，P3）。不重复正确性结论。

---

### rt-7 日志 SSE 每次轮询 `findOne` 整行执行记录（P3）

**现象**：日志流轮询体每拍都 `findOne` 取**整行** `task_executions`（含 `logs` text 列），
只为读 `status`；`logs` 列在 S3/DB 两条路径下都可能很大（回调上限 512KB）。

**逐字代码**（`apps/admin-api/src/modules/task/task.service.ts:4082-4085`）：
```ts
4082:    const flush = async (): Promise<boolean> => {
4083:      // Returns true when execution is terminal and no more lines pending
4084:      const exec = await this.execRepo.findOne({ where: { id: execId } });
4085:      if (!exec) return true;
```
轮询节奏（同文件 :4045、:4053-4054、:4160）：
```ts
4045:    const POLL_INTERVAL = 1000; // ms
4053:    const IDLE_BACKOFF_THRESHOLD = 3;
4054:    const IDLE_BACKOFF_MAX_INTERVAL = 5000;
```

**触发路径**：任意一条 `GET /tasks/:id/executions/:execId/logs/stream`（每个打开日志面板的
Tab 一条，槽位上限 64）→ while 循环 → 每 1s（空闲退避到 5s）一次 `findOne`。

**影响与量级估计（未实测）**：64 条流 × 1/5s~1/1s = **13-64 次 findOne/s**；每次若 `logs` 列为
100KB，则 1.3-6.4 MB/s 的**纯浪费**的出库流量 + 64 份 100KB 对象瞬时驻留。R-24 退避已把
空转 QPS 从 128 降到 ~13（注释自述），但**没有把列宽降下来**。相比 rt-4，这条不会引发
容量事故，属「明确的浪费 + 可省的内存」，定 P3。

**最小修法**：`findOne({ where: { id: execId }, select: { id, status, taskId, logStorage,
logObjectKey, timeout } })`——`flush()` 实际只用到 `status/taskId/logStorage/logObjectKey`，
`logs` 与 `result`/`params` 全列都不需要。（`maybeNotifyTimeoutWarning` 用的是 task 行，不受影响。）

**可借鉴的 OSS 做法**：Prisma/TypeORM 的 `select` 投影纪律；Kubernetes 的 watch 用
`PartialObjectMetadata` 只传元数据同理。

**与既有条目的关系**：`PLAN-CLAIMS.md:255`（NETOPT-1⑦）修的是这条循环的**监听器泄漏**，
不是列宽；未重复。

---

### rt-8 `/executions/stream` 每条连接常驻 1s 定时器（P3）

**现象**：空闲 ping 周期默认 30s，但实现是**每 1s 醒一次**判断是否该 ping，而不是把定时器
设成 30s、每次有帧时重置。

**逐字代码**（`apps/admin-api/src/modules/metrics/executions-stream.controller.ts:136-143`）：
```ts
136:        while (!ac.signal.aborted) {
137:          const wake = await this.waitCancellable(ac.signal, 1_000);
138:          if (wake) break;
139:          if (Date.now() - lastFrameAt >= this.idlePingMs) {
140:            ping();
141:            lastFrameAt = Date.now();
```
（`idlePingMs` 默认 30_000，见同文件 :71。）

**触发路径**：每条 `/executions/stream` 连接 → 每秒一次 `new Promise` + `setTimeout` +
`addEventListener("abort")` / `removeEventListener` 的成对分配。

**影响与量级估计（未实测）**：按白皮书实测的 500 条 SSE（其中约半数为 `/executions/stream`）
计，250 条 × 1/s = **250 次 timer 回调/s**，每次含 1 Promise + 1 listener 分配
（~2-5µs）⇒ 约 0.5-1.3 ms/s ≈ **0.05-0.13% CPU** + 250 个短命 Promise/秒的 GC 压力。
**量级很小，不构成容量问题**；记录它是因为（a）改成「30s 单定时器 + 收帧时 `clearTimeout`/
重设」是 10 行以内的等价改法，(b) 同仓的 `streamExecutionLogs` 已经用了「有数据即重置基线」
的自适应模式（`task.service.ts:4049-4056`），两处口径不一致会被后来者当成模板抄走。
定 P3。

**最小修法**：把循环改成事件驱动：`idleTimer = setTimeout(ping, idlePingMs)`，
`forwarder` 里 `clearTimeout(idleTimer); idleTimer = setTimeout(ping, idlePingMs)`；
连接关闭时 `clearTimeout`。主循环消失，`waitCancellable` 只用于 `abort` 等待。

**可借鉴的 OSS 做法**：Node 官方 SSE 示例与 `graphql-sse` 的 keep-alive 都是「单定时器 +
每帧重置」（`res.flushHeaders()` 后 `const hb = setInterval` 在 `close` 里 `clearInterval`）。

**与既有条目的关系**：未见于 playbook §7 / ledger。`executions-stream.controller.ts` 的头注自述
「保活：1s 粒度扫描 idle ping」——是刻意的实现选择，非回归；这里只建议换成等价但更省的模式。

## 5 建议实施顺序（收益 ÷ 风险）

排序原则：先做「收益确定、改动局部、可单测反证」的，再做「需要改契约/改存储布局」的。
每条都给出**反证方式**（还原产品代码后应转红的用例），因为本轮 §2 已声明无真机 profiling。

| 序 | id | 为什么排这里 | 改动面 | 反证方式 | 预估 |
|---|---|---|---|---|---|
| 1 | rt-5 | 收益最高（一次抖动 = 整实例退出），风险最低（纯包裹 + 一条守卫脚本） | 5 个文件各包一层 + 新 `check-cron-guard.mjs` | 新守卫脚本在还原后应报出 5 处；单测：mock repo 抛错，断言 cron 方法 resolve 且 logger.warn 被调 | 0.5 天 |
| 2 | rt-3 | 一处改动消掉两处放大（Redis + 逐连接序列化），且消费方只需首行 | `domain-events.ts` + `task.service.ts:5155` + listener:88 + web 消费方 + 相关断言 | 单测：`cb.logs` 给 512KB，断言 emit 的 payload 无 `logs` 且 `logHead.length ≤ 500`；relay 单测断言 publish 的 JSON 长度上界 | 0.5-1 天 |
| 3 | rt-4 | 直接决定「监控会不会把 DB 打死」，白皮书已推荐扩到 300 槽，不修则扩容即事故 | `metrics-stream.controller.ts` 改成进程级快照泵 + 订阅者表；`getSummary` 两条 SQL 合一 | 单测：2 条连接在线，断言 `metrics.getSummary` 只被调 1 次/拍；还原后调 2 次 | 1-1.5 天 |
| 4 | rt-2 | 唯一「秒级卡死全进程」的同步 CPU；但需动 S3 写面 | `gzipSync`→异步（第一步）+ append 改分段对象（第二步） | 第一步：单测断言 `zlib` 异步 API 被调用（jest.spyOn）；第二步：storeLogLines 单测断言 put 调用次数 = 页数 且每次 body ≤ 单页 | 0.5 天（第一步）/ 2 天（第二步） |
| 5 | rt-1 | 事故场景（大批掉线）下才触发，但触发时是 OOM + 重启 | `executor.service.ts` 6135-6246 | 单测：构造 3000 条 RUNNING 超期行，断言 `find` 的 `select` 不含 `logs`、分页用 keyset（断言 `skip` 未被调用）、重入闸第二次调用直接 return | 1 天 |
| 6 | rt-6 | 真问题但在故障路径；改批量需要压测佐证（本轮无数据） | `outbox-dispatcher.service.ts` 常量 + 自适应批量 + 新 gauge | 单测：积压 1000 行时断言 claim 的 LIMIT 参数 > 5；文档守卫可复用 doc-guard 手法 | 1 天（含文档同步） |
| 7 | rt-7 | 一行 `select`，纯赚 | `task.service.ts:4084` | 单测：断言 `findOne` 的 `select` 键集不含 `logs` | 0.2 天 |
| 8 | rt-8 | 收益小，但顺手统一两处 SSE 的保活口径 | `executions-stream.controller.ts:136-143` | 单测：连接 5s 内不 ping、断言只有 1 个活跃 timer（`jest.getTimerCount()`） | 0.3 天 |

**建议同批处理的「验证债」**（不属于 finding，但修复时必须补，否则无法证明收益）：
1. 用 `EXPLAIN (ANALYZE, BUFFERS)` 固化 `getSummary` 两条 SQL 在 30 万行上的真实耗时（rt-4 的量级依据）；
2. 压测脚本加一个「N 条 `/metrics/stream` 在线 + DB 池 waiting」档（现在 `scripts/load-test-stack.sh`
   的 sse 场景只测建连/保活，不测服务端取数成本）；
3. `scripts/micro-benchmark.mjs` 已有 `storeLogLines 万行` 场景——把 S3 append 路径也纳入，
   这样 rt-2 的 O(P²) 就有回归闸（现在该场景只覆盖 DB 路径）。
