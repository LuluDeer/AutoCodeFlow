/**
 * R199 · 「**卡住 N**」页头入口（Roadmap P1「异常接管台」的另一半）。
 *
 * ## 与 `PendingTakeoverBadge` 的分工（**两个组件，不是一个组件的两个模式**）
 *
 * · `PendingTakeoverBadge`（R198）= **等人工**（`waiting_input`）：会话**正常地**在等人，
 *   人来了就能继续。
 * · 本组件（`StalledBadge`）= **卡住不动**（`running` 且**久无进展**）：没有人能推进它，
 *   **等再久也没用** —— 需要的是**介入/终止**。
 *
 * ⇒ 两个口径**互不重叠**（判据里 `stalled` 只看 `running`），所以两个徽标可以同时出现，
 * 语义不冲突。**为什么不做成一个组件的两个模式**：两个组件各自的**失败态文案不同**
 * （「待接管数未知」vs「卡住数未知」）且**判定数据源不同**（`status` 过滤 vs `stalled` 过滤），
 * 合并只会得到一个带 `kind` 分支的组件 ⇒ **分支比组件更贵**。
 *
 * ## 三条约束（与 R198 同款，来自本仓主导缺陷类）
 *
 * ① **读失败不得渲染成「0 个卡住」** —— 那会让运营放心地不去管；
 * ② **读失败不得静默不渲染** —— 同上；
 * ③ **只有「真的读到且为 0」才允许不显示**。
 *
 * ## 判据
 *
 * 见 `docs/observability/agent-stalled-criterion.md`（**先定判据再写代码**）：
 * > stalled = `running` 且「最近一步 `AgentStep` 的 `createdAt`」距今超过 N 分钟（默认 15）。
 */
import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Tooltip } from "antd";
import { useTranslation } from "react-i18next";
import { agentApi } from "../api/agent";

export interface StalledBadgeProps {
  /** 点徽标时回调（页面把列表切到「只看卡住」）。 */
  onJump: () => void;
  /** 主列表刷新信号（+1 ⇒ 徽标跟着刷）。 */
  refreshToken?: number;
  /** 卡住阈值（分钟）；不传 ⇒ 用后端默认（15）。 */
  minutes?: number;
}

interface State {
  count: number | null;
  error: unknown;
}

export default function StalledBadge({ onJump, refreshToken = 0, minutes }: StalledBadgeProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<State>({ count: null, error: null });

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      // ⚠️ 容错：测试替身常常只 mock 了页面用到的那几个方法（R181 方法学 358）
      //   ⇒ 本徽标是**增强**功能，方法缺失时降级为「读不到」，不让页面因一个徽标崩掉。
      const fn = agentApi.stalledCount;
      if (typeof fn !== "function") throw new Error("stalledCount unavailable");
      const count = await fn(minutes);
      if (signal?.aborted) return;
      setState({ count, error: null });
    } catch (err: unknown) {
      if (signal?.aborted) return;
      // 不清零、不静默：保留「不知道」这个事实（见头注 ①②）。
      setState({ count: null, error: err });
    }
  }, [minutes]);

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load, refreshToken]);

  // 读失败：**必须**看得见（否则运营以为「没有卡住的」）。
  if (state.error) {
    return (
      <Tooltip title={t("agents.stalled.loadFailHint")}>
        <Button size="small" danger type="text" onClick={() => void load()} data-testid="stalled-load-fail">
          {t("agents.stalled.loadFail")}
        </Button>
      </Tooltip>
    );
  }

  // 只有「**真的读到且为 0**」才不显示——这是唯一合法的静默情形。
  if (state.count === null || state.count === 0) return null;

  return (
    <Badge count={state.count} size="small" offset={[-2, 2]}>
      <Button size="small" type="text" onClick={onJump} data-testid="stalled-jump">
        {t("agents.stalled.label")}
      </Button>
    </Badge>
  );
}
