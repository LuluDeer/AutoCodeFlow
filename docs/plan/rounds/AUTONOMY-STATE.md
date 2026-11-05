# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：以 `git log -1` 为准 · **5 worker 并行** · ⚠ **链当前红在 83/95 `check:source-text-contracts`（自检 33/35）**
**会话**：第 74 轮 · 并行第 12 批

## 本轮落地（HEAD）
1. **admin `packageUrl` 零闸缺陷已补**（`41212555`）：用户可写的包地址此前**无任何 host 闸**，行已落库、只在派发期异步失败 ⇒ 现 `assertUserSuppliedPackageUrl` 在 create/update 前置；反向验证：闸短路 ⇒ 2 failed（云元数据 create/update 红）。三端矩阵：云元数据/CGNAT ⇒ node/python/admin 均 **拒**；合法公网三端放行；RFC1918 admin 刻意恒放行（admin 自己托管的 URL）。
2. **python `zip` accept 期闸**（`c56d750f` 红 + `f13422c0` 绿）：复用 `_assert_safe_package_url`，闸在 `register_live_execution` 与建 work_dir **之前**（同时钉住 `execution_exists(eid) is False`）；7 passed；全量 `-k not slow` **1804 passed**。
3. **node accept 期 DNS 预闸（方案 A）**（`d2d5c22f`）：新增 `ACCEPT_STAGE_DNS_TIMEOUT_MS = 2000` + `assertSafeDnsResolutionWithTimeout`（Promise.race，超时按 deny），在 `execute.ts:896-914` 与 `pull.ts:483-505` 镜像；域名→云元数据/NXDOMAIN/域名→私网(关) ⇒ **400**，合法公网 **200**，超时用注入替身（25ms）不真等；撤预闸 ⇒ 4 failed。单测全部注入 `dns.promises.lookup` 替身，**零外网依赖**。
4. **V8 coverage 死判据守卫**（`5f58c518`，链 **94→95**）：跑 2 个可跑脚本、跨运行取 max、两种入口都跑 ⇒ 真仓库**零误报**；注入 `assertFooBarDead` ⇒ **exit 1 点名 file:line**。未覆盖脚本**显式列出**不静默跳过。
5. **发版公告**（`a96b133e`）：`docs/RELEASE-NOTES-ssrf-posture.md`（五节、19 处依据锚点、6 条自检命令）；索引行由 Lead 补（`14697e23`）后 `test:docs` 0。
6. **体量代签**（`072ad4b3`/`988edb37`/`b0bc210e`）：admin `application.*` 三处、node `execute{,.spec}` + `execute.python-multiversion.spec`，全部含回滚值。

## ⚠ 当前红（下一轮第一件事）
`check:source-text-contracts` **自检 33/35**，失败是 ㉗/㉘ **隔离性用例**（「只坏守卫侧 ⇒ spec 侧仍绿」实得 1 项）⇒ 说明本轮某处**新增了源码文本断言但未登记/未隔离**。可能的来源：W1 的 liveness 守卫、W5 的 DNS 预闸测试、或 R71 新增的 spec。**必须先定位是哪条新增断言，再按仓规登记或改写为行为断言**（教训：断言源码文本必须登记）。

## 未收口
① 上述 source-text-contracts 红；② W1 liveness 守卫的**反向验证与删接线验证第 2 次未做**（做法已明确：只替换判断表达式、临时删链段跑 guards-wired）；③ liveness 覆盖面仅 2 个脚本（扩面前提=零误报）；④ 「发布公告必需小节」判据缺失（W2 实测：`REQUIRED_SECTIONS` 只管 `docs/adr/`）⇒ 建议按白名单只对 `docs/RELEASE-NOTES-*.md` 要求五节；⑤ webhook 面判据 blocked（等 admin 纯函数）；⑥ ADR-034 契约类别表实施；⑦ 真机脚本接链（需 CI postgres）；⑧ R18-B blocked。

## 纪律（并行版）
只信「命令 + 真实 exit code」；未跑标 `unverified`；**判据必须能红——绿而不可红 = 死判据，回滚不保留**；作者中断≠改动作废；覆盖边界先判「差异 vs 缺口」；跨端改动**同载荷同结论**；**定位代码块只用 CodeGraph 符号边界**；断言源码文本必须登记；worker 只跑定向，全量/链由 Lead 串行跑；`git add` 显式路径；遇 `index.lock` sleep 2s 重试；禁 `pkill -f`。
