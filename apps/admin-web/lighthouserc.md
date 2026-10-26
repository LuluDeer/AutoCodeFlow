# Lighthouse CI 断言口径

`lighthouserc.json` 是 JSON，写不了注释，所以门禁的取值依据记在这里。
改动其中的断言前请先读本节——这里的每一条都是**实测取证**过的，不是拍脑袋。

## 为什么不用裸 `vite preview`

早期配置用 `npx vite preview` 作为 `startServerCommand`。它**没有 `/api` 代理**，
而登录页挂载时会请求 `GET /api/auth/oidc/status`（SSO 可用性探测）。审计环境
没有后端，该请求必然 502/ECONNREFUSED，于是：

- `errors-in-console` 判 0 分并失败——但错误来自「审计环境缺后端」，
  不是前端代码缺陷。这是一条**伪缺陷**，却把整个 job 拖红。

现在改用 `scripts/lhci-serve.cjs`：静态托管 `dist/`，`/api/*` 回确定性 JSON 桩
（`/api/auth/oidc/status` 回 `{"enabled":false}`），其余路径走 SPA 回退。
这样 `errors-in-console` 才重新只反映**前端自己打出来的错误**。

## 分三档：error / warn / off

### error —— 真实缺陷，必须修

| 审计项 | 依据 |
| --- | --- |
| `heading-order` | 曾实测报错：页面里只有 `h3`（品牌名）和 `h5`（表单标题），**没有 h1/h2**，判为跳级。已在 `LoginPage.tsx` 修为 `h1`+`h2`。 |
| `meta-description` | `<head>` 无 description。已在 `index.html` 补齐。 |
| `robots-txt` | 文件不存在，SPA 回退把 `/robots.txt` 返回成 **HTML**，审计报 `43 errors found / Syntax not understood`。已补 `public/robots.txt`。 |
| `errors-in-console` | 修掉上面那条伪缺陷后，它才具备门禁资格：此后每次红都代表前端真的往控制台打了错误。 |

### warn —— 需要真实优化，但不应阻塞发版

| 审计项 | 为什么不是 error |
| --- | --- |
| `categories:performance` | 既有决策（基线未稳定前不卡发版），本轮维持。 |
| `unused-css-rules` / `unused-javascript` | 单页审计口径，而这是 SPA：`/` 落到登录页时，绝大部分应用 bundle 与 antd 样式**本来就没用上**。数值恒高（实测 CSS 34 KiB / JS 180–186 KiB），当作回归信号看，不当作失败。 |
| `render-blocking-resources` | 同上，首屏外资源天然被判为无效，需拆包/预加载才能真降。 |
| `valid-source-maps` | 见下节「为什么 `valid-source-maps` 是 warn」。 |

### 为什么 `valid-source-maps` 是 warn

**它不是被上游默认带进来才红的，是「chunk 长大到越过阈值」才第一次生效的。**

Lighthouse 只在脚本 **≥ 500 KiB（512000 B）** 时才要求它带 source map
（`valid-source-maps.js` 的 `LARGE_JS_BYTE_THRESHOLD`），而它找 map 的唯一途径是
DevTools 的 `sourceMapURL`——即 bundle 末尾的 `//# sourceMappingURL=` 魔法注释
或响应头 `SourceMap:`。

本仓 `vite.config.ts` 用 `sourcemap: 'hidden'`（O-17：**产出** `.map` 供排障侧按
URL 拉取，但**不注入**注释，以免浏览器在首屏自动下载几十 MB 的 map）。二者叠加
的结果是：`dist/` 里躺着一份合法的 `.map`，Lighthouse 却永远发现不了它 →
`valid-source-maps` 恒判 0。

此前一直绿，只是因为没有任何 chunk 越过 500 KiB。2026-10-26 的 i18n 词条增长
把 `i18n-*.js` 顶到 **605.9 kB**（`lang="zh"` 与 `en` 两份词条都被打进同一 chunk），
`GlueEditor-*.js`（2.7 MB，懒加载）本就超过——于是这条断言从「不适用」变成
「每个 URL 红一次」，`develop` 与所有 PR 全红。

**为什么不是 error（不修 build）：**

- **不能改成 `sourcemap: true`**：那会把 `sourceMappingURL` 注进 2.7 MB 的
  GlueEditor 与 606 KB 的 i18n，浏览器一进登录页就会去拉 ~12 MB 的 map，
  首屏性能直接倒退——正是 O-17 当初选择 `hidden` 的理由。
- **不能只在审计服务器补 `SourceMap:` 头**：`scripts/lhci-serve.cjs` 是审计环境的
  替身，让它在响应头里自报 map 只是「让审计看得见」，而**生产 nginx 并不发这个
  头**——那是把审计口径与生产形态脱钩，属于假绿。
- 真正的收敛方向是 **chunk 拆分**（i18n 按语言拆 / 懒加载），那是性能优化议题，
  不该与「修 CI 红灯」混在同一轮。

因此与 `unused-css-rules` 同档：**留作回归信号（warn），不阻塞发版**。若日后
真的希望它变成 error，路径是先把 `i18n` chunk 拆到 500 KiB 以下，再把
`sourcemap` 切到 `true`（或让生产 nginx 按需发 `SourceMap:` 头），两者都要
单独取证，不要靠调这条断言蒙过去。

### off —— 评估口径与当前架构不匹配

| 审计项 | 为什么关闭 |
| --- | --- |
| `uses-http2` | 审计环境是本地 http 单进程服务器，协议由生产 nginx/网关决定。 |
| `viewport` | 移动端已由 `index.html` 的 viewport meta 保证，此审计对管理台价值低。 |
| `uses-long-cache-ttl` | 缓存策略由生产 nginx `Cache-Control: immutable` 承担（见 `nginx.conf`），本地服务器不是判据。 |
| `legacy-javascript` | 构建工具链（Vite 8 / rolldown）产出决定的，非本仓手写代码可控。 |
| `render-blocking-insight` | 新版诊断 insight，与 `render-blocking-resources` 重复；留后者即可。 |
| `network-dependency-tree-insight` | 纯诊断性 insight（关键请求链深度评分），没有可执行的通过阈值；开关它只会每次刷警告噪声，不产生任何回归信号。 |
| `forced-reflow-insight` | 纯诊断性 insight。实测唯一命中源是 `vendor-react` bundle 内部的 71 ms 强制回流——是 React 自身渲染管线的特征，本仓没有对应的可改代码；它也不反映回归（数值随机器波动）。 |

## 本地复现

```bash
cd apps/admin-web
npm run build
node scripts/lhci-serve.cjs &      # 端口 4173
npx lhci collect --url=http://localhost:4173/ --url=http://localhost:4173/login
npx lhci assert
```

报告落在 `.lighthouseci/`（已 gitignore）。
