# AUTONOMY-STATE — 状态卡（≤40 行）

**会话**：第 4 轮已收 · HEAD `a6f249f9` · 工作区干净 · 手册 `AUTONOMY-LOOP.md`
**累计**：R01 CGNAT · R02 守卫链报告面 · R03 灰度租约空窗 · R04 自检 hermeticity
**teammate**：`guard-chain`（熟栈，续跑即可，别新开）

## R04 结论（完成，主会话独立复核过）

- **修掉**：自检读开发者本机 `.env`（`.env` 有**三个**入口，R03 只数了一个）—— `main.ts:31` 模块级 dotenv preload（早于 Nest 启动，灌进 133 键）· `app.module.ts:70` `ConfigModule.forRoot` · `data-source.ts:14` `dotenv.config()`。只修中间那个，`test:pull-dispatch` **仍然红**（401×37）。
- **判据红→绿**：`test:guards:selftests` **exit 1**（`test:pull-dispatch` ④「经 pull 链跑至 SUCCESS」+⑤「传输分支证据」）→ **有 `.env` 链接 exit 0 / 无 `.env` 链接 exit 0**，21 套件全绿，`injected env` 1→0。
- **主会话复核**：`npm run test:guards:selftests` => **exit 0**（本次实跑，`.env` 符号链接在位）。
- 回归：`typecheck:api`、`test:guards:repo`(85)、`test:docs`、`check:size-caps`、`check:guards-wired`、`test:env-drift` 全 exit 0。

## 未收口（按优先级）

1. **P1 协议两格 `loopback@on` / `privateIPv4@off`**：阻碍在 `verify-smoke-dispatch-push.sh:27,60,701-750` 的 B4/B5 把「开关放通 loopback」写成期望（与契约相反）+ compose/.env 默认值。修法顺序 R04 已给：先改取样地址 → 两处判定 → compose/.env 默认值 → 删豁免两条。
2. executor-node 侧 `.env` 加载未做同样约束（§7.4 P2，非主因）。
3. 133 键二分未做（§7.4 P2，可选）。
4. 守卫框架 meta-改造（§7.2 P2，`check-guards-wired.mjs:424-425`）。
5. `policy:"webhook"` 仍随开关放行 `restricted`（§7.1）。
6. 真机债：接管 CAS 并发 / 灰度 × 部分唯一索引 / agent 域 23505 归因 / firepoint 步骤 7；docker `verify-smoke-*` 本会话未跑 ⇒ `unverified`。

## 下轮第一步（新会话照做）

1. `git log -1 --oneline && git status --short`（预期 `a6f249f9`、干净）；
2. 打 **P1 协议两格**：立项写清「先改 `verify-smoke-dispatch-push.sh` 取样地址 → 两处判定 → 默认值 → 删豁免」四步，判据 = `check:protocol-three-way` exit 0 + selftest 条数净增 + 真机 `verify-smoke-dispatch-push` 真跑（跑不了标 unverified）；
3. 若两格实测「本就正确」：只补反证、无代码变更，回执写明「只加判据」；
4. `send_message` 到 `guard-chain` 续跑。

## 纪律速记

- 主会话 ≤8 次工具调用/轮；不读代码/完整测试输出/diff。R01 9（bootstrap 超 1）、R02 7、R03 7、R04 8。
- **只信 `命令 + 真实 exit code`**；回执也会给错归因（R01→R02 已证），关键结论交叉复核。
- 未跑标 `unverified`；`git add` 只用显式路径，禁 `-A`。
- 同一阻塞连续 3 轮 → blocked；验证失败 2 次 → 回滚；轮数 ≥6 或已被压缩 → 收尾轮。
