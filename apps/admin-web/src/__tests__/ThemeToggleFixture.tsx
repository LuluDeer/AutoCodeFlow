/**
 * 测试夹具：最小主题切换按钮（MainLayout 头部按钮同款接线）。
 * 独立文件避免在测试里渲染整个 MainLayout（依赖 router/auth/api 全家桶）。
 */
import { Button } from 'antd';
import { SunOutlined, MoonOutlined, DesktopOutlined } from '@ant-design/icons';
import { useThemeStore } from '../theme/store';
import { resolveTheme, systemPrefersDark } from '../theme/store';

const ICONS = {
  light: <SunOutlined />,
  dark: <MoonOutlined />,
  system: <DesktopOutlined />,
} as const;

export default function ThemeToggleFixture() {
  const mode = useThemeStore((s) => s.mode);
  const cycleMode = useThemeStore((s) => s.cycleMode);
  return (
    <Button
      type="text"
      data-testid="theme-toggle"
      aria-label={`当前主题 ${mode}`}
      icon={ICONS[resolveTheme(mode, systemPrefersDark()) === 'dark' && mode === 'system' ? 'system' : mode]}
      onClick={cycleMode}
    >
      {mode}
    </Button>
  );
}
