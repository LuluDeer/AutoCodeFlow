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

## 修改纪律

- **只能追加向量，不能修改既有向量**——已发布的客户端包按旧向量断言。
- 改动信封/错误体行为本身属于破坏性契约变更：先改 admin-api 源头 + 本文件 `$schemaVersion`，四端同批发布。
