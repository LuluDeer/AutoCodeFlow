# D-18：全仓乐观锁假设为假 —— 复现、订正与根治

> **owner**：verify-reconcile · **等级**：P1（唯一剩下的正确性缺陷）
> **测量/施工窗口**：2026-11-03 10:03 → 10:2x（Asia/Shanghai）· **HEAD**：`746e35f6`
> **结论**：假设**已独立复现为假**；注释已订正为事实；`stop()` 已改为显式条件 UPDATE；
> 剩余 3 个调用点登记待改（§4）。**本条尚未整体闭环。**

---

## §1 独立复现

### 1.1 结构证据（**必然性**，不依赖运行环境）

| # | 命题 | 我的复现命令与结果 |
|---|---|---|
| ① | `save()` 的执行体 `SubjectExecutor` **零处**把 `versionColumn` 用于 WHERE | `grep -n "versionColumn" node_modules/typeorm/persistence/SubjectExecutor.js` → **无输出（0 命中）** |
| ② | `UpdateQueryBuilder` 对版本列**只自增**，不拼接版本谓词 | `sed -n '430,445p' node_modules/typeorm/query-builder/UpdateQueryBuilder.js` → 仅见 `" = " + escape(versionColumn.databaseName) + " + 1"` |
| ③ | `OptimisticLockVersionMismatchError` 唯一抛出点在 `SelectQueryBuilder`，且被 `lockMode === "optimistic"` 守护 | `grep -rn "new OptimisticLockVersionMismatchError" node_modules/typeorm --include=*.js` → 仅 `SelectQueryBuilder.js:803/808`（另有 `browser/` 同内容副本）；其上方即 `if (result && this.expressionMap.lockMode === "optimistic" && this.expressionMap.lockVersion)` |
| ④ | **仓内无任何 `setLock("optimistic")`** ⇒ 上述分支在业务代码里**永不可达** | 全 `src/**/*.ts`（剥注释、跳过 `__tests__`）扫描：仅有 `users.service.ts` 的两处 `setLock("pessimistic_write")` |

⇒ `repo.save()` 走不到 ③，② 也不给它谓词 ⇒ **`saveWithOptimisticLock()` 的 catch 是死分支**，
`APP_DEPLOYMENT_CONCURRENT_MODIFICATION`（409）**生产永不触发**。
并发 `stop` / `upgrade` / `redeploy` 是**最后写入者静默胜出**。

### 1.2 语义复刻证据（「真跑起来失败是静默的」）

按 TypeORM `SubjectExecutor` 真实语义（覆盖写 + 版本列自增、**无** version 谓词）实现最小 fake repo，
断言：过期快照写入时 **不抛异常 ∧ 列被静默覆盖 ∧ 版本号仍只 +1**。原始输出见 §5。

### 1.3 真 DB 可用性（**如实说明：未连真库**）

本机 `DB_HOST=postgres` 不可解析、本地 PG 无 `autoflow` 角色 ⇒ **没有**「真库并发写」的行为证据。
**补证判据**（留给有 DB 的环境）：开两个连接加载同一行，各自对**含不同 version 的快照**调 `repo.save()`，
断言**两边都成功**且 `version` 只 +1（而非 +2、也不抛错）。

> ⚠️ 强度标注：§1.1 是**结构证据**（证明「这条路不可能抛」），§1.2 是**语义复刻**（证明「跑起来是静默的」）。
> **两者都不是真库行为证据。** 若终审要求行为证据，须在有 PG 的环境补跑 1.3 的判据。

---

## §2 逐调用点清单

> `grep -rn "saveWithOptimisticLock"` 共 **10** 处命中，但其中 **1 处定义 + 6 处注释**；
> **真实调用点 = 4 个**（`codegraph callers` 交叉验证一致）。行号为改动前快照。

