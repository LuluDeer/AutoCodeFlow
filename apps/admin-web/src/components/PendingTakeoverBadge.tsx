/**
 * R198 · 「**待接管 N**」页头入口（Roadmap P1「异常接管台」的最小可用形态）。
 *
 * ## 缺的是什么（这是"功能新增"，不是修 bug）
 *
 * 运营打开 `AgentSessionsPage` 时，**看不出当前有多少会话在等人工**——
 * 只有逐行扫橙色徽标（`needsApprovalBadge`），或者**先知道**要选哪个 status 才筛得出来。
 * Roadmap P1 的原话是「stalled / escalated **统一队列**，**运营视角**一键接管，
 * 而不是只看 Agent 会话日志」。
 *
 * 本组件给的是那个队列的**入口**：页头一个「待接管 N」徽标，点一下就把
 * `statusFilter` 设成 `waiting_input` ⇒ 列表立刻只剩需要人工的会话。
 * 这是**最小可用**形态（不做新页面、不改后端），但把「运营视角」这件事补齐了。
 *
 * ## 三条设计约束（都是本仓主导缺陷类的直接教训）
 *
 * ① **不能把「读失败」渲染成「0 个待接管」** —— 那会让运营**放心地不去处理**
 *    （"看起来没人等我"）。这正是 R188–R195 修的同一类假事实。
 *    ⇒ 失败态**显式**说「待接管数未能获取」，并给重试。
 * ② **不能把「读失败」渲染成「没有徽标」** —— 同上，静默等于谎报 0。
 * ③ **0 个时**才真的不显示徽标（这是**唯一**可以不显示的合法情形，
 *    因为此时"没有待接管"是真的）。
 *
 * ## 为什么单独请求，而不是复用列表的 `total`
 *
 * 主列表的 `total` 受 `statusFilter` / `kindFilter` / 分页影响——
 * 用户一筛选，它就不再是「待接管数」了。用一个 `pageSize: 1` 的独立请求拿**全量 `total`**
 * 才是准确的口径（轻量：只要 1 条记录）。
 */
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Tooltip } from 'antd';
import { useTranslation } from 'react-i18next';
import { agentApi } from '../api/agent';

export interface PendingTakeoverBadgeProps {
  /** 点徽标时回调（页面把 `statusFilter` 设成 `waiting_input`）。 */
  onJump: () => void;
  /**
   * 外部刷新信号：主列表刷新时 +1，让本徽标也跟着刷（否则运营处理完一条、
   * 列表刷新了而徽标还停在旧数——**两个数字互相矛盾**比没有数字更糟）。
   */
  refreshToken?: number;
}

/** 徽标的口径：`pending` = 等人工（`waiting_input`）；`stalled` = 卡住不动（`running` 且久无进展）。 */
export type BadgeKind = "pending" | "stalled";

interface State {
  count: number | null;
  error: unknown;
}

export default function PendingTakeoverBadge({ onJump, refreshToken = 0 }: PendingTakeoverBadgeProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<State>({ count: null, error: null });

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      // `pageSize: 1` ⇒ 只取 total，不要记录体（口径：**全量**待接管数，不受列表筛选影响）。
      // ⚠️ 容错：测试替身常常只 mock 页面用到的那几个方法（R181 方法学 358）。
      //   本徽标是**增强**功能 ⇒ 方法缺失时降级为「读不到」，不让整个页面因一个徽标崩。
      const fn = agentApi.pendingTakeoverCount;
      if (typeof fn !== 'function') throw new Error('pendingTakeoverCount unavailable');
      const total = await fn();
      if (signal?.aborted) return;
      setState({ count: total, error: null });
    } catch (err: unknown) {
      if (signal?.aborted) return;
      // ⚠️ 不清零、不静默：保留「不知道」这个事实（见头注 ①②）。
      setState({ count: null, error: err });
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load, refreshToken]);

  // 读失败：**必须**看得见（否则运营以为「没人等我」）。
  if (state.error) {
    return (
      <Tooltip title={t('agents.pendingTakeover.loadFailHint')}>
        <Button size="small" danger type="text" onClick={() => void load()} data-testid="pending-takeover-load-fail">
          {t('agents.pendingTakeover.loadFail')}
        </Button>
      </Tooltip>
    );
  }

  // 只有「**真的读到且为 0**」才不显示——这是唯一合法的静默情形。
  if (state.count === 0) return null;

  // 还在读（`count === null` 且无错误）：不显示数字，但**也不谎报 0**。
  if (state.count === null) return null;

  return (
    <Badge count={state.count} size="small" offset={[-2, 2]}>
      <Button size="small" type="text" onClick={onJump} data-testid="pending-takeover-jump">
        {t('agents.pendingTakeover.label')}
      </Button>
    </Badge>
  );
}
