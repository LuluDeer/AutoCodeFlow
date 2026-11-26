/**
 * N27 — ToolSearch 按需检索（本地纯函数形态）。
 *
 * ## 定位
 *
 * 这是**纯函数**，不注册任何 MCP 工具、不 import 任何包（零依赖）、不碰 IO。
 * 56 工具面由 `tools.ts` 的 `register*Tools` 注册，本文件**一个工具都不加**——
 * 若把 `tool_search` 注册成第 57 个工具，`test:mcp-tool-surface`（EXPECTED_TOOLS = 56）
 * 立刻红。调用方（未来 CLI / agent）按需拿一份工具清单后自己调 `searchTools`。
 *
 * ## 契约
 *
 * - 关键词命中：对工具 `name` + `description` 做大小写不敏感的分词匹配；
 *   查询词按非字母数字切分，工具文本同样切分（兼容 `list_tasks` / camelCase），
 *   查询 token 与工具 token 取交集（含包含关系，覆盖 `task` ↔ `tasks`、
 *   `deploy` ↔ `redeployment` 这类单复数/复合词），交集非空即命中；
 *   score = 命中 token 数。
 * - tags 过滤：工具需带有所请求 tag 中的至少一个（大小写不敏感，OR）。
 * - limit：缺省 10，硬上限 50；非数/NaN/Infinity 回落到缺省，<= 0 返回空。
 * - 排序：score 降序 → 名称**字典序**（码点比较，不用 localeCompare 以免受 locale 影响）。
 * - 纯函数：不改入参、不共享可变状态；返回值恒为新数组。
 */

/** 最小工具形状：与 MCP `tools/list` 的 `{ name, description?, ... }` 结构兼容。 */
export interface ToolDefinition {
  name: string;
  description?: string;
  tags?: string[];
}

/** 检索条件；三项全可选，空 query ⇒ 返回按名称排序的默认前 N 个工具。 */
export interface ToolSearchQuery {
  keyword?: string;
  tags?: string[];
  limit?: number;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

/** 分词：camelCase 拆边界 + 非字母数字分隔符，统一小写并做轻量单复数归一。 */
function tokenize(input: string | undefined | null): string[] {
  if (typeof input !== "string" || input.length === 0) return [];
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .map((piece) => piece.toLowerCase())
    .filter((piece) => piece.length > 0)
    .map((piece) =>
      piece.length > 3 && piece.endsWith("s") && !piece.endsWith("ss")
        ? piece.slice(0, -1)
        : piece,
    );
}

/** tag 归一：trim + 小写 + 去重，非字符串条目直接丢弃。 */
function normalizeTags(tags: readonly string[] | undefined): string[] {
  if (!Array.isArray(tags)) return [];
  const out: string[] = [];
  for (const raw of tags) {
    if (typeof raw !== "string") continue;
    const tag = raw.trim().toLowerCase();
    if (tag.length > 0 && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/** limit 归一：缺省 10、上限 50、非法回落缺省、<= 0 返回 0。 */
function resolveLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  if (limit <= 0) return 0;
  return Math.min(MAX_LIMIT, Math.floor(limit));
}

/**
 * 对工具清单做确定性检索。泛型形式让调用方保留自己的工具类型（含 inputSchema
 * 等额外字段），返回值仍是 `ToolDefinition[]` 的子类型。
 */
export function searchTools<T extends ToolDefinition>(
  query: ToolSearchQuery,
  tools: readonly T[],
): T[] {
  const condition: ToolSearchQuery = query ?? {};
  const list: readonly T[] = Array.isArray(tools) ? tools : [];
  const queryTokens = tokenize(condition.keyword);
  const queryTags = normalizeTags(condition.tags);
  const limit = resolveLimit(condition.limit);

  const scored: Array<{ tool: T; score: number }> = [];

  for (const tool of list) {
    if (!tool || typeof tool.name !== "string") continue;

    if (queryTags.length > 0) {
      const toolTags = normalizeTags(tool.tags);
      if (!queryTags.some((tag) => toolTags.includes(tag))) continue;
    }

    let score = 0;
    if (queryTokens.length > 0) {
      const haystack = [...tokenize(tool.name), ...tokenize(tool.description)];
      for (const token of queryTokens) {
        // constant-time-exempt: 此 token 是用户查询分词，非凭据/密钥；纯文本检索无需恒定时间比较
        if (haystack.some((candidate) => candidate === token || candidate.includes(token))) {
          score += 1;
        }
      }
      if (score === 0) continue;
    }

    scored.push({ tool, score });
  }

  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    const left = a.tool.name;
    const right = b.tool.name;
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  });

  return scored.slice(0, limit).map((entry) => entry.tool);
}
