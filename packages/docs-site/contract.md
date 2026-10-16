# 回调与信封契约（contract-fixtures）

> 重组自 [packages/contract-fixtures/README.md](https://github.com/LuluDeer/AutoCodeFlow/blob/develop/packages/contract-fixtures/README.md)。

`contract-fixtures` 是 AutoCodeFlow 四个客户端包（`acf-cli`、
`mcp-server`、`autocodeflow-node-sdk`、`autoflow-sdk`）的**共享契约测试
向量**——单一事实源。

## 背景

第八轮「信封拆包」缺陷曾在四端各修各的，测试向量各自漂移。QA-07 把契约
固化为语言无关的 `contract.json`，四端测试套件加载**同一份文件**断言，
防止再次漂移。

## 契约面

信封源头是 admin-api 的全局 `ResponseInterceptor`
（`apps/admin-api/src/common/interceptors/response.interceptor.ts`）：

1. **envelope**：成功响应一律 `{ code, message: "success", data }`；
   客户端必须拆出 `data`，`data: null` 拆包结果为 `null`。
2. **passthrough**：非信封形态的 body 原样返回（数组永远不是信封）。
3. **2xx 区间**：200..299 一律按成功处理。
4. **错误体 detail 提取顺序**：`message`(string) → `message`(string[],
   `"; "` 连接) → `error`(string) → 空串（不得吞原始状态码/文本）。

## 消费方式

```ts
// TS (vitest / jest)
import vectors from '../../contract-fixtures/contract.json';
```

```python
# Python (pytest)
import json, pathlib
vectors = json.loads((pathlib.Path(__file__).parents[2] / "contract-fixtures" / "contract.json").read_text(encoding="utf-8"))
```

| 包 | 测试文件 |
|---|---|
| acf-cli | `packages/acf-cli/src/__tests__/client.test.ts`（contract-fixtures describe 块） |
| mcp-server | `packages/mcp-server/src/__tests__/api.test.ts`（同上） |
| autocodeflow-node-sdk | `packages/autocodeflow-node-sdk/src/__tests__/contract.test.ts` |
| autoflow-sdk | `packages/autoflow-sdk/tests/test_contract.py` |

## 已知分歧（knownDivergence）

**该分歧已于 2026-09-14（PK-06 统一批次）关闭。** 统一后四端（acf-cli /
mcp-server / autocodeflow-node-sdk / autoflow-sdk）的信封拆包判据一致：
**载荷是对象、含 `data` 键、且 `code` 为数值**（对齐 admin-api
ResponseInterceptor 的 `code = statusCode ?? 200` 恒数值语义），
`message` 是否存在不再参与判定。

- 字符串 `code`（如 `{code:"200",message:"x",data:{...}}`）不是信封，
  四端一致原样透传——由 `passthrough.stringCodeEnvelope` 向量钉住。
- `knownDivergence` 条目保留为历史档案：其 `cli_mcp_unwrapped` 键记录的
  是 2026-09-13 之前 cli/mcp 宽松启发式（`data+(code|message)` 即拆）的
  旧行为，已无任何在发客户端如此表现；`data+message` 无 `code` 的载荷
  现在四端一致保留。

## 参数注入契约（params → env）

`executorEnvSerialization` 段是 **A-11（2026-10-02）旧语义的冻结档案**：字符串也会
被 JSON 序列化（带首尾双引号）。那正是生产回归的形态——中台 `ParamsEditor` 的
契约是 `Record<string,string>`，于是经控制台配置的每个参数都多了一对引号，按本文
「注入的环境变量」表裸读的脚本直接报错（生产实证：`tk-ship-notify` 静默停摆
12 天）。该段按 append-only 纪律保留，不再对实现断言。

在用语义在 **`executorEnvSerializationV2`** 段（A-11R，2026-10-14；协议 v5）：

| | 逐键通道 `AUTOFLOW_<KEY>` | 类型化通道 `AUTOFLOW_PARAMS_JSON` |
|---|---|---|
| 字符串 | **裸值**（`欧盟`，不加引号） | 一份 JSON 里按真实类型 |
| 布尔/数字/null/容器 | JSON 字面量（`true`/`3`/`null`/`[1,"a"]`） | 同上 |
| 空 / 缺省 params | 无 | **不注入** |

`AUTOFLOW_PARAMS_JSON` 存在的唯一理由：逐键通道的值恒为**字符串**，原理上无法
区分字符串 `"true"` 与布尔 `true`。它在逐键循环之后注入（用户参数不得覆盖平台
变量）。字节一致现在是事实：python 改由 `js_json.py` 实现 `JSON.stringify` 自身
规则（浮点指数排版与 JS 整数键序），不再用 `json.dumps`（`1e-7` 曾渲染成 `1e-07`）。

## 修改纪律

- **只能追加向量，不能修改既有向量**——已发布的客户端包按旧向量断言。
- 改动信封/错误体行为本身属破坏性契约变更：先改 admin-api 源头 + 本文件
  `$schemaVersion`，四端同批发布。

## 回调契约（CallbackItemDto）

`POST {AUTOFLOW_ADMIN_API_URL}/api/executions/callback`，请求体为
`CallbackItemDto[]`：

| 字段 | 说明 |
|------|------|
| `executionId` | 必填（SDK 自动补齐本执行） |
| `status` | `success` \| `failed` |
| `executorAddress` | 执行器注册地址（SDK 自动补齐，缺省不发送空串） |
| `deviceFingerprint` | 稳定安装身份（协议 v6 起，可选）：SDK 从环境变量 `AUTOFLOW_DEVICE_FINGERPRINT` 读取并**自动补齐**，与执行器 register/heartbeat 上报的是同一个值。**它是回调的行身份**——当两台执行器共用同一 `executorAddress`（pull 模式允许，见 ADR-017 §5）时，仅靠地址无法判断回调来自哪一行。服务端按「指纹 → 凭据归属行 → 地址」三级阶梯判定归属；**缺省时逐级回落，绝不会因缺少该字段拒绝合法回调**。采集失败时不发送该键（不是发空串/`null`） |
| `logs` | 阶段性摘要（截断 512 KB） |
| `errorMessage` | 失败信息（截断 4 KB） |
| `failureReason` | 失败分类枚举（py 客户端白名单校验；默认 `script_error`）。**执行器可上报子集**为 admin 全集减去 admin 内部专用的 `stale_recovered`——上报它会被 DTO 的 `@IsIn` 拒绝，且一个非法取值会拒掉**整批**回调。取值清单单一事实源：`packages/executor-protocol/protocol.json` |
| `exitCode` | 进程退出码（可选，int） |
| `durationMs` | 耗时毫秒 |
| `artifacts` | 产物清单（FEAT-05，best-effort 至多 20 条，终态回调时落盘 manifest） |
| `result` | 结构化执行留痕（可选，JSON 对象，序列化后 ≤4 KB、嵌套 ≤6 层，原样落库 `task_executions.result`）。`python_task_multiversion` 起承载解释器快照 `{interpreter: {requested, resolved, reason, detail, pool}}`——解释器不可用时运维据此判断"请求了哪个版本 / 池里有什么"，无需重跑任务。**只在非空对象时写入**：缺省不会把已有值覆盖成 null（旧执行器不发送该字段） |

per-execution token（`AUTOFLOW_CALLBACK_TOKEN`）仅授权本 `executionId`
的回调，越权或过期一律 401（fail-closed）；执行器共享 token 绝不进入
任务子进程（SEC-01）。
