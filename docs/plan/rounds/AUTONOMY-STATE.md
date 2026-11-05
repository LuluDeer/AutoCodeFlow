# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：以 `git log -1` 为准 · **5 worker 并行** · **守卫链 94 段全绿**（代签后已复验）
**会话**：第 73 轮 · 并行第 11 批

## 本轮落地 / 裁决
1. **体量代签并复验**（`40f1d629`）：`execute.spec.ts` 2331→**2362**、`execute.ts` 2118→**2136**（R70-W5 的 accept 闸 + scp-like fail-closed 验收证据，回滚值写入 why）；链 **94/94 exit 0**。
2. **accept 期 DNS 缺口实测确认**（W5，零代码改动）：`169.254.169.254.nip.io` 与 `10.0.0.5.nip.io` 在 accept 期**返回 200**、NXDOMAIN 也 200，**`dns.lookup` 调用数 = 0**，闸只在下载期拦（176/177 ms）⇒ 违反 `resolution=dns-resolve` + `onResolutionFailure=deny` + `stage=accept`。
   **裁决 = 方案 A**（在既有 async 预闸处镜像 ~10 行 + **2 s 超时按 deny**）：理由 = 契约明确 + **python 已是真解析 fail-closed**、node 自己 gitRepo 预闸也是 A 形态，选 B 会让 node 成为三端唯一落后侧；实测增量 0.1–210 ms。
3. **python packageUrl accept 闸**（W4，`c56d750f` 先落红用例）：按 node 同法补在 `accept_execution()` 手检段，正在转绿。
4. **W1 webhook 覆盖判据：记 blocked（连续两轮「绿但不可红」）**。已试路径 = R71 字符串锚点命中**内嵌探针脚本**；R72 用 CodeGraph 拿到 `main()` **:979–:1173** 仍红演示失败（`errs len: 0`）。**重启条件** = admin 侧导出无 Nest 依赖的 `webhookPosture(addr)` 纯函数后改为真跑。**不保留死判据**（守着永不执行的断言比没有更糟）。
5. **元守卫优先**（W1，采纳它自己的建议）：`check-guard-judgement-liveness` —— 检测 `scripts/check-*.mjs` 里「已定义但从未被调用」的函数/常量，专防死判据；要求**先解决误报**（模板字符串内的同名不算）。
6. **发版公告草案**（W2）：`docs/RELEASE-NOTES-ssrf-posture.md`（新文件，五节：影响面/受众/升级步骤/回滚/自检清单）。
7. **W3**：admin accept 期载荷入口核查 + 三端「同载荷同结论」矩阵（`apps/admin-api/src/modules/application/**` 改动在途）。

## 待办（按优先级）
1. 收 W5（DNS 预闸）、W4（python 闸转绿）、W3（admin 核查）、W2（公告）、W1（元守卫）。
2. 合并后：`digest:regen`（node 改了）→ 链 **94/95**（元守卫可能 +1）→ `docs`/`size-caps`/`guards-wired`。
3. 未收口：webhook 面判据 blocked（等 admin 纯函数）；ADR-034 契约类别表实施；真机脚本接链（需 CI postgres）；R18-B blocked；flaky 待复发取证。

## 纪律（并行版）
只信「命令 + 真实 exit code」；未跑标 `unverified`；**判据必须能红——绿而不可红 = 死判据，回滚不保留**；形态不合不套用；作者中断≠改动作废（Lead 独立验收后收编）；覆盖边界先判「差异 vs 缺口」；跨端改动**同载荷同结论**；**定位代码块只用 CodeGraph 符号边界，禁字符串锚点**（本项目已三次踩坑：R57/R71/R72）；worker 只跑定向，全量/链由 Lead 串行跑；`git add` 显式路径；遇 `index.lock` sleep 2s 重试；禁 `pkill -f`。
