# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：以 `git log -1` 为准（HEAD 含 `96ac8eae`）· **5 worker 并行** · 守卫链 93 段
**会话**：第 67 轮 · 并行第 5 批

## 本轮落地（HEAD）
1. **node 下载面同族缺陷已修**（`96ac8eae`）：`lib/ssrf-guard.ts:358-359` 的 `if (allow) return`（`options.allowPrivateNetwork || config.allowPrivateNetwork`，后者读 `EXECUTOR_ALLOW_PRIVATE_NETWORK`）与 DNS 面 `:403-404` 的早退，使**开关开启时整张受限表被跳过**——loopback / linkLocal（含 `169.254.169.254`、`fd00:ec2::254`）/ cgnat / unspecified / multicast / reserved 全放行，**DNS 面连解析都不做**。修法：**恒拒/类别表优先于开关**，`categoryAllowed` 上收为单一实现；旧实现 **14 failed** → 修后 **37 passed / 受影面 13 suites 260 passed**；反向验证（加回 `if (allow) return`）⇒ **14 failed**。
2. **python 出站闸收紧已落地并用 ADR 收口**（`4cf4ebdb` + `cb10d056`）：开关只放行 privateIPv4；ADR-032 补「用户影响说明」+「粒度不足→契约拆分地址类（新 ADR）」后续立项；Step 1–3 = Accepted，Step 4–5 待办。
3. **`.env.example` 补 `PY_EXECUTOR_SWITCH_POSTURE_STRICT=1`**（`4a33b5e0`）⇒ `test:env-drift` **exit 0**；未走 WHITELIST（回滚阀必须可见）。
4. **W3 per-call context 恢复**（`29bf2fca`，我误删已更正）+ ADR-031 步骤 2 进度回填（`1102403a`），5 suites/200 passed、`tsc` 0。
5. **W2 部署页消歧**（`411d475f`/`86018f10`）：那条是「候选执行器容量占用」不是部署进度 ⇒ 判定**不同语义**、只消歧不改换算，并钉「不消费 `reservedSlots`」。
6. **W1 形态分派助手**（`7dc708f0`）：`expectContentContains`/`expectRequiredFieldsInJson`，selftest 12/12，`compose`、`package-adoption` 已接。

## 已复核
- `npm run check:desktop-bundle-drift` ⇒ **exit 0**（executor-node 56 输入文件、agent-worker 41，摘要一致）——W5 改 `src/**` 后 digest 已同步，**无需我再回填**。

## 在途 / 待办
1. **W1 正在进行**：代签两笔体量（spec 1493、runtime 987）+ 接 `check-protocol-breaking` + 跑全链。
2. **新增代签需求（W5）**：`apps/executor-node/src/routes/deploy.spec.ts` → **1487**（回滚值 1475，超 baseline maxLines）⇒ 由 W1 一并签。
3. **用户可见行为变更（两处，需文档同步）**：
   - python：开关开启时 Tailscale `100.64/10`、`169.254.x`、`0.0.0.0` 形态、`198.18/15` 被拒；
   - node：同机 `127.0.0.1` 下载拓扑失效（与 `UPGRADING.md §10` 已宣告口径一致，需确认升级说明覆盖）。
4. 未收口：真机脚本接链（需 CI postgres）；R18-B blocked；flaky 待复发取证；`EXECUTOR_TOKEN_EPOCH_MODE=on` 待运维；服务端无 `reservedSlots<=running` 下限；**admin webhook 面（`safe-http.util.ts:91`）仍宽松**（ADR-032 表内另一格，未动）。

## 纪律（并行版）
只信「命令 + 真实 exit code」；未跑标 `unverified`；断言必须能失败（恒真⇒变绿；**删副本来隔离**）；形态不合不套用；**删别人写域文件前先确认它是否已验证**（本轮教训：我误删过一次）；worker 只跑定向、全量/链由 Lead 或 W1 在无在途改动时串行跑；`git add` 显式路径；遇 `index.lock` sleep 2s 重试；禁 `pkill -f`。
