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

> **生成物恒带 `strict=True`**（pydantic 侧）。pydantic 默认 **lax** 会把数字
> 字符串强转成数字（`'3600'` → `3600`）、把 `0/1/'yes'/'true'` 强转成 bool，而
> zod 侧**从不**强转（`z.number().int()` 拒 `'3600'`）。于是同一 schema 两侧
> 对同一载荷判定相反——lax 下 python 侧闸门形同虚设：它声称拒绝的东西被悄悄
> 改写后接受了。实爆：`{"timeout_seconds": "3600"}` 在 zod 侧被拒、在 pydantic
> 侧通过。语义后果：`{"timeout": "0"}`（显式不限时）也会被 python 静默接受，
> 而 node 直接 400——同一条任务派到两台执行器上一台跑一台拒。生产流量不受影响
> （admin 的派发载荷由 Prisma 实体序列化，数值恒为 JSON 数字）。由
> `tests/test_protocol_schemas.py` 的两条用例钉住（配置位 + 实际行为）。

> **别名必须与正名同严**（新增纪律）。本文件的 `*_source` / `*_language` /
> `*_version` 等 snake_case 别名是**同一语义的第二入口**，不是"透传字段"——
> 校验强度必须与驼峰正名一致。曾有别名写成裸 `z.string()` 而正名是 enum 的情
> 况（`code_source` / `glue_language`），于是 `{"code_source":"ftp"}` 能绕过闸
> 门、而 `{"codeSource":"ftp"}` 被拒。两侧运行时都读两个键、行为虽一致，但协议
> 这样就**没有如实描述校验面**——而协议的意义正是描述它。新增别名时：正名有
> enum 则别名必须有同集 enum，正名是数值则别名必须同样拒字符串。

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

- ~~**timeout 越界的执行器侧策略两端不一致**~~ —— **A3-C 已收口**。两侧
  `/execute` 的协议闸门现在都按 `schemas.TaskConfig` 的边界拒绝（400），
  `executor-python` 不再静默 clamp（`_clamp_timeout_seconds` 保留为解析期兜底，
  仍是 clamp 语义，但越界值已不可能到达它）。契约向量的 `rejectedBy` 已改为
  `"admin-api, executor-node, executor-python"`。
  收口过程中顺带发现并修掉一个真问题：`executor-python` 的 `accept_execution`
  把 E-19 的 `requirements` 手检放在 `register_live_execution` **之后**，畸形载荷
  被拒时 live 条目不会注销——该 executionId 在本执行器上**永久**被当成「已在运行」
  （admin 重试全撞 400，心跳还会上报一个不存在的执行）。闸门与手检现已统一前移
  到登记之前，`tests/test_execute_protocol_gate.py::test_rejected_execution_leaves_no_live_entry`
  钉住它（把闸门置空该用例即转红）。
- **`Executor` 表（而非 `TaskExecution`）的条件 UPDATE + RETURNING** 不在本契约
  范围——那是执行器注册状态机，与执行终态无关（A1 亦然）。
- ~~**生成物尚未接进两侧 `/execute` 运行时校验**~~ —— **A3-C 已接进**。
  - executor-node：`acceptExecution` 在既有手检**之后**加一道
    `ExecuteRequestSchema.safeParse` 闸门。放在手检之后是因为手检的 400 文案更
    具体且已被既有用例钉住；闸门兜的是手检没覆盖的部分（params / executionId
    的类型、task 各字段类型、timeoutSeconds 边界）。`protocol-schemas.spec.ts`
    之外新增「向量驱动端点」用例：`schemaVectors.ExecuteRequest.invalid` 的每一
    条都必须让 `POST /execute` 返回 400（少了这层，schema 只是被测试引用的产物）。
    - 顺带修掉一个 500→400：`executionId` 传非字符串时，`isSafeExecutionIdSegment`
      的 `RegExp.test` 会隐式转换放行，随后 `path.join` 抛 TypeError 被兜成
      **500**。畸形输入该是 400，已加 `typeof` 守卫。
  - executor-python：`accept_execution` 在最前面（登记表之前）加一道
    `ProtocolExecuteRequest.model_validate`。这里**没有**替换 FastAPI 的
    `ExecuteRequest`（`task` 保持 dict，全代码库按字典访问，替换要动 2000+ 行，
    风险远大于收益）——两个模型分工不同：那个是反序列化，这个是协议校验。
  - 代价：内嵌执行器的 ncc bundle 因此内联 zod（2111kB → 2275kB），是它首次
    引入第三方运行时依赖（ADR-005 同 commit 回填了哈希）。
  - ~~仍未接进运行时的：`ConfigReloadRequest` / `ConfigReloadResponse` /
    `HealthReadyResponse` 三个生成物只被测试消费~~ —— **已接进运行时**。
    - executor-node：`routes/config.ts` 在数值下界手检**之后**、任何 `config`
      写入**之前**加 `ConfigReloadRequestSchema.safeParse` 闸门（兜手检抓不到的
      类型/形状错误）；出参经 `buildReloadResponse()` 过 `ConfigReloadResponseSchema`
      后才发送。`routes/health.ts` 的 ready/not_ready 三个分支统一经 `sendReady()`
      过 `HealthReadyResponseSchema`。
    - executor-python：`routers/config.py` 同序（手检 → `ProtocolConfigReloadRequest
      .model_validate` 闸门 → 写入），两处返回经 `_conform_response()` 过生成物；
      `routers/health.py` 的 `_readiness()` 三个分支统一经 `_ready_json()` 过
      `ProtocolHealthReadyResponse`。
    - 接线时抓到并修掉一个**真实三方漂移**：node 的 `/config/reload` 响应一直用
      camelCase（`updatedFields`/`ignoredFields`），而 protocol.json 与 python
      都是 snake_case（`updated_fields`/`ignored_fields`）——node 是三方里唯一的
      漂移点，前端不读这两个字段、无外部消费方，已对齐为 snake_case。
    - 反证有牙：两侧 config/health 用例都用**生成的** schema 现校验真实出参
      （`safeParse`/`model_validate`），再改回 camelCase / 退回旧状态值立即红。
