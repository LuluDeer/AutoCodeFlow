# ADR-029：出站地址闸的「元数据地址恒拒」契约段（`networkPolicy.metadataAddresses`）

> 状态：**已接受**（2026-11-05，Lead 裁定 R07 方案②）· 决策人：Lead · 实施：R08
> 相关：ADR-026（条件状态写）无关联；本 ADR 涉及 `packages/executor-protocol/protocol.json`
> 与 admin-api / executor-node / executor-python 三端出站 SSRF 闸。

## 0. 一句话

把「**真正要恒拒的云元数据地址**」从 `restricted` 类里**拆出来单列**为契约段
`networkPolicy.metadataAddresses`，语义是 **任何 posture、任何开关状态都 DENY**，
三端（admin-api / executor-node / executor-python）**都从该契约段派生**、不各抄一份地址表。

## 1. 动机：契约自相矛盾（R07 实测，不是推理）

R07 按「先契约后实现」核查 `policy:'webhook'` 面，发现：

| 命题 | 证据（基线 `a316155c`） |
|---|---|
| webhook 面的契约是「`restricted` **随开关放行**」 | `docs/deployment.md:197-199`、`docs/api-reference.md:1021`、`apps/admin-api/src/common/utils/safe-http.util.ts:44-52` docstring |
| 同一份契约又承诺「**云元数据恒拒**」 | 同上（`deployment.md:197/199` 原话） |
| 而阿里云元数据**就在** `restricted` 里 | 实跑 `classifyAddressRisk("100.100.100.200") === "restricted"` |
| ⇒ 三个 webhook 开关任一开启即可达 | 实跑矩阵 `webhook-on: allow`（`artifacts/autonomy/R07/probe-posture-matrix.mjs`） |

同族扫描还确认：admin 三个姿态里，**执行器面**（`safe-http.util.ts:104-107`）与 **git 面**
（`assertSafeGitRepoUrl`，`:707+`）都已**恒拒** `restricted`，**只有 webhook 面放行**——
而"放行"是文档明写的。⇒ 问题不在"哪个姿态写错了"，而在**「元数据」与「restricted」被混为一类**：
`restricted` 里同时装着「合法的内网拓扑」（Tailscale `100.64/10`、RFC2544 基准段）与
「必须恒拒的云元数据端点」（阿里云 `100.100.100.200`）。

三个候选方案（R07 评估）：
- ① webhook 面 `restricted` 改恒拒 —— **否决**：会打断 Tailscale 合法用户（破坏性、无契约依据）；
- ③ 改文档降级「云元数据恒拒」承诺 —— **否决**：安全承诺降级；
- ② 拆出元数据地址单列恒拒 —— **采纳**：语义更准、不破坏任何合法拓扑、三端可同读。

## 2. 契约段形状

`packages/executor-protocol/protocol.json` → `networkPolicy.metadataAddresses`：

```json
"metadataAddresses": {
  "$comment": "<语义、判定顺序、来源与扩展规则，见下>",
  "addresses": ["100.100.100.200/32"]
}
```

**语义（三条，写进 `$comment` 并被三端实现与判据共同约束）**：

1. **恒拒**：列出的地址**任何 posture（executor / webhook / git）× 任何开关状态**都 DENY；
   没有"开关可解锁"这一档。
2. **判定顺序**：必须在**风险分类之前**（`classifyAddressRisk` / `classify_restricted_*` 之前）
   先判元数据 —— 否则开关仍能把它放行（这正是 R07 缺陷的成因）。
3. **取代关系**：本段**取代** docstring/文档里「`restricted` 随开关放行」对**元数据地址**的模糊覆盖；
   `restricted` 对**非元数据**成员（Tailscale CGNAT、RFC2544）的语义**保持不变**。

**基线成员与扩展规则**：首版只有 `100.100.100.200/32`（阿里云 ECS 元数据，实测落在 `100.64/10`）。
新增成员**必须**同时满足：① 有公开文档证明它是云元数据/凭据端点；② 有测试覆盖（三端各一条）；
③ 在 `$comment` 里写明来源。**不收录**「只是内网地址」的条目——那是 `private-lan` 的事。

> 已知且**本 ADR 不处理**：`192.0.0.192`（Oracle Cloud 元数据）当前被分类为 `public`，
> 根因是**分类器**缺 `192.0.0.0/24`（契约 `reserved` 已含该类，属"分类器与契约不一致"），
> 与"元数据地址表"是两条不同的修法 ⇒ R09 独立立项。

## 3. 三端同读方案（怎么避免各写一份常量）

