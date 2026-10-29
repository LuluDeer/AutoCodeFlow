import { useContext, useMemo } from 'react';
import { QueryClientContext, useQuery } from '@tanstack/react-query';
import { executorsApi } from '../api/executors';
import { queryKeys } from '../api/queries';
import { queryClient as appQueryClient } from '../api/queryClient';

/**
 * 执行器可读名解析（用户报障：中台「执行器」列只有一个 IP:端口，看不出是哪台机器）。
 *
 * ## 问题
 *
 * 部署表 / 版本历史表此前只渲染 `executorAddress`（形如 `192.168.4.54:8003`）。
 * 用户给执行器起的名字（`executorName`，注册时上报、执行器列表页就在显示）
 * 在这些列里完全缺席——于是"这条部署到哪台机器了"要靠记 IP 才能答上来。
 *
 * 数据其实**早就在前端**：部署页为了渲染执行器下拉候选与占用判断，本来就
 * `GET /executors` 拿到了完整清单（含 `appName`）。缺的只是把两处接起来。
 *
 * ## 匹配口径
 *
 * 优先按 `executorId`（稳定主键）；旧记录 `executorId` 可能为空，回落按
 * `address` 匹配。**都匹配不到时返回 null**，由调用方如实只显示地址——
 * 绝不编造名字（把地址当名字、或显示"未知执行器"都会误导排查）。
 */
/**
 * 本 hook 实际消费的执行器行结构子集——建立索引只读 `id` / `appName` /
 * `address` 三个字段（见下方 index 构建），任何含这三列的行都可用。
 *
 * R3-E 遗留收口：`AppDeploymentPage` 的下拉/占用判断已整体改吃
 * `GET /executors/picker` 的轻读面（`ExecutorPickerItem`，6 列），若本 hook
 * 仍要求完整 `Executor` 类型，该页就得为名字解析**再拉一次全列 list()**——
 * 首屏 list+picker 双请求。参数放宽为该子集后，调用方直接传 picker 行即可
 * （`Executor` 全列行显然也满足该子集，`ApplicationDetailPage` 的自拉路径不受影响）。
 */
export interface ExecutorNameSourceItem {
  id?: string;
  appName?: string;
  address?: string;
}

export interface ExecutorNameIndex {
  /** 解析出可读名；解析不到返回 null（调用方应回落显示地址）。 */
  nameOf: (deployment: { executorId?: string | null; executorAddress?: string | null }) => string | null;
  /** 清单本身，供调用方复用（避免二次请求）。 */
  executors: ExecutorNameSourceItem[];
  loading: boolean;
}

/**
 * 自拉清单走 TanStack Query 缓存（P2-B1）——与 `useExecutorsList()` 同 key/同
 * queryFn，同一时刻的多个调用方被合并成**一次**请求。
 *
 * ## 为什么必须收敛
 *
 * 此前自拉路径是 `useEffect` + 裸 `executorsApi.list()`，**完全绕过** Query 缓存：
 *   · 执行详情页：常驻的 `ExecutionInfoCard` 与「重试链」Tab 的
 *     `ExecutionRetryChain` 各挂一个本 hook → 各拉一次全量清单；
 *   · 应用详情页：概览 / 版本历史 / 发布记录三个页签各挂一个 → 各拉一次。
 * 清单是大对象（全列 20+ 字段 × N 台），重复拉取纯属浪费；执行器列表页本来
 * 就有一份同 key 的缓存（`useExecutorsList`，30s 轮询），却完全没被复用。
 *
 * ## 收敛后仍然保留的语义
 *
 * · `source` 优先：传了（含空数组）就**不发请求**，行为逐条不变；
 * · 匹配不到 → null（调用方如实回落地址 / `#id`）；
 * · 失败静默：名字只是锦上添花，拉取失败不得让部署表/版本表报错。
 */
export function useExecutorNames(source?: ExecutorNameSourceItem[]): ExecutorNameIndex {
  // 调用方提供了清单（含空数组）→ 完全以它为准，绝不重复请求。
  const selfFetch = source === undefined;

  /**
   * 取 QueryClient：Provider 里的优先（生产 `main.tsx` 恒挂 `QueryClientProvider`，
   * 与 `useExecutorsList` 共用同一份缓存）；无 Provider 时回落到模块级单例。
   *
   * 回落分支存在的原因：hooks 必须**无条件**调用（条件调用 useQuery 违反 hooks
   * 规则，且 useQuery 拿不到 client 会直接抛错）。少量既有页面测试没有挂
   * `QueryClientProvider`（它们测的页面本身还没迁 Query），若这里硬要求
   * Provider，这些页面会从"名字解析降级"直接变成"整页崩"。
   */
  const contextClient = useContext(QueryClientContext);
  const client = contextClient ?? appQueryClient;

  const { data, isFetching } = useQuery(
    {
      // 与 api/queries.ts 的 useExecutorsList 同一个 key + queryFn：缓存共享、
      // 并发合并、写后 invalidate 一并生效。
      queryKey: queryKeys.executors.list,
      queryFn: ({ signal }) => executorsApi.list(signal),
      // 调用方给了清单就不发请求（与自拉路径的 source 语义一一对应）
      enabled: selfFetch,
      // 失败不重试（重试职责在传输层，见 api/queryClient.ts F-32 注）；30s 内
      // 切页/切页签不重复拉取，与全站 Query 默认 staleTime 同口径。
      retry: false,
      staleTime: 30_000,
    },
    client,
  );

  // 引用稳定性：`data ?? []` 每次渲染都会新建空数组，直接当 useMemo 依赖会让
  // 索引每帧重建（lint 的 exhaustive-deps 警告指的就是这个）。这里把"选哪份清单"
  // 收敛成一次 memo，依赖只有三个真输入。
  const executors = useMemo<ExecutorNameSourceItem[]>(
    () => (selfFetch ? (data ?? []) : source),
    [selfFetch, data, source],
  );

  const index = useMemo(() => {
    const byId = new Map<string, string>();
    const byAddress = new Map<string, string>();
    for (const e of executors) {
      const name = e.appName?.trim();
      if (!name) continue;
      if (e.id) byId.set(e.id, name);
      if (e.address) byAddress.set(e.address, name);
    }
    return { byId, byAddress };
  }, [executors]);

  const nameOf = useMemo(
    () =>
      (deployment: { executorId?: string | null; executorAddress?: string | null }): string | null => {
        if (deployment.executorId) {
          const hit = index.byId.get(deployment.executorId);
          if (hit) return hit;
        }
        if (deployment.executorAddress) {
          return index.byAddress.get(deployment.executorAddress) ?? null;
        }
        return null;
      },
    [index],
  );

  // 只在自拉路径上报 loading（传入 source 时 loading 恒 false，与此前一致）
  return { nameOf, executors, loading: selfFetch && isFetching };
}
