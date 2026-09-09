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

`contract.json` 的 `knownDivergence` 条目留档一处差异：cli/mcp 用宽松的
`data+(code|message)` 启发式拆包，node-sdk/py-sdk 要求严格的
`code+message+data` 三元组。**admin-api 恒发 code，真实流量不受影响**；
不要依赖宽松形态——四端统一属破坏性契约变更，需同批发版。

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
| `logs` | 阶段性摘要（截断 512 KB） |
| `errorMessage` | 失败信息（截断 4 KB） |
| `failureReason` | 失败分类枚举（py 客户端白名单校验；默认 `script_error`） |
| `exitCode` | 进程退出码（可选，int） |
| `durationMs` | 耗时毫秒 |
| `artifacts` | 产物清单（FEAT-05，best-effort 至多 20 条，终态回调时落盘 manifest） |

per-execution token（`AUTOFLOW_CALLBACK_TOKEN`）仅授权本 `executionId`
的回调，越权或过期一律 401（fail-closed）；执行器共享 token 绝不进入
任务子进程（SEC-01）。
