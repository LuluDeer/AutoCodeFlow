# 已知问题与未清偿任务索引

> 所属: docs/atlas/08-workflows/troubleshooting · 最后核对: 2026-09-13 · 对应代码: docs/PLAN-CLAIMS.md（认领状态总表 + H2 新任务段）
>
> **快照日期 2026-09-13，认领板为准**：本表是 `docs/PLAN-CLAIMS.md` 的只读快照索引，状态/Owner/备注以认领板原行为唯一事实源；发现本表与板不一致，先改板再改（或直接改）本表。

## 待认领（unclaimed）

| 编号 | 优先级 | 一句话 | 补充背景（摘自板上备注） | 去向建议 |
|---|---|---|---|---|
| BUG-04 | P3 | minio 依赖链 moderate 漏洞跟踪 | "无代码（跟踪上游），minio 链 moderate，等上游"；`apps/admin-api/package.json` 当前 `minio: ^8.0.7` | 跟踪上游发版后升依赖 + 跑 `npm run test:api` 回归；无需自研修复 |
| BUG-07 | P2 | QA8 detached 信号深验 | "Windows 测试任务书 + e2e 脚本；需 Windows 真机窗口"；platform 矩阵见 `docs/VERIFY-MATRIX.md` | 需 Windows 真机或扩 CI windows job；任务书线索在 `docs/windows-findings.md` |
| AUTH-04 | P3 | OIDC SSO（可选） | "admin-api auth 模块"，可选项非阻塞 | 新功能，从 [../../01-apps/admin-api/modules/auth.md](../../01-apps/admin-api/modules/auth.md) 读起；认证信任链背景见 [../../04-flows/security-model.md](../../04-flows/security-model.md) |
| DSK-01 | P2 | macOS 打包 | "executor-desktop + CI（需 macOS 真机）" | 参照 DSK-02 Linux 先例（electron-builder 双 target + `ci.yml` `desktop-linux-bundle` job 形态） |

## 已认领但有明确遗留（claimed / blocked，剩余范围摘自板上备注）

| 编号 | 状态 | 已达成 | 剩余 |
|---|---|---|---|
| BUG-19（=QA-05） | claimed | 四档容量全部达成（500 并发 100%、2000 任务@300 并发 1321 任务/分钟、SSE 500 连接、回调 10k≈7.3 万条/分钟）；瓶颈定位=DB 连接池 waiting 280（非 CPU）；`docs/CAPACITY-WHITEPAPER.md` 已产出；多实例槽位分布 `npm run test:arch31-multi-instance` 15/15 | **24h 长稳档**（`NGINX_SOAK_SECONDS=86400`，留目标环境作上线门禁）与**多主机网络拓扑**真机验证 |
| ARCH-31 | documented/blocked | 多实例矩阵 `docs/ARCH-MULTI-INSTANCE-MATRIX.md`；silence/渠道配置/rollout/outbox 四项真机套件全过（`test:arch31-multi-instance` 15/15、`test:arch31-rollout` 20/20、`test:arch31-outbox` 7/7） | **真机双实例重复投递边界验证**（矩阵"后续拆分"最后一项；口径=单机多进程，非多主机网络拓扑；webhook 实际投递次数需公网接收端） |

## 已清偿但值得留痕的样本（done，不再跟踪）

这三条曾长期挂在板上，清偿过程展示了"遗留项如何收口"的典型路径，新会话处置上表遗留时可参照：

- **BUG-18**（私服链路隔离加固 + 契约自检闸）：从"npmrc 泄漏/依赖劫持"隐患出发，最终交付了 `scripts/bug18-private-registry-selftest.mjs`（dry-run 与 live 两档，根脚本 `npm run test:private-registry`）与 e2e 用例 44；收口关键 = 把"真机验证"拆成可机检的 selftest，剩余的"prod 凭据回环"如实留在备注而非硬标 done。
- **BUG-17**（nginx SSE 长流验证）：真机验证任务反哺出 `scripts/nginx-sse-selftest.mjs`（根脚本 `npm run test:nginx-sse`）固定成永久回归资产，还顺带暴露并修掉了 BUG-21（派发失败不发布领域事件）——"验证型遗留"经常比"开发型遗留"更产出自测工具。
- **UI-16**（toast-only 页错误态）：最初只覆盖 2 页即标 done，后续五批盘点把 13 页真实缺口清零——教训是"清单型任务的验收要先全量盘点再动第一页"，处置上表遗留时同样适用。

## 记录口径说明

- "复核销账"类条目（板上大量 `done` 行备注"板信息滞后，无需改动"）不进本表——它们不是遗留问题。
- 本表只收"认领板上有行"的遗留；排障型知识（根因/修复/预防）按 [README.md](README.md) 规范入独立 `YYYY-MM-DD-<slug>.md` 文件，两者不混写。
- 环境受限类（BUG-07 Windows、DSK-01 macOS）长期挂着属正常态，接手前先在板上确认是否已有会话在途。
- 新一轮快照时：逐行对照认领板刷新状态、更新顶部快照日期；清偿的行直接移出（历史在板上，不留墓碑）。
- 板上备注里"如实缩水"的剩余项是本表最重要输入——那些条目写明"剩余 XXX / 仍未完成 / 留验"，正是编译本表的原始材料。

## 快照方法（下一次怎么刷新本表）

1. 打开 `docs/PLAN-CLAIMS.md`，对「认领状态总表」与「H2 新任务段」两张表逐行 grep 状态列：

```bash
grep -n "| unclaimed |" docs/PLAN-CLAIMS.md    # 待认领全收
grep -n "| claimed |" docs/PLAN-CLAIMS.md      # 只收备注带"剩余/留验/未完成"的行
grep -n "blocked" docs/PLAN-CLAIMS.md          # blocked 与 documented/blocked 同上
```

2. 每行摘三样：一句话、补充背景（引用板上备注原文短语）、去向建议（指向 atlas 对应篇目或命令）。
3. 与上一版 diff：新出现的行补入；状态变 `done` 的行移出，若其清偿过程有方法论价值（见下方样本节），压缩成一条样本而不是整行保留。
4. 更新顶部「快照日期」，并在"最后核对"处保持同一日期。
5. 拿不准某行是否算"遗留"时，宁可收录并在补充背景里标注"状态存疑，以板为准"，也不要静默丢弃——索引的价值是不漏，不是精确。

## 相关文档

- [README.md](README.md)（问题记录规范）· [TEMPLATE.md](TEMPLATE.md)（问题记录模板，排障知识入册用）
- [../task-board/README.md](../task-board/README.md)（如何认领上表任务）
- [../add-new-api-module.md](../add-new-api-module.md) / [../add-new-web-page.md](../add-new-web-page.md)（常见任务类型的操作手册）
- `docs/PLAN-CLAIMS.md`、`docs/DEVELOPMENT-PLAN-2026-09H2.md`（任务详情与验收口径）
- `docs/CAPACITY-WHITEPAPER.md`、`docs/QA-05-capacity-boundaries.md`、`docs/ARCH-MULTI-INSTANCE-MATRIX.md`（上表两行遗留的技术底稿）
