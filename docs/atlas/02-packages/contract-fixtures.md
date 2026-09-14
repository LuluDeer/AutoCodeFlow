# contract-fixtures — 四端共享契约测试向量

> 所属: docs/atlas/02-packages · 最后核对: 2026-09-13 · 对应代码: packages/contract-fixtures

## 职责

`contract-fixtures` **不是可发布包**（目录里没有 package.json / pyproject.toml，只有 `contract.json` + `README.md`），而是四个客户端包共享的**语言无关契约测试向量**（QA-07，单一事实源）。它锁定的契约对象是 admin-api 全局 `ResponseInterceptor`（`apps/admin-api/src/common/interceptors/response.interceptor.ts`）产生的响应信封行为。

**为什么存在**：第八轮"信封拆包"缺陷曾在 acf-cli / mcp-server / 双 SDK 四端各修各的、测试向量漂移。QA-07 把契约固化成一份 JSON，四端测试套件加载同一份文件断言，杜绝再次漂移。

## 契约面（contract.json 顶部字段核实）

1. **envelope**：成功响应一律 `{ code, message: "success", data }`；客户端必须拆出 `data`；`data: null` 拆包结果为 `null`。
2. **passthrough**：非信封形态的 body 原样返回；数组永远不是信封。
3. **2xx 区间**：200..299 一律按成功处理（不只 200）。
4. **错误体 detail 提取顺序**：`message`(string) → `message`(string[], `"; "` 连接) → `error`(string) → 空串；不得吞原始状态码/文本。

## 夹具清单（contract.json 顶层结构核实）

| 键 | 内容 |
|---|---|
| `$schemaVersion` | `1`（破坏性契约变更时 bump） |
| `envelope` | full / arrayData / nullData / non200SuccessCode（201 必须与 200 同样拆包） |
| `passthrough` | plainObject / plainString / emptyObject / arrayBody / stringCodeEnvelope（PK-06 统一后追加：字符串 `code` 不是信封，四端一致透传） |
| `statusRange` | success: [200,201,202,204]、failure: [400,401,403,404,409,429,500,502] |
| `errorBody` | 5 条错误体向量（信封式 message、message 数组、error 字段等） |
| `knownHeuristicEdge` | 已知边界：载荷带**完整** `code+message+data` 三元组会被所有端当信封拆掉——实体载荷绝不能同时携带这三个键（PK-06 统一后判据为「`data` 键 + `code` 数值」，`message` 不再参与判定） |
| `knownDivergence` | **已收敛，条目降级为历史档案**（PK-06 统一批次，2026-09-14）：cli/mcp 2026-09-13（WIKI-OPT-4）收紧为「`data` 键 + `code` 数值」，node/py SDK 2026-09-14 同批跟进——四端判据现完全一致，`data+message` 无 `code` 的载荷四端一致原样保留。向量里 `cli_mcp_unwrapped` 键记录的是收紧前 cli/mcp 宽松启发式的旧行为，已无在发客户端如此表现；测试现统一断言 `node_py_unwrapped_preserved`（四端同值） |

## 被谁消费（以代码核实）

| 包 | 测试文件 | 读取方式 |
|---|---|---|
| acf-cli | `packages/acf-cli/src/__tests__/client.test.ts`（contract-fixtures describe 块） | vitest import JSON |
| mcp-server | `packages/mcp-server/src/__tests__/api.test.ts` | vitest import JSON |
| autocodeflow-node-sdk | `packages/autocodeflow-node-sdk/src/__tests__/contract.test.ts` | jest import JSON |
| autoflow-sdk | `packages/autoflow-sdk/tests/test_contract.py` | pytest `json.loads(pathlib...)` |

对应根命令：`npm run test:cli` / `test:mcp` / `test:node-sdk` / `test:sdk-py`（见根 [package.json](../../package.json)）。docs-site 的 [契约页](docs-site.md) 也把本 README 重组为站点内容。

## 修改纪律（README.md 原文约束，改前必读）

- **只能追加向量，不能修改既有向量**——已发布的客户端包按旧向量断言，改旧向量等于判历史版本"违约"。
- 改动信封/错误体**行为本身**属于破坏性契约变更：先改 admin-api 源头 + 本文件 `$schemaVersion`，四端**同批**发布（正好落在三包 lockstep 发布线上，见 [包生态总览](README.md)）。
- ~~`knownDivergence` 里的分歧是有意保留并记录在案的，不要"顺手统一"——统一它同样是一次契约变更。~~ **已按上述纪律完成统一**（PK-06，2026-09-14，node/py SDK 与已收紧的 cli/mcp 同批对齐，向量仅追加未修改）；条目降级为历史档案。

## 契约要点展开（读向量前先理解）

- **为什么 `data: null` 必须拆成 `null`**：`nullData` 向量钉住"有 `data` 键但值为 null"仍是信封，拆包结果就是 `null`——客户端不得把 null 数据误判为"非信封"。
- **为什么 `non200SuccessCode` 重要**：admin-api 的 `code` 字段镜像 HTTP 状态码，201/202/204 也走信封；若客户端只认 `code===200` 会把创建类响应当失败。
- **数组防线**：`arrayBody` 向量钉住"数组永远不是信封"——早期某端实现曾对数组做 `data in body` 判断而出错。
- **knownHeuristicEdge 的工程含义**：任何 REST 载荷只要同时带 `code+message+data` 三键就会被四端一致拆包；这不是 bug 而是启发式的固有模糊性，用"实体不得携带全三元组"的纪律规避（admin-api 的实体字段名遵守该约定）。
- **knownDivergence 的工程含义（历史）**：统一（2026-09-14）前，宽松启发式（cli/mcp 旧版：`data`+(code|message) 即拆）与严格三元组（双 SDK 旧版：三键齐备才拆）只在 `data+message` 无 `code` 的构造载荷上表现不同；真实流量恒有 `code`，两派等价。统一后判据为「`data` 键 + `code` 数值」，该载荷四端一致保留——向量保留在案供考古，测试统一断言 `node_py_unwrapped_preserved`。

## 消费方式速查（README.md 原文）

```ts
// TS (vitest / jest)
import vectors from '../../contract-fixtures/contract.json';
```

```python
# Python (pytest)
import json, pathlib
vectors = json.loads((pathlib.Path(__file__).parents[2] / "contract-fixtures" / "contract.json").read_text(encoding="utf-8"))
```

## 常见改动场景

**新增一条向量**（如 admin-api 新增了一种错误体形态）：
1. 在 admin-api 落地/确认行为（[响应拦截器](../01-apps/admin-api/README.md)）；
2. `contract.json` 对应区块**追加**新向量（带 `$comment` 说明来源缺陷号/原因）；
3. 四端测试跑一遍（上表四条 npm 命令）——若某端行为不符，修该端实现而不是改向量；
4. 更新本文档的夹具清单行数与"最后核对"。

## 相关文档

- [包生态总览](README.md) · [acf-cli](acf-cli.md) · [mcp-server](mcp-server.md) · [autoflow-sdk](autoflow-sdk.md) · [node-sdk](autocodeflow-node-sdk.md)
- [契约页（docs-site）](docs-site.md) · [发版流程](../08-workflows/release-process.md) · [认证与信任链](../04-flows/security-model.md)（回调 token 侧契约）
- 改 admin-api 的 ResponseInterceptor 前，先读本文件 README 的「修改纪律」并跑四端契约测试。
