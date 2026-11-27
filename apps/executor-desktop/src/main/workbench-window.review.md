# desktop 独立工作台窗口阶段 A — 独立验收审查报告（终版 · 含独立真机 fixture 复验）

- 审查 agent：`verify-wbwindow`（只读审查，不改生产源码；独占新增仅本报告 + `workbench-window.review.selftest.ts`）
- 审查时点：2026-11-27（Asia/Shanghai）
- 审查对象：独立 BrowserWindow（独立 partition + 独立 preload）+ `loadURL` 中台 `/workbench` + 白名单 channel；四页零改动；执行器配置/凭据 channel 对工作台不可调用。
- 审查方式：CodeGraph 1.6.4（已手动 `codegraph sync` 覆盖新文件）→ 源码逐行 → 独立 selftest → 变异反证 → 构建产物实测 → **本 agent 独立真机 CDP 复验**。

---

## 四项逐条结论

### 验收 1：隔离真实性 —— 通过（代码级 + 真机 fixture 复验）

**preload 实际暴露面**（`apps/executor-desktop/src/preload/workbench.ts`）：

| 项 | 结论 | file:line |
|---|---|---|
| 独立命名空间 | `exposeInMainWorld('workbenchApi', {...})` | `src/preload/workbench.ts:22` |
| 仅 `getUrl` | `ipcRenderer.invoke('workbench:getUrl')` | `src/preload/workbench.ts:24` |
| 仅 `navigate` | `ipcRenderer.invoke('workbench:navigate', target)` | `src/preload/workbench.ts:26` |
| 仅 `close` | `ipcRenderer.invoke('workbench:close')` | `src/preload/workbench.ts:28` |
| 危险 channel | 代码里零出现（非仅注释声称），禁用集逐项 selftest 否决 | 全量桥对照：`src/preload/index.ts:66` config:save / `:102` agent:get-status / `:106` executor:stop / `:187` apps:uninstall / `:240` updater:install |

**BrowserWindow 安全配置**（`src/main/workbench-window.ts`）：

| 项 | 结论 | file:line |
|---|---|---|
| 独立 session partition | `WORKBENCH_SESSION_PARTITION = 'persist:acf-workbench'`；`partition:` 注入 webPreferences；`session.fromPartition(...)` | `:23` / `:153` / `:218` |
| `contextIsolation: true` | 显式逐项 | `:154` |
| `nodeIntegration: false` | 显式逐项 | `:155` |
| `webviewTag: false` | 显式逐项（另 `will-attach-webview` 拒绝） | `:160` / `:253-256` |
| `sandbox: true` + 独立 preload | `preload: ../preload/workbench.js` | `:157` / `:47` / `:150` |

**第二道闸（IPC 双向收窄）**：`src/main/workbench-ipc.ts:37` `createGuardedIpcMain`（sender URL 锚定中台 origin）+ `:50/:55/:67` `isWorkbenchSender`；`src/main/workbench-window.ts:177-189` 以 webContents.id 全等（`sameWindow`）为**硬前提**，再取 partition 双路证据——`normalizePartition`（`:31-34`，归一 `persist:` 前缀）或主进程侧 `__acfWorkbenchPartition` 标记（`:42` / `:233`，渲染层不可伪造），无窗口 fail-closed。此处修掉了 impl 真机发现的 Electron 45 `webContents.session.partition` 在 IPC 事件读不到、导致工作台自调用被误杀的缺陷，**隔离未放宽**（id 硬前提仍在）。真机 CDP 复验：工作台 getUrl 可用、外部 host navigate 被拒、四页与工作台桥互不出现。

### 验收 2：loadURL 安全 —— 通过（纯函数 + 源码锚点 + 真机落点）

| 项 | 结论 | file:line |
|---|---|---|
| 协议白名单 | 只接受 `http:` / `https:`，`javascript:/file:/data:/ftp:` 全拒（含基址与导航双路径） | `src/main/workbench-window.ts:93` / `:121` |
| host 约束 | 基址非空 host + 拒 userinfo + 空串抛错不回落 localhost；导航按 `origin` **全等**（非前缀，防 `admin.evil.tld` 混淆）；preload navigate 只收同源**相对路径**（拒 `//` 与绝对 URL，防开放重定向） | `:94` / `:86` / `:123` / `:130-142` |
| 跳转守卫 | `will-navigate` / `will-redirect` 同源校验 + `setWindowOpenHandler` deny + `will-attach-webview` preventDefault | `:237-256` |
| 只 loadURL | `win.loadURL(workbenchUrl)`，无 loadFile / 无 webview 标签 | `:274` |

