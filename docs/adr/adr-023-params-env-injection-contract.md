# ADR-023: params → 子进程 env 的注入口径——字符串回归裸值 + 类型化通道（协议 4→5，A-11R）

状态：Accepted

## 背景

### 生产实证

2026-10-02 上线的 **A-11**（R5 审计第 11 项，`89f4af45`）把 `params` → 子进程 env 的
序列化从 `String(v)` / `str(v)` 改成统一 JSON（`JSON.stringify(v)` /
`json.dumps(v)`）。当天就有一个应用因此**静默停摆 12 天**：

- `tk-ship-notify` 读 `region` 参数得到字符串 `'"欧盟"'`（带首尾双引号），
  `region_filter_formula('"欧盟"')` 抛「未知区域参数」→ 任务 failed；
- 运营在 2026-10-02 ~ 10-14 期间**没有收到任何飞书通知**，且失败是静默的
  （任务按计划触发，只是每次都在业务层报错）。

### 根因：中台只能表达字符串，执行器却对字符串也加了编码层

A-11 想修的问题**是真的**：`String(v)` 与 python `str(v)` 对布尔/空值/容器产出
不同字节（`true` vs `True`、`null` vs `None`、`["a"]` vs `['a']`），同一任务脚本
在两个执行器上读到不同值。

但落地时把**字符串也一起 JSON 化**了，而中台 `ParamsEditor` 的契约是
`Record<string, string>` —— **控制台上配的每一个参数都是字符串**：

| 参数（UI 里填的） | A-11 注入的 env | 文档教读法 | 结果 |
|---|---|---|---|
| `limit = 3` | `AUTOFLOW_LIMIT='"3"'` | `int(os.environ["AUTOFLOW_LIMIT"])` | ❌ `ValueError` |
| `region = 欧盟` | `AUTOFLOW_REGION='"欧盟"'` | 裸读 | ❌ 值里带引号 |
| `mode =`（空串） | `AUTOFLOW_MODE='""'` | `if os.environ.get(...)` | ❌ **`'""'` 是真值** |

于是：**所有**经中台 UI 配置的字符串参数、以及按官方文档裸读参数的存量脚本，
全部受影响。shell 任务（`$AUTOFLOW_X` 拼命令）、node 裸读 `process.env`、第三方
SDK 这三类消费方**根本无法**自行规避——它们的读取方式由语言/SDK 决定。

### 放大因素

1. **文档未同步**：`sdk-guide.md` / `app-development-guide.md` 里教裸读的段落
   全部早于 A-11 且未改（blame 到 2026-08-12），而中台 UI 的提示词至今没提引号
   语义——唯一写了引号语义的是 CLI 侧文档，且是 10-09 才补的。
2. **没有协议门禁**：A-11 上线时**未 bump `PROTOCOL_VERSION`**（仍是 4），中台
   无法区分「已落地 A-11 的执行器」与「旧执行器」——**v4 被两种语义共用**。
   任何"按版本分派两种语义"的方案对已部署机队都失效。
3. **A-11 自称的"两端字节一致"并未做到**：契约向量只有 10 条，恰好不含临界形态。
   实测 `1e-7` node 给 `1e-7`、python 给 `1e-07`；`0.00001` node 给 `0.00001`、
   python 给 `1e-05`。即 A-11 修掉了"布尔/空值/容器"那一半，却在**用户不可见的
   地方**留下另一半漂移。

### 为什么必须作为契约决策处理

逐键通道的值**恒为字符串**——这是 env 的物理约束。因此"这个值是字符串 `"true"`
还是布尔 `true`"这个问题，在逐键通道上**原理上无法回答**。任何试图靠"猜测性
解析"回答它的方案都会在某个方向上错：把用户填的 `3` 转成数字会破坏格式化，
不转又无法表达真实数字。这不是实现缺陷，是**通道表达力**的缺口，必须靠新增
一条通道解决，而不是靠调启发式。

## 决策

