# 如何扩展 SDK（双 SDK 同步改）

> 所属: docs/atlas/08-workflows · 最后核对: 2026-09-13 · 对应代码: packages/autoflow-sdk/、packages/autocodeflow-node-sdk/、packages/contract-fixtures/

AutoCodeFlow 有两个任务侧 SDK，**能力面保持对称**，改任何一个都要评估另一侧是否同批改：

| | Python | Node |
|---|---|---|
| 包名 | `autoflow-sdk`（`packages/autoflow-sdk/`） | `@autocodeflow/sdk`（`packages/autocodeflow-node-sdk/`） |
| 源码 | `autoflow_sdk/`：`context.py` `callback.py` `http.py` `logger.py` `models.py` `result.py` | `src/`：`context.ts` `http-client.ts` `logger.ts` `types.ts` `index.ts` |
| 测试 | `tests/`（pytest）：`test_context.py` `test_callback.py` `test_contract.py` 等 | `src/__tests__/`（jest）：`context.test.ts` `contract.test.ts` 等 |
| 本地测试 | `python -m pytest -q`（根：`npm run test:sdk-py`） | `npx jest`（根：`npm run test:node-sdk`） |

## 前置条件

- 已读：[../02-packages/autoflow-sdk.md](../02-packages/autoflow-sdk.md)、[../02-packages/autocodeflow-node-sdk.md](../02-packages/autocodeflow-node-sdk.md)、[../02-packages/contract-fixtures.md](../02-packages/contract-fixtures.md)
- 已读仓库根 `docs/sdk-guide.md`（能力矩阵与两侧行为差异的权威文档）
- 在 `docs/PLAN-CLAIMS.md` 认领（足迹通常同时含两个包目录）

## 步骤（以"新增一个 TaskContext 能力"为例）

### 1. 先查 admin 侧 DTO 契约

SDK 回调字段的最终裁判是 `apps/admin-api/src/modules/task/dto/execution-callback.dto.ts`。node 侧 `src/context.ts` 头注明确写了三方对齐关系（ECO-01）：

```
node src/context.ts 常量 ↔ python autoflow_sdk/callback.py 常量 ↔ admin execution-callback.dto.ts
```

### 2. Python 侧改动

改 `packages/autoflow-sdk/autoflow_sdk/` 对应文件（context 能力 → `context.py`，回调载荷 → `callback.py`，请求/结果模型 → `models.py`/`result.py`）。字段上限常量集中在 `callback.py`：

```python
ERROR_MESSAGE_MAX_LENGTH = 4096   # callback.py L44
LOGS_MAX_LENGTH = 512_000         # callback.py L45
```

### 3. Node 侧对称改动

改 `packages/autocodeflow-node-sdk/src/` 对应文件，常量在 `src/context.ts`：

```ts
export const ERROR_MESSAGE_MAX_LENGTH = 4096;  // context.ts L10
export const LOGS_MAX_LENGTH = 512_000;        // context.ts L11
```

注意两侧**有意的刻意分歧**（不要"顺手统一"）：python 侧对 `failureReason` 做客户端白名单校验（非法值抛 `ValueError`），node 侧是 thin client、交给 admin DTO 校验拒绝——该分歧记录在 `src/context.ts` 的 `ReportFailureOptions` 注释与 `docs/sdk-guide.md`。

### 4. contract-fixtures 是否要动

`packages/contract-fixtures/contract.json` 是**四个客户端包**（acf-cli、mcp-server、双 SDK）共享的契约向量单一事实源，由 `node src/__tests__/contract.test.ts` 与 `python tests/test_contract.py` 两侧消费。规则（见该文件 `$comment`）：

- 向量 **append-only**（已发布客户端要能对旧向量断言）；
- 只改行为不改信封语义 → 通常**无需动**；
- 破坏性契约变更 → 必须 bump `$schemaVersion` 且**四端同批发**。

### 5. 两侧测试都加

```bash
npm run test:sdk-py      # packages/autoflow-sdk pytest
npm run test:node-sdk    # packages/autocodeflow-node-sdk jest
npm run typecheck:node-sdk
```

上限类改动至少各加一条边界断言（真实先例：`context.test.ts` 用 `ERROR_MESSAGE_MAX_LENGTH + 100` 断言截断长度）。

### 6. 版本与发布

三包（双 SDK + `packages/mcp-server`）走 **lockstep 单版本线**（当前 manifest 均为 1.2.0），版本一致性由 release.yml 的 `version-guard` job 强制（四处版本必须与 tag 相等）。版本提升与发布流程见 [release-process.md](release-process.md)，不要手改单包版本不同步发布。

## 验收清单

- [ ] python / node 两侧能力对称（或分歧已写入两侧注释 + `docs/sdk-guide.md`）
- [ ] 字段上限常量两侧数值一致，且与 admin DTO 校验一致
- [ ] contract.json 若动过：`$schemaVersion` 已 bump 且评估过四端影响
- [ ] `npm run test:sdk-py` 与 `npm run test:node-sdk` 全绿，两侧都有新测试
- [ ] `packages/*/CHANGELOG.md` 随 release-please 流程更新（不手写版本号）
- [ ] 认领板行更新状态

## 常见坑

- **只改一侧**：先例 BUG-15（SEC-01 复审）就是双 SDK 一起修的降级/重试问题——单侧修复会在下一次对齐审计里被点名。
- **绕过常量直接写魔法数**：两侧常量是 parity 锚点，新上限要提常量并互相对照注释。
- **动 contract.json 旧向量**：append-only 被破坏会让已发布版本的对账测试失败；要改语义就新增向量 + bump `$schemaVersion`。
- **py 侧 `__init__.py` 版本漏改**：`autoflow_sdk/__init__.py` 的 `__version__` 是 version-guard 的四处检查点之一，漏改 = tag push 直接 fail（release-please 的 python extra-files 会自动同步，人工 bump 时容易漏）。

## 相关文档

- [../02-packages/contract-fixtures.md](../02-packages/contract-fixtures.md) · [../05-interfaces/sdks.md](../05-interfaces/sdks.md)
- [release-process.md](release-process.md) · [task-board/README.md](task-board/README.md)
- 仓库根 `docs/sdk-guide.md`
