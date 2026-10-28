import type { ToolCall } from "./ai.service";

/**
 * 上游响应归一（2026-10-28）：`chatMultimodal` 的**不可信响应**收口。
 *
 * ## 为什么必须在网关收口，而不是信任 provider
 * OpenAI 兼容端点各有偏差，实测/已知的三种畸形形状都会把 Agent 带进死路：
 *
 *   ① **tool_calls[].id 缺失或重复**。id 是 tool 消息的关联键（`role=tool` 的
 *      `tool_call_id` 必须回指它），也是审批键的一部分：
 *      · 缺 id → 下一轮回传 `tool_call_id: undefined`，上游直接 400；
 *      · 重复 id → 两次调用共用一个键，结果重放与审批单都会错位
 *        （与 `agent_tool_calls.toolCallId` 那笔修复同源：关联键必须唯一）。
 *   ② **function.arguments 是对象而不是 JSON 字符串**。Agent 侧按字符串
 *      解析（`JSON.parse(call.function.arguments)`），对象会直接抛 `[object Object]`。
 *   ③ **content 是 parts 数组**。部分 provider 即使纯文本也返回
 *      `[{type:"text",...}]`，原样写进 `agent_steps.content`（text 列）会变成
 *      "[object Object]"，模型下一轮看到的就是这串垃圾。
 *
 * ## 设计取舍
 * 归一**不猜测语义**：拿不到函数名就丢弃该条（模型调用一个不存在的工具比
 * "我们替它编一个"安全），ID 缺失才生成（形如 `call_1_ab12cd`，确定性、可
 * 复盘）；arguments 非字符串时才序列化，字符串原样保留（避免二次转义）。
 * 全部纯函数、无 IO，单测可逐条钉住。
 */

/** 单次响应里接受的工具调用上限（超出丢弃——防异常批量拖垮一轮循环）。 */
export const MAX_TOOL_CALLS_PER_RESPONSE = 32;

/** 生成确定性短哈希（FNV-1a → base36）。不引 crypto：只求稳定，不求抗碰撞。 */
function shortHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/**
 * content 归一为字符串。
 *
 * - string → 原样（只做 null 兜底）；
 * - parts 数组 → 拼接 text 片段（图片/视频片段**不进文本**，它们在多模态
 *   请求里已有自己的位置；这里只负责"模型说了什么"）；
 * - 其它（对象/数字/null）→ 空串（宁可让循环按"模型没给结论"处理，
 *   也不要把 JSON 垃圾写进会话历史）。
 */
export function normalizeAssistantContent(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (!Array.isArray(raw)) return "";
  const parts: string[] = [];
  for (const part of raw) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (!part || typeof part !== "object") continue;
    const rec = part as Record<string, unknown>;
    if (rec.type === "text" && typeof rec.text === "string")
      parts.push(rec.text);
  }
  return parts.join("");
}

/**
 * tool_calls 归一。
 *
 * 返回 `undefined`（而不是空数组）表示"这次没有可用调用"——调用方据此走
 * 终态判定（模型给出结论），空数组与 undefined 在该判定里等价，但保留
 * undefined 与既有 `res.toolCalls ?? null` 语义一致。
 */
export function normalizeToolCalls(raw: unknown): ToolCall[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;

  const out: ToolCall[] = [];
  const usedIds = new Set<string>();

  for (const entry of raw) {
    if (out.length >= MAX_TOOL_CALLS_PER_RESPONSE) break;
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    const fn = rec.function;
    if (!fn || typeof fn !== "object") continue;
    const fnRec = fn as Record<string, unknown>;

    const name = typeof fnRec.name === "string" ? fnRec.name.trim() : "";
    // 无名字 = 无法执行（也进不了边界白名单），整条丢弃
    if (!name) continue;

    const rawArgs = fnRec.arguments;
    const args =
      typeof rawArgs === "string"
        ? rawArgs
        : rawArgs === null || rawArgs === undefined
          ? "{}"
          : JSON.stringify(rawArgs);

    const rawId = typeof rec.id === "string" ? rec.id.trim() : "";
    let id =
      rawId.length > 0
        ? rawId
        : `call_${out.length + 1}_${shortHash(name + args)}`;
    // 重复 id：加后缀而不是丢弃整条——两次调用都是模型真实意图，
    // 丢一次会让它对"为什么我只拿到一个结果"产生错误推理。
    if (usedIds.has(id)) {
      let n = 2;
      while (usedIds.has(`${id}_${n}`)) n += 1;
      id = `${id}_${n}`;
    }
    usedIds.add(id);

    out.push({ id, type: "function", function: { name, arguments: args } });
  }

  return out.length > 0 ? out : undefined;
}

/**
 * `finish_reason === "length"` 判定。
 *
 * 为什么值得单独判：输出被 max_tokens 截断时，模型给不出结论（JSON 断了、
 * 或话说一半）。这不叫"模型不配合"，而是**我们的预算不够**——不记录就会在
 * 排查时归因到错误方向（"模型笨"），而真正的处置是调大 maxTokens 或缩短输入。
 */
export function isTruncatedFinish(raw: unknown): boolean {
  return typeof raw === "string" && raw.toLowerCase() === "length";
}
