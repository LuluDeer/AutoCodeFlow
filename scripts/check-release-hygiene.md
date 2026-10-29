# Release Hygiene 审计（发版卫生守卫）

## 为什么需要

仓库有三条独立发版线混排在同一个 Releases 页：主仓 `v*`（人工 tag 主路径）、
桌面 `desktop-v*`（`desktop-v*` tag 自动出三平台安装包）、Python 四库 `v0.x`
（release-please 自动）。历史上积过三类问题：

| 问题 | 案例 | 后果 |
|---|---|---|
| 忘发布的 Draft | v1.1.0 / v1.1.1 / v1.5.2 | 发版对象半截，用户看不见 |
| 同 tag 重复对象 | desktop-v1.5.2 ×2（workflow 重跑竞态） | 语义混乱 |
| 主仓 release 抢 GitHub Latest | v1.5.1 实爆 | **桌面自动更新源被破坏**（electron-updater 读 `/releases/latest` 找不到 `latest.yml`） |

第三条的系统性修复：release-please-config.json 设 `prerelease: true`
（release-please 建的对象全部标 prerelease）+ release.yml 的 ensure-release
job（人工 tag 路径幂等建对象，同样标 prerelease）。桌面 `desktop-v*` 是唯一
合法的 Latest 持有者（它就是更新源本体）。

## 审计判据（违反即 exit 1）

1. **Draft 遗留**：draft 状态超 7 天；
2. **同 tag 重复**：同一 tagName 多个对象（draft 无有效 tag 关联，不计入）；
3. **Latest 竞争**：全部 `v*`（非 desktop）非 draft 对象必须标 prerelease
   ——**无豁免期**（2026-10-02 已把历史存量全部修正；`desktop-v*` 是唯一合法的
   Latest 持有者）。

判据**不可信**时（而不是「没问题」时）同样 exit 1，文案前缀是
`[release-hygiene] 结构错误`：`/releases` 返回非数组、读到 0 个对象、某个对象缺
`tag_name` / `draft` / 合法 `created_at`。这四种形态都会让某条判据**静默失效**，
「0 个对象 = 0 处违规 = OK」是其中最难发现的一种。

## 用法

CI：`.github/workflows/release-hygiene.yml` 每周二自动跑 + 手动 dispatch
（step 先跑 `--selftest`，再跑真审计）。
本地：`GITHUB_TOKEN=$(gh auth token) GITHUB_REPOSITORY=LuluDeer/AutoCodeFlow node scripts/check-release-hygiene.mjs`
（gh keyring 加密存储无法脚本读，本地必须显式给 token。）

自检（离线，不访问 GitHub）：`node scripts/check-release-hygiene.mjs --selftest`
——12 条用例跑真脚本子进程，`--fixture <file.json>` 把「API 会返回的 Release 数组」
直接灌进判据。`--fixture` / `--root` 只服务于 selftest，CI 主跑路径不带它们。

违规处置速查：

- Draft 遗留 → `gh release edit <tag> --draft=false --prerelease`（发布并按
  仓库惯例标 prerelease）或 `gh release delete <tag> --yes`（半截垃圾）；
- tag 重复 → `gh api -X DELETE repos/:owner/:repo/releases/<id>` 删多余对象
  （保留一个）；
- Latest 竞争 → `gh release edit <tag> --prerelease`。
