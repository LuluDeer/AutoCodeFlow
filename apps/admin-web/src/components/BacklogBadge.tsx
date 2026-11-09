/**
 * R203 · 「**积压 N**」页头入口 —— Roadmap P1「异常接管台」三件套的第三件。
 *
 * ## 与另外两个徽标的分工（**三个口径互不重叠**）
 *
 * | 徽标 | 状态 | 现象 | 人的动作 |
 * |---|---|---|---|
 * | 待接管（R198） | `waiting_input` | **正常地**在等人 | 审批 / 回复澄清 |
 * | 卡住（R199） | `running` 且久无进展 | 跑着跑着不动了 | 介入 / 终止 |
 * | **积压（本轮）** | `pending` 且**队列里没有 job** | **根本没开始跑** | **重新入队**（无损） |
 *
 * 判据：`docs/observability/agent-backlog-criterion.md`；后端端点 R202。
 *
 * ## 为什么**只告警不处置**（与 `sweepStaleRunning` 的自动收敛**故意不同**）
 *
 * `queue.add` 失败是**可恢复**的：重新 `add` 一次即可，会话行与预算都还好好的，
 * 且 `jobId` 相同 ⇒ **重复 add 幂等安全**。
 * 而「重新入队」**要求会话仍是 `pending`** ⇒ 若像 stale-running 那样自动改成 `failed`，
 * 运营就只能走 resume（多一步，且 resume 有「steps 被清理则拒绝」的限制）。
 * ⇒ **绝不能自动改状态**。
 *
 * ## 三条约束（与 R198/R199 同款，来自本仓主导缺陷类）
 *
 * ① **读失败不得渲染成「0 条积压」**（那会让运营放心地不管）；
 * ② **读失败不得静默不渲染**；
 * ③ **只有「真的读到且为 0」才允许不显示**。
 *
 * ## 额外一条（R395 的直接落地）：**`truncated` 必须呈现**
 *
 * 对账有上限（后端 `BACKLOG_PROBE_LIMIT = 200`）。若截断了却只说「积压 3」，
 * 运营会以为「一共就 3 条」，而实际可能有几百条 ⇒ **同一符号两个语义**。
 * ⇒ 截断时徽标带 `+`（`3+`）并在 tooltip 里说明「只对账了前 N 条」。
 */
import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Tooltip } from "antd";
import { message } from "../utils/toast";
import { useTranslation } from "react-i18next";
import { agentApi } from "../api/agent";

export interface BacklogBadgeProps {
  /**
   * 点徽标时的回调。**可选**：不传时徽标自己弹出「如何重新入队」的说明
   * （解释跟着徽标走，页面不必知道这条业务的细节）。
   */
  onJump?: () => void;
  /** 主列表刷新信号（+1 ⇒ 徽标跟着刷）。 */
  refreshToken?: number;
}

interface State {
  count: number | null;
  /** ⚠️ **是否因上限截断**（R395：必须呈现，不能只给 count）。 */
  truncated: boolean;
  /** 实际对账了几条（诊断用，进 tooltip）。 */
  probed: number;
  error: unknown;
}

export default function BacklogBadge({ onJump, refreshToken = 0 }: BacklogBadgeProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<State>({
    count: null,
    truncated: false,
    probed: 0,
    error: null,
  });

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      // ⚠️ 容错：测试替身常常只 mock 页面用到的那几个方法（R181 方法学 358）
      //   ⇒ 本徽标是**增强**功能，方法缺失时降级为「读不到」，不让页面因一个徽标崩掉。
      const fn = agentApi.backloggedCount;
      if (typeof fn !== "function") throw new Error("backloggedCount unavailable");
      const r = await fn();
      if (signal?.aborted) return;
      setState({ count: r.count, truncated: r.truncated, probed: r.probed, error: null });
    } catch (err: unknown) {
      if (signal?.aborted) return;
      // 不清零、不静默：保留「不知道」这个事实（见头注 ①②）。
      setState({ count: null, truncated: false, probed: 0, error: err });
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load, refreshToken]);

  // 读失败：**必须**看得见（否则运营以为「没有积压的」）。
  if (state.error) {
    return (
      <Tooltip title={t("agents.backlog.loadFailHint")}>
        <Button size="small" danger type="text" onClick={() => void load()} data-testid="backlog-load-fail">
          {t("agents.backlog.loadFail")}
        </Button>
      </Tooltip>
    );
  }

  // 只有「**真的读到且为 0**」才不显示——这是唯一合法的静默情形。
  if (state.count === null || state.count === 0) return null;

  return (
    <Tooltip
      title={
        state.truncated
          ? t("agents.backlog.truncatedHint", { probed: state.probed })
          : t("agents.backlog.hint")
      }
    >
      <Badge
        // R395：截断时用 `N+` 而不是 `N` —— 否则「3」在两种情形下同形。
        count={state.truncated ? `${state.count}+` : state.count}
        size="small"
        offset={[-2, 2]}
      >
        <Button
          size="small"
          type="text"
          onClick={onJump ?? (() => message.info(t("agents.backlog.howTo")))}
          data-testid="backlog-jump"
        >
          {t("agents.backlog.label")}
        </Button>
      </Badge>
    </Tooltip>
  );
}