1. **逐键通道 `AUTOFLOW_<KEY>`：字符串回归裸值，非字符串保持 JSON。**
   - 字符串 → 原样注入（`欧盟` 就是 `欧盟`），回到 A-11 之前对字符串的行为；
   - 布尔/数字/null/容器 → JSON 字面量（`true`/`3`/`null`/`[1,"a"]`），保留
     A-11 对两端字节漂移的真修复。

   理由：中台主入口、shell 任务、文档示例、第三方 SDK 这四类消费方读的都是
   **裸值**，而它们的读法不可改写。字符串裸值是唯一能让它们恢复正确的口径。

2. **新增类型化通道 `AUTOFLOW_PARAMS_JSON`**：整个 params 对象一份紧凑 JSON，
   供需要**精确类型**的消费方（两个 SDK 的 `fromEnv()` / `from_env()`）做类型
   还原。
   - 注入点在逐键循环**之后**（与 `AUTOFLOW_CALLBACK_TOKEN` 同一纪律）：用户
     参数不得覆盖平台变量；名为 `params_json` 的参数会被它覆盖，这是刻意的
     （该名字属平台命名空间）。
   - 空 / 缺省 params **不注入**：注入 `{}` 只会让消费方多一个要特判的形态，
     缺席比空值更清楚。
   - 它是**唯一**能区分字符串 `"true"` 与布尔 `true` 的通道——这正是它存在的
     全部理由。

3. **两端字节一致从"声明"变成"事实"**：python 侧不再用 `json.dumps`（其浮点
   排版与 `JSON.stringify` 不同、对象键序为纯插入序），改由
   `apps/executor-python/js_json.py` 实现 `JSON.stringify` 自身的规则：
   - `Number::toString`（ECMA-262 §6.1.6.1.20）：指数/定点的选择阈值
     （`n > 21` 或 `n <= -6`）与指数不补零；
   - **JS 的整数键排序**：整数索引键先按数值升序排在前面，其余键按插入序跟随
     （`{"b":1,"0":2}` node 给 `{"0":2,"b":1}`、python 原本给 `{"b":1,"0":2}`）；
   - 超出 IEEE-754 安全整数区的整数按 double 排版（复刻 node `JSON.parse` 已经
     丢过精度这一事实）。

4. **协议版本 4 → 5**（`protocol.json` `currentProtocolVersion` + 两端
   `PROTOCOL_VERSION`）。理由是 evolutionRules 第 1 条：中台必须能区分「按 v5
   语义注入（字符串裸值 + 有 `PARAMS_JSON`）」与「v4 及更早的 A-11 后语义
   （字符串带引号）」。**注意 v4 已被两种语义共用**，故不能用 v4 判断字符串
   是否带引号——这正是必须新增版本号、而不是回填 v4 的原因。
   方向为**执行器→中台**（中台从不构造子进程 env），
   `PROTOCOL_CONTROL_PLANE_MIN` 仍为 2，不改变任何既有控制面分支。

5. **`$schemaVersion` 1 → 2**（contract-fixtures），并按 append-only 纪律**新增**
   `executorEnvSerializationV2` 段；A-11 的 `executorEnvSerialization` 段**冻结为
   历史档案**，不再对实现断言（它钉的正是本次要修的行为）。

6. **SDK 承接解码**：`autoflow_sdk.TaskContext.from_env()` 与
   `autocodeflow-node-sdk` 的 `getParam()` 优先读类型化通道；旧执行器（< v5）
   回落逐键通道并**尽力而为**地还原类型，且对 A-11 的引号形态做剥离容错
   （这是对存量机队的兼容层，不是必需层）。

7. **中台 `ParamsEditor` 支持显式类型**（文本/数字/布尔/JSON）。这是根因的
   中台半边：此前控制台**只能**产出字符串，需要真实布尔/数字/数组的用户没有
   任何入口。类型选择器把用户意图显式表达出来，不再依赖对字符串做猜测性解析。
   默认类型是「文本」，与既有行为一致（存量任务语义不被静默改变）。

### 明确不做

- **不**在 SDK 里对逐键通道做"聪明"的猜测性 JSON 解析（把裸 `3` 转成数字）：
  那会破坏 `f"{v:>10}"` 这类格式化，并把用户填的字符串静默变成另一种类型。
  类型还原只发生在**确定安全**的形态上（容器、三个字面量、带 JSON 标记的数字）。