| # | 路径:行 | 所在方法 | 改的是什么状态 | 风险 | 状态 |
|---|---|---|---|---|---|
| 1 | `:1560` | `deploy()` 行复用 | 复用既有行的部署字段 | 中：复用行被并发 redeploy 覆盖 | ⬜ **未改** |
| 2 | `:2249` | `stop()` | `status=STOPPED`、`pid=null`、`statusMessage` | **高**：与 upgrade/redeploy 并发 ⇒ 停机意图被静默丢弃或反过来丢弃别人的升级 | ✅ **已改**（条件 UPDATE） |
| 3 | `:2567` | `pushDeployToExecutor()` | 推送后行状态/pid/statusMessage | **高**：`upgrade()` 已改条件占坑，但**推送后的落库**仍整行 save ⇒ 可能覆盖并发列 | ⬜ **未改** |
| 4 | `:4337` | `upgradeWithSnapshot()` | 回滚到上一版本的推送链路 | 中：回滚与人工 upgrade 并发 | ⬜ **未改** |

**注**：`upgrade()` **不含**在上表 —— 它在 **H-3（1-A）** 已改为行级条件 UPDATE 占坑（`WHERE id AND status='running'`）。
本次**未重复改**它。

---

## §3 改法与验证

### 3.1 `stop()` → 显式条件 UPDATE

```ts
const expectedVersion = deployment.version;
const stopClaimed = await this.repo.createQueryBuilder()
  .update(AppDeployment)
  .set({
    status: DeploymentStatus.STOPPED,
    pid: null,
    statusMessage: deployment.statusMessage,
    version: () => '"version" + 1',
  })
  .where('"id" = :id', { id: deployment.id })
  .andWhere('"version" = :expected', { expected: expectedVersion })
  .execute();
if ((stopClaimed?.affected ?? 0) === 0) {
  throw new AppError(ErrorCode.APP_DEPLOYMENT_CONCURRENT_MODIFICATION, { deploymentId });
}
deployment.version = expectedVersion + 1;
const saved = deployment;
```

**为什么是条件 UPDATE 而非「先查再写」**：后者是读后判（TOCTOU），两个并发请求可同时通过检查。
`WHERE version = :expected` + `SET version = version + 1` 是**原子 CAS**，DB 保证只有一个赢家 `affected=1`。

**只写本次真正改变的列**（不整行回写）——这与既有 R50/ADR-026 纪律一致：整行 `save` 会用读到的快照
覆盖并发的其他列（心跳推进、审批痕迹等），正是本缺陷的静默性来源之一。

### 3.2 订正虚假注释

`saveWithOptimisticLock` 的 doc 注释已从「宣称乐观锁生效」改为**事实 + 三重取证 + 正确做法**，
并明确写出：「`repo.save()` 是最后写入者静默胜出；409 生产永不触发；新增代码不要再走这里」。

同时把 `pushDeployToExecutor` 处引用该注释的段落一并纳入待改清单（§4）。

### 3.3 测试

| 文件 | 变化 |
|---|---|
| **新增** `__tests__/app-deployment.optimistic-lock.spec.ts` | 反向实证：4 条结构证据 + 2 条语义复刻 + 2 条转正判据。**8 用例全绿**（转正判据在修复前是红的，修复后转绿——见 §5） |
| **修改** `__tests__/app-deployment.service.spec.ts` | **重写 2 条建立在假假设上的旧用例**（它们 mock `save` 抛版本冲突来「证明」乐观锁生效 —— 证明的是一条假路径），改为驱动真实 CAS：`affected=0 ⇒ 409`、`save` 不得被调用。另给审计用例的本地 repo 补 `createQueryBuilder`。 |

**一次性删掉的假信号**：旧用例 `expect(repo.save).toHaveBeenCalled()` 断言的是「走了 save」，
而立意是「乐观锁挡住了并发」。**它测的是实现细节，不是性质** —— 所以它能一路绿到生产。

### 3.4 验证原始输出（摘要，完整见 §5）

```
jest src/modules/application  → Test Suites: 22 passed, 22 total / Tests: 495 passed, 495 total
tsc --noEmit                  → EXIT=0
check-conditional-writes      → ✔ 无条件状态写 0 处 / warn 2 处 / 整行 save 35（基线 0/0/35）
```

---

## §4 未改项与理由