- ~~`kill` / `logs` 两端共有响应未 schema 化~~ —— **已收口（KillResponse /
  LogsResponse，均 `additionalProperties:false` → zod `.strict()` / pydantic
  `extra="forbid"`）**。
  - executor-node：`routes/execute.ts` 的 kill 五个返回点（404 一处 + 200 四处）
    统一经 `killBody()` 过 `KillResponseSchema`；`routes/logs.ts` 成功页经
    `LogsResponseSchema` 后才发送，校验不过抛错走 500（不发 admin 无法解析的载荷）。
  - executor-python：`routers/execute.py` 的 `_kill_body()` 三处返回过
    `ProtocolKillResponse`；`routers/logs.py` 返回前过 `ProtocolLogsResponse`
    （本地 response_model 管序列化，生成物管两侧形状不漂移）。
  - 跨语言坑（钉在向量注释里）：①pydantic lax 会把 `'yes'/'true'/0/1` 强转 bool，
    故 `ok-not-boolean` 非法向量用两侧默认模式都拒绝的 `"maybe"`；②zod `.strict()`
    把未知键报在根路径（键名在 `issue.keys`），pydantic forbid 报在该键 loc，
    两侧错误定位不同形，故「多余键拒绝」不放进共享向量，改由两侧各自运行时测试断言。
  - 反证有牙：node `execute.spec.ts`/`logs.spec.ts`、python `test_kill.py`/
    `test_logs.py` 都用**生成的** schema 现校验真实 200/404/分页出参，并断言
    strict/forbid 拒绝未声明键。
- `deploy` / `update-package` 端点载荷**仍未** schema 化——它们是 executor-node
  **独有**（executor-python 无对应 router），按「修改纪律」不拉进两端共享契约。
  **B-1（中台↔执行器深度审查）已登记**：protocol.json 新增顶层 `executorNodeOnly`
  段，把 `POST /api/deploy` / `POST /api/update-package` /
  `GET /api/update-package/status` 的预期形状（取自 deploy.ts 的 `DeployPayload`
  与 update-package.ts 的字面量）落成文档型契约，供未来 python 补齐时对齐；一旦
  python 补齐对应端点，**必须**把共有面提升进 `schemas` 段并删除 `executorNodeOnly`
  对应条目。生成器只消费 `schemas` 段，故 `executorNodeOnly` / `versioning` 不参与
  双生成，也不会被受控子集检查误伤。
- **B-3/U-2（协议版本协商）已落地**：protocol.json 新增顶层 `versioning` 段
  （`currentProtocolVersion` / `supportedMinProtocolVersion` / `compatibilityMatrix`
  / `evolutionRules`）。执行器在 register（及心跳）上报 `protocolVersion`；中台按
  兼容矩阵分支（低于下限只 warn + 兜底，不拒绝注册）。详见本文件下方「修改纪律」
  与 `versioning` 段注释。

## 修改纪律

- **只能追加向量，不能修改既有向量**——已发布的端按旧向量断言。
- 语义本身变更（如 readiness 状态码、timeout 值域、枚举增删）属**破坏性契约变更**：
  先改源头 + 本文件 `$schemaVersion`，三端同批发布。
- 新增契约面前先问：这条语义是否真的三方共有？只属于一端的实现细节不该进这里
  （进来了就是给另外两端凭空加耦合）。
