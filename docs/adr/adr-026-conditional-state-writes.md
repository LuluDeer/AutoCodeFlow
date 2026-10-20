# ADR-026: 状态迁移写必须条件化（conditional state writes）

状态：Accepted

## 背景

2026-10-20 这一轮密集审计（R32-A2 起）在**四个互不相关的模块**里连续挖出同一类缺陷，形态完全一致：
**一次状态写入没有带「前置状态」条件**，于是并发或长窗口下会把别人刚写完的状态按旧快照盖回去。

已确认的实例（都修了，都配了反证）：

| 实例 | 现场 | 后果 |
| --- | --- | --- |
| users.update（R32-C3，`c02d6092`） | 整行 `save(user)`，窗口含 `bcrypt(12)` | 并发的 `sessionVersion+1` 被回退（**已吊销 token 复活**）、`isActive=false` 被撤销（**禁用失效**）、新密码哈希被旧哈希覆盖（**改密被撤销**） |
| api-keys.revoke（R32-C1，`aa7e5235`） | 整行 `save(row)` | 把 `touchLastUsed` 刚落的 `lastUsedAt` 打回快照值 ⇒ 下次认证又判「首次使用」，重复落 firstUse 审计 |
| deploy 推送重试耗尽（R33-B2，`2c865d72`） | 无条件 `save(FAILED)`，窗口**约 93 秒** | 执行器其实已成功部署、心跳已推进到 RUNNING，却被**回滚成失败**（运维去重试，线上是好的） |
| sop 状态机（R33-A2） | 多处以 `WHERE id` 单条件 UPDATE | 终态可被改回 / `failed`↔`completed` 互改 / 清扫器与完成路径互相覆盖 |

关键在于**它在测试里永远绿**：单线程、无并发、无长窗口的用例下，「无条件写」与「条件写」行为完全相同。
所以这类缺陷不会由测试暴露，只会由**并发 / 超时 / 重试**暴露，而那时已经是生产事故。

## 决策

1. **凡是写「状态 / 生命周期 / 凭据 / 会话版本」这类字段，必须用条件写**（`UPDATE … WHERE id AND status IN (…)`、
   乐观锁 `WHERE version = …`、或 `saveWithOptimisticLock`），不得用 `repo.save(entity)` 直接回写整行。
2. **条件的取值集合必须是「本次动作的合法起始状态」，不是「当前看到的状态」**。典型错误是先 `findOne`
   判一下再 `save` —— 那只是把竞态窗口挪了个位置，没有消除它（read-then-write）。
3. **命中为 0 不是错误，是并发收敛**：正确处理是**跳过该写**并留一条 warn（说明「行已被其它动作推进」），
   而不是抛 500。只有「本次动作的业务前置」不满足（例如审批未通过）才抛业务错误。反例见 R33-B2：
   条件不命中时若还写 FAILED，等于把并发结果盖掉。
4. **不许用陈旧快照做整行回写**。若确实需要写多列，只写「本次动作真正改变的列」；`updatedAt` 交给
   `UpdateQueryBuilder` 的 `CURRENT_TIMESTAMP`（用库时钟，而非应用进程时钟）。
5. **状态写必须可观测**：跳过写要 warn（含行 id 与原因），成功写要能从事后审计看出是谁赢的。
   「静默跳过」与「静默覆盖」同样不可接受。
6. **新增状态迁移点时，必须同时给出**：① 条件写的 WHERE 谓词；② 一条「并发后到者不覆盖」的用例；
   ③ 该用例的反证（把条件去掉必须转红）。

## 后果

- 正向：把「谁赢」的决定权交给数据库的行锁 / 条件谓词，而不是「谁最后 save」。上面四个实例修完后
  各自模块全绿，且每处都有「去掉条件即转红」的反证。
- 代价：条件写拿不到 `entity.save()` 的便利（级联、`@VersionColumn` 自动递增），调用方要自己维护返回的
  视图对象；部分旧用例断言的是「`save` 被调用过」，需升级为「`update({…条件},{精确列})` 且不再 save」——
  这类改写**必须逐条说明为什么不降低强度**（R32-C3 的实际做法：断言从 1 条变多条，强度是提高的）。
- 验收项：任何触碰状态机的 PR，评审先问「这条 UPDATE 的 WHERE 带状态了吗？」；答案是没有就必须在
  PR 描述里写明为什么安全（例如该表无并发写者）。

## 替代方案（被否）

- **方案 A：全局加 `@VersionColumn` 并在所有 save 前校验版本**。否掉：`save()` 的 diff 是拿「内存陈旧值
  vs 写入时刻库中行」比，陈旧值 ≠ 新值 ⇒ 仍被判脏列写回（R32-C3 实测）；版本列只能拦住「同时改」，
  拦不住「先读后长窗口再写」。
