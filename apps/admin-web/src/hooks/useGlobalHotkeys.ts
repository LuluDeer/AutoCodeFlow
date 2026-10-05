/**
 * HOTKEY-01：全站键盘快捷键（g 前缀序列跳转 + ? 速查唤起），MainLayout 全局挂载一次。
 *
 * ── 快捷键面 ────────────────────────────────────────────────────────────────
 *   ?（Shift+/）       切换快捷键速查 Modal（onToggleHelp，Esc 关闭由 Modal 承担）
 *   g d / g t / g e    跳转 仪表盘 / 任务列表 / 执行器
 *   g x / g a          跳转 执行记录 / 应用
 *   ⌘K / Ctrl K        命令面板——仍由 CommandPalette 自挂监听，本 hook 不重复处理
 *
 * ── 触发护栏（按序短路，先到先得） ──────────────────────────────────────────
 *   1. e.repeat：按住不放的连发不触发；
 *   2. Ctrl/⌘/Alt 组合键：是浏览器与应用既有快捷键的语义空间，让路；
 *   3. 输入态（input/textarea/select/contentEditable）：正在打字时 g、? 都是
 *      字面字符；⌘K 面板打开时焦点恒在其搜索框内，天然被本条覆盖；
 *   4. antd 弹层内（Modal/Drawer/Popover/Dropdown）：弹层有自己的键盘语义
 *      （Esc 关闭、菜单导航），不在其上叠加全局跳转；
 *   5. isOverlayOpen()：⌘K 命令面板 / 速查 Modal 任一打开中，g 序列与 ? 一律忽略。
 *
 * ── g 序列状态机 ────────────────────────────────────────────────────────────
 *   按 g → 进入待定态并启动 G_SEQUENCE_TIMEOUT_MS 计时；窗口内第二个键命中
 *   GOTO_HOTKEYS 即跳转并消费序列；不命中/超时/再按 g（重新起手并刷新计时）
 *   均复位。序列期间任何不相关按键都会消费待定态，避免"按过 g 之后忘了"
 *   在数秒后突然跳页的惊吓跳转。
 */
import { useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

/** g 序列第二键的宽限窗口（毫秒）——超时未按第二键则序列重置 */
export const G_SEQUENCE_TIMEOUT_MS = 1000;

/** g 前缀跳转目标（路由以 router.tsx 实际路径为准；id 同时是速查 Modal 的 i18n 键段） */
export interface GoToHotkey {
  id: 'dashboard' | 'tasks' | 'executors' | 'executions' | 'applications';
  /** g 之后的第二个键（小写） */
  secondKey: string;
  path: string;
}

/** 跳转清单（唯一事实源：hook 消费执行跳转，ShortcutHelpModal 消费渲染速查行） */
export const GOTO_HOTKEYS: readonly GoToHotkey[] = [
  { id: 'dashboard', secondKey: 'd', path: '/dashboard' },
  { id: 'tasks', secondKey: 't', path: '/tasks' },
  { id: 'executors', secondKey: 'e', path: '/executors' },
  { id: 'executions', secondKey: 'x', path: '/executions' },
  { id: 'applications', secondKey: 'a', path: '/applications' },
];

/**
 * 输入态判定：target 是可编辑元素（input/textarea/select/contentEditable）时不触发。
 * antd Input 内部的真实 <input>、Select 的搜索态输入都会命中本判定。
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * 弹层内判定：焦点落在 antd Modal/Drawer/Popover/Dropdown 内部时不触发
 * （速查 Modal、任务触发弹窗、通知铃面板、用户菜单……弹层键盘语义自持）。
 */
export function isInsideOverlay(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.closest('.ant-modal, .ant-drawer, .ant-popover, .ant-dropdown') !== null;
}

export interface UseGlobalHotkeysOptions {
  /** ?（Shift+/）切换快捷键速查 Modal（开 ↔ 关） */
  onToggleHelp: () => void;
  /** 任一全局弹层（⌘K 命令面板 / 速查 Modal）打开中——期间 g 序列与 ? 一律忽略 */
  isOverlayOpen: () => boolean;
}

export function useGlobalHotkeys({ onToggleHelp, isOverlayOpen }: UseGlobalHotkeysOptions): void {
  const nav = useNavigate();
  /** g 已按下、等待第二键的待定态 */
  const pendingRef = useRef(false);
  /** 待定态超时计时器句柄 */
  const timerRef = useRef<number | null>(null);

  const resetPending = useCallback(() => {
    pendingRef.current = false;
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // 连发（按住不放）不触发——与 CommandPalette 的 e.repeat 守卫同口径
      if (e.repeat) return;
      // Ctrl/⌘/Alt 组合键让路（⌘K 由 CommandPalette 自行处理）
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // 输入态：打字时 g / ? 都是字面字符
      if (isEditableTarget(e.target)) return;
      // 弹层内不叠加全局跳转
      if (isInsideOverlay(e.target)) return;
      // ⌘K 面板 / 速查 Modal 打开中：一律忽略
      if (isOverlayOpen()) return;

      if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
        e.preventDefault();
        resetPending();
        onToggleHelp();
        return;
      }

      const key = e.key.toLowerCase();
      if (key === 'g') {
        // 第一键（或重新起手）：进入/刷新待定态与超时计时
        pendingRef.current = true;
        if (timerRef.current !== null) window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(resetPending, G_SEQUENCE_TIMEOUT_MS);
        return;
      }
      if (pendingRef.current) {
        // 第二键：无论命中与否序列都消费完毕
        resetPending();
        const hit = GOTO_HOTKEYS.find((h) => h.secondKey === key);
        if (hit) {
          e.preventDefault();
          nav(hit.path);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [nav, onToggleHelp, isOverlayOpen, resetPending]);
}

export default useGlobalHotkeys;
