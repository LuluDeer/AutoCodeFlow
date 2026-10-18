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