- **方案 B：只在应用层加锁（进程内 mutex / Redis 锁）**。否掉：本仓是多实例部署（ARCH-31），进程内锁
  跨实例无效；Redis 锁引入新故障面（锁服务抖动 ⇒ 写不进去或永久锁死），而多实例矩阵已证明 DB 条件
  谓词足够。
- **方案 C：把所有写收敛到 repository 层统一加条件**。否掉：条件取值集合是**每个迁移点各自的业务语义**
  （poll 用 `pulledAt IS NULL`、完成用「排除终态」、推送失败用「仍在飞」），统一封装只能退化成
  「所有列都条件化」，复杂度高于收益。

## 关联

- 计划项：R32-C3 / R32-C1 / R33-B2 / R33-A2（同一根因的四个实例）
- 相关 ADR：ADR-002（调度器双保险：Redis Leader + DB 条件 claim，本决策的同源先例）、ADR-017
  （执行器身份：`address` 不是身份 ⇒ 同址多行的身份解析也必须是条件化 / fail-closed）

## 附录：整行回写（`repo.save(entity)`）普查

静态守卫 `scripts/check-conditional-writes.mjs` 只看 `.update({ id }, …)` 一种形态；**整行回写**是它
的已知盲区（见该脚本头注），靠 `--report-saves`（只报告、永不失败）枚举。

### 判定口径（三问，按顺序）

1. **这个实体是刚 create 出来的，还是方法早期读到的快照？** 前者是 INSERT，无害。
2. **写的时候是否持有行锁或版本列？** `findOne(..., { lock: "pessimistic_write" })` 在事务内持有到
   commit；`@VersionColumn` 会让 save 自动追加版本谓词。两者都**不存在「读后写前」窗口**。
3. **它拥有的列 vs 实体上的全部列，差集里有没有别的写者？** 有 ⇒ 真缺陷：那就是「用旧快照盖掉
   别人刚写的事实」。**修复方式优先正向白名单 ∩ 采纳集，不用黑名单 delete**（黑名单会随新列腐化）。

### 已判定为无害（26 处，逐处依据）

| 类别 | 位置 | 依据 |
|---|---|---|
| 插入 | `agent-session:122/376/433` | 同一处 `create(...)` 之后立即 save |
| 插入 | `app-deployment:914/1029`、`application:556` | 同上（含请求行/部署行/应用行） |
| 插入 | `audit:147`、`config:569`、`metrics:216` | 审计/配置历史/指标上报行，只追加 |
| 插入 | `oidc:555`、`users:105`、`task-template:104` | JIT 建号 / 管理员 seed / 模板新建 |
| 插入 | `executor:1217/1876`、`executor-package:382` | 重试行 / 首注册新行 / 包新建 |
| 插入 | `notification-silence:124`、`project-access:190`、`projects:87` | 静默窗口 / 成员行 / 项目行新建 |
| 插入 | `sop:256/317/429/819/879`、`task:4606/4672` | SOP/版本/指派/澄清 ×2、执行日志行 |
| 锁内 | `executor-package:707` | 事务内 `pessimistic_write` 重读后写回 |
| 版本列保护 | `app-deployment:366` | 就是 `saveWithOptimisticLock()` 本体（`@VersionColumn`） |

### 已修（本轮之前逐处修掉的，list 供追溯）

`sop.publish` / `sop.draft` / `sop` 澄清修订 / `sop` resend 重排队 / `executor.markOffline` /
`executor.setOfflineById` / `executor.rotateToken` / `executor.update` / `executor.heartbeat` /
`executor.register` / `executor-package.update` / `application.deployFromGit`（头 + 收尾） /
`application.update` / `app-deployment` rollout 痕迹 ×2 / `agent-session.finish`+`markWaiting` /
`task.analyzeExecution` / `task.update`+`updateGlue`+`remove` / `project-access` 成员写 ×2 /
`projects.update` / `event-subscription.update`。

### 待判定（版本快照类，风险低但同型）

- `app-deployment:2019`（部署产物 version.status）
- `application:489`（版本快照的 packageUrl 回填）
- `mutex-group:130`（互斥组配置更新：实体当前只有 name/scope/description，与 `projects.update` 同型）

这三处的共同点：**写的是「几乎没有第二个写者」的列**，所以现在不构成缺陷；但按 `projects.update`
（R62）的理由，它们同样是**定时炸弹** —— 实体加一列、且那列有别的写者，就会变成缺陷。
处理顺序：等它们各自的模块有其他改动时顺带收紧，**不为它们单独开一轮**。
