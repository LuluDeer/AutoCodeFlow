# executor-protocol（A3）

admin-api / executor-node / executor-python **三方共享的执行器协议契约向量**——单一事实源。

## 背景

评审 `docs/DEEP_REVIEW_0ef3bbe.md` §七 A3 指出：dispatch 载荷（timeout=0 / requirements /
traceparent）、回调载荷（failureReason 枚举 / 日志截断 / artifacts）、运维端点（`/health/ready`
形状与状态码）的三方一致性**只靠两侧注释互相引用维持**（"见 node execute.ts:xxx parity"、
"python 侧同步"），每轮一致性修复都在补漏——即"注释里的 parity"。

本包把已确认一致的语义固化为语言无关的 `protocol.json`，三端测试套件加载**同一份文件**断言，
任一侧回退即红在 CI，不再依赖人记得改注释。

与既有 `packages/contract-fixtures`（QA-07，四个客户端包共享的**响应信封**契约）同构：
都是"一份 JSON + N 端断言"。区别在于这里管的是**执行器协议面**而非 HTTP 信封拆包。

## 契约面

| 段 | 内容 | 三端落点 |
|---|---|---|
| `readiness` | `/health/ready` 的**状态码与 body 形状**（`ready`→200 / `not_ready`→503，body 扁平、不得有 `detail` 包裹，`reason` 非空） | admin-api `health.controller/health.service`；executor-node `routes/health.ts`；executor-python `routers/health.py` |
| `timeout` | 任务超时解析语义（`0` = 显式不限时；`1..86400` 有界；越界/负值拒绝；缺省回落执行器默认） | admin-api `create-task.dto` 语义；executor-node `routes/execute.ts`；executor-python `routers/execute.py` |
| `failureReason` | 枚举全集（以 admin `ExecutionFailureReason` 为准）与**执行器可上报子集**（全集减去 admin 内部专用的 `stale_recovered`） | admin-api `dto/execution-callback.dto.ts` 的 `@IsIn`；executor-node `callback.ts` 的 `CallbackFailureReason`；executor-python 回调载荷 |

## 消费方式

```ts
// TS (jest)
import protocol from '../../../packages/executor-protocol/protocol.json';
```

```python
# Python (pytest)
import json, pathlib
protocol = json.loads(
    (pathlib.Path(__file__).parents[2] / "packages" / "executor-protocol" / "protocol.json").read_text(encoding="utf-8")
)
```

（路径按各端测试文件所在层级调整；`acf-cli` 既有消费点的写法见
`packages/contract-fixtures/README.md`。）

## 已知残差（如实）

- **timeout 越界（>86400 / <0）的执行器侧策略两端不一致**：`executor-node` 拒绝
  （400），`executor-python` 夹紧到边界。`admin-api` 的 `create-task.dto` 已用
  `@Min(0) @Max(86400)` 前置拦截，正常派发路径执行器收不到越界值，因此这属于
  **纵深防御层的漂移**而非活跃事故。契约向量把它标记为 `rejectedBy: "admin-api"`
  而不是假装三端一致；真正收口需要把 python 的 `_clamp_timeout_seconds` 改为拒绝，
  属行为变更，未含在本切片。
- **`Executor` 表（而非 `TaskExecution`）的条件 UPDATE + RETURNING** 不在本契约
  范围——那是执行器注册状态机，与执行终态无关（A1 亦然）。
- 本切片只钉了 `readiness` / `timeout` / `failureReason` 三段。评审 A3 的完整形态
  还包括 `ExecuteRequest` / `ConfigReload` / 运维端点的 schema 化（zod + pydantic
  双生成），未做。

## 修改纪律

- **只能追加向量，不能修改既有向量**——已发布的端按旧向量断言。
- 语义本身变更（如 readiness 状态码、timeout 值域、枚举增删）属**破坏性契约变更**：
  先改源头 + 本文件 `$schemaVersion`，三端同批发布。
- 新增契约面前先问：这条语义是否真的三方共有？只属于一端的实现细节不该进这里
  （进来了就是给另外两端凭空加耦合）。
