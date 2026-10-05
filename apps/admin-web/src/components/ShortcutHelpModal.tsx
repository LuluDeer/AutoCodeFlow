/**
 * HOTKEY-01：快捷键速查 Modal（? / Shift+/ 唤起，Esc 关闭），MainLayout 全局挂载。
 *
 * ── 交互 ───────────────────────────────────────────────────────────────────
 *   ?（Shift+/）唤起/再按切换（由 useGlobalHotkeys 调 onToggleHelp 承担）；
 *   Esc 关闭——antd Modal keyboard 默认行为之外，再显式挂一层 document 级
 *   keydown 兜底（CommandPalette 同款先例：保证任意 antd 版本下 Esc 均生效，
 *   且本 Modal 无输入框、无自然 keydown 源，显式监听才可单测）。
 *
 * ── 数据源 ─────────────────────────────────────────────────────────────────
 *   跳转行直接消费 useGlobalHotkeys 导出的 GOTO_HOTKEYS（键位/路由唯一事实源），
 *   速查表与实际监听永不漂移；⌘K 提示按平台判定（Mac ⌘K / 其他 Ctrl K），
 *   与 CommandPalette 实际监听的 metaKey||ctrlKey 保持一致（F-25 同源纯函数）。
 *
 * ── 样式 ───────────────────────────────────────────────────────────────────
 *   全部走 antd token（colorBorder/colorBgLayout/colorText…），暗色模式自动跟随，
 *   零硬编码色。
 */
import { useEffect } from 'react';
import { Modal, Typography, theme } from 'antd';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import '../i18n';
import { GOTO_HOTKEYS } from '../hooks/useGlobalHotkeys';
import type { GoToHotkey } from '../hooks/useGlobalHotkeys';
import { isMacPlatform, searchShortcutHint } from '../layouts/shortcut-hint';

const { Text } = Typography;

export interface ShortcutHelpModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface HotkeyRow {
  keys: string;
  label: string;
}

/** 跳转目标 → i18n 键（静态键面，供 i18n-key-check 守卫成对校验） */
function gotoLabel(t: TFunction, id: GoToHotkey['id']): string {
  switch (id) {
    case 'dashboard': return t('hotkeys.goto.dashboard');
    case 'tasks': return t('hotkeys.goto.tasks');
    case 'executors': return t('hotkeys.goto.executors');
    case 'executions': return t('hotkeys.goto.executions');
    case 'applications': return t('hotkeys.goto.applications');
  }
}

/** 平台相关的搜索快捷键提示（Mac ⌘K / 其他 Ctrl K）；navigator 缺席时按非 Mac */
function searchKeysHint(): string {
  try {
    return searchShortcutHint(isMacPlatform(navigator.platform, navigator.userAgent));
  } catch {
    return searchShortcutHint(false);
  }
}

export default function ShortcutHelpModal({ open, onOpenChange }: ShortcutHelpModalProps) {
  const { t } = useTranslation();
  const { token } = theme.useToken();

  // Esc 显式关闭（见头注：兜底 antd keyboard 默认行为 + 提供可单测的关闭路径）
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onOpenChange]);

  const globalRows: HotkeyRow[] = [
    { keys: searchKeysHint(), label: t('hotkeys.palette') },
    { keys: '?', label: t('hotkeys.help') },
  ];
  const gotoRows: HotkeyRow[] = GOTO_HOTKEYS.map((h) => ({
    keys: `g ${h.secondKey}`,
    label: gotoLabel(t, h.id),
  }));

  // 键帽样式：token 驱动（暗色模式自动跟随），底部加厚模拟键帽立体感
  const kbdStyle: React.CSSProperties = {
    display: 'inline-block',
    minWidth: 38,
    padding: '1px 8px',
    textAlign: 'center',
    fontSize: 12,
    lineHeight: '20px',
    borderRadius: 6,
    border: `1px solid ${token.colorBorder}`,
    borderBottomWidth: 2,
    background: token.colorBgLayout,
    color: token.colorText,
  };

  const renderRows = (rows: HotkeyRow[]) =>
    rows.map((row) => (
      <div
        key={row.keys}
        role="listitem"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          padding: '6px 4px',
        }}
      >
        <kbd style={kbdStyle}>{row.keys}</kbd>
        <Text style={{ color: token.colorText, textAlign: 'right' }}>{row.label}</Text>
      </div>
    ));

  const groupTitleStyle: React.CSSProperties = {
    display: 'block',
    fontSize: 12,
    color: token.colorTextSecondary,
    padding: '4px 4px 2px',
  };

  return (
    <Modal
      open={open}
      onCancel={() => onOpenChange(false)}
      title={t('hotkeys.title')}
      footer={null}
      width={420}
      destroyOnHidden
      data-testid="shortcut-help-modal"
      styles={{ body: { paddingTop: 8 } }}
    >
      <div role="list" aria-label={t('hotkeys.aria.list')}>
        <Text style={groupTitleStyle}>{t('hotkeys.group.global')}</Text>
        {renderRows(globalRows)}
        <Text style={{ ...groupTitleStyle, marginTop: 8 }}>{t('hotkeys.group.goto')}</Text>
        {renderRows(gotoRows)}
      </div>
    </Modal>
  );
}
