# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：HEAD `2e413714` · 工作区干净 · 守卫链 **92 段** · 约定已成文，但 admin 侧留**已登记缺口**
**会话**：第 27 轮已收 · 25 轮产出（R01–R25，69 提交）· 手册 §7 已修正（禁止冻结）
**teammate**：`guard-chain`（崩 2 次均 recover；R25 拒绝硬推红、改为登记缺口 + review_by）

## R25 结论（**部分完成**，两件事必须分开看）
### 已完成
- **约定成文**：`docs/operations.md`「自检环境隔离（SELFTEST_SKIP_ENV_FILE）」——三条款（**测试夹具默认开** / **生产代码不得隐式默认开** / **自检脚本必须显式传**）+ 三态语义表 + 「为什么不用藏起 `.env`」。**断言的是机制**（`hermeticEnv()` / `HERMETIC_ENV` 冻结），不是「碰巧没有 `.env`」。
- **守卫**：`check-env-switch-default-policy.mjs`（selftest 5/5）+ `scripts/env-switch-known-gaps.json`（缺口登记，**review_by 过期即红**）；链 **91 → 92**、`[92/92]` 可见、删接线 `guards-wired` exit 1 点名。
- **判据修正（有价值）**：初版判据「文本里出现过入口路径」产生 **2 个误报**（只在注释里提 `main.ts`；只是 `read('apps/.../main.py')` 当文本）⇒ 改为「**同一行**既有启动动作（`spawn`/`execFile`/`execSync`）又有应用入口路径」后消失。

### 已回滚并登记缺口（关键发现）
- **admin-api jest 的「默认开」实测打挂 57 个既有 spec**（`57 failed / 1789 passed / 1846`）⇒ 回滚 `setupFiles`，保留 `apps/admin-api/test/setup-env-file.ts` 备用。
- ⇒ **这 57 个 spec 依赖开发者机器上的 `.env` 值**，是「本地绿、换个环境未必绿」的隐患（`review_by = 2026-12-05`，过期守卫即红）。

## 未收口（按优先级）
1. **甄别 admin-api 的 57 个 spec**（下轮主靶）：分类为「应自带夹具值」/「应显式注入 config」/「真依赖本机环境」；收敛后挂 `setupFiles` 并**删除缺口登记条目**。
2. 「四端全量」本轮未字面执行（只跑 admin 定向 + 全量对照；web/node/python 沿用 R24 结果）—— 需要时补跑。
3. **bundle-digest 回填摩擦**（改 `executor-node/src/main.ts` 必触发，第 4 次）；②字节哈希待 CI。
4. R18-B 三条重启条件（§7.19，blocked）；并发轴仍缺 `rolloutBatchClaimId` CAS / `agent_approvals` consume。
5. `EXECUTOR_TOKEN_EPOCH_MODE=on` 待运维；`UPGRADING.md` 头部基线；§7.17 P3 越界态提示。

## 下轮第一步（R26）
1. `git log -1 --oneline` 确认 `2e413714`（**自己跑**）；
2. 立项 **`admin-specs-env-independence`**（可分批，**首轮只做分类报告 + 第一批收敛**，别想一口吃完 57 个）：
   - 先产出**分类清单**（`artifacts/autonomy/R26/spec-classification.md`）：57 个 spec 逐个归到三类之一，附依据（读的是哪个 env 键、值从哪来）；
   - 第一批：取**机械可判**的那类（例如只是需要固定夹具值的）批量修 —— 用 `setupFiles` + 显式默认值，**不许把真依赖本机的偷偷改成常绿**；
   - 判据：**先开开关跑红**（同一批 spec 在该开关下失败）→ 修后**开关下仍绿**且**不开开关也绿**（两态都绿才算修好）；
   - 每批修完更新 `env-switch-known-gaps.json` 的条目数（**只减不增**），并让守卫计数下降可见。

## 纪律速记
- 主会话 ≤8 次调用/轮；只读本卡 + 手册 + git 摘要。本轮实测 7 次。
- **只信命令 + 真实 exit code**；回执会错归因、我会错摘要（㊱）、别编 sha（㊲）、ADR 也会错（R15）、压测会假绿（R16）、不等式证据要审时起点（㊸）、与自比对是假绿（㊹）、换载体先 grep 读者（㊺）、**「恰好碰不到」不是判据**、**不为对称而对称**。
- 新增：**判据本身也会误报**（R25 的 2 个假阳）—— 判据从「文本出现」升级到「同一行的语义组合」才准确。
- 未跑标 `unverified`；`git add`/`checkout` 只用显式路径，禁 `-A`；每单元一提交。
