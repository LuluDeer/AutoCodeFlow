/**
 * P3-2：IPC reject 错误消息的用户可读化（纯函数，无 React / Electron 依赖）。
 *
 * Electron 的 ipcRenderer.invoke 在主进程 handler throw 时，reject 出来的
 * Error.message 是 `Error invoking remote method 'executor:start': Error: 端口 8002 已被占用…`
 * ——主进程的错误文案本身已是人话（端口占用、注册预检、连接错误码等），
 * 但整个渲染层的错误条此前直接把这段原文塞进 `err.message` 展示位，
 * 用户看到的是内部包装前缀 + 通道名 + 双层 Error: 噪声。
 *
 * 这里做**展示层统一剥除**（不动 preload 契约、不动主进程）：
 *   · `Error invoking remote method 'channel': ` —— Electron 前缀，剥；
 *   · 其后可能还叠一层 `Error: ` / `TypeError: ` 等 V8 序列化前缀，剥一次；
 *   · 两段都不在时原样返回（本地 throw / 非 IPC 异常不误伤）。
 *
 * 所有渲染层 catch 分支的 `err instanceof Error ? err.message : String(err)`
 * 统一改走 ipcErrorMessage()（见各页面 catch 点）。
 */

/** Electron invoke 失败的固定包装前缀（channel 名被单引号包裹）。 */
const INVOKE_PREFIX_RE = /^Error invoking remote method '[^']*':\s*/;

/**
 * V8 错误序列化后叠在消息前的类型名前缀，剥一次（避免误伤正文冒号）：
 *   · `TypeError: xxx` / `RangeError: xxx` —— 类型名以 Error/Exception 结尾；
 *   · 裸 `Error: xxx` —— Electron invoke 包装剥除后残留的第二层（主进程
 *     throw new Error(msg) 序列化形态），单独放行。
 */
const ERROR_NAME_RE = /^(?:[A-Z][A-Za-z0-9]*(?:Error|Exception)|Error):\s*/;

/** 从未知异常形态提取「用户可读」消息：IPC 包装前缀与 V8 错误名前缀剥除。 */
export function ipcErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(INVOKE_PREFIX_RE, '').replace(ERROR_NAME_RE, '');
}
