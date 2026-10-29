import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * WEB-2（首屏请求数）：⌘K 才用的命令面板 / 快捷键速查**不得**静态进 entry。
 *
 * 首屏 24 个资源请求撞 HTTP/1.1 的 6 并发上限，而 entry 里整块装着命令面板
 * （及其依赖）是纯浪费——用户可能整个会话都不按 ⌘K。现在两者都是
 * `lazy(() => import(...))` + 打开才挂载；本用例是**源码级**回归守卫：
 * 谁把静态 import 加回来，这里立即红（比等评测跑 bundle 分析快得多）。
 */
const SRC = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

describe('WEB-2 · entry 不静态包含仅按需使用的浮层', () => {
  const layout = read('layouts/MainLayout.tsx');

  it('CommandPalette 用 lazy 动态导入，不是静态 import', () => {
    expect(layout).not.toMatch(/^import CommandPalette from/m);
    expect(layout).toMatch(/lazy\(\(\) => import\('\.\.\/components\/CommandPalette'\)\)/);
  });

  it('ShortcutHelpModal 同样按需加载', () => {
    expect(layout).not.toMatch(/^import ShortcutHelpModal from/m);
    expect(layout).toMatch(/import\('\.\.\/components\/ShortcutHelpModal'\)/);
  });

  it('两个浮层都只在打开时挂载（未打开不请求各自 chunk）', () => {
    expect(layout).toMatch(/\{paletteOpen && \(/);
    expect(layout).toMatch(/\{helpOpen && \(/);
  });

  it('⌘K 监听到位：事件监听不能只活在面板内部（面板未挂载时必须能唤起）', () => {
    // 面板内监听默认开启，但 MainLayout 必须传 hotkeys={false} 并自己监听，
    // 否则「未挂载 → 无法唤起」或「双监听互相抵消」二者必居其一。
    expect(layout).toMatch(/hotkeys=\{false\}/);
    expect(layout).toMatch(/\(e\.metaKey \|\| e\.ctrlKey\) && \(e\.key === "k" \|\| e\.key === "K"\)/);
  });
});
