# ADR-032: python 执行器出站闸的「开关姿态」与契约对齐

状态：Proposed
- 日期：2026-11-05
- 决策来源：R61-W4（承接 R59-W4 的实测发现；R59 只修了元数据恒拒表，姿态差异当时登记为遗留）
- 本轮范围：**只写 ADR + 索引行，零业务代码**

## 动机

`packages/executor-protocol/protocol.json` 的 `networkPolicy.switch.semantics` 只有一句话：
**开关开启 ⇒ 放行 privateIPv4；其余一律仍拒**。但 python 执行器出站闸的开关档是另一种语义：

```text
开关开启 ⇒ 放行「一切非 loopback 的受限地址」
```

两句话的差集落在五类地址上：`linkLocal` / `cgnat` / `unspecified` / `multicast` / `reserved`。
其中 `linkLocal` 按契约自己的 `addresses.linkLocal.description` **包含云元数据**
（`169.254.169.254` = AWS/GCP/Azure 实例元数据；`fd00:ec2::254` = AWS IPv6 元数据）。
⇒ 实测后果：`EXECUTOR_ALLOW_PRIVATE_NETWORK=true` 的 python 执行器**可以 clone / 下载
云元数据端点**（同机凭据面），而同一份契约在 admin 执行器姿态与 node 的 gitRepo 面是拒的。

这不是「python 缺测试」而是**三端两种安全承诺**，且同一字段（`task.gitRepo`）在两端结论相反：

| `task.gitRepo` 主机（开关开启） | node（`assertGitRepoNetworkPolicy`） | python（`_package_url_host_denied`） |
| --- | --- | --- |
| `10.0.0.5`（RFC1918） | 放行 | 放行 |
| `169.254.169.254`（云元数据） | **400 拒绝** | **放行并 clone** |
| `100.64.0.1`（CGNAT / Tailscale） | **400 拒绝** | **放行并 clone** |
| `0.0.0.0` / `224.0.0.1` | **400 拒绝** | **放行** |

R59-W4 已经把「契约恒拒表」（`metadataAddresses` 的两条字面量）在 python 闸门上钉死，
但**恒拒表只覆盖了两个厂商的元数据端点**，`169.254.169.254` 这类非表内 linkLocal 元数据
仍在口子里。要一次关掉，只能把闸门的**放行表**换成契约自己的那一张。

## 事实（先取证，再决策）

python 闸门只有一个判据函数 `apps/executor-python/routers/execute.py:2155`，开关档在
`apps/executor-python/routers/execute.py:2196`（`return _host_is_loopback(host)`）——
即「受限 ⇒ 开关开 ⇒ 除 loopback 外一律放行」。它被三条真实出站通道共用：

- packageUrl 首跳：`apps/executor-python/routers/execute.py:2208`（`_assert_safe_package_url`）
- packageUrl 逐跳重定向复检：`apps/executor-python/routers/execute.py:2507`
- gitRepo 地址闸：`apps/executor-python/routers/execute.py:2311`（`_validate_git_repo_task`）

同一模块里**已经存在**契约口径的判定函数，只是闸门没消费它：
`apps/executor-python/network_policy.py:347`（`category_allowed`：唯一解锁 `privateIPv4`）、
`apps/executor-python/network_policy.py:244`（`host_safety_verdict`：R59 引入，恒拒表优先）。

三端 / 五面的现状（开关**开启**）：

| 契约地址类 | admin 执行器 `apps/admin-api/src/common/utils/safe-http.util.ts:111` | admin webhook `apps/admin-api/src/common/utils/safe-http.util.ts:91` | node gitRepo `apps/executor-node/src/git-repo-network-policy.ts:101` | node 下载面 `apps/executor-node/src/lib/ssrf-guard.ts:359` | python 三通道 `apps/executor-python/routers/execute.py:2155` |
| --- | --- | --- | --- | --- | --- |
| public | 放行 | 放行 | 放行 | 放行 | 放行 |
| privateIPv4 | 放行 | 放行 | 放行 | 放行 | 放行 |
| loopback | 拒 | 放行 | 拒 | 放行 | 拒 |
| linkLocal | 拒 | 拒 | 拒 | **放行** | **放行** |
| cgnat | 拒 | 放行（admin 把 `100.64/10` 并入 `restricted` 组） | 拒 | **放行** | **放行** |
| unspecified / multicast / reserved（非恒拒表） | 拒 | 拒 | 拒 | **放行** | **放行** |
| 契约恒拒表 `metadataAddresses` | 拒 | 拒 | 拒 | 拒 | 拒（R59 已修） |

