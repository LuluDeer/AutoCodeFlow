/**
 * R199 · 「需要注意」徽标组（**待接管 N** + **卡住 N** + 只看卡住的可清除标签）。
 *
 * ## 为什么是一个组件而不是页面上散着两处
 *
 * ① **桌面页头与移动端筛选栏都要挂**（两处完全相同的组合）⇒ 抽出来**只写一遍**；
 * ② `AgentSessionsPage` 在 `check:size-caps` 的**逐文件只减不增**基线上**双顶格**
 *    （`nonCommentLines` 1042/1042、`functionLines` 1029/1029）⇒ 新增这一组节点
 *    若留在页面上**必然破顶** ⇒ 外提（R380 的做法）。
 *
 * ## 两个口径的分工（**互不重叠**）
 *
 * · **待接管 N**（`waiting_input`）：会话**正常地**在等人，人来了就能继续；
 * · **卡住 N**（`running` 且久无进展）：**没有人能推进它**，等再久也没用 ⇒ 需要**介入/终止**。
 *
 * 判据（卡住）见 `docs/observability/agent-stalled-criterion.md`。
 */
import { Space, Tag } from "antd";
import { useTranslation } from "react-i18next";
import PendingTakeoverBadge from "./PendingTakeoverBadge";
import StalledBadge from "./StalledBadge";

export interface AgentAttentionBadgesProps {
  /** 主列表刷新信号（+1 ⇒ 两个徽标都跟着刷）。 */
  refreshToken: number;
  /** 当前是否处于「只看卡住」筛选。 */
  stalledOnly: boolean;
  /** 点「待接管」⇒ 只看等人工的会话。 */
  onShowPending: () => void;
  /** 点「卡住」⇒ 只看卡住的会话。 */
  onShowStalled: () => void;
  /** 关掉「只看卡住」标签 ⇒ 回到全部。 */
  onClearStalled: () => void;
}

export default function AgentAttentionBadges({
  refreshToken,
  stalledOnly,
  onShowPending,
  onShowStalled,
  onClearStalled,
}: AgentAttentionBadgesProps) {
  const { t } = useTranslation();
  return (
    <Space size={4}>
      <PendingTakeoverBadge refreshToken={refreshToken} onJump={onShowPending} />
      <StalledBadge refreshToken={refreshToken} onJump={onShowStalled} />
      {/* 「只看卡住」必须有清除入口 —— 否则点了徽标就「回不去了」。 */}
      {stalledOnly ? (
        <Tag closable color="orange" onClose={onClearStalled}>
          {t("agents.stalled.onlyStalled")}
        </Tag>
      ) : null}
    </Space>
  );
}
