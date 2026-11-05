# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：以 `git log -1` 为准 · **5 worker 并行** · **守卫链 95 段全绿** · 工作区干净
**会话**：第 80 轮 · 并行第 18 批收尾

## 本轮落地（HEAD）
1. **主机名同义判定纯函数**（`2ab84496` + `40694ee1` prettier 收尾）：`address-category.util.ts` 新增 `isLoopbackHostname(host)` / `normalizeHostname(host)`，**零 import**（`grep -c '^import'` = 0）、**仓外 `require` 实测 exit 0**（8 条主机名：`localhost`/`foo.localhost`/`LOCALHOST`/`localhost.`/`localhost.localdomain` = true；`example.com`/`notlocalhost.com`/`127.0.0.1` = false）。
   - **职责边界（关键发现）**：`classifyAddress` 第一条即 `if (!isIP(addr)) return {category:null}` ⇒ 主机名按设计「交给 DNS」；admin 对 `*.localhost` 的拒绝**是 DNS 的副产品**（`safe-http.util.ts:176/:469` 的 `SSRF_HOST_DNS_LOOKUP_FAILED`），所以**不做 DNS 的仓外探针覆盖不到契约那 2 格**。
   - **W3 的克制（对）**：**没有**在 DNS 前插短路（那会把错误码从 `DNS_LOOKUP_FAILED` 变成 `HOST_DENIED` = 行为变化，超出「零行为变化」约束），只**新增**纯函数 + 一条行为对照用例钉住「两者结论一致」。
   - 判据：表驱动 4 例 + 行为对照 1 例 + 既有 14 例 ⇒ 19 passed；反向验证去掉 `*.localhost` ⇒ 3 failed。`safe-http.util.ts` 445 **持平未涨**。
2. **ADR-034 补 §9（W5，未新开 ADR-036）**（`130b3bfa`）：判断「并入而非重复造」——R79 唯一新增事实是「node 必须保持 0 import 才能仓外 require」，属对 §2.3 的修订，不构成独立议题。§9 关键设计：类别表**改为入参** `categoryAllowed(category, allowPrivate, unlockedUnderSwitch)`（与既有 metadata 入参同款），`lib/ssrf-guard.ts` 作为非零依赖包装层传生成物；**既有调用方签名零改动**；另加两条判据（0 import 守卫 + 生成物↔契约逐字一致）。
3. **W2 独立黑盒验收（R78）**：五节判据「该红必红 / 非白名单不误伤」两侧都验（削节 ⇒ exit 1 点名；临时文件缺节 ⇒ 仅 trigger 既有孤儿判据、五节判据自身 0）；posture 判据在 `--root` 夹具三处注入**全部被抓住**（util 放宽 / spec 硬编码地址 / 条数声明不符）；如实转录其层级声明：「真跑发生在各端自己的测试 runner 里；本守卫只保证三张表存在、同源、同量、且真的会被跑」+「地址→risk 那一步不覆盖」。
4. 全链复验：**95/95 exit 0**。

## ⚠ 两条已知潜在分叉（都要独立一轮，别混做）
1. **`*.localhost` 的 DNS 旁路**：若某环境 DNS 真能把 `*.localhost` 解析到公网地址 ⇒ admin 会放行而契约要求拒。修它**必须改错误码**（`DNS_LOOKUP_FAILED` → `HOST_DENIED`）+ 写迁移说明 ⇒ 属行为变更，须立项。
2. **类别名不统一**（admin `restricted` vs node/python `reserved`，结论一致）⇒ ADR-034 实施时一并解决。

## 待办（按优先级）
1. **`*.localhost` 旁路**（安全项，需行为变更 + 错误码迁移说明）。
2. ADR-034 实施第 1 步（契约段 + 生成物 + 一个端读），沿用其验收信号（标签差异应**仍是 4 条**再降到 0）。
3. 跨端对照判据接入（两侧零依赖出口都已就绪：admin `fc05ef71`、node `b3aac035`）。
4. 未收口：真机脚本接链（需 CI postgres）；R18-B blocked；liveness 覆盖面仅 2 个脚本；flaky 待复发取证。

## 纪律（并行版）
只信「命令 + 真实 exit code」；未跑标 `unverified`；**判据必须能红**；**对照断言只证「重构未改行为」，须另配独立锚定**；**零行为变化 优先于「顺手修好」**（W3 本轮示范：发现旁路但不改，先立条目）；**降级/跳过必须显式打印**；**链必须在无在途改动时跑**（并发期的红可能是工作区噪声——W2 实测过一次：首跑 7 处 mismatch 实为 W1 未提交改动）；作者中断≠改动作废；一次只改一个文件 + `node --check` + 失败即回滚；定位代码块只用 CodeGraph；断言源码文本必须登记；`git add` 显式路径；遇 `index.lock` sleep 2s 重试；**禁 `pkill -f`**。