selftest 实测：`resolveWorkbenchUrl` 对空串/javascript:/file:/data:/userinfo 全抛；`isAllowedWorkbenchUrl` 对任意外 host / 协议相对 / javascript: 全 false；`resolveWorkbenchNavigation` 对绝对 URL / `//` 全抛。真机 CDP：工作台 URL 落在 `http://127.0.0.1:5199/workbench`，恶意 navigate 后 URL 未变。

### 验收 3：四页零改动 —— 通过（git 级，落盘后复核）

```bash
git diff --name-only -- apps/executor-desktop/src/renderer/pages apps/executor-desktop/src/renderer/App.tsx
```
落盘前后两次均**空输出**。`git status --short -- apps/executor-desktop` 仅 `index.ts` 修改与新增 workbench 文件；`src/main/window-manager.ts` 四页 `sharedWebPreferences()` 仍用 defaultSession + 全量 `index.js`（独立 selftest 锚点断言通过）。真机 CDP：四页 `#wizard` 页 `electronAPI` 57 键、`workbenchApi` absent。工作树中台 97 个既有改动与本切片无关。

### 验收 4：变异反证 —— 通过（断言够严，非假绿）

1. impl 白名单 selftest（`src/main/workbench-window.selftest.ts`）独立实跑：**19 条 check 全绿，EXIT=0**（含新增 partition 归一 + fail-closed 两断言）。
2. 变异：仅改编译产物副本的 `PRELOAD_SRC` 指向全量 `src/preload/index.ts`（**未改任何生产源码**）→ **EXIT=1**，`AssertionError` 实际集合多出 `config:save` / `executor:stop` / `apps:uninstall` / `agent:get-status` / `config:get` 等全部危险 channel。断言真红。
3. 本审查独立 selftest（`src/main/workbench-window.review.selftest.ts`，不 import impl 自测）**5 组断言全绿，EXIT=0**，自带变异反证亦成立。

---

## 实测结果（全部本 agent 实跑）

| 命令 / 验证 | 结果 |
|---|---|
| impl selftest（`npx tsc … src/main/workbench-window.selftest.ts && node dist-selftest/workbench-window.selftest.js`） | EXIT=0，19 条 ok |
| 变异反证（preload→全量 index.ts） | EXIT=1，真红（预期） |
| 本审查 review selftest（手动编译+node） | EXIT=0，5 组 ok |
| `npm run test:main`（既有 65 条 selftest） | EXIT=0 |
| `npm run test:main`（含 lead 新接线后重跑，含 workbench-window.selftest.js） | EXIT=0，19 条 workbench check 全绿 |
| `npm run test:renderer` | EXIT=0（renderer 全套断言通过） |
| `npm run build:main` | EXIT=0；首跑暴露 workbench.js 缺失（D1），修复后复验两产物齐全且 workbench.js 自包含 |
| **独立真机 CDP 复验**（Electron `--workbench --no-sandbox` + fixture 中台 5199 + CDP :9222） | EXIT=0，见下 |

真机 CDP 断言逐条（本 agent 独立启动进程、独立跑 `/tmp/opencode/wb-cdp.cjs`）：

```text
WORKBENCH_URL: http://127.0.0.1:5199/workbench
WORKBENCH_DOM: workbenchApi keys: ["getUrl","navigate","close"] | electronAPI present: false
WORKBENCH_GETURL: http://127.0.0.1:5199/workbench
WORKBENCH_BAD_NAV: REJECTED:Error invoking remote method 'workbench:navigate': Error: 工作台导航只接受同源相对路径
WORKBENCH_URL_AFTER: http://127.0.0.1:5199/workbench -> http://127.0.0.1:5199/workbench
FOUR_PAGE_URL: file:///data/project/AutoCodeFlow/apps/executor-desktop/dist/renderer/index.html#wizard
FOUR_PAGE_ELECTRONAPI: object keys=57 hasWorkbenchApi=false
```

Electron 日志佐证：`[workbench] window opened`；`Error occurred in handler for 'workbench:navigate': Error: 工作台导航只接受同源相对路径`（恶意 navigate 真被 handler 拒绝，非前端自欺）。

---

