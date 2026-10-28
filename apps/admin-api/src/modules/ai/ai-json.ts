/**
 * 模型输出 → JSON 对象的**宽容提取**（纯函数）。
 *
 * 为什么要容错：prompt 里写「只返回 JSON」，模型仍可能包 ```` ```json ```` 栅栏、
 * 或前后加一句「好的，SOP 如下：」。直接 `JSON.parse` 会把这类**内容正确、
 * 包装多余**的输出判成失败，用户侧表现为"生成失败、请重试"——而重试通常
 * 还是同样的包装。
 *
 * 与执行器侧 `extractJsonObject`（apps/executor-desktop/.../runtime.ts）同一套
 * 语义：先试围栏内容，再试首个 `{` 到末个 `}`；两者都失败才返回 null。
 * 不猜语义、不修补残缺 JSON（半截 JSON 就是失败，见 agent-context 头注）。
 */
const MAX_INPUT_CHARS = 512 * 1024;

export function extractJsonObject(
  text: unknown,
): Record<string, unknown> | null {
  if (typeof text !== "string" || text.length === 0) return null;
  if (text.length > MAX_INPUT_CHARS) return null;

  const candidates: string[] = [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced) candidates.push(fenced[1]);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim()) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* 试下一个候选 */
    }
  }
  return null;
}

/** slug 归一：小写、非字母数字折叠为 `-`、去首尾、限长 128。 */
export function normalizeSopSlug(raw: unknown): string {
  const text = typeof raw === "string" ? raw : "";
  const slug = text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 128);
  return slug;
}
