# 路由与鉴权守卫

> 所属: docs/atlas/01-apps/admin-web · 最后核对: 2026-09-13 · 对应代码: apps/admin-web/src/router.tsx、main.tsx、components/PrivateRoute.tsx、components/RequireAdmin.tsx、store/auth.ts、api/client.ts、layouts/MainLayout.tsx

## 路由表（核实于 src/router.tsx）

`createBrowserRouter`，全部页面组件 `lazy(() => import(...))` + `withSuspense(<PageFallback />)`；共 21 条路由（19 个真实页面 + index 重定向 + 通配 404），完整表见 [README](README.md)。

结构要点：

- `/login` 独立顶层（无守卫）
- `/` 分支整体包 `<PrivateRoute><MainLayout /></PrivateRoute>`
- `index` 重定向 `/dashboard`；`*` 通配 404（NotFoundPage 也挂在守卫内——未登录访问任意路径先落登录页）
- 路由级 ADMIN 门控五条：`/executors/install`、`/users`、`/notifications`、`/audit`、`/executor-packages`
- future flag `v7_relativeSplatPath: true`
- 路由内联注释标注演进编号（CORE-03 模板、R5/R6 RBAC），可作为改动时的历史线索

```tsx
// router.tsx 的典型形态（三例）
{ path: '/login', element: withSuspense(<LoginPage />) },
{ path: 'dashboard', element: withSuspense(<DashboardPage />) },
{ path: 'users', element: <RequireAdmin>{withSuspense(<UserManagementPage />)}</RequireAdmin> },
```

入口链（main.tsx）：

```
ErrorBoundary(ErrorFallback)
  → QueryClientProvider（staleTime 30s / retry 2 / refetchOnWindowFocus false）
    → ThemedProviders
      → RouterProvider
```

App.tsx 是空壳占位（`return null`），路由不经它。

## 守卫实现

### PrivateRoute（components/PrivateRoute.tsx，14 行）

- 判据是 **refreshToken**（不是 accessToken）
  - token 短生命周期；用 refreshToken 判定「有活跃会话」
  - 首个鉴权请求由 axios 拦截器自动刷新拿新 access token
- `_hasHydrated` 为 false（zustand persist 未完成 localStorage 回灌）时返回 null，避免回灌完成前误判登出闪跳登录页
- 无 refreshToken → `<Navigate to="/login" replace />`

### RequireAdmin（components/RequireAdmin.tsx，47 行）

- 依据 `isAdminUser(user)`（store/auth.ts：`user?.role === 'admin'`）
- role 未知（profile 尚未拉取/拉取失败）→ 显示 antd Spin 加载态
  - MainLayout 的 profile 同步 effect 会补齐 role
  - **只有 role 确认非 admin 才渲染 Result 403 页**——避免管理员刷新时闪现 403
- 403 页：subTitle 走 i18n（requireAdmin.subTitle），extra「返回控制台」按钮 `nav('/dashboard', { replace: true })`
- role 来源：登录响应只含 token，`GET /auth/profile`（authApi.me）由 MainLayout 回填 store

### 三层防线（路由 + 菜单 + 后端）

1. 路由级 `<RequireAdmin>`：URL 直达也 403（普通用户不会白屏/报错）
2. MainLayout `ADMIN_ONLY_MENU_KEYS` 菜单隐藏 + 头部通知铃铛 `{isAdmin && ...}`
   - R6 回归守卫：isAdmin 放行条件必须在分组化菜单后保留——e2e-17 实证过管理员菜单被全藏的 bug
3. 后端接口本身 `@Roles(ADMIN)`：GET/PATCH /notification/channels、/executors/install-cmd、/config/executor-shared-token、执行器删除等——前端门控只是体验层，权限裁决在后端 RolesGuard

完整后端角色模型见 [security-model](../../04-flows/security-model.md)。

## 会话生命周期（与 client.ts 协同）

```
登录 LoginPage → authApi.login
  ├ TOTP 用户：200 + { totpRequired: true } → 输入动态码 → authApi.verifyLogin
  └ setAuth(token, refreshToken, user?) → 跳 ?redirect= 或 /dashboard
页面请求 → 请求拦截器注入 Bearer token（来源 useAuthStore）
401 → 单飞 tryRefreshToken（POST /auth/refresh，裸 axios，防循环）
  ├ 成功 → setToken(+新 refreshToken) → 重放原请求
  └ 失败/再次 401 → logout() + window.location.href='/login?redirect=<当前路径+query>'
登出 → logoutRemote()（POST /auth/logout，best-effort 4s）→ 本地 logout → nav('/login')
```

- LoginPage 对 `?redirect=` 只接受站内路径（`startsWith('/')` 且非 `//` 开头），防开放重定向
- SSE 流（/metrics/stream、/executions/stream、日志流）不走 Authorization 头，用 `?access_token=` 查询参数鉴权（jwt.strategy 白名单）——token 过期时流失败，靠 hooks 的退避重建
- 会话管理 UI 在 settings/SecuritySettings：listSessions / revokeSession / revokeOtherSessions（DR-04 撤销语义）+ TOTP 启停

## 404 与错误兜底层次

1. 路由级：`*` → NotFoundPage（未匹配任何路径）
2. 渲染级：根 ErrorBoundary → ErrorFallback（含复制错误信息）
3. 页面级：StateError 组件（useRequest/React Query 的 error 透传）
4. 接口级：axios 拦截器统一 antMessage toast + 安全方法重试 + 401 刷新

## 常见改动场景：新增一个页面（速查）

1. `src/pages/NewPage.tsx`（组件文件只导出组件；纯逻辑拆 `src/pages/<kebab-case>.ts`）
2. `router.tsx` 顶部 lazy import + 路由条目（ADMIN-only 则包 `<RequireAdmin>`）
3. MainLayout `buildMenuItems` 挂菜单键；ADMIN-only 再进 `ADMIN_ONLY_MENU_KEYS`
4. `MainLayout.ROUTE_NAMES` 加面包屑名 + locales/zh.ts、en.ts 加 `nav.*` key
5. api 层方法 + queries.ts hook + 测试（vitest 单测 / e2e 冒烟加进 e2e/pages.spec.ts）

详细流程见 [新增前端页面流程](../../08-workflows/add-new-web-page.md)。

## 相关文档

[README](README.md) · [api-layer.md](api-layer.md) · [store-and-hooks.md](store-and-hooks.md) · [pages-system.md](pages-system.md)（Login/SecuritySettings）
