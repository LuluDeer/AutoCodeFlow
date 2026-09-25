/**
 * MODAL-01：全局 Modal 命令式出口（antd App 实例桥），与 TOAST-01 同源动机。
 *
 * 背景（与 toast.ts 完全同类）：全站 11 处命令式 `Modal.confirm/error(...)` 调的是
 * antd **静态方法**。静态方法渲染在 React 树之外，不消费 ConfigProvider 的
 * theme/locale——暗色主题下确认框仍是亮面样式，英文界面下按钮文案也回落
 * 中文。antd 官方口径是用 `<App>` 上下文的 `App.useApp().modal` 实例
 * （antd 自己的告警也写明静态方法 "do not have context env"）。
 *
 * 方案：ThemedProviders 挂载一个 ModalApiBridge，把 App.useApp().modal
 * 注册到本模块；全站从本文件导入同名 `Modal` 调用（调用点仅需改 import）。
 * 桥未挂载时（测试直渲组件 / 非 React 场景）回退 antd 静态 Modal——
 * 既有测试的 `vi.spyOn(Modal, 'confirm')` 侦察继续生效。
 *
 * 用法（调用点零改动，只换 import 来源）：
 *   - import { Modal } from 'antd';                 // 旧
 *   + import { Modal } from '../utils/modal';       // 新
 *   之后 `Modal.confirm({...})` 写法不变。
 *
 * 注意：`<Modal>` **组件**形式（JSX）不受影响，仍应从 'antd' 导入——
 * 组件在 React 树内，本就消费主题。本模块只接管命令式静态方法。
 */
import { Modal as antdModal } from 'antd';
import type { HookAPI as ModalHookAPI } from 'antd/es/modal/useModal';
import type { ModalFuncProps } from 'antd/es/modal/interface';

let appApi: ModalHookAPI | null = null;

/** 由 ThemedProviders 内的 ModalApiBridge 在挂载时注册（主题化实例） */
export function registerModalApi(api: ModalHookAPI): void {
  appApi = api;
}

/**
 * 与 antd 静态 Modal 同形的出口。
 *
 * `confirm` / `info` / `success` / `error` / `warning` 五个命令式方法全部
 * 透传到主题化实例；未挂载桥时回退静态实现。
 *
 * `useModal` 不在本出口——它是 Hook，必须由组件直接调用。
 * `destroyAll` 静态方法在 HookAPI 上不存在（属 Modal 静态专有），故
 * 回退到 antd 静态实现（清空 body 级 holder，行为与迁移前一致）。
 */
export const Modal = {
  confirm: (props: ModalFuncProps) => appApiOr().confirm(props),
  info: (props: ModalFuncProps) => appApiOr().info(props),
  success: (props: ModalFuncProps) => appApiOr().success(props),
  error: (props: ModalFuncProps) => appApiOr().error(props),
  warning: (props: ModalFuncProps) => appApiOr().warning(props),
  /** HookAPI 无 destroyAll；静态专有。保持静态调用（清理 body 级 holder）。 */
  destroyAll: () => antdModal.destroyAll(),
};

function appApiOr(): ModalHookAPI {
  return appApi ?? (antdModal as unknown as ModalHookAPI);
}
