import { QueryClient } from '@tanstack/react-query';

/**
 * ARCH-26: TanStack Query 全局默认（渐进引入——新页面/改造页消费 src/api/queries.ts
 * 薄层 hooks 自动继承；既有 ahooks useRequest 页面保持原样，全站推广留后续轮）。
 * - staleTime 30s：对齐原 Dashboard 各卡 30s 轮询节奏，切页回来 30s 内不再重复拉取；
 * - refetchOnWindowFocus 关闭：管理台多 Tab 并开场景下，聚焦瞬间全 key 重取
 *   会造成请求风暴，轮询/失效策略已覆盖数据新鲜度；
 * - refetchOnReconnect 保留默认 true：断网恢复后自动拉取最新数据。
 *
 * F-32（DEEP_REVIEW 0ef3bbe）：**重试职责归一**——重试只保留一层，落在传输层
 * （api/client.ts 的响应拦截器：仅安全方法、1 次、1s 退避）。此前 Query 层
 * retry=2 与之叠加，一次失败最多打 6 发请求（3 次 Query 尝试 × 2 次 axios 尝试），
 * 且每次尝试失败都弹一次 toast（"双报错"放大成 3 条）。
 * 选择保留 axios 层而非 Query 层，理由：
 *  1) axios 层覆盖**全部**调用方（含尚未迁 Query 的 ahooks useRequest 页面），
 *     去掉它会让旧页面彻底失去重试；Query 层只覆盖已迁移页面；
 *  2) axios 层的错误 toast 是唯一的全局错误出口，若由 Query 层重试，每次重试
 *     都会再弹一条 toast（拦截器对每次失败都提示），需要额外去重改造才能收敛；
 *  3) 单层后请求放大收敛为最多 2 发、toast 恒 1 条。
 * 因此 Query 层显式 retry:false —— 重试能力仍在（传输层），不会双重叠加。
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: false,
        refetchOnWindowFocus: false,
      },
    },
  });
}

/** 应用级单例（main.tsx 挂到 QueryClientProvider） */
export const queryClient = createQueryClient();
