# R330 独立验收 —— installId 原始指纹拦截（B3）

验收人：r330-guard-verify  
时间：2026-11-21（Asia/Shanghai）  
写域：仅本文件；未改实现 / spec / baseline。探查用 CodeGraph CLI（MCP 未暴露 `codegraph_explore`）。

## 结论速览

- 功能结论：修复正确。只拦小写 64-hex 原始指纹；32-hex HMAC、`inst-1`、`ttfv-e2e-<uuid>`、大写 hex、带连字符 ID 全部放行。
- P0：无。没有合法 installId 形状被误拦。
- 建议：关闭 B3；无生成物重生成需求。

## 1. 拦截精准

证据（当前源码，CodeGraph node 读取）：

- `apps/admin-api/src/modules/agent/dto/agent-telemetry.dto.ts:25`：`const RAW_FINGERPRINT_RE = /^[0-9a-f]{64}$/;`
- `apps/admin-api/src/modules/executor/executor-fingerprint.util.ts:138`：`const FINGERPRINT_RE = /^[0-9a-f]{64}$/;` —— 两条正则逐字同形。
- DTO `:27-39`：`@ValidatorConstraint({ name: "installIdNotRawFingerprint", async: false })`；`validate()` 对非字符串/空串返回 `true`（fail-open 给 `@IsOptional` / `@IsString`），仅 `RAW_FINGERPRINT_RE.test(value)` 命中时返回 `false`。
- DTO `:37` 默认文案：`installId 不接受原始设备指纹（64 位 hex）；请改传 deviceFingerprint 由服务端派生，或传已派生的匿名 installId` —— 含 `deviceFingerprint` 与 `匿名 installId` 双重引导。
- DTO `:65`：`installId` 在 `@IsOptional` / `@IsString` / `@MaxLength(128)` 之后追加 `@Validate(InstallIdNotRawFingerprintConstraint)`。

结论：符合 PM 裁决，未强制 32-hex。

## 2. 不破坏契约（形状矩阵实测）

脚本：`/tmp/r330-verify/shape-check.cjs`（ts-node + `class-validator.validateSync`，只 require 源码，不改仓库文件）。  
`node /tmp/r330-verify/shape-check.cjs` → `ALL_SHAPES_OK`，exit 0。

| 输入形状 | 期望 | 实测 |
|---|---|---|
| `a`×32（HMAC 32hex） | 放行 | 放行（0 errors） |
| `A`×32 | 放行 | 放行 |
| `inst-1` | 放行 | 放行 |
| `ttfv-e2e-123e4567-e89b-12d3-a456-426614174000` | 放行 | 放行 |
| `A`×64（大写 hex） | 放行 | 放行 |
| `some-hyphen-id-123` | 放行 | 放行 |
| `a`×63 / `a`×65 / `g`×64 | 放行 | 放行 |
| `optIn` only（无 installId） | 放行 | 放行 |
| `a`×64（小写原始指纹） | 拒绝 | 拒绝，逐字文案命中 |
| `x`×129 | 拒绝（既有 MaxLength） | 拒绝 |

补充实测：`deviceFingerprint = "a"×64` 且无 installId → 0 errors；`installId="inst-1"` + 原始指纹 `deviceFingerprint` → 0 errors。原文指纹仍可走既有派生路径，未被新校验波及。

## 3. fail-closed 于真实错配

`validateSync` 对 `{optIn:true, installId:"a"×64}` 返回 1 条错误，constraint 文本与 spec 常量逐字相同。即 B3 的「原始指纹原样落库、与 HMAC 32hex 错配」入口已在 DTO 层堵住。

## 4. 测试有效性（独立反证）

- 基线：`jest src/modules/agent/__tests__/agent-telemetry-consent.spec.ts -t "R330" --runInBand` → 4 passed / 18 skipped，exit 0。
- 反证：把当前 DTO 复制到 `/tmp/r330-verify/agent-telemetry.dto.mirror.ts`，仅删掉 `  @Validate(InstallIdNotRawFingerprintConstraint)` 一行；用 jest `--moduleNameMapper` 把 DTO 导入映射到该镜像（`/tmp/r330-verify/node_modules` 符号链接到 admin-api 依赖解决 TS 解析）。结果：
  - ①「64hex 小写 ⇒ 失败」转红：`expect(installIdError).toBeDefined()` → `Received: undefined`；
  - ②③④ 仍绿；1 failed / 3 passed，exit 1。
- 还原/不伪造：原 DTO sha256 在反证前后均为 `d2a9ec427c0d1fd03abbac4715d6901449a9ea62bf2c8d1359038495457541a3`；spec sha256 始终 `82f4aaa312ba998062fe8ce158f400bf1245730aae0c882ef1a60b37f8181d92`；镜像 sha256 始终 `4539ac19540597f5763743e15e76a36c3e791a7bcdeb82a011578b0edd8f6664`。
- 过程记录（P2，非功能缺陷）：实现方在协调消息到达前曾对源文件做过一次「临时删行 → jest → cp 还原」，最终态相对其落盘初态有纯格式漂移（class 声明由 3 行折为 1 行，162→160 行），语义与正则、文案、装饰器均不变；我已对最终态重跑全部形状与反证，结论不受影响。

## 5. 守卫与生成物

| 命令 | 结果 |
|---|---|
| `cd apps/admin-api && npx jest src/modules/agent/__tests__/agent-telemetry-consent.spec.ts -t "R330" --runInBand` | 4 passed，exit 0 |
| `cd apps/admin-api && npx jest --runInBand --silent`（首次） | 进程 OOM（heap 4096MB）exit 134；属本机内存/运行方式问题，非断言失败；已改按官方 `npm test` 重跑，见下 |
| `cd apps/admin-api && npm test -- --silent` | 见文末「全量单测」 |
| `cd apps/admin-api && npm run build` | BUILD_EXIT=0 |
| `npm run lint:api` | LINT_EXIT=0 |
| `npm run check:api-reference` | exit 0（232 路径全覆盖，附录与 openapi 逐字节一致） |
| `npm run check:api-i18n` | exit 0（1865 个中文节点全有英文） |
| `npm run check:response-schema` | exit 0（覆盖 255/269，与基线一致） |

Swagger：`@ApiPropertyOptional` 描述未改（仍为「不透明的安装标识；优先于设备指纹」）。`apps/admin-api/openapi.json` mtime 22:32，早于本次切片落盘；`check:api-reference` / `check:api-i18n` 全绿。**无需重生成 openapi / api-reference / api-i18n，未自行跑生成链。** 构建 prebuild 重写 `install-script.content.ts` 的 mtime，但内容 `git diff` 为空。

## 诚实边界

验收级别为「单测 / 内存替身 + class-validator validate()」，未做真 HTTP 400 响应验证（任务允许降级，且 validate() 已覆盖 DTO 契约）。未覆盖真实 PG 持久化副作用；该切片本身不改持久化逻辑。

## 全量单测

`cd apps/admin-api && npm test -- --silent`（官方脚本，4 workers）：

```text
Test Suites: 2 skipped, 509 passed, 509 of 511 total
Tests:       6 skipped, 8601 passed, 8607 total
Snapshots:   0 total
Time:        211.572 s
FULL_JEST_DEFAULT_EXIT=0
START sha=d2a9ec427c0d1fd03abbac4715d6901449a9ea62bf2c8d1359038495457541a3
END   sha=d2a9ec427c0d1fd03abbac4715d6901449a9ea62bf2c8d1359038495457541a3
```

首次 `--runInBand` 的 OOM 已通过该官方脚本复跑消解；起止 sha 一致，证明全量单测期间实现文件未变。
