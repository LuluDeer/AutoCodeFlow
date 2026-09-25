/**
 * TOAST-01：全局 message 出口（antd App 实例桥）。
 *
 * 背景：全站约 90 处直接 `import { message } from 'antd'` 调**静态方法**——
 * 静态 message 渲染在 React 树之外，不消费 ConfigProvider 主题/locale，
 * 暗色主题下 toast 仍是亮面样式。antd 官方口径是用 `<App>` 上下文的
 * App.useApp() 实例。
 *
 * 方案：ThemedProviders 挂载一个 MessageApiBridge，把 App.useApp().message
 * 注册到本模块；全站从本文件导入同名 `message` 调用（调用点零改动）。
 * 桥未挂载时（测试直渲组件 / 非 React 场景）回退 antd 静态 message——
 * 既有测试的 vi.mock('antd') 覆盖与 vi.spyOn(message) 侦察全部继续生效。
 */
import { message as antdMessage } from 'antd';
import type { MessageInstance } from 'antd/es/message/interface';

let appApi: MessageInstance | null = null;

/** 由 ThemedProviders 内的 MessageApiBridge 在挂载时注册（主题化实例） */
export function registerMessageApi(api: MessageInstance): void {
  appApi = api;
}

function api(): MessageInstance {
  return appApi ?? antdMessage;
}

/** 与 antd message 同签名的出口——调用方 `message.success(...)` 无需改动。
 *  注意用 ...args 原样透传（不做形参展开），保证 `error(msg, 4)` 这类调用
 *  传给实例的参数个数与之前逐位一致——测试对调用参数有精确断言。 */
export const message: MessageInstance = {
  success: (...args) => api().success(...args),
  error: (...args) => api().error(...args),
  info: (...args) => api().info(...args),
  warning: (...args) => api().warning(...args),
  loading: (...args) => api().loading(...args),
  open: (...args) => api().open(...args),
  destroy: (...args) => api().destroy(...args),
};
