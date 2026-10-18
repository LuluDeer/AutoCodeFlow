# VERIFY：桌面端更新链真机往返（N-11 / DSK-03 残差收口）

- **日期**：2026-10-06（Linux 侧会话）
- **对象**：`apps/executor-desktop` 打包态 AppImage 更新链（electron-updater 6.8.9，Linux AppImageUpdater）
- **结论**：**PASS**——检测→下载→sha512 校验→重启安装→原地换体→换体后版本读数→UI 渲染，九步全绿，单轮 1.1 分钟。

## 背景与口径

N-11（DSK-02/03）在 2026-10-01 已完成「产包」半边（1.6.5 AppImage + deb，见
PLAN-CLAIMS N-11 行），残留「更新链**真机**往返」——当时登记的触达条件是
「已发布的两个版本」。本轮改用**本地构建双版本 + 本地 generic feed** 等效
触达：不经 GitHub Releases，直接验证 electron-updater 更新链机制本体。

与 GitHub 线上往返的关系：generic 与 github provider 共享同一套
electron-updater 检测/下载/校验/安装机制（provider 只决定 feed 地址与清单
获取方式）；本地 feed 已把机制链路全部钉住，GitHub 线上往返属生产发布渠道
的回归项（release.yml 发版后由既有 update-chain 守卫与线上观察覆盖）。

## 环境与材料

- 构建基线：develop @ e2166aa5（本轮 N-12 提交后，desktop 侧零改动）
- 双本地构建（`apps/executor-desktop` 下，`dist/` 已有同日 build）：
  - **old = 1.7.1 + 内嵌 generic feed**：临时配置 `electron-builder.old.yml`
    （`electron-builder.yml` 的 `publish` 映射段替换为
    `- provider: generic` + `url: "http://127.0.0.1:18081/"`，output 重定向
    `/tmp/acf-update-test/dist-old`）→ `npx electron-builder --linux AppImage
    --publish never --config electron-builder.old.yml`
    构建 40s；产物内 `resources/app-update.yml` 实测含 generic url。
  - **new = 1.7.2**：同 repo 配置 + `extraMetadata: { version: 1.7.2 }` +
    output 重定向 `dist-new`。产物含 `latest-linux.yml`（version/sha512/size/
    blockMapSize）。
  - ⚠️ CLI 内联 `--config.publish='[{...}]'` 在 electron-builder 26.15.3 不
    可用（yargs 合并成对象撞 schema「publish must be array」，JSON 字符串又
    被当 publisher 模块名找）——必须走配置文件副本。
- 本地 feed：`python3 -m http.server 18081 --bind 127.0.0.1`（cwd=dist-new）。
- 驱动：Playwright `_electron`（`@playwright/test` 1.63，spec 见附录），
  `electron.launch({ executablePath: <AppImage> })` **直接驱动打包态**——
  与既有 e2e 冒烟（dev 入口 dist/main）不同，updater 仅生产包启用。

## 验证步骤与证据（九步断言）

1. **首启向导**：`getByText('欢迎使用')` 可见（打包态真实首启流）。
2. **完成配置**：`saveAndCloseWizard({...cfg, autoStart:false,
   autoStartExecutor:false})` → 状态页 `.app` 渲染（真实用户流，非注入）。
3. **后台自检命中**：30s 延迟检查 → 本地 feed `latest-linux.yml` →
   UpdateBanner `发现新版本 1.7.2`（≤120s 窗口，实测 ~35s 内）。
4. **显性下载**：点「下载更新」（autoDownload=false 的用户确认流）→
   243MB 经本地 HTTP → `新版本 1.7.2 已下载完成`。
5. **主进程日志**：`userData/logs/executor-*.log` 含
   `updater: update available 1.7.1 -> 1.7.2` 与
   `updater: update downloaded (1.7.2)` 两行。
6. **重启并安装**：点「重启并安装」→ 旧进程退出（≤60s）。
7. **★ 原地换体（字节级）**：dist-old 目录内 AppImage 被 AppImageUpdater
   换体并**重命名为新版本文件名**（`...1.7.2.AppImage`——「旧文件名路径
   消失」是预期行为，断言须按目录扫描）；sha256 与新构建逐字节一致
   （首轮实测 `3a78525a…`，记录轮断言 `toBe(newSha)`）。
8. **换体后版本读数**：重启换体产物，主进程 `app.getVersion() === '1.7.2'`
   （userData 保留 → 配置延续，免向导）。
9. **更新后 UI**：再次启动同 userData 实例（second-instance 真实用户路径）
   → 状态窗创建 → `.app` 渲染 + `状态监控` 文案可见。

## 过程中钉住的事实（复现者必读）

- **已配置且未开自启的桌面端启动后是纯托盘态，不建任何窗口**（index.ts
  启动分支只处理 `!configured → openWizard` / `autoStartExecutor → 自启`）。
  重启验证不能用 `firstWindow()` 直接等窗——这是正确行为不是缺陷。触发
  窗口的真实用户路径是「再次启动」（second-instance → focusOrOpenStatus）。
- **优雅停机最长 40s**（executor 子进程排水）：pkill 后必须轮询进程消失
  再起新实例，固定 2s 等待会撞单实例锁（第二实例 `process.exit(0)`，
  表现为 firstWindow 超时而 evaluate 撞在退出竞态前仍可能成功）。
- 日志按日期命名 `executor-YYYY-MM-DD.log`（非 main.log）。
- updater 会话独立 partition（`electron.net` + Chromium 校验栈）：本地
  **https 自签**源需系统/用户信任库（本机无 sudo/certutil 不可行）；改走
  **http 源内嵌 app-update.yml**——updater.ts 的 `AUTOUPDATE_URL` env 路径
  对 http 有意拒绝（D2-P2-4 安全裁决），构建期内嵌则不受该闸（该差异本身
  有 selftest 钉住，本轮零代码改动）。
- 现场清理：临时构建配置用完即删（不入库）；feed 服务与 /tmp 产物回收。

## 验收对照（N-11）

| 验收项 | 状态 |
|---|---|
| AppImage/deb 产包 | ✅ 2026-10-01（1.6.5）+ 本轮双构建再证（1.7.1/1.7.2） |
| 更新链真机走通 | ✅ 本轮九步全绿（本地 generic feed 等效触达，GitHub 线上往返归生产发布回归） |

## 附：驱动 spec 要点

完整驱动为一次性 spec（约 130 行，现场已清理），要点可复现：

```js
const app = await electron.launch({
  executablePath: OLD_APPIMAGE, args: ['--lang=zh-CN'],
  env: { ...process.env, ELECTRON_USER_DATA_DIR: userData },
});
// ①wizard 完成流（同 N-10 用例1 形态）→ ②等 banner「发现新版本 1.7.2」
// ③点「下载更新」→ 等「已下载完成」→ ④读 logs 断言两行 updater 日志
// ⑤点「重启并安装」→ 等 process exit（60s 上限）
// ⑥目录扫描 dist-old 内 AppImage → sha256 === newSha（换体+改名断言）
// ⑦pkill 残留 → 轮询 pgrep 消失 → 重启 → evaluate app.getVersion()==='1.7.2'
// ⑧再启动一实例触发 second-instance → app2.waitForEvent('window') → 断言 UI
```

spec 存放于仓库外 /tmp（一次性验证驱动，不入 CI 面）；复现按本节步骤。
