/**
 * R195（P3-2）· 命令面板「组内只显示前 N 条」的**截断告知**。
 *
 * ## 为什么要有它（缺陷的**真实边界**）
 *
 * `CommandPalette` 每组只列 `MAX_PER_GROUP`（5）条，且**没有任何「还有更多」的提示**
 * ⇒ 用户在 ⌘K 里看到「任务」组只有 5 条就结束 ⇒ 可能的误解是
 * 「**这个任务不存在 / 没建过**」（⇒ 可能重复创建同名任务）或
 * 「**搜不到 = 系统里没有**」（⇒ 放弃在 ⌘K 里找，转去列表页翻页）。
 *
 * ⚠️ **R188 复核把危害收窄了**（值得记，避免以后又按旧描述排期）：
 * 候选池的 50 条截断那一层**已被服务端 `q` 预过滤削弱**（`name OR description` ILIKE）
 * ⇒ 池截断只在「**真的存在 50+ 条命中**」时才发生，此时「只列 5 条」**本来就是设计意图**（Top 5）。
 * ⇒ **真正的缺陷只剩这一条**：**组内截断到 5 且无任何告知**。
 *
 * ## 为什么做成独立组件（不是就地写一行）
 *
 * `CommandPalette.tsx` 在 `check:size-caps` 的**逐文件只减不增**棘轮上**双顶格**
 * （`nonCommentLines` 709/709、`functionLines` 614/614）⇒ **就地加任何一行都会红**
 * ⇒ 照 R188/R190 的先例外提成独立文件，让大文件**净减**。
 */
import { Typography } from "antd";
import { useTranslation } from "react-i18next";

const { Text } = Typography;

export interface PaletteGroupTruncationHintProps {
  /** 本组**实际命中**的条数（截断前的真实数量）。 */
  total: number;
  /** 本组**已显示**的条数。 */
  shown: number;
}

/**
 * 组内截断提示：仅在「**确实截断了**」（`total > shown`）时渲染。
 *
 * 文案要回答两件事：**还剩多少** + **怎么办**（继续输入缩小范围）——
 * 只说「已截断」而不说「怎么找全」，用户仍会以为「就这么多了」。
 */
export default function PaletteGroupTruncationHint({
  total,
  shown,
}: PaletteGroupTruncationHintProps) {
  const { t } = useTranslation();
  if (total <= shown) return null;
  return (
    <Text type="secondary" style={{ display: "block", padding: "4px 8px", fontSize: 12 }}>
      {t("palette.groupTruncated", { shown, total })}
    </Text>
  );
}
