# 如何新增一个前端页面（admin-web）

> 所属: docs/atlas/08-workflows · 最后核对: 2026-09-13 · 对应代码: apps/admin-web/src/（api/ pages/ router.tsx layouts/ locales/）

每一步都以仓库内真实文件为参照核对过（参照页：`RegistryPage.tsx` + `TaskTemplatesPage.tsx` 的落地面）。全文路径均相对仓库根目录。

## 前置条件

- `cd apps/admin-web && npm install` 完成；`npm run dev`（Vite）可起。
- 已读：[../01-apps/admin-web/README.md](../01-apps/admin-web/README.md)、[../01-apps/admin-web/api-layer.md](../01-apps/admin-web/api-layer.md)、[../01-apps/admin-web/routing-and-auth.md](../01-apps/admin-web/routing-and-auth.md)
- 若新页面消费**新后端端点**：先走完 [add-new-api-module.md](add-new-api-module.md) 第 6 步，保证 `src/types/generated/api-types.ts` 已更新。

## 步骤

### 1. api 层加方法

在 `apps/admin-web/src/api/<domain>.ts` 建领域文件（真实范例：`api/registry.ts`）：

```ts
import { client } from './client';

export interface PypiPackage { /* ... */ }

export const registryApi = {
  listPypiPackages: async (): Promise<string[]> => {
    const resp = await client.get('/registry/pypi/packages') as { packages: string[] };
    return resp.packages ?? [];
  },
};
```

要点（与 `api/client.ts` 一致）：`client` 已在响应拦截器里**拆掉 `{code,message,data}` 信封**，类型直接写业务载荷；错误不要 try/catch 吞掉返回空值——UI-16 纪律是透出给页面 `StateError` 组件（`registry.ts` 里有现成注释先例）。

### 2. 类型生成（消费后端契约）

```bash
cd apps/admin-web
npm run gen:api-types
# = openapi-typescript ../admin-api/openapi.json -o src/types/generated/api-types.ts
```

`src/types/generated/api-types.ts` 是生成物，**勿手改**；与 `openapi.json` 的漂移由 CI `api-types-drift` job 拦截。

### 3. 页面组件

建 `src/pages/<X>Page.tsx`。可参照的真实形态：

- `src/pages/RegistryPage.tsx`（双 Tab + 空态 + StateError 错误态）
- `src/pages/TaskTemplatesPage.tsx`（卡片列表 + 新建 Modal）
- 读侧数据优先用 `src/api/queries.ts` 的 React Query hooks（FEAT-17 收口后的约定），写后失效用 `invalidateTaskData` 等既有 helper。

### 4. 注册路由

编辑 `src/router.tsx`（当前 74 行，结构一目了然）：

```tsx
const MyPage = lazy(() => import('./pages/MyPage'));           // 顶部 lazy 段
// MainLayout children 数组内：
{ path: 'my-page', element: withSuspense(<MyPage />) },
```

ADMIN-only 页面用既有门控包裹（真实先例：`/users`、`/audit`、`/executor-packages`）：

```tsx
{ path: 'my-admin-page', element: <RequireAdmin>{withSuspense(<MyAdminPage />)}</RequireAdmin> },
```

### 5. 菜单/入口

编辑 `src/layouts/MainLayout.tsx` 的菜单分组（真实结构：`g-overview/g-tasks/g-executions/g-executors/g-applications/g-system` 分组，子项 `key` = 路由路径、`label` = `t('nav.xxx')`）。新分组需同时加 `nav.group.*` 文案。

### 6. i18n 文案

`src/locales/zh.ts` 与 `src/locales/en.ts` 两份**扁平 key** 同步加（真实先例：`'nav.dashboard'`、`'nav.taskTemplates'`）。默认语言 zh，缺 key 回退 zh（`src/i18n/index.ts`），但两份都要补齐避免英文环境中文串。注意：仓库大量页面仍是页内硬编码中文（渐进迁移策略，见 `i18n/index.ts` 头注），新页面建议直接走 `t()`。

### 7. 测试

vitest + Testing Library，测试放 `src/__tests__/`（真实范例目录已有大量 `*.test.tsx`）：

```bash
cd apps/admin-web
npm test        # vitest run
npx tsc --noEmit
npm run lint
npm run build   # tsc -b && vite build
```

约定：mock `api/<domain>` 模块断言渲染与交互；mutation 失败要有 onError 断言（UI-15 纪律）；读请求失败要断言 StateError 渲染（UI-16 纪律，参见 [../07-testing/frontend-testing.md](../07-testing/frontend-testing.md)）。

## 验收清单

- [ ] `api/<domain>.ts` 方法不改 `api/client.ts`；错误透出不吞
- [ ] `npm run gen:api-types` 已跑，生成物同 commit 提交
- [ ] `router.tsx` 路由可达；ADMIN-only 页套了 `RequireAdmin`
- [ ] `MainLayout.tsx` 菜单入口存在（或页面确属详情/向导类无需入口）
- [ ] `locales/zh.ts` + `en.ts` 双份 key 齐全
- [ ] `npm test` / `tsc --noEmit` / `lint` / `build` 全绿，测试只增不减
- [ ] 错误态用 `StateError`、空态有兜底（UI-16 权威盘点口径）

## 常见坑

- **手改生成类型**：`src/types/generated/api-types.ts` 只能由 `gen:api-types` 产出，手改必被 CI drift 闸打回。
- **`client.get` 返回值当 AxiosResponse 用**：拦截器已拆信封，直接 `as` 成业务类型（`api/client.ts` 头部注释专门讲了这个 re-type）。
- **忘记双 locale**：英文环境出现 key 名或中文串；fallback 是 zh 不会报错，只能靠肉眼/测试发现。
- **ADMIN 门控加在页面内部而非路由**：路由级 `RequireAdmin` 是既有模式（见 `router.tsx` 注释），页面内自行判断易漏。

## 相关文档

- [../01-apps/admin-web/api-layer.md](../01-apps/admin-web/api-layer.md) · [../01-apps/admin-web/routing-and-auth.md](../01-apps/admin-web/routing-and-auth.md) · [../01-apps/admin-web/store-and-hooks.md](../01-apps/admin-web/store-and-hooks.md)
- [../07-testing/frontend-testing.md](../07-testing/frontend-testing.md)
- [add-new-api-module.md](add-new-api-module.md)（供给端）· [task-board/TEMPLATE.md](task-board/TEMPLATE.md)
