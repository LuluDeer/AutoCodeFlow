// UI-10 i18n：本轮先落基础设施 + 公共文案（中/英），示范页随演进逐页迁移。
//
// 设计（渐进式、零后端依赖）：
//  - 单一 i18n 实例，lng 优先级 = localStorage('autoflow-lang') > **浏览器语言** >
//    **默认英文**（见 detectLanguage）。产品要求原文：「默认是英文，但是也优先
//    跟随浏览器/系统语言，后面想换也可以进行更换」——故：
//      · 用户显式切过 → 永远听用户的（持久化在 localStorage）；
//      · 没切过 → 浏览器是中文（zh*）给中文，**其余一律英文**（含 en* 与 fr 等
//        未支持语言；未支持语言回落英文而不是中文，这是「默认英文」的体现）；
//      · 不引 browser-languagedetector 插件（零新增依赖，行为可测）。
//  - zh 与 en 两套扁平 key；缺失时回退 zh（fallbackLng 清净，避免「英文环境
//    看到 key 名」）。
//  - 未迁移页仍硬编码中文（本文件只承载已迁移文案 + 少量公共项）；逐页迁移时
//    把该页文案搬进 locales 并对齐测试。
//
// ⚠️ 「默认英文」只决定**首次进入时的语言**，不改变词条覆盖度：zh 是 fallbackLng，
//    且部分页面仍有硬编码中文，故中文用户与英文用户都不应看到裸 key（由
//    i18n-source-guard.test.ts 钉住「源码用到的 key 必须存在于字典」）。
//
// 网络性能审计（2026-09-18）：语言包按语言动态分割。zh 为 fallback，静态打包进
// i18n 入口 chunk；en（~140KB）仅在「启动检测为 en」或「用户显式切到 en」时按需
// import（Vite 会拆成独立 chunk）。语言切换时 setLanguage 负责现取现挂
// （i18next.addResourceBundle 后 changeLanguage）。
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import zh from '../locales/zh';

export const STORAGE_KEY = 'autoflow-lang';

/**
 * 解析初始语言。优先级：**已保存的选择 > 浏览器语言 > 默认英文**。
 *
 * 分支语义（三者缺一不可）：
 *   ① 已保存 'zh'/'en' → 直接返回（用户的显式选择永远最高优先，否则「设置」
 *      形同虚设——切到中文刷新又变回英文是最典型的坏体验）；
 *   ② 浏览器 `zh*` → 中文（含 zh-CN / zh-TW / zh-Hans 等）；
 *   ③ 其余全部 → **英文**。刻意**不**用 `startsWith('en')` 判定：那样 fr/de/ja
 *      等未支持语言会掉进「非 en」分支拿到中文，与「默认英文」的产品要求相反。
 *      localStorage 不可用（隐私模式）时抛错被吞，走 ②/③，绝不因此崩渲染。
 */
export function detectLanguage(): 'zh' | 'en' {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'zh' || saved === 'en') return saved;
  } catch {
    /* storage 不可用（隐私模式等）→ 走浏览器判定 */
  }
  try {
    const nav = String(navigator.language ?? '').toLowerCase();
    if (nav.startsWith('zh')) return 'zh';
  } catch {
    /* navigator 不可用（极少数非浏览器环境）→ 走默认 */
  }
  return 'en';
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
