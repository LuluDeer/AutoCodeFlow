/**
 * R207 · 「**队列可能空转**」页头徽标 —— 异常接管台的第五个徽标。
 *
 * ## 与另四个徽标的分工（**五个口径互不重叠**，R399 的强制步骤）
 *
 * | 徽标 | 观测对象 | 现象 |
 * |---|---|---|
 * | 待接管（R198） | 会话状态 | `waiting_input` 正常等人 |
 * | 卡住（R199） | 会话的**最近 step** | `running` 但久无进展 |
 * | 积压（R203） | 会话 ↔ job 的**存在性** | `pending` 但队列里没有 job |
 * | 队列停摆（R205） | 队列的 **worker 注册面** | 有活排队，但**没有 worker** |
 * | **队列空转（本轮）** | **最老 waiting job 的年龄** | **worker 在册、却不再消费** |
 *
 * 判据：`docs/observability/agent-queue-idle-criterion.md`。
 *
 * ## 三条约束（与 R198/R199/R203/R205 同款）
 *
 * ① **读失败不得渲染成「队列正常」**；
 * ② **`degraded`（判定不完整）也不得渲染成「正常」**——它是「没读到」的一种；
 * ③ **只有「真的读到且不空转」才允许不显示**。
 *
 * ## 额外一条（本条特有）：**`suppressedBy` 必须静默**
 *
 * 后端在「已停摆」时让位（`suppressedBy: 'queue-stall'`）——那是**完整判定**，
 * 只是这一格归停摆徽标。⇒ 此时本徽标**不显示**，且**不得**当成「读不到」
 * 去渲染一个「未知」按钮：那会让运营以为观测坏了，而它其实好得很。
 *
 * ## 为什么文案说「**可能**」空转
 *
 * 阈值 = 「墙钟预算 × 并发槽位数 + 一拍」（由配置推导，见后端 `deriveIdleThreshold`）。
 * 若某轮 LLM 调用本身**卡在超时边缘**且墙钟判定恰好在轮次开头，真实等待会略超阈值
 * ⇒ 存在**误报窗口**。⇒ 文案说「可能」；**只告警不处置**（自动重入队会在
 * 「其实还在慢慢跑」时造成**重复执行**）。处置是人的事：**查 worker 进程 / Redis 连接**。
 */
import { useCallback, useEffect, useState } from "react";
import { Button, Tooltip } from "antd";
import { useTranslation } from "react-i18next";
import { agentApi } from "../api/agent";

export interface QueueIdleBadgeProps {
  /** 点徽标时的回调（页面可据此给出处置指引）。 */
  onJump?: () => void;
  /** 主列表刷新信号（+1 ⇒ 徽标跟着刷）。 */
  refreshToken?: number;
}

interface State {
  idleStuck: boolean;
  /** ⚠️ 判定**不完整**（某个观测量读失败）—— 不是「正常」。 */
  degraded: boolean;
  /** ⚠️ 已停摆 ⇒ 本判据让位（**完整判定**，不是读失败）。 */
  suppressed: boolean;
  /** 最老 waiting job 的年龄（ms）。 */
  oldestAgeMs: number;
  /** 在排队的 job 数。 */
  waitingCount: number;
  error: unknown;
}

export default function QueueIdleBadge({ onJump, refreshToken = 0 }: QueueIdleBadgeProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<State>({
    idleStuck: false,
    degraded: false,
    suppressed: false,
    oldestAgeMs: 0,
    waitingCount: 0,
    error: null,
  });

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      // ⚠️ 容错：测试替身常常只 mock 页面用到的那几个方法（R181 方法学 358）
      //   ⇒ 本徽标是**增强**功能，方法缺失时降级为「读不到」，不让页面因一个徽标崩掉。
      const fn = agentApi.queueIdle;
      if (typeof fn !== "function") throw new Error("queueIdle unavailable");
      const r = await fn();
      if (signal?.aborted) return;
      setState({
        idleStuck: r.idleStuck,
        degraded: r.degraded,
        suppressed: r.suppressedBy === "queue-stall",
        oldestAgeMs: r.oldestAgeMs,
        waitingCount: r.waitingCount,
        error: null,
      });
    } catch (err: unknown) {
      if (signal?.aborted) return;
      setState({
        idleStuck: false,
        degraded: true,
        suppressed: false,
        oldestAgeMs: 0,
        waitingCount: 0,
        error: err,
      });
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
      <Tooltip title={t("agents.queueIdle.loadFailHint")}>
        <Button size="small" danger type="text" onClick={() => void load()} data-testid="queue-idle-load-fail">
          {t("agents.queueIdle.loadFail")}
        </Button>
      </Tooltip>
    );
  }

  // ⚠️ `degraded` = 判定**不完整** ⇒ **不得**渲染成「正常」（与读失败是同一种假事实）。
  if (state.degraded) {
    return (
      <Tooltip title={t("agents.queueIdle.degradedHint")}>
        <Button size="small" type="text" onClick={() => void load()} data-testid="queue-idle-degraded">
          {t("agents.queueIdle.degraded")}
        </Button>
      </Tooltip>
    );
  }

  // ⚠️ 让位给停摆徽标 ⇒ **静默**（这是完整判定，不是读不到；渲染「未知」会是新假事实）。
  if (state.suppressed) return null;

  // 只有「**真的读到且不**空转」才不显示 —— 这是唯一合法的静默情形。
  if (!state.idleStuck) return null;

  // 分钟取整向上：`Math.round` 会把 29.6min 显示成 30min，让「刚过阈值」看起来更久。
  const ageMinutes = Math.ceil(state.oldestAgeMs / 60_000);

  return (
    <Tooltip title={t("agents.queueIdle.hint", { minutes: ageMinutes, waiting: state.waitingCount })}>
      <Button size="small" danger type="text" onClick={onJump} data-testid="queue-idle-jump">
        {t("agents.queueIdle.label")}
      </Button>
    </Tooltip>
  );
}
