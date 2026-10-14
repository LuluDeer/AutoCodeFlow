# contract-fixtures（QA-07）

AutoCodeFlow 四个客户端包（`acf-cli`、`mcp-server`、`autocodeflow-node-sdk`、`autoflow-sdk`）的**共享契约测试向量**——单一事实源。

## 背景

第八轮「信封拆包」缺陷曾在四端各修各的，测试向量各自漂移。QA-07 把契约固化为语言无关的 `contract.json`，四端测试套件加载**同一份文件**断言，防止再次漂移。

## 契约面

信封源头是 admin-api 的全局 `ResponseInterceptor`（`apps/admin-api/src/common/interceptors/response.interceptor.ts`）：

1. **envelope**：成功响应一律 `{ code, message: "success", data }`；客户端必须拆出 `data`，`data: null` 拆包结果为 `null`。
2. **passthrough**：非信封形态的 body 原样返回（数组永远不是信封）。
3. **2xx 区间**：200..299 一律按成功处理。
4. **错误体 detail 提取顺序**：`message`(string) → `message`(string[], `"; "` 连接) → `error`(string) → 空串（不得吞原始状态码/文本）。

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

现有消费点：

| 包 | 测试文件 |
|---|---|
| acf-cli | `packages/acf-cli/src/__tests__/client.test.ts`（contract-fixtures describe 块） |
| mcp-server | `packages/mcp-server/src/__tests__/api.test.ts`（同上） |
| autocodeflow-node-sdk | `packages/autocodeflow-node-sdk/src/__tests__/contract.test.ts` |
| autoflow-sdk | `packages/autoflow-sdk/tests/test_contract.py` |
| executor-node / executor-python（A-11 env 序列化 + A-LOG 日志行切分） | `apps/executor-node/src/__tests__/executor-protocol-contract.spec.ts`；`apps/executor-python/tests/test_audit_fixes.py`（A-11R）、`apps/executor-python/tests/test_logs.py`（A-LOG） |

## params → env 的序列化契约（executorEnvSerialization / V2）

`executorEnvSerialization` 段是 **A-11（2026-10-02）旧语义的历史档案**——字符串
也会被 JSON 序列化（带上一对首尾双引号）。那正是 A-11 生产回归的形态：中台
`ParamsEditor` 的契约是 `Record<string,string>`，于是经控制台配置的每个参数都
多了引号，按官方文档裸读的脚本直接报错（生产实证：`tk-ship-notify` 静默停摆
12 天）。该段按 append-only 纪律冻结保留，**不再对实现断言**。

在用语义在 **`executorEnvSerializationV2`** 段（A-11R，2026-10-14）：

| | 逐键通道 `AUTOFLOW_<KEY>` | 类型化通道 `AUTOFLOW_PARAMS_JSON` |
|---|---|---|
| 字符串 | **裸值**（`欧盟`，不加引号） | 一份 JSON 里按真实类型 |
| 布尔/数字/null/容器 | JSON 字面量（`true`/`3`/`null`/`[1,"a"]`） | 同上 |
| 空 / 缺省 params | 无 | **不注入**（缺席比空值更清楚） |
| 消费方 | 直读 env 的脚本、shell 任务、第三方 SDK | 两个 SDK 的类型还原 |

`AUTOFLOW_PARAMS_JSON` 存在的唯一理由：逐键通道的值恒为**字符串**，原理上无法
区分字符串 `"true"` 与布尔 `true`。它在逐键循环之后注入（用户参数不得覆盖平台
变量）。

字节一致（parity）现在是**事实**而非声明：python 不再用 `json.dumps`（其浮点
排版与 `JSON.stringify` 不同——`1e-7` 曾渲染成 `1e-07`、`0.00001` 成 `1e-05`，
对象键序也是纯插入序），改由 `apps/executor-python/js_json.py` 实现
`JSON.stringify` 自身规则，包括 JS 的整数键排序。向量里的浮点指数、大整数与
整数键序条目正是原 10 条向量漏掉的形态。

## 修改纪律

- **只能追加向量，不能修改既有向量**——已发布的客户端包按旧向量断言。
- 改动信封/错误体行为本身属于破坏性契约变更：先改 admin-api 源头 + 本文件 `$schemaVersion`，四端同批发布。
