/**
 * R171：「下发到设备」弹窗的**数据装载 + 序号守卫**（从 `ApplicationDetailPage` 抽出）。
 *
 * ## 为什么抽出来（两个理由，都不是洁癖）
 *
 * ① **R170 的序号守卫只照抄了代码、没照抄测试** —— 那条守卫写在页面内联函数里，
 *    要测它必须驱动整张版本历史表、点两行的「下发」按钮、并在 `Promise` 之间精确控时序。
 *    抽成 hook 后能直接对**守卫本身**写竞态用例（`__tests__/deploy-modal-deploy-seq.test.tsx`）。
 * ② 页面已顶到体量棘轮（`check:size-caps` 只减不增），抽出**净减**行数。
 *
 * ## 守卫要防的具体事故（原文见 R170 提交）
 *
 * 快速先点版本 A 再点版本 B（或 A 的响应慢于 B）时，**A 的旧响应晚到**会把 `pkg` 与
 * `checkedExecutors` 整个覆盖成 A 的 ⇒ **标题写着 B、要下发的包地址与默认勾选的执行器却来自 A**
 * ⇒ 用户点「确认下发」就**发错包**（不可逆）。
 *
 * 形态与同仓 `AgentSessionsPage.detailSeq` / `SopsPage.detailSeq` **一致**（不另发明）。
 */
import { useCallback, useRef, useState } from 'react';
import { applicationsApi, deploymentsApi } from '../../api/applications';
import { resolveDeployPkgState } from './deploy-pkg-state';
import type { DeployModalData } from './DeployToDevicesModal';

/** 「下发目标」的最小形状（页面侧 `deployTarget` 的可重用部分）。 */
export interface DeployTargetLike {
  id: string;
}

export interface UseDeployModalData {
  /** null = 清单读取中（弹窗内 Spin）。 */
  data: DeployModalData | null;
  /** 勾选缺省 = 全部 `running` 行的执行器（与旧 rollback 缺省行为一致）。 */
  checked: string[];
  /** 勾选变更（支持函数式更新，形态与 `useState` 的 setter 一致）。 */
  setChecked: (next: string[] | ((prev: string[]) => string[])) => void;
  /** 读失败（弹窗侧据此渲染错误块并**关闭**弹窗：无从安全勾选时不许假装没设备）。 */
  error: unknown;
  /**
   * 装载某个版本的下发清单；**只允许最新一发落地**。
   *
   * 返回值 = **本次调用的**错误（`null` = 成功或被更新的调用取代）。
   * ⚠️ **不要**用状态字段 `error` 在 `await load()` 之后判断 —— React 的 setState 不同步，
   * 那一行读到的仍是**上一次渲染**的值（R171 实测踩到）。返回值是可靠的那一份。
   */
  load: (target: DeployTargetLike) => Promise<unknown>;
  /** 关闭/重置（**同时自增序号** ⇒ 关掉后旧响应不会写回）。 */
  reset: () => void;
}

export function useDeployModalData(appId: string): UseDeployModalData {
  const [data, setData] = useState<DeployModalData | null>(null);
  const [checked, setCheckedState] = useState<string[]>([]);
  const [error, setError] = useState<unknown>(null);
  /** R170/R171：每次调用自增；`reset` 也自增 ⇒ 旧响应一律丢弃。 */
  const seq = useRef(0);

  const setChecked = useCallback((next: string[] | ((prev: string[]) => string[])) => {
    setCheckedState((prev) => (typeof next === 'function' ? next(prev) : next));
  }, []);

  const reset = useCallback(() => {
    seq.current += 1;
    setData(null);
    setChecked([]);
    setError(null);
  }, [setChecked]);

  const load = useCallback(
    async (target: DeployTargetLike) => {
      if (!target.id) return null;
      const mine = ++seq.current;
      setData(null);
      setChecked([]);
      setError(null);
      try {
        const [deps, releases] = await Promise.all([
          deploymentsApi.list(appId, 1, 100),
          // packageUrl 是确认前的提示信息，读取失败不阻断下发面（标为「未确认」）
          applicationsApi.getReleases(appId, 1, 200).catch(() => null),
        ]);
        if (mine !== seq.current) return null; // 旧响应晚到 ⇒ 丢弃（别的版本 / 已关闭）
        const rows = deps.data ?? [];
        setData({
          rows,
          // 旧后端不带 total ⇒ 回落实取行数（按未截断处理，不谎报截断）
          total: deps.total ?? rows.length,
          pkg: resolveDeployPkgState(releases, target.id),
        });
        setChecked([
          ...new Set(
            rows.filter((d) => d.status === 'running').map((d) => d.executorId).filter((x): x is string => !!x),
          ),
        ]);
        return null;
      } catch (err: unknown) {
        if (mine !== seq.current) return null; // 旧响应的失败不该动当前弹窗
        setError(err);
        return err;
      }
    },
    [appId],
  );

  return { data, checked, setChecked, error, load, reset };
}
