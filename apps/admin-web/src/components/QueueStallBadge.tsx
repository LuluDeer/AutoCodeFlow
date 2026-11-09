/**
 * R205 · 「**队列可能停摆**」页头徽标 —— 「异常接管台」的第四个徽标。
 *
 * ## 与另三个徽标的分工（**四个口径互不重叠**）
 *
 * | 徽标 | 观测对象 | 现象 |
 * |---|---|---|
 * | 待接管（R198） | 会话状态 | `waiting_input` 正常等人 |
 * | 卡住（R199） | 会话的**最近 step** | `running` 但久无进展 |
 * | 积压（R203） | 会话 ↔ job 的**存在性** | `pending` 但队列里没有 job |
 * | **队列停摆（本轮）** | **队列的 worker 注册面** | **有活排队，但结构上没人能消费** |
 *
 * 判据：`docs/observability/agent-queue-stall-criterion.md`。
 *
 * ## 为什么文案必须说「**可能**停摆」
 *
 * 判据的 `workers === 0` 读的是 BullMQ 的 worker 注册表。若某 worker 的**事件循环被阻塞**
 * （同步重活、GC 停顿），它的心跳可能过期 ⇒ 注册表读出来是空的 ⇒ **误报**。
 * ⇒ 文案说「**可能**」；**只告警不处置**（自动 `resume`/重新入队都可能在「其实只是心跳过期」
 * 时**造成真实损害** —— 重复执行）。处置是人的事：**查 admin-api 进程 / Worker 是否还活着**。
 *
 * ## 三条约束（与 R198/R199/R203 同款）
 *
 * ① **读失败不得渲染成「队列正常」**；
 * ② **`degraded`（判定不完整）也不得渲染成「正常」** —— 它是「**没读到**」的一种；
 * ③ **只有「真的读到且不���摆」才允许不显示**。
 */
import { useCallback, useEffect, useState } from "react";
import { Button, Tooltip } from "antd";
import { useTranslation } from "react-i18next";
import { agentApi } from "../api/agent";

export interface QueueStallBadgeProps {
  /** 点徽标时的回调（页面可据此给出处置指引）。 */
  onJump?: () => void;
  /** 主列表刷新信号（+1 ⇒ 徽标跟着刷）。 */
  refreshToken?: number;
}

interface State {
  stalled: boolean;
  /** ⚠️ 判定**不完整**（某个观测量读失败）—— 不是「正常」。 */
  degraded: boolean;
  /** 成因（`paused` / `no-worker`）。 */
  reason: string | null;
  /** 在排队的 job 数。 */
  pendingJobs: number;
  error: unknown;
}

export default function QueueStallBadge({ onJump, refreshToken = 0 }: QueueStallBadgeProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<State>({
    stalled: false,
    degraded: false,
    reason: null,
    pendingJobs: 0,
    error: null,
  });

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      // ⚠️ 容错：测试替身常常只 mock 页面用到的那几个方法（R181 方法学 358）
      //   ⇒ 本徽标是**增强**功能，方法缺失时降级为「读不到」，不让页面因一个徽标崩掉。
      const fn = agentApi.queueStall;
      if (typeof fn !== "function") throw new Error("queueStall unavailable");
      const r = await fn();
      if (signal?.aborted) return;
      setState({
        stalled: r.stalled,
        degraded: r.degraded,
        reason: r.reason,
        pendingJobs: r.pendingJobs,
        error: null,
      });
    } catch (err: unknown) {
      if (signal?.aborted) return;
      setState({ stalled: false, degraded: true, reason: null, pendingJobs: 0, error: err });
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load, refreshToken]);

  // 读失败 ⇒ **必须**看得见（否则运营以为「队列没问题」）。
  if (state.error) {
    return (
      <Tooltip title={t("agents.queueStall.loadFailHint")}>
        <Button size="small" danger type="text" onClick={() => void load()} data-testid="queue-stall-load-fail">
          {t("agents.queueStall.loadFail")}
        </Button>
      </Tooltip>
    );
  }

  // ⚠️ `degraded` = 判定**不完整** ⇒ **不得**渲染成「正常」（那与读失败是同一种假事实）。
  if (state.degraded) {
    return (
      <Tooltip title={t("agents.queueStall.degradedHint")}>
        <Button size="small" type="text" onClick={() => void load()} data-testid="queue-stall-degraded">
          {t("agents.queueStall.degraded")}
        </Button>
      </Tooltip>
    );
  }

  // 只有「**真的读到且不**停摆」才不显示 —— 这是唯一合法的静默情形。
  if (!state.stalled) return null;

  return (
    <Tooltip
      title={
        state.reason === "paused"
          ? t("agents.queueStall.pausedHint")
          : t("agents.queueStall.noWorkerHint", { pending: state.pendingJobs })
      }
    >
      <Button size="small" danger type="text" onClick={onJump} data-testid="queue-stall-jump">
        {t("agents.queueStall.label")}
      </Button>
    </Tooltip>
  );
}