- **不**回填/复用 v4 表示新语义（见决策 4）。

## 后果

### 正向收益

- **`tk-ship-notify` 那类故障消失**：字符串参数恢复裸值，官方文档教的
  `int(os.environ["AUTOFLOW_LIMIT"])` 重新成立。
- **空串恢复为假值**：A-11 的 `'""'` 是真值，会让 `if os.environ.get(...)` 走错
  分支且**不报错**；裸空串是假值，判断正确。
- **类型歧义有解**：需要精确类型的消费方读 `AUTOFLOW_PARAMS_JSON`，不再猜。
- **两端字节一致可断言**：`js_json.py` 使 python 与 `JSON.stringify` 逐字节相同，
  由 36 条逐键向量 + 9 条 paramsJson 向量在两端测试里各钉一遍（差分探针实测
  9927/9927 个随机/边界值一致）。
- **中台表达力补齐**：布尔/数字/数组第一次可以在控制台上正确配置。
- **可观测**：协议 v5 让中台能识别机队口径，为后续观测与兜底提供判据。

### 接受的代价与边界

- **字符串与 JSON 字面量在 env 里仍然长得一样**：逐键通道上 `AUTOFLOW_X=true`
  既可能是布尔 `true` 也可能是用户填的字符串 `"true"`。这是通道的固有模糊性，
  由类型化通道解决，**不**由启发式解决。
- **旧执行器（< v5）上 SDK 的类型还原是尽力而为的**：`true`/`false`/`null`
  会被还原成布尔/空值，因为留在字符串形态会让 `false`/`null` 变成**真值**——
  与 A-11 的 `'""'` 同一类静默故障。需要字面字符串的用户应升级执行器或读
  `AUTOFLOW_PARAMS_JSON`。
- **升级窗口内两端语义并存**：未升级的执行器仍会加引号。SDK 的引号剥离容错
  让这一窗口内的脚本可用；但**未使用 SDK** 的脚本（shell、裸读 node）在旧
  执行器上仍需自行容错——故本 ADR 要求执行器与 SDK 同批发布。
- **多一个模块、多一条通道、多一个协议版本**：`js_json.py`（python）、
  `param-env.ts`（node）、`AUTOFLOW_PARAMS_JSON`、协议 v5 条目。
- **中台类型选择器改变 UI 契约**：`ParamsEditor` 的 value 从
  `Record<string,string>` 变为 `Record<string,unknown>`，触发弹窗的
  `String(v)` 强制转换一并移除（那正是类型在 UI 这一跳被丢掉的地方）。

### 验收项

- `apps/executor-node/src/__tests__/executor-protocol-contract.spec.ts`：逐条断言
  `executorEnvSerializationV2` 的向量；**反证**——每条字符串向量必须
  `env === input` 且不以 `"` 开头（有人把字符串重新 JSON 化即转红）；类型化
  通道键名精确为 `AUTOFLOW_PARAMS_JSON`。
- `apps/executor-node/src/routes/execute.spec.ts`：字符串裸值 + 非字符串 JSON +
  类型化通道 + 空 params 不注入 + 名为 `params_json` 的参数不得覆盖平台通道。
- `apps/executor-python/tests/test_audit_fixes.py`：同上（含 `1e-7` 浮点指数形态，
  即 A-11 漏掉的那类漂移）。
- `apps/executor-python/tests/test_execute.py`：既有 `AUTOFLOW_FOO=bar` 裸读断言
  在 v5 下仍然成立（该用例此前用旧的 `str(v)` 自算期望值，与实现无强绑定）。
- `packages/autoflow-sdk/tests/test_context.py` 与
  `packages/autocodeflow-node-sdk/src/__tests__/context.test.ts`：类型化通道优先、
  真实类型还原、字符串 `"true"` 不变成布尔、旧执行器回落 + A-11 引号剥离。
- `apps/admin-web/src/__tests__/params-editor.test.tsx`：按值推断类型、文本默认
  不猜测性转换、切换类型后按该类型提交、JSON 解析失败给可见提示且不丢参数。