⇒ **「两种承诺」**：契约口径 = {admin 执行器, node gitRepo}；宽松口径 = {admin webhook, node 下载面,
python 三通道}。python 是唯一一个**连 gitRepo 面也走宽松口径**的端 —— 这就是本节开头那张表的来源。

宽松口径内部也**并不一致**（admin webhook 只多放 loopback 与 `restricted`；node 下载面与 python 放行
除恒拒表外的全部），但它们的共同点是**都与契约的「开关只放行 privateIPv4」冲突**。本 ADR 只负责把
python 收回到契约那一侧；宽松口径之间的互相对齐不在本轮（见「明确不做」第 4 条）。

现状被两条用例**明确钉住**（不是遗漏，是有意为之，改它必须走本 ADR）：

- `apps/executor-python/tests/test_execute.py:3618`：`assert _package_url_host_denied('169.254.169.254') is False`
  —— 在开关开启态断言**云元数据地址放行**。
- `apps/executor-python/tests/test_execute.py:3500`：302 重定向到 `169.254.169.254` 在开关开启态
  **跟随成功**（断言在 `apps/executor-python/tests/test_execute.py:3522`），docstring 写明
  「钉住放行，任何收紧都必须是有意识的决定（改这条用例）」。

`node lib/ssrf-guard.ts:350` 与 admin `safe-http.util.ts:132` 都已经有「元数据先于开关」的前置判定，
`apps/executor-python/network_policy.py:244` 是 python 侧的同款（R59 落地）；本 ADR 处理的是**其余五类**。

## 方案

### 决策 1（核心）：闸门的放行表换成契约那张表

`_package_url_host_denied` 的开关档从「非 loopback 则放行」改成「`category_allowed`」：

```python
def _package_url_host_denied(host: str) -> bool:
    restricted, category, metadata_hit = network_policy.host_safety_verdict(host)
    if metadata_hit:                      # ADR-029：恒拒表优先，先于开关、先于一切
        return True
    if not restricted:
        return False
    return not network_policy.category_allowed(
        category, allow_private=bool(getattr(settings, 'allow_private_network', False))
    )
```

等价改写（逐类对照，契约 `addresses` 七类 + 恒拒表）：

| 类 | 开关关闭 | 开关开启 | 改动 |
| --- | --- | --- | --- |
| public | 放行 | 放行 | 无 |
| privateIPv4 | 拒 | 放行 | 无 |
| loopback | 拒 | 拒 | 无（既有 ADR 的收紧被 `category_allowed` 天然保留） |
| linkLocal | 拒 | **拒**（原：放行） | **收紧** |
| cgnat | 拒 | **拒**（原：放行） | **收紧** |
| unspecified | 拒 | **拒**（原：放行） | **收紧** |
| multicast | 拒 | **拒**（原：放行） | **收紧** |
| reserved | 拒 | **拒**（原：放行） | **收紧** |
| 恒拒表 | 拒 | 拒 | 无（R59 已如此） |

### 决策 2：判定顺序固定为「恒拒表 → 分类 → 开关」

契约 `networkPolicy.metadataAddresses.enforcement = "deny-before-classification"`。
顺序写成三档，任何后续改动不得调换：

```text
① metadata_hit            ⇒ DENY（任何姿态、任何开关）
② restricted == False     ⇒ ALLOW（公网）
③ category_allowed(类别)  ⇒ 唯一可能放行 privateIPv4
```

### 决策 3：主机名解析到受限类的那条路

python 闸门对主机名做真实解析（契约 `resolution.mode = "dns-resolve"`，fail-closed）。
现状 `host_safety_verdict` 只返回**第一个**受限类别 ⇒ 多答案 `[10.0.0.5, 169.254.169.254]`
会拿到 `privateIPv4`（开关开 ⇒ 放行），而 node 的 gitRepo 面对解析结果**逐地址**判、
任一不通过即拒（`apps/executor-node/src/git-repo-network-policy.ts:133`）。
⇒ 新增 `network_policy.host_denied_under_policy(host, allow_private, resolver=None)`：
逐解析地址跑 `category_allowed`，任一拒即拒；解析失败仍 fail-closed。闸门改为调用它。

### 决策 4：灰度开关与默认值

引入 `PY_EXECUTOR_SWITCH_POSTURE_STRICT`（读进 `apps/executor-python/config.py` 的 Settings）：

- **默认 `1`（严格 = 本 ADR 的口径）**。理由：契约的 `switch.semantics` 已经承诺「只放行 privateIPv4」，
  默认宽松等于「承诺是假的」；且本仓已有先例（R05 让 admin 执行器姿态直接按契约收口，代价是
  「内网执行器必须显式 `EXECUTOR_ALLOW_PRIVATE_NETWORK=true`」）。
