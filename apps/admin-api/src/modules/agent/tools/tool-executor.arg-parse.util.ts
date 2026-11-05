/**
 * R67（ADR-031 步骤 4/5 第一刀）：**入参归一/校验**——从 `tool-executor.service.ts`
 * 整段搬出的纯函数（零依赖、不碰 DB / 事件 / 状态机）。
 *
 * 为什么搬：`execute` 当时 676 行（本仓最长函数）。这段是它内部**唯一的纯计算段**
 * （输入只有模型给的 JSON 字符串，输出只有 `args` 或一句可回给模型的错误文案），
 * 与审批事务、台账写入、副作用调用都没有交集 ⇒ 搬出对行为零影响。
 *
 * 语义逐字保持：`repairToolArguments` 的修复顺序（代码围栏 → 散文包裹 → 尾逗号）
 * 与「修不了如实报错、绝不猜缺失值」的纪律**一个字都没改**，只是换了文件。
 */

/**
 * 预览**信封**（`{"truncated":…,"omittedBytes":…,"args":…}`）的结构。
 *
 * 截断发生在 `args` 这段 JSON 文本上，而信封会把它**再转义一次**（`"` → `\"`）：
 * 转义只会变长（[`"`、控制字符]），因此「固定预留 N 字节」的做法在引号密集的
 * 载荷上会被顶破——实测 40 字段的 patch 就溢到 2081 > 2048。所以上限不是靠预留
 * 算出来的，而是**按真实信封长度二分**（见 `buildArgsPreview`）。
 */
export function previewEnvelope(
  argsJson: string,
  truncated: boolean,
  omittedBytes: number,
): string {
  return truncated
    ? JSON.stringify({ truncated: true, omittedBytes, args: argsJson })
    : JSON.stringify({ truncated: false, args: argsJson });
}

/**
 * 工具参数的**保守修复**（参考 langchain `parse_partial_json` 的取舍）。
 *
 * 真实模型经常把 tool_call.arguments 写成下面几种形态：
 *   · 包在 Markdown 代码围栏里（```json … ```）；
 *   · 前后夹一句解释（"好的，参数如下：{…}"）；
 *   · 末尾多一个逗号（`{"a":1,}`）——JS 模型最常见的语法漂移。
 *
 * 这些都是**无歧义**的语法噪音，修掉不会改变语义。反之，缺引号/缺括号/缺值
 * 一律不猜：把 `{"timeout":}` 猜成 0 或 null，会让工具带着错误参数执行，比
 * 直接报错更难排查（与「结果截断不要假装完整」同一条纪律）。
 *
 * 返回 `{ok:true,value}` 或 `{ok:false,reason}`；reason 面向模型/日志，说明
 * 尝试过哪些修复。
 */
export interface RepairedToolArguments {
  ok: boolean;
  value?: unknown;
  reason?: string;
}

export function repairToolArguments(raw: string): RepairedToolArguments {
  const original = typeof raw === "string" ? raw : "{}";
  let text = original.trim();
  if (text === "") return { ok: true, value: {} };

  // ① 剥离 Markdown 代码围栏（可带 json 语言标注，围栏内是 JSON 本体）
  const fence = /^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/m.exec(text);
  if (fence) text = fence[1].trim();

  const attempts: Array<{ label: string; value: string }> = [
    { label: "原始 JSON", value: text },
  ];

  // ② 散文包裹：截取第一个 `{` 到最后一个 `}`（或 `[`…`]`）
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  const firstBracket = text.indexOf("[");
  const lastBracket = text.lastIndexOf("]");
  const objectSpan =
    firstBrace >= 0 && lastBrace > firstBrace
      ? text.slice(firstBrace, lastBrace + 1)
      : null;
  const arraySpan =
    firstBracket >= 0 && lastBracket > firstBracket
      ? text.slice(firstBracket, lastBracket + 1)
      : null;
  if (objectSpan && objectSpan !== text) {
    attempts.push({ label: "去除前后散文", value: objectSpan });
  } else if (!objectSpan && arraySpan && arraySpan !== text) {
    attempts.push({ label: "去除前后散文", value: arraySpan });
  }

  // ③ 尾逗号：`,}` / `,]`（只删紧跟闭合符前的逗号，字符串内的逗号不受影响
  //    ——这里用简单正则；如果逗号在字符串里，删除后 JSON 仍能解析则说明它
  //    本来就不是分隔符，语义不变）。
  for (const base of [text, objectSpan, arraySpan]) {
    if (!base) continue;
    const noTrailingComma = base.replace(/,\s*([}\]])/g, "$1");
    if (noTrailingComma !== base) {
      attempts.push({ label: "去除尾逗号", value: noTrailingComma });
    }
  }

  const seen = new Set<string>();
  for (const attempt of attempts) {
    if (seen.has(attempt.value)) continue;
    seen.add(attempt.value);
    try {
      return { ok: true, value: JSON.parse(attempt.value) };
    } catch {
      /* 继续下一种 */
    }
  }
  return {
    ok: false,
    reason: `已尝试 ${[...seen].length} 种保守修复（去围栏/去散文/去尾逗号）仍无法解析`,
  };
}

/**
 * 工具调用参数的归一结果。
 *
 * `ok:false` 携带的 `message` **就是回给模型/落库的原文**（含修复尝试摘要与
 * 前 200 字符的原始载荷）——把它留在这里而不是让调用方拼，是为了「错误文案
 * 只有一份实现」（同 R41 的脱敏出口纪律）。
 */
export interface ParsedToolArguments {
  /** 解析（含保守修复）是否成功。 */
  ok: boolean;
  /** 成功时的归一参数；失败时为 null。 */
  args: Record<string, unknown> | null;
  /** 失败时**就是回给模型/落库的原文**；成功时为 null。 */
  message: string | null;
}

/**
 * 解析模型给的 `tool_call.arguments`（JSON 字符串）→ 归一后的对象或错误文案。
 *
 * 纯函数：不读库、不写台账、不抛异常。调用方拿到 `ok:false` 时只需
 * `persist({status:"error", errorMessage: message})` + 把 message 回给模型。
 */
export function parseToolArguments(rawArguments: string): ParsedToolArguments {
  const repaired = repairToolArguments(rawArguments);
  if (!repaired.ok) {
    return {
      ok: false,
      args: null,
      message: `工具参数不是合法 JSON（${repaired.reason}）：${rawArguments.slice(0, 200)}`,
    };
  }
  const parsed = repaired.value;
  return {
    ok: true,
    args:
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : null,
    message: null,
  };
}