- `apps/admin-api/src/modules/executor/__tests__/protocol-version-consistency.spec.ts`：
  三端 `PROTOCOL_VERSION === protocol.json currentProtocolVersion`（**本次必红过一次**
  ——A-11 当年漏改的就是这道闸）。
- ADR-005：`apps/executor-node/src` 有改动 → 同 commit 重打 desktop bundle 并回填
  `executor-node-bundle.sha256`。
- 文档同步：`docs/sdk-guide.md`、`docs/app-development-guide.md`、
  `packages/acf-cli/README.md`、`docs/atlas/05-interfaces/cli.md` 及 docs-site 镜像。

## 替代方案（被否）

- **方案 B：只在 SDK 里做类型还原，不改执行器口径**（即"让每个租户自己 `_unwrap`"）。
  否决：`_unwrap` 只有**自研应用**能补。被引号污染的是 env 值本身，而 shell 任务
  （`$AUTOFLOW_X` 拼命令）、node 裸读 `process.env`、第三方 SDK（boto3 读
  `AWS_ACCESS_KEY_ID`）这三类消费方**无法**改写读法。且"每上一个新应用都要重抄
  一遍 `_unwrap`"是**税单会一直增长**的形态——`tk-ship-notify` 已用 12 天静默
  停摆证明了漏抄的代价。需要每租户重复实现才能正确的契约，是平台缺陷。

- **方案 C：只改执行器口径（字符串裸值），不加类型化通道**。
  能救回存量，但**布尔/数字的真实类型永远无法传达到消费方**——用户填的字符串
  `"true"` 与平台传的布尔 `true` 在 env 里不可区分。中台的类型选择器也就失去
  意义（选了布尔也和文本一样）。类型化通道是让这次 UI 改动有意义的前提。

- **方案 D：把整个 params 改成只有 `AUTOFLOW_PARAMS_JSON` 一条通道**（废弃逐键）。
  否决：逐键通道有大量存量消费者（shell、文档示例、第三方 SDK），废弃即破坏性
  变更且无法渐进迁移。两条通道并存、各有明确职责，是本 ADR 的选择。

- **方案 E：按协议版本分派两种语义**（v4 及以前按引号语义、v5 按裸值）。
  否决：**无法实现**——A-11 上线时未 bump 版本，**v4 被两种语义共用**，中台
  仅凭 `protocolVersion === 4` 无法判断该执行器注入的字符串带不带引号。这正是
  本次必须新增 v5 的原因，而不是可用 v4 做分支的理由。

- **方案 F：在 SDK 里猜测性解析逐键值**（凡能 JSON 解析就解析）。
  否决：会把用户填的 `3` 变成数字、`2024-06-01` 变成解析失败、`欧盟` 保持字符串
  ——行为随值的内容而变，且**静默**。用户想要的类型应显式声明（中台类型选择器）
  或从确定无损的通道读取（`AUTOFLOW_PARAMS_JSON`）。

## 关联

- 计划项：A-11R（承接 A-11 / `89f4af45`；生产报障 `tk-ship-notify`）
- 相关 ADR：[ADR-005](./adr-005-bundle-same-commit.md)（同 commit 重打 bundle）、
  [ADR-007](./adr-007-config-first-ownership.md)（多来源配置的优先级必须钉死在
  契约与测试里——本次"两条通道各自职责"同源）、
  [ADR-018](./adr-018-executor-occupied-vs-running.md)（同款协议 bump 纪律：
  中台必须能区分两种上报口径，猜错的方向恰好是危险方向）
- 相关文档：[执行器协议契约](../atlas/01-apps/executor-contract.md) ·
  [SDK 指南](../sdk-guide.md) · [应用开发指南](../app-development-guide.md) ·
  `packages/executor-protocol/protocol.json`（`versioning.compatibilityMatrix` v5 条目）·
  `packages/contract-fixtures/contract.json`（`executorEnvSerializationV2`）·
  `apps/executor-python/js_json.py` · `apps/executor-node/src/param-env.ts`