**单一事实源 = `protocol.json`**，三端各自读**生成物**（不手写地址表）：

| 端 | 生成物 | 由谁生成 |
|---|---|---|
| admin-api | `apps/admin-api/src/generated/protocol-metadata-addresses.ts`（`METADATA_ADDRESSES`） | `scripts/generate-executor-protocol.mjs`（既有生成器，扩展） |
| executor-node | `apps/executor-node/src/generated/protocol-metadata-addresses.ts`（同形状） | 同上 |
| executor-python | `apps/executor-python/generated/protocol_metadata_addresses.py`（`METADATA_ADDRESSES`） | 同上 |

漂移防守：
- `check:protocol-sync`（既有守卫）= `npm run gen:protocol && git diff --exit-code -- <生成物目录>`；
  本轮把 **`apps/admin-api/src/generated`** 也纳入 diff 路径 ⇒ 三端生成物**同时**被钉住
  （改契约忘了重新生成 ⇒ 红；手改生成物 ⇒ 红）。
- 三端各自的测试各有一条「元数据地址恒拒」用例（admin: `ssrf-deny-matrix.spec.ts`；
  node: `ssrf-deny-parity.spec.ts` / `ssrf-guard.spec.ts`；python: `tests/test_ssrf_guard.py`）。
- **已知覆盖缺口（如实）**：`check:ssrf-deny-parity` 目前只比对**两端**
  （admin 矩阵 ↔ executor-node 的 parity spec），**python 不在该守卫面内**。
  本轮不为它扩面（那需要另立判据与 python 侧 parity 清单文件）；改由 python 自己的 pytest 覆盖，
  缺口登记在 `AGENT-SWARM-PLAYBOOK.md §7.7`。

## 4. 影响面

| 谁 | 影响 |
|---|---|
| **用 `AI_ALLOW_PRIVATE_NETWORK` / `EVENT_WEBHOOK_ALLOW_PRIVATE_NETWORK` / `NOTIF_ALLOW_PRIVATE_NETWORK` 打 `100.100.100.200` 的部署** | **行为变更**：从「开关开启即可达」变成「恒拒」。这是**安全收紧**，正常部署不会把云元数据当 webhook 目标 ⇒ 视为修正而非兼容性破坏，但仍按"用户可见行为变更"补 `docs/UPGRADING.md` 段 |
| Tailscale（`100.64/10`）/ RFC2544 基准段用户 | **不受影响**（`restricted` 语义未动） |
| 内网执行器（R05 的 `EXECUTOR_ALLOW_PRIVATE_NETWORK`） | **不受影响**（`private-lan` 未动） |
| executor-node / executor-python | 各加一次「元数据先判」的分支；生成物 +2 文件（不改变线缆协议，不 bump 协议版本） |

**协议版本**：本段是**收紧**（只会多拒，不会让任何原本被拒的地址变通）且不改线缆载荷形状 ⇒
按 `versioning.evolutionRules` **不 bump** `currentProtocolVersion`。

## 5. 回滚路径

- 单提交 `git revert <R08 sha>`：一次回退契约段 + 三端生成物 + 三端用法 + 文档。
- **向后兼容说明（契约段可空数组）**：把 `metadataAddresses.addresses` 改成 `[]`
  ⇒ 三端生成物为空数组、判定函数恒返回 `false`，行为**退化回 R07 之前**
  （webhook 面 `restricted` 仍随开关放行）。即"清空数组"是**不需要改代码**的软回滚档。
  注意：`check:protocol-sync` 会要求重新生成，且三端测试会红（它们断言元数据恒拒）
  ⇒ **软回滚 = 同时改测试**，正式回滚仍建议 `git revert`。
- 无 schema / 迁移 / 数据变更；无公共 API 形状变更（仅错误发生条件收紧）。

## 6. 判据（本 ADR 的验收，落在代码里）

1. **红（未实现时）**：`apps/admin-api: npm test -- --testPathPatterns ssrf-deny-matrix`
   ⇒ `✕ webhook 姿态：开关开启也拒（R07 的裁决点）`，**exit 1**；
2. **绿**：同一命令 **exit 0**；`check:protocol-three-way` **exit 0** 且 selftest **N → N+k**；
3. `check:ssrf-deny-parity` **exit 0**（两端面；python 由 pytest 覆盖，缺口见 §3）；
4. `check:protocol-sync` **exit 0**（三端生成物 ≡ 契约）；
5. 文档三处口径统一 + `docs/UPGRADING.md` 补段（`check:upgrade-notes` 咬合）。
