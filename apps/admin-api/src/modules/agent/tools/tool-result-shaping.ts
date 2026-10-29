/**
 * 工具结果裁剪（首尾保留）。放在独立文件是为了打破
 * runtime ↔ tool-executor 的 import 环：runtime 的「重放渲染」也要用同一
 * 裁剪口径（第 6 轮审计 P2），而 tool-executor 已 import runtime 的常量。
 */

/**
 * 把超长工具结果裁成模型可读的「首 + 尾」形态（中间省略）。
 *
 * 旧实现是 `slice(0, 2000)`——只留头部。对 `get_execution_logs` 这类载荷，
 * **错误与失败原因几乎总在尾部**，切掉尾部等于把模型最需要的证据丢了（它只
 * 能看到开头的 INFO 行，然后基于不完整事实推理）。langchain 的文本裁剪与
 * 日志查看器惯例都是「保留首尾、省略中段」：头部有上下文（时间/任务/前几
 * 行），尾部有结论（异常栈、退出码）。
 *
 * 省略比例 70% 头 / 余下给尾；标记里带被省略的字符数，模型能判断「还有
 * 多少没看到」，而不是以为结果就这么短。
 */
export function shapeToolResultForModel(
  serialized: string,
  max = 2000,
): { content: string; truncated: boolean } {
  if (serialized.length <= max) {
    return { content: serialized, truncated: false };
  }
  const omitted = serialized.length - max;
  const marker = `\n\n…[中间省略 ${omitted} 字符；已保留首尾以便定位错误与结论]…\n\n`;
  const budget = max - marker.length;
  if (budget < 8) {
    // 上限比标记还短：放不下「首+尾+标记」三段，退化为纯前缀（仍不超上限）。
    // 这是畸形配置/极小 max 的防御分支，正常路径（2000）永不触发。
    return { content: serialized.slice(0, max), truncated: true };
  }
  const headLen = Math.ceil(budget * 0.7);
  const tailLen = budget - headLen;
  return {
    content: serialized.slice(0, headLen) + marker + serialized.slice(-tailLen),
    truncated: true,
  };
}