| 项 | 为什么这轮不改 |
|---|---|
| `pushDeployToExecutor`（`:2636`） | 它是 `upgrade()` 的**下游**，而 `upgrade()` 的占坑语义刚由 1-A 落地。若此处也改条件 UPDATE，需先确认「占坑成功后推送再落库」的 version 期望值是谁的（占坑已 `version+1`）——**期望值取错会把正常升级打成 409**。属需要单独设计与测试的一档，不宜与本轮一起改。 |
| `upgradeWithSnapshot`（`:4406`） | 同上（回滚链路复用 `pushDeployToExecutor`），且它由 `failBatch` 自动触发——失败会被 `catch` 吞成日志，改错难察觉。 |
| `deploy()` 行复用（`:1589`） | 复用路径本身已有 `uq_app_deployments_application_in_flight` 结构约束护着「同一应用同时一个在途部署」；`version` CAS 叠加收益较低，优先级排后。 |

**统一说明**：Lead 要求「先做 upgrade/stop 两条最高频路径」——`upgrade()` 已由 H-3 完成，`stop()` 本轮完成。
其余 3 处按「不要一次性改 10 处然后一起红」的纪律登记，**未改不是遗忘**。

---

## §5 反向实证的原始输出

### 5.1 修复前的红灯（证明「乐观锁假设」与「注释」都不成立）

```
✕ UpdateQueryBuilder 对版本列只自增，不拼接任何 WHERE version 谓词      ← 我的正则应过宽，已收窄
✕ 仓内没有任何 setLock('optimistic')                                  ← 遍历扫到了我自己的 spec 文本，已修
✕ stop() 必须走条件 UPDATE（不再是 read-modify-write + save）
✕ 注释不得再宣称 save 会自动追加 version 谓词（运维唯一会读的地方）
Tests: 6 failed, 2 passed, 8 total
```
（前两条是**我自己的断言缺陷**，修正后转绿；后两条是**真实待修项**。）

### 5.2 修复后（全绿）

```
✓ TypeORM 的 SubjectExecutor（save 的执行体）零处把 versionColumn 用作 WHERE
✓ UpdateQueryBuilder 对版本列只自增，不拼接任何 WHERE version 谓词
✓ 异常唯一抛出点在 SelectQueryBuilder，且被 lockMode==='optimistic' 守护
✓ 仓内没有任何 setLock('optimistic') ⇒ 上述 throw 分支在业务代码里永不可达
✓ 过期快照写入：不抛异常 ∧ 列被覆盖 ∧ 版本号仍只 +1
✓ 『乐观锁会抛 409』这一期望在当前实现下必然落空（反向钉住）
✓ stop() 必须走条件 UPDATE（不再是 read-modify-write + save）
✓ 注释不得再宣称 save 会自动追加 version 谓词
Tests: 8 passed, 8 total
```

### 5.3 模块全量

```
PASS src/modules/application/__tests__/app-deployment.service.spec.ts
Test Suites: 22 passed, 22 total
Tests:       495 passed, 495 total
```

---

## §6 风险 + 回滚

| 风险 | 说明 | 缓解 |
|---|---|---|
| **`stop()` 的 version 期望值** | 条件 UPDATE 用 `deployment.version`（`findByIdRaw` 读到的）。若在「读」与「写」之间有别的写者改了行，CAS 落败 ⇒ **409**。这是**想要的行为**（此前是静默覆盖），但**对前端是新行为**：并发点 stop 可能首次出现 409 | 409 码 `APP_DEPLOYMENT_CONCURRENT_MODIFICATION` 是**既有码**，前端已有展示分支（此前只是永不触发）。建议前端确认该码的提示文案可读 |
| **假阳性 409** | 若某路径在 stop 前已把行 `version` 改过（如心跳写的条件 UPDATE 是否 bump version？） | 心跳走条件 UPDATE **不** bump version（R50 列级写），故不干扰。已由 495 用例覆盖 |
| **测试替身与真实语义脱节（本缺陷的根因）** | 既有 33 处 `repo.save` mock 让「不覆盖」无法被观察 | 新增的 `optimistic-lock.spec.ts` **复刻了覆盖语义**，是唯一能观察到静默丢失的测试。**但它是语义复刻，不是真库** |
| 回滚 | 改动局限于 `stop()` 一处方法与两处注释 + 两个 spec 文件 | `git revert <sha>` 即可；无 schema/迁移变化；不涉及数据 |

**未闭环声明**：剩余 3 个调用点（§4）仍走静默覆盖。**D-18 在它们改完前不算修完。**
