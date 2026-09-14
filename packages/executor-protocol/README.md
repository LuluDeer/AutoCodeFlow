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
| `schemas` | **A3 完整形态**：`ExecuteRequest` / `TaskConfig` / `ConfigReloadRequest` / `ConfigReloadResponse` / `HealthReadyResponse` 的 JSON Schema（2020-12 受控子集） | 由生成器产出两侧 schema，见下 |
| `schemaVectors` | 上表每个 schema 的 valid / invalid 样本（invalid 附 `expectErrorPath`） | 三端加载同一份断言 |

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

## A3 完整形态：zod + pydantic 双生成

`schemas` 段是**单一事实源**（JSON Schema 2020-12 受控子集），由零依赖的
node 生成器产出两侧：

```bash
npm run gen:protocol            # 重新生成两侧
npm run check:protocol-sync     # 生成 + git diff --exit-code（CI 同款）
```

| 产物 | 落点 | 消费方 |
|---|---|---|
| zod | `apps/executor-node/src/generated/protocol.schemas.ts` | `src/protocol-schemas.spec.ts`（26 例） |
| pydantic | `apps/executor-python/generated/protocol_schemas.py` | `tests/test_protocol_schemas.py`（26 例） |

**受控子集**：`type`（数组形式即 nullable）/ `properties` / `required` /
`additionalProperties` / `items` / `enum` / `minimum` / `maximum` / `pattern` /
`default` / `$ref`（仅 `#/$defs/<本段内的名字>`）。生成器遇到子集外的关键字
**报错退出**——静默跳过会让契约悄悄失效，而且是永远不会变红的那种失效。内联
嵌套对象同样被拒绝（zod 侧会生成匿名类型，两侧形状无法对齐），必须先抽成顶层
schema 再 `$ref`。

生成物随源码**同 commit**（与 ADR-005 bundle 产物同款纪律），CI 的
`executor-protocol-drift` job 重跑生成器并 `git diff --exit-code`：改了
`protocol.json` 却没重跑生成 → 红。

两侧 spec 加载**同一份** `protocol.json`、跑**同一批**向量：任一侧对协议的
理解与另一侧分叉，就有一侧会红。invalid 分支不只断言「被拒绝」，还断言拒绝
发生在 `expectErrorPath` 指定的字段上——只断言被拒绝会退化成永真断言。

另有两条把「生成物」与「运行时」钉在一起的断言（防止 schema 沦为只被测试
消费的摆设）：

- executor-node：`protocol.json` 里 `executionId` 的 pattern 与运行时守卫
  `isSafeExecutionIdSegment` **逐字符比对**（同一批样本上结果必须一致）。
- executor-python：协议的 valid 样本必须能被 `routers/execute.py` **真正在用**
  的请求模型接受。

## 已知残差（如实）

- **timeout 越界（>86400 / <0）的执行器侧策略两端不一致**：`executor-node` 拒绝
  （400），`executor-python` 夹紧到边界。`admin-api` 的 `create-task.dto` 已用
  `@Min(0) @Max(86400)` 前置拦截，正常派发路径执行器收不到越界值，因此这属于
  **纵深防御层的漂移**而非活跃事故。契约向量把它标记为 `rejectedBy: "admin-api"`
  而不是假装三端一致；真正收口需要把 python 的 `_clamp_timeout_seconds` 改为拒绝，
  属行为变更，未含在本切片。
- **`Executor` 表（而非 `TaskExecution`）的条件 UPDATE + RETURNING** 不在本契约
  范围——那是执行器注册状态机，与执行终态无关（A1 亦然）。
- `ExecuteRequest` / `ConfigReload` / 运维端点的 **schema 化已做**（见上节的
  zod + pydantic 双生成）。但**生成物目前只被测试消费 + 两条运行时一致性断言，
  尚未接进两侧 `/execute` 的运行时校验**：
  - executor-node `/execute` 仍是手写的 `if (!executionId || !body.task)` +
    `isSafeExecutionIdSegment`（语义与 schema 等价，故未替换）；
  - executor-python `/execute` 在 `autocodeflow_sdk` 缺席时用本地 fallback 模型
    （`task: Dict[str, Any]`），**嵌套字段不校验**——改成生成物需要先处理
    `req.task.get(...)` 的多处字典式访问与 `merge_task_with_manifest` 的入参类型，
    且会与「timeout 越界 python 侧 clamp」的既有漂移相互纠缠（见上一条残差）。
  接进运行时属行为变更，留作下一步（先让契约面与向量站住，再动执行路径）。
- `kill` / `deploy` / `update-package` / `logs` 等端点的载荷**未** schema 化——
  先只收协议面最核心的三个（ExecuteRequest / ConfigReload / readiness），避免
  把只属于一端的实现细节拉进共享契约（见「修改纪律」）。

## 修改纪律

- **只能追加向量，不能修改既有向量**——已发布的端按旧向量断言。
- 语义本身变更（如 readiness 状态码、timeout 值域、枚举增删）属**破坏性契约变更**：
  先改源头 + 本文件 `$schemaVersion`，三端同批发布。
- 新增契约面前先问：这条语义是否真的三方共有？只属于一端的实现细节不该进这里
  （进来了就是给另外两端凭空加耦合）。
