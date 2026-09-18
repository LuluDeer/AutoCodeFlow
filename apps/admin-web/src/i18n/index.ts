// UI-10 i18n：本轮先落基础设施 + 公共文案（中/英），示范页随演进逐页迁移。
//
// 设计（渐进式、零后端依赖）：
//  - 单一 i18n 实例，lng 优先级 = localStorage('autoflow-lang') > 默认 zh。
//    默认 zh 是产品基线（未迁移页全部硬编码中文，语言一致性）；只在用户
//    显式切换后持久化 localStorage。不引 browser-languagedetector 插件
//    （零新增依赖，行为可测——测试环境 navigator 是 en-US 时仍保持 zh）。
//  - zh 与 en 两套扁平 key；缺失时回退 zh（fallbackLng 清净，避免「英文环境
//    看到 key 名」）。
//  - 未迁移页仍硬编码中文（本文件只承载已迁移文案 + 少量公共项）；逐页迁移时
//    把该页文案搬进 locales 并对齐测试。
//
// 网络性能审计（2026-09-18）：语言包按语言动态分割。zh 为产品基线 + fallback，
// 静态打包进 i18n 入口 chunk；en（~140KB）仅在「启动检测为 en」或「用户显式
// 切到 en」时按需 import（Vite 会拆成独立 chunk）。zh 用户首屏不再下载 en 包，
// 语言切换时 setLanguage 负责现取现挂（i18next.addResourceBundle 后 changeLanguage）。
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import zh from '../locales/zh';

export const STORAGE_KEY = 'autoflow-lang';

export function detectLanguage(): 'zh' | 'en' {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'zh' || saved === 'en') return saved;
  } catch {
    /* storage 不可用（隐私模式等）→ 走默认 */
  }
  return 'zh';
}

export function setLanguage(lng: 'zh' | 'en'): Promise<unknown> {
  try {
    localStorage.setItem(STORAGE_KEY, lng);
  } catch {
    /* 持久化失败不阻断切换 */
  }
  if (lng === 'en' && !i18n.hasResourceBundle('en', 'translation')) {
    return import('../locales/en').then((mod) => {
      i18n.addResourceBundle('en', 'translation', mod.default, true, true);
      return i18n.changeLanguage(lng);
    });
  }
  return i18n.changeLanguage(lng);
}

export const availableLanguages = [
  { code: 'zh', label: '中文' },
  { code: 'en', label: 'English' },
];

async function initI18n(): Promise<void> {
  const lng = detectLanguage();
  const resources: Record<string, { translation: Record<string, string> }> = {
    zh: { translation: zh },
  };
  // 仅当启动检测为 en 时才动态拉取 en 包（zh 用户永远不下载它）。
  if (lng === 'en') {
    const en = (await import('../locales/en')).default;
    resources.en = { translation: en };
  }
  await i18n.use(initReactI18next).init({
    resources,
    lng,
    fallbackLng: 'zh',
    interpolation: { escapeValue: false }, // React 已转义，无需 i18next 二次转义
    react: { useSuspense: false },
  });
}

void initI18n();

export default i18n;
