# 审批单跨实例恢复 e2e — 独立验收审查报告

- 审查 agent：`verify-crossinstance`。全程只读 impl 产出与源码；仅新增本报告文件，未触碰任何源码、既有 test、scripts/package.json、docs 主文档。
- 报告位置：`apps/admin-api/test/release-cross-instance.review.md`。选择理由：与被测 spec 同目录，审查项可直接对照行号；不占用 `docs/` 主文档区。
- 审查对象：`apps/admin-api/test/release-cross-instance.e2e-spec.ts`（378 行）。
- 契约：两个真 `createTestApp()` Nest 实例（appA/appB）共享 PG/Redis；appA `requestRelease` + `decide(granted)`；appB `releaseByApprovalKey`（其进程内 Map 必空）；断言真库副作用；篡改 `session.contextJson.cardHash` 反证零副作用；随机 uuid 隔离 + `afterAll` 精确清理。

## 对照基线（CodeGraph 探查原文行号）

- `apps/admin-api/test/helpers/app.helper.ts:12-38`：`createTestApp()` 每次都 `Test.createTestingModule(...).compile()` + `createNestApplication()` + `app.init()`；两次调用得到两个独立 Nest 应用容器。
- `apps/admin-api/test/release-restart-recovery.e2e-spec.ts:58-61`：单实例清 Map 模拟重启的反模式；跨实例 spec 未采用。
- `apps/admin-api/src/modules/workbench/release-approval.service.ts:224-227`：两个实例各自持有独立 `sessionByRequestKey` / `argsByApprovalKey`。
- `apps/admin-api/src/modules/workbench/release-approval.service.ts:307`：`requestRelease` 只把锚点写入**当前实例**的 `argsByApprovalKey`。
- `apps/admin-api/src/modules/workbench/release-approval.service.ts:355-367`：快路径命中即直接 `releaseIfApproved`，**不调用** `approvals.findByKey`。
- `apps/admin-api/src/modules/workbench/release-approval.service.ts:369-400`：未命中走审批单 + 会话 context 持久化恢复，逐字 `argsDigest` 对账后才发布。
- `apps/admin-api/src/modules/agent/entities/agent-approval.entity.ts:184-197`：`consumedAt` 是「副作用真的执行过」的独立事实列。

## 四项逐条结论

### 1. 真实性审查 — 通过

| 判据 | 结论 | 证据 file:line |
|---|---|---|
| `createTestApp()` 调用两次，分别赋给 appA/appB | 通过 | `release-cross-instance.e2e-spec.ts:187-188` |
| 两个实例的服务与 DataSource 是不同对象 | 通过 | `:211-213`（`releaseA !== releaseB`、`approvalsA !== approvalsB`、`dbA !== dbB`） |
| 两实例连同一物理库 | 通过 | `:216-218`（`current_database()` 相等）；`:138-141`（A 写入的 draft 对 B 可见） |
| appA 建单 + 批准，appB 完成发布 | 通过 | `:149-155`（`releaseA.requestRelease`）、`:293-294`（`approvalsA.decide(..., "granted", ...)`）、`:299`（`releaseB.releaseByApprovalKey`） |
| appB 快路径无该 key，且有显式断言 | 通过 | `:72-73`（`cachedKeyIn` 只读观察）、`:160-161`、`:277-278`、`:330-331` 三处 `expect(cachedKeyIn(releaseB, key)).toBe(false)`；同时 `:160`/`:277`/`:330` 断言 A 侧为 true |
| 无 mock / 无替身 / 无绕过恢复路径 | 通过 | 全文件仅 `:297` 与 `:354` 两处 `jest.spyOn(approvalsB, "findByKey")`；无 `mockImplementation`/`mockReturnValue`/`overrideProvider`/`page.route`/`nock`/`clearProcessMaps`（grep 仅命中注释 `:37` 与这两处 spy）。spy 只读透传原方法、保持原语义，均在 `finally` 中 `mockRestore`（`:304-306`、`:360-362`），返回值由真实实现产生 |
| test/e2e 库守卫 | 通过 | `:179-184` |

### 2. 副作用断言审查 — 通过

| 判据 | 结论 | 证据 file:line |
|---|---|---|
| 真库版本行恰 1 条且署名/内容哈希同源 | 通过 | `:309-314`（`versionRows(dbB, sopId)` → `toHaveLength(1)`、`publishedBy: "agent:tool-call"`、`contentHash`） |
| 真库审批单 `consumed` + `consumedAt` 非空 | 通过 | `:315-317`；前置 `argsDigest` 与申请一致见 `:288-290` |
| 真库 `sops.status=published` 且 `currentVersion` 同源 | 通过 | `:318-324` |
| `{published:true}` 不单独作结论 | 通过 | `:300` 仅为附加断言，结论由 `:309-324` 的真库读支撑 |
| 持久化恢复路径被真实执行 | 通过 | `:297`、`:302-303`：`approvalsB.findByKey` 被调用 1 次；结合快路径源码 `:355-367`，证明 B 未走内存快路径 |
| 篡改反证：零副作用 | 通过 | `:335-348`（经 B 的 DataSource 真库改 `cardHash`，摘要不等）；`:350`（调用前 0 行）、`:357`（`published:false/dependency_unavailable`）、`:359`（B 仍读库）、`:365`（调用后 0 行）、`:366-368`（仍 `granted`、`consumedAt` null）、`:369-375`（仍 draft、`currentVersion` null） |

