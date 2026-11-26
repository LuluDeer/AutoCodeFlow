/**
 * N17「审批短语（scoped + TTL）」——一句话审批的**唯一解析口径**（纯函数）。
 *
 * 借鉴 Octop 的「一句话审批」UX：管理员在会话里回一句 `allow` 即完成批准。
 * 本仓把授权语义收窄成 **once + TTL + 策略指纹重算**：解析结果里只有
 * `scope: "once"`，**没有 `all` 这个值**——永久授权在本机制里根本无法表达。
 *
 * ## 为什么是「整句精确匹配」而不是「包含关键词」
 *
 * 审批是把一次副作用放行的决定，误判方向极不对称：
 *   · 「可以，不过先别动 prod」包含「可以」⇒ 若按关键词放行，等于把一句
 *     带否定条件的话当成批准；
 *   · 「这件事不允许 allow」包含 `allow` ⇒ 同理会放行一次被明确否定的操作。
 * 因此只认**整句**（trim + ASCII 小写归一化后）恰好等于白名单里的某个短语。
 * `可以` / `好的` / `行` / `ok` / `yes` 这类模糊词**刻意不收**——它们没有
 * 「批准这一次副作用」的精确语义，而且正是自然语言里最容易带条件/反讽的词。
 *
 * 英文短语大小写不敏感（`Allow` / `ALLOW` 都认），中文无大小写概念；首尾空白
 * 被 trim（聊天输入框的换行/空格不构成新语义）。除这两种归一化外不做任何
 * 模糊化：不做子串、不做别名扩展、不做拼音/同义词映射。
 */
export type ApprovalPhraseKind = "allow" | "deny" | "reset";

export interface ParsedApprovalPhrase {
  kind: ApprovalPhraseKind;
  /** 恒为 "once"——类型层面就不存在 "all" 永久授权。 */
  scope: "once";
}

/** 白名单：**恰好**这些整句被识别；多一个词都不行（含 `allow all`）。 */
const PHRASE_TABLE: ReadonlyMap<string, ApprovalPhraseKind> = new Map([
  ["allow", "allow"],
  ["allow once", "allow"],
  ["允许", "allow"],
  ["批准", "allow"],
  ["deny", "deny"],
  ["拒绝", "deny"],
  ["reset", "reset"],
]);

/**
 * 解析一句审批短语。返回 null = 不是审批短语（调用方按「普通聊天」处理）。
 *
 * `reset` 之所以在白名单里而不被丢掉：它是 Octop UX 里「撤销刚才那次授权」
 * 的自然说法。但在 once + TTL 模型下它没有对应的 `decide(granted|denied)`
 * 动作，服务层 `decideByPhrase` 会把它显式拒绝并给出可归因的错误——让
 * 「识别到但不支持」与「根本没识别」在日志/错误码上可区分。
 */
export function parseApprovalPhrase(text: string): ParsedApprovalPhrase | null {
  if (typeof text !== "string") return null;
  const normalized = text.trim().toLowerCase();
  const kind = PHRASE_TABLE.get(normalized);
  if (!kind) return null;
  return { kind, scope: "once" };
}