- **`0` 作为回滚逃生阀**：只为中国区实测的合法内网拓扑（Tailscale `100.64/10`、链路本地文件服务）
  留一条不改版本的退路，运行期生效（无需发版）。
- **到期条件（必须写进下一步计划）**：R62 删除该开关并固定严格；届时 `=0` 退路不再可用。
  理由：本仓反复用的棘轮纪律 —— **逃生阀必须回收**，否则它会变成第二种永久姿态，
  与「三端两种承诺」的成因一模一样。

## 影响面

**要改的既有用例（其余保持绿）**

| 位置 | 现状 | 改法 |
| --- | --- | --- |
| `apps/executor-python/tests/test_execute.py:3618` | 开关开启态断言 `169.254.169.254` **放行** | 改断言为 `is True`（拒绝），注释指向本 ADR |
| `apps/executor-python/tests/test_execute.py:3500` | 302→`169.254.169.254` 开关态**跟随成功** | 改成「开关态也拒绝」，用例改名 `..._rejected_even_with_switch_on` |
| `apps/executor-python/tests/test_execute.py:3596` | 末段注释「私网/元数据随开关」 | 注释改为「私网随开关；其余五类任何开关都拒」 |

保持绿：`apps/executor-python/tests/test_zip_channel.py:622`（默认姿态全拒）、
`apps/executor-python/tests/test_zip_channel.py:637`（loopback 恒拒）、
`apps/executor-python/tests/test_ssrf_guard.py:50`、以及 R59 新增的
`apps/executor-python/tests/test_network_policy_metadata_parity.py:219`（恒拒表恒拒）。
只有 RFC1918 的 gitRepo 用例（`apps/executor-python/tests/test_execute.py:3482`）零变化。

**失效半径（谁会被影响）**

- 受影响：**设了** `EXECUTOR_ALLOW_PRIVATE_NETWORK=true`，且出站目标是
  `cgnat`（Tailscale `100.64/10`）、`linkLocal`（`169.254.x` / `fe80::/10` / `fd00::/8`）、
  `unspecified`、`multicast`、`reserved`（含 `198.18/15` RFC2544、`240/4`）的部署 ——
  这些目标将从「可用」变成 400 / 下载失败。
- 不受影响：RFC1918 三段（文档化的内网 GitLab/Gitea 拓扑）、公网、loopback（本来就恒拒）。
- 收益：关闭 python → 云元数据的通道（`169.254.169.254`、`fd00:ec2::254`），
  并让 `task.gitRepo` 在 node / python 两侧结论一致（此前同请求两端相反）。

**跨端后果（必须在下一轮处理，不在本轮）**

python 收紧后会**比 node 下载面更严**（node `apps/executor-node/src/lib/ssrf-guard.ts:359`
仍是 `if (allow) return`）。处理方式只有两条，都不在本轮写域：

1. node 下载面同样改成 `categoryAllowed`（推荐，与 gitRepo 面同构）；
2. 或在 `scripts/protocol-four-way-allowlist.json` 登记 `grid:linkLocal@on:node` 等格子（`scripts/` 域）。

**守卫面**

- `scripts/check-protocol-three-way.mjs` 的 python 探针是**建模**（按 `category_allowed` 推算），
  不是真跑闸门 ⇒ 本轮缺陷从未被它发现。建议下一步把探针改成真跑闸门（`scripts/` 域，Lead 代办）。
- 契约与协议版本：**不改** `packages/executor-protocol/protocol.json`（`switch.semantics` 已如此写），
  故无协议版本 bump、无需重跑生成物。

## 回滚路径

- **代码回滚**：单一 commit 即可回退（闸门一处 + 两处用例 + 一处配置），`git revert <sha>`。
  不涉及数据迁移、无 schema 变更、不写库 ⇒ 无补偿动作。
- **运行期回滚（不发版）**：`PY_EXECUTOR_SWITCH_POSTURE_STRICT=0` 并重启执行器 ⇒ 回到现状宽松姿态。
  该开关必须在 R62 删除（见「决策 4」的到期条件）。
- **判据回滚**：新用例与 R59 的恒拒表用例互不依赖；回滚后它们会红 —— 这是**预期的红灯**，
  不允许通过删除用例来「修好」；只允许随本 ADR 一起 supersede。

## 分步计划

**Step 1（红，零业务代码）**
新增「开关姿态对齐」用例文件：对契约 `networkPolicy.addresses` 的每一类 example，在开关两态下断言
`_package_url_host_denied(host)` 与 `network_policy.category_allowed(类别, 开关)` **同结论**。
判据：`python3 -m pytest <新文件> --no-cov` → **exit 1**，失败项恰好点名 `linkLocal`/`cgnat`/
`unspecified`/`multicast`/`reserved` 五类 × 开关开启（共 ≥5 条）。