## 发现的缺陷（回报主控裁决，本 agent 不改 src）

### D1【已发现 → 主控已修复 → 本 agent 复验通过】`bundle-preload.cjs` 曾缺第二 esbuild 入口

- 发现时事实：`apps/executor-desktop/scripts/bundle-preload.cjs` 当时**未被修改**，仍单入口 `index.ts`（原 `:22-24`），清理循环（原 `:40-45`）只保留 `index.js` / `index.js.map`。实测 `npm run build:main` 前 `dist/preload/workbench.js` 存在（658B，tsc 直出），执行后 **MISSING**。
- 当时影响：`WORKBENCH_PRELOAD_PATH`（`src/main/workbench-window.ts:47`）指向 `../preload/workbench.js`；产物缺失会使真机工作台窗口 preload 加载失败 → `window.workbenchApi` undefined → 工作台能力全废。**这是本次审查抓到的真实假绿点**：所有 selftest 只读 `src/` 源码锚点、`test:main` 不跑 `build:main`，故「selftest 全绿 ≠ 真机可用」。
- 修复（主控/impl 响应后落盘，非本 agent 改动）：`apps/executor-desktop/scripts/bundle-preload.cjs` 新增 `WORKBENCH_ENTRY = src/preload/workbench.ts`、`WORKBENCH_OUT = dist/preload/workbench.js`，双入口 esbuild 循环，`KEEP` 白名单纳入 `workbench.js` / `workbench.js.map`。
- 本 agent 复验：再次 `npm run build:main`（EXIT=0）→ 四件产物齐全（`workbench.js` 696B）；`workbench.js` 无相对 `require`（沙箱自包含 OK）。**D1 已消除**，真机 CDP 确认 `workbenchApi` 3 键可读。

### D2【门禁覆盖提示，非阻断】本审查 selftest 未纳入门禁

lead 已把 impl 的 `workbench-window.selftest.ts` 加入 `package.json` test:main 链与 `tsconfig.selftest.json` include（实测已接线）。本 agent 的 `workbench-window.review.selftest.ts` 为独立审查产物，因边界限制未改这两个配置，靠手动 `tsc` + `node` 跑（EXIT=0）。如需常驻门禁由主控决定。

### D3【impl 真机发现 → 已修复 → 本 agent 复验通过】Electron 45 partition 读取误杀

- impl 真机日志（`wb-electron5.log`）显示：旧 `isWorkbenchSender` 单靠 `sender.session.partition` 判定，Electron 45 IPC 事件读不到该值 → 工作台自己的 `workbench:getUrl` / `workbench:navigate` 被误杀（`sender not allowed`）。
- 修复后实现（`:31-34` normalize + `:42`/`:233` 主进程标记 + `:177-189` id 硬前提）经本 agent 独立真机 CDP 复验：`getUrl` 返回配置 URL（不再误杀），外部 host navigate 仍被拒（隔离未放宽）。**D3 已消除。**

---

## 最高验收级别（诚实声明）

**真机 fixture 级（本 agent 独立复验）**。

- `test:main` / `test:renderer` / impl selftest / 独立 selftest / 变异反证 / `build:main` 均**实跑**，非只读推断。
- 本 agent 独立启动真实 Electron（`--workbench --no-sandbox --disable-gpu`，CDP :9222）+ fixture 中台（127.0.0.1:5199），实跑 CDP 断言（EXIT=0）：工作台 `loadURL` 落在 `/workbench`；`workbenchApi` 恰 `getUrl/navigate/close` 三键、`electronAPI` absent；`getUrl()` 返回配置 URL；外部 host `navigate` 被拒且窗口 URL 未变；四页 `#wizard` 页 `electronAPI` 57 键、`workbenchApi` absent。
- **边界（不越级）**：中台页面是**本地 fixture**（非真实中台 Workbench 产品页），未验证真实中台业务流程（阶段 B 会话能力：goal → preview → commit → 审批 → 记录）。真机证据覆盖「隔离真实性 + loadURL 落点 + channel 面 + IPC 往返 + 双向桥互斥」，**不覆盖真实中台业务路径**。
- 结论：阶段 A 的隔离契约达**真机 fixture 级**；D1（preload 产物缺失）与 D3（Electron 45 partition 误杀）均已修复并经本 agent 复验。阶段 A 可按「隔离与窗口链路真机可用」验收；真实中台页面联调仍属后续项，不以本级别冒充。
