# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：以 `git log -1` 为准 · **5 worker 并行** · **守卫链 97 段全绿** · 工作区仅 W2 在途
**会话**：第 96 轮 · 并行第 32 批

## ⚠ 体检抓到唯一真实退步（已定性、已派修）
`npm run health:snapshot` 全量（R95，`7f86559a`）：
| 项 | 本次 | 上次(R53) | 结论 |
|---|---|---|---|
| **admin-api 两态** | **8043 passed / 10 failed / 8053**，exit 1 | 7956 / 0 / 7956 | **退步** |
| admin-web | 2390 / 1 skipped / 2391 | 2357 | +33 |
| executor-node | 1858 / 13 skipped / 1871 | 1514 | +344 |
| executor-python | 1981 / 1 skipped / 1982，cov 87.45% | 1692 | +289 |
| 守卫链 | **97 段 / 执行 97 / diff 空** | 93 | +4 |

**定性：`failed`，不是 killed** —— 证据：① 日志无 `killed:` 行；② 该 step JSON `signal=null`；③ jest 汇总完整（470/472 suites）。**`signal` 字段已进基线**（step 字段 = `['code','label','secs','signal','summary']`）。
**根因**：10 条 **`OidcService`** 用例（discovery/authorize、二跳 SSRF、ID Token 验签矩阵）用 `127.0.0.1` 当 issuer/端点，被 **R66/R78 收紧的 loopback 恒拒**拦下。
**Lead 裁决：改测试数据，不放宽门禁**（OIDC issuer 现实中是公网 HTTPS；放宽 loopback 会让 R66/R78 的收紧失效，且守卫依赖它）。已派 W3（R96）。

## 本轮落地（HEAD）
- **体检器新能力实战生效**：`signal` 字段区分 `killed` 与 `failed`（本轮首次用上，直接排除了「swap 98.7% 导致被杀」的误判路径）。
- **浮空 rejection 纪律**（`2b7ee1a2`，W2）：修 **4 处应用代码**（`mutateAsync` 的 promise 无人消费：④ confirm 的 `onOk` 裸 await、⑨ `handleOk` 的 await save、⑫ Popconfirm 返回 rejecting promise、⑳ `test()` 裸调用）+ 2 条**可红**纪律用例；**不改 UI 文案、不动全局配置**。
  - **更重要的发现**：真正让纪律失效的是**仓库自己的 reporter**（`src/test-setup.ts:17` → `test-support/unhandled-rejection.ts:85` 的 `process.on('unhandledRejection')` + `void promise`）⇒ `dangerouslyIgnoreUnhandledErrors` **不是有效杠杆**；W2 **主动作废**了自己「flag=false 仍全绿」的测量（探针证明 flag 未生效）。已派它评估「test 级失败 vs 保持现状+加度量」两档。

## 在途
- **W3**：修 10 条 OIDC 用例（去掉 loopback 测试数据，保持断言强度；二跳 SSRF 用受限但非 loopback 的目标构造）+ 报「其它把 loopback 当合法目标的出站类 spec」清单。
- **W2**：⑨⑳ 可红断言 + 报告器两档评估（**先给影响面数字再动手**）。

## 待办
1. 收 W3（10 条转绿 ⇒ 退步归零）、W2（报告器裁决）。
2. 修完后**再跑一次体检**确认 admin-api 回到 0 failed。
3. 未收口：真机脚本接链（需 CI postgres）；R18-B blocked；ADR-031 步骤 4/5；`CATEGORY_ALIASES` 独立判据。

## 机器状态
swap **8185/8191 MiB ≈ 99.9%**，但 web 793s 仍 exit 0 ⇒ 目前可跑；若后续被杀，**分端跑**（web+node → admin-api 两态 → python）或扩 swap。

## 纪律（并行版）
只信「命令 + 真实 exit code」；**先看 `signal` 再判退步**（killed ≠ 回归）；**测试数据不可用「故意恒拒的目标」当合法样本**（OIDC/issuer 类应公网 HTTPS）；**为过测试放宽安全不变量是最后手段，且需 ADR**；**全局豁免/自制 reporter 会让纪律形同虚设**；**测量实验要能作废自己**；**静态特征判据要写明挡不住什么**；**豁免必须进基线**；**链必须在无在途改动时跑**；作者中断≠改动作废；一次只改一个文件 + `node --check`/`tsc` + 失败即回滚；定位代码块只用 CodeGraph；断言源码文本必须登记；`git add` 显式路径；遇 `index.lock` sleep 2s 重试；**禁 `pkill -f`**。