**Step 2（绿，改闸门 + 灰度开关）**
`_package_url_host_denied` 换成决策 1 的写法；`config.py` 加 `PY_EXECUTOR_SWITCH_POSTURE_STRICT`
（默认 `1`，`0` ⇒ 走旧判据）；改 `test_execute.py:3618` / `:3500` / `:3596`。
判据：Step 1 文件 **exit 0**；且
`pytest tests/test_execute.py tests/test_zip_channel.py tests/test_ssrf_guard.py
tests/test_network_policy_metadata_parity.py --no-cov` → **exit 0**；
把开关置 `0` 再跑 Step 1 文件 ⇒ **exit 1**（证明逃生阀真的能回旧姿态，不是装饰）。

**Step 3（红→绿，解析路径）**
先加 `[10.0.0.5, 169.254.169.254]` 的多答案用例（注入 resolver）断言**拒绝** ⇒ 现状红；
再实现 `host_denied_under_policy` 并接线 ⇒ 绿。判据同上（exit 1 → exit 0）。

**Step 4（收口检查）**
跑 `node scripts/check-protocol-three-way.mjs`（须 exit 0）+ 全量定向回归。若 node 下载面仍宽松，
把跨端分歧交 Lead 登记或另立项 —— **python 侧不自行登记** `scripts/` 域。

**Step 5（回收逃生阀）**
R62 删除 `PY_EXECUTOR_SWITCH_POSTURE_STRICT`，固定严格姿态；部署文档补一句
「Tailscale/CGNAT 目标已不支持，请用 RFC1918 或反向代理」。判据：
`grep -r PY_EXECUTOR_SWITCH_POSTURE_STRICT apps/executor-python` 只剩本 ADR 的引用（或全无）⇒ exit 0。

## 明确不做

1. **本轮不写业务代码**：`apps/executor-python/routers/execute.py` 与 `network_policy.py`
   的行为**零变化**；本轮交付 = 本 ADR + `docs/adr/README.md` 的索引行。
2. 不改 `packages/executor-protocol/protocol.json`：契约已是目标口径，改契约等于**降级安全承诺**。
3. 不改 `scripts/**`（探针改造、豁免账登记）—— 写域外，Lead 代办。
4. 不改 node / admin 的宽松面（node 下载面、admin webhook 面）：各自另立项，本 ADR 只管 python 与契约对齐。
5. 不删 R59 的恒拒表前置判定（`apps/executor-python/network_policy.py:244`）：
   即使 `category_allowed` 覆盖它的结论，也保留为纵深防御（元数据先判是 ADR-029 的硬要求）。
6. 不动 `apps/executor-python/tests/test_ssrf_guard.py:82` 的硬编码地址副本：
   它是三向检查「R09 三端覆盖」判据的**字面量锚点**（脚本读该文件文本），删了守卫会红。

## 替代方案（被否）

- **方案 B：改契约去迁就宽松面**（把 `switch.semantics` 改成「除 loopback 外全放行」）。
  否决：契约是**安全承诺**，降级会同时让 admin 执行器与 node gitRepo 面失守，且
  `169.254.169.254` 依旧可达 —— 那正是 ADR-029 判定「恒拒」时要堵的口子。
- **方案 C：只收 `linkLocal`（把元数据口子堵上），`cgnat`/`multicast`/`unspecified`/`reserved` 保持宽松**。
  否决：又制造「同一份契约两种承诺」；R01 已在 admin 侧把 `cgnat` 钉成两态都拒，
  部分收口只会让下一次「哪个类在哪端松」再开一轮。
- **方案 D：只改文档**（在 docstring 里写清「开关解锁非 loopback 受限地址」）。
  否决：文档不能把 SSRF 口子变成「已声明行为」；ADR-029 已经裁决过这一路线
  （当时的结论是「不降级安全承诺、不打断 Tailscale 合法用户」，做法是拆表，不是改文档）。
- **方案 E：把 python 执行器的出站收成「仅 admin 白名单」**。
  否决：超出本轮范围，且 node 侧同款拓扑要一起改；先对齐契约，再谈收窄。

## 关联

- 相关 ADR：ADR-029（元数据地址恒拒）、ADR-022（执行器「受控的任意代码执行」信任模型）
- 计划项：R61-W4（本 ADR）、R59-W4（恒拒表前置 + 契约驱动测试）、R07（webhook 面同形缺陷）、
  R01（admin 的 cgnat 收口）、R05（admin 执行器姿态按契约收口）
- 守卫：`scripts/check-protocol-three-way.mjs`（真四向检查）、`scripts/docs/check-docs.mjs`（ADR 结构断言）
