import { useEffect, useMemo, useState } from 'react';
import { executorsApi, Executor } from '../api/executors';

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
export interface ExecutorNameIndex {
  /** 解析出可读名；解析不到返回 null（调用方应回落显示地址）。 */
  nameOf: (deployment: { executorId?: string | null; executorAddress?: string | null }) => string | null;
  /** 清单本身，供调用方复用（避免二次请求）。 */
  executors: Executor[];
  loading: boolean;
}

/**
 * 拉取（或复用）执行器清单并建立 id/address → appName 索引。
 *
 * ## 为什么要支持「传入清单」
 *
 * `AppDeploymentPage` 本来就会 `GET /executors`（下拉候选 + 占用判断，见
 * fetchAll）。若本 hook 再自拉一次，同一页面会重复请求同一端点——而且会破坏
 * 该页既有的性能契约（F-34：执行器清单**只在首屏拉一次**，秒级轮询拍不重复
 * 拉取；已有测试 `app-deployment-polling.test.tsx` 断言 list 恰好被调用 1 次）。
 *
 * 故：**传入 `source` 时直接用，不发请求**；不传（`undefined`）才自拉——
 * 供没有现成清单的页面（如 ApplicationDetailPage 的两个表）使用。
 *
 * 注意 `source` 传空数组表示「清单就是空的」，**不会**触发自拉（调用方已经
 * 拉过了，只是还没回来或真的没有）。这样名字会随调用方的 state 到位而出现。
 *
 * 拉取失败**不抛出**：名字只是锦上添花，不该让整个部署表/版本表因此报错。
 * 失败时 nameOf 恒返回 null，页面照常显示地址（与改动前的行为一致）。
 */
export function useExecutorNames(source?: Executor[]): ExecutorNameIndex {
  const [fetched, setFetched] = useState<Executor[]>([]);
  const [loading, setLoading] = useState(false);
  // 调用方提供了清单（含空数组）→ 完全以它为准，绝不重复请求。
  const selfFetch = source === undefined;

  useEffect(() => {
    if (!selfFetch) return;
    let cancelled = false;
    setLoading(true);
    executorsApi
      .list()
      .then((list) => {
        if (!cancelled) setFetched(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        // 静默降级：名称解析不可用时页面仍显示地址（信息不缺失，只是不够友好）
        if (!cancelled) setFetched([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selfFetch]);

  const executors = selfFetch ? fetched : source;

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

  return { nameOf, executors, loading };
}
