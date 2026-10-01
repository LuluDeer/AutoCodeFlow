/**
 * FIX-1.1 依赖链契约翻转的纯函数核心（从迁移 1790000000048 抽出）。
 *
 * 抽出的原因：TypeORM 加载迁移文件时会把**文件内所有导出**都当作迁移候选，
 * 并校验其 name 以 13 位时间戳结尾——迁移文件里导出纯函数会让 CI 的空库迁移
 * 链直接炸（TypeORMError: Object migration name is wrong）。放 common/utils
 * 后既保持「迁移与单测共用同一份翻转语义」，又不进迁移 glob。
 */

/** 任务主键为 uuid v4 形态（小写/大写均可）；宽松匹配 8-4-4-4-12 hex。 */
export const TASK_UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * 纯函数翻转单行 dependencies 映射（供迁移与单测共用——迁移内不做内联
 * SQL/DO 块，让翻转语义可被无 PG 的单测环境逐条验证）。
 *
 * 逐条目判定（不是整行判定——同一行内可能混有已翻转/未翻转条目）：
 *  - up：key 是 UUID 且 value 不是 → 旧契约条目，翻转为 `{value: key}`；
 *  - down：对称回翻（key 非 UUID 且 value 是 UUID 的条目 → `{value: key}`）；
 *  - 其余（已是目标契约的条目、key 与 value 同为 id 的降级条目、双向都不是
 *    id 的脏数据）→ 原样保留，重放天然幂等。
 *
 * key 冲突降级（与前端 buildDependenciesPayload 同语义）：两个上游任务同名、
 * 或翻转目标 key 已被既有条目占用时，展示别名让位语义位——后者降级 key=uuid，
 * 保证 value（扇出/环检测的判据）永不丢失。先处理到的条目保留显示名 key。
 *
 * @param deps 行内映射原值（假定来自 jsonb object；非对象由调用方过滤）
 * @param direction up=旧契约翻新（{uuid:name}→{name:uuid}）；
 *                 down=对称回翻（{name:uuid}→{uuid:name}）
 */
export function flipDependencyMap(
  deps: Record<string, string>,
  direction: "up" | "down" = "up",
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(deps ?? {})) {
    const needsFlip =
      direction === "up"
        ? TASK_UUID_RE.test(key) && !TASK_UUID_RE.test(value)
        : !TASK_UUID_RE.test(key) && TASK_UUID_RE.test(value);
    if (!needsFlip) {
      out[key] = value;
      continue;
    }
    // 翻转：key/value 互换。冲突降级——目标 key 已被先处理条目占用时，
    // 展示别名让位，key 保留原 uuid（value 语义位不丢）。
    const newKey = out[value] !== undefined ? key : value;
    out[newKey] = key;
  }
  return out;
}
