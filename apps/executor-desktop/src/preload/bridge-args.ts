/**
 * R102-A1：preload 桥的**参数归一**（fail-closed）。
 *
 * ## 为什么需要这一层
 *
 * R86-A1 给主进程加了 IPC sender 白名单闸——只接受本应用**主 frame**。于是
 * 渲染层自身的代码执行（XSS / 注入的 HTML / 恶意链接）恰好落在闸的允许集合
 * 里：闸校验的是"谁在调"，不是"调的时候带了什么"。桥是渲染层与主进程之间
 * 唯一的数据闸门，它的形参签名只是**类型声明**，运行时可以是任何东西
 * （对象、Symbol、带 getter 的 Proxy、几 MB 的字符串）。
 *
 * 主进程侧当然有自己的校验（path-domain 的路径域、EXECUTION_ID_PATTERN、
 * port-check 的端口边界），本层是**第二道**，目标是让那些校验器拿到的永远
 * 是字符串/数字/布尔，而不是"任意形状"：
 *   · 非字符串 → 空串（主进程的路径域/ID 正则一律拒绝空串，失败方向安全）；
 *   · 超长字符串 → 空串（**不截断**：截断会把一个非法路径"修"成另一个**合法**
 *     路径，比拒绝危险得多）；
 *   · 行号 → 非负整数，其余归 0（主进程 fromLine 的默认值）；
 *   · 布尔 → 只认严格 true（"false" / "0" 这类真值串不得把开关打开）。
 *
 * 本模块**刻意不 import electron**：它是纯函数，可以直接被
 * renderer.selftest.mjs 用裸 node 驱动断言（同 renderer/number-input.ts 先例），
 * 行为闸不依赖 Electron 二进制。
 */

/** 路径 / ID / URL 这类"标识型"字符串的长度上限：任何合法值都远小于它。 */
export const MAX_STRING_ARG = 4096;

/** 剪贴板正文是**内容**而非标识，允许更长（复制一整行超长日志不能变空）。 */
export const MAX_CLIPBOARD_ARG = 1024 * 1024;

/**
 * 归一化成字符串：非字符串一律返回空串，超长也返回空串（见文件头"不截断"）。
 */
export function asString(value: unknown, maxLength: number = MAX_STRING_ARG): string {
  if (typeof value !== 'string') return '';
  if (value.length > maxLength) return '';
  return value;
}

/**
 * 归一化日志行号：主进程 fromLine 的语义是"从第几行开始读"，缺省 0。
 * 只接受非负有限数；小数向下取整；其余（字符串 / NaN / Infinity / 负数）归 0。
 */
export function asLineNumber(value: unknown): number {
  if (typeof value !== 'number') return 0;
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  return Math.floor(value);
}

/**
 * 归一化布尔开关：只认严格 true。
 *
 * 渲染层正常只会传布尔，但"任意形状"下 'false' / '0' / {} 都是真值——
 * 它们一旦被主进程当 boolean 用，就会把**关闭**解释成**打开**（自启、
 * 通知这类开关的失效方向必须永远是"不打开"）。
 */
export function asBool(value: unknown): boolean {
  return value === true;
}
