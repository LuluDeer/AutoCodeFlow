/**
 * Agent 死循环守卫：按「同一工具 + 同一参数」的连续调用次数升级提醒。
 *
 * 判据只认**连续**调用：中间只要出现一次不同的工具/参数，计数即归零；用户
 * 追加消息同样归零（用户给出了新信息，此前的重复不再构成死循环证据）。
 * `denied` 也算一次——被拒后原样重提正是典型死循环形态，不能因为没产生
 * 副作用就从计数里消失。
 *
 * 规范化必须深度排序：对象键顺序是 JSON 序列化细节，不该让
 * `{"a":1,"b":2}` 与 `{"b":2,"a":1}` 被判成两次不同调用；数组顺序有语义，
 * 保持原样。循环引用/超大参数不会让守卫把主链弄死——退化成稳定占位串。
 */

export interface DoomLoopCall {
  toolName: string;
  args: unknown;
  /** 该次调用是否因边界闸门/审批被拒（被拒仍计入连续次数）。 */
  denied?: boolean;
}

export type DoomLoopLevel = 0 | 3 | 5 | 8;

export interface DoomLoopVerdict {
  /** 当前连续次数（含本次）。 */
  count: number;
  /** 命中的升级档位；0 = 尚未触达任何提醒。 */
  level: DoomLoopLevel;
  /** 需要插入到模型下一条 user/tool 消息的提醒；无升级时为 null。 */
  reminder: string | null;
  /** level=8 时为真：调用方应据此收敛会话，不再继续推理。 */
  converge: boolean;
}

/** 升级阈值（升序，闭集）。 */
export const DOOM_LOOP_THRESHOLDS: readonly DoomLoopLevel[] = [
  3, 5, 8,
] as const;

/** 深度排序规范化：同构对象键顺序无关，数组顺序保留。 */
export function canonicalCallKey(toolName: string, args: unknown): string {
  return `${toolName}:${canonicalValue(args, 0)}`;
}

function canonicalValue(value: unknown, depth: number): string {
  if (depth > 12) return '"<depth>"';
  if (value === null) return "null";
  if (value === undefined) return '"<undefined>"';
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      return Number.isFinite(value) ? String(value) : '"<number>"';
    case "boolean":
      return value ? "true" : "false";
    case "bigint":
      return JSON.stringify(String(value));
    case "function":
      return '"<function>"';
    case "symbol":
      return '"<symbol>"';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalValue(item, depth + 1)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map(
      (key) => `${JSON.stringify(key)}:${canonicalValue(obj[key], depth + 1)}`,
    )
    .join(",")}}`;
}

/** 各档提醒文案（中文；调用方直接插入模型上下文）。 */
function reminderFor(level: DoomLoopLevel, count: number): string {
  switch (level) {
    case 3:
      return `检测到连续 ${count} 次相同工具调用，请先改用只读工具确认现状，或给出结论。`;
    case 5:
      return `已连续 ${count} 次重复同一调用（含被拒调用），不要再以相同参数重试；换一条路径或直接给出结论。`;
    case 8:
      return `连续 ${count} 次重复同一调用，已判定为死循环；请立即停止工具调用并给出结论。`;
    default:
      return "";
  }
}

/**
 * 会话级守卫。生产由 AgentModule 单例提供；纯状态、无 DB/Redis 依赖，
 * 单测可直接 new。
 */
export class AgentDoomLoopGuard {
  private readonly counters = new Map<string, { key: string; count: number }>();

  /** 记一次工具调用；返回本次是否触发升级提醒。 */
  observe(sessionId: string, call: DoomLoopCall): DoomLoopVerdict {
    const key = canonicalCallKey(call.toolName, call.args);
    const previous = this.counters.get(sessionId);
    const count = previous?.key === key ? previous.count + 1 : 1;
    this.counters.set(sessionId, { key, count });
    const level = [...DOOM_LOOP_THRESHOLDS]
      .reverse()
      .find((threshold) => count >= threshold) as DoomLoopLevel | undefined;
    const hit = level ?? 0;
    return {
      count,
      level: hit,
      reminder: hit === 0 || count !== hit ? null : reminderFor(hit, count),
      converge: hit === 8 && count === 8,
    };
  }

  /** 用户消息（含追加消息）重置：新信息使旧计数不再成立。 */
  onUserMessage(sessionId: string): void {
    this.counters.delete(sessionId);
  }

  /** 会话结束/清理时释放状态。 */
  clear(sessionId: string): void {
    this.counters.delete(sessionId);
  }

  /** 只读快照（诊断用；不修改状态）。 */
  peek(sessionId: string): DoomLoopVerdict | null {
    const entry = this.counters.get(sessionId);
    if (!entry) return null;
    const level = [...DOOM_LOOP_THRESHOLDS]
      .reverse()
      .find((threshold) => entry.count >= threshold) as
      DoomLoopLevel | undefined;
    return {
      count: entry.count,
      level: level ?? 0,
      reminder: null,
      converge: false,
    };
  }
}