### 3. 清理审查 — 通过（有一处边界缺陷，见「证据强度缺陷」）

| 判据 | 结论 | 证据 file:line |
|---|---|---|
| 随机前缀/uuid 隔离 | 通过 | `:41`（`e2e-crossinst`）、`:105-109`（`randomUUID()` 参与 runId/sopId/slug/cardHash/creatorName） |
| fixture 记账 | 通过 | `:68-69`、`:174` |
| `afterAll` 覆盖全部插入表 | 通过 | `:227-265`：`agent_approvals`（`:240-244` 按 key、`:246-250` 按 sessionId，含 `scope='session'` 派生行）、`agent_events`（`:251-255`）、`agent_sessions`（`:256-258`）、`sop_versions`（`:259-261`）、`sops`（`:262-264`） |
| 失败也清 | 基本通过 | `:228-236` 每步独立 try/catch（单步失败不阻断后续）；`:267-270` 两个 app 在 `finally` 中 close |

### 4. 变异反证 — 通过（断言足以捕获替换）

- 独立实测命令：`cd apps/admin-api && NODE_OPTIONS="--experimental-vm-modules --max-old-space-size=4096" DB_DATABASE=autoflow_test npx jest --config ./test/jest-e2e.json --runInBand test/release-cross-instance.e2e-spec.ts`
- 实测结果：**PASS**，1 suite / 2 tests 全绿；`PASS test/release-cross-instance.e2e-spec.ts (5.119 s)`，两项用例 74 ms / 22 ms；`Test Suites: 1 passed, 1 total`；`Tests: 2 passed, 2 total`；总耗时 5.33 s，命令退出状态成功。输出含既有 Jest 配置告警（`_comment-forceExit` 未知字段、ts-jest `globals` 弃用）与 `Force exiting Jest`（AppModule open handles），均为仓库既有配置/句柄现象，不影响断言结果。
- 只读反证分析：把 appB 换成 appA 后**不足以证明跨实例**，且会被 spec 当场判红，理由两条独立：
  1. `:149-155` + `release-approval.service.ts:307` 使 A 的 `argsByApprovalKey` 含该 key；若把 `:299` 的 `releaseB` 换成 `releaseA`，`release-approval.service.ts:355-367` 命中快路径，`:302-303` 期望 `approvalsB.findByKey` 被调用 1 次即失败；若连 spy 也随 B→A 替换，A 快路径同样不调用 `findByKey`，断言仍失败。
  2. `:160-161`/`:277-278`/`:330-331` 三处显式比对 A=true、B=false；若把 B 的引用整体替换成 A，期望 false 的断言立即失败。
  即：跨实例结论不是靠「接口返回 + 库副作用」蒙出来的，Map 空断言与 `findByKey` 观察形成双重闸门。

## 发现的证据强度缺陷

1. **fixture 入账时机偏晚（轻微，影响「失败也清」的严格性）**：`createFixtureInA` 在 `:123-136` 已 INSERT `sops` draft，`:149-155` 已建审批单/会话，但 `fixtures.push` 发生在 `:174`。若在这两步之后、入账之前抛错（如 `:120`/`:141`/`:156-161` 断言失败），该行不会被 `afterAll`（`:239`）遍历到，留下随机前缀的孤儿行。随机 uuid 隔离使后续运行互不污染，但库内会残留。建议把 `fixtures.push` 提前到 INSERT 后（本次审查只读）。
2. **「Map 必空」按 per-key 断言而非 `size === 0`**：`:72-73`、`:160-161` 判定的是目标 approvalKey 不在 B 的快路径 Map 中。对本用例这是正确的证据口径（B 从未见过该 key），但严格字面「Map 空」并非 `size` 断言。由于 `releaseByApprovalKey` 自身不会写入 `argsByApprovalKey`，当前套件下 B 的 Map 实际为空；不构成假绿。
3. **spy 的实现耦合**：`:297`/`:354` 依赖私有端口 `findByKey` 名称。这是只读观察、非 mock，且已在 `finally` 恢复；属于白盒证据，若未来重构恢复路径端口名需同步。

## 最高验收级别声明

最高为 **第 3 级「真实进程内集成」**：两个真 Nest `createTestApp()` 实例（独立 DI 容器、独立 Map、独立 DataSource 对象）+ 真 PG/Redis，验证持久化恢复与真库副作用；两实例**同进程**，非两个 OS 进程，也非真实浏览器/构建产物路径。按 AGENTS §4.4 **不越级**报为第 4 级；对外汇报须标注此边界。
