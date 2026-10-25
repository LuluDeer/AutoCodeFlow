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
// F-42（UIUX 审计 P1-3）：en 改为**静态 import 同步注册**，取代 2026-09-18
// 网络性能审计「en 按需分包」的决策。原因：动态包让 initI18n 必须 await 其落定
// 后才能 i18n.init，而 React 树在模块求值后立即挂载——这段异步窗口里组件拿着
// **未初始化**的 i18next 渲染，真机出现两类竞态形态：冷启动 EN 侧边栏整块回退
// 中文（fallbackLng 兜底）或直接渲染原始 key；运行时切 EN 也在全站 17 个页面
// 复现 raw key（侧边栏 buildMenuItems 的 nav.* 全部裸奔）。en/zh 两包都很小
// （en 产物 ~140KB raw / ~40KB gzip），正确性优先：同步注册后 init 无 await、
// 模块求值完成时双语资源已就位，竞态窗口物理消失；代价是 en 并入主 chunk
// （zh 用户多下载约 40KB gzip）。若未来确需恢复拆分，**必须**同时给挂载树加
// i18n ready 门控（等 isInitialized 再渲染），禁止「裸 async init + 立即渲染」
// 的组合再次出现。
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import zh from '../locales/zh';
import en from '../locales/en';

export const STORAGE_KEY = 'autoflow-lang';

/**
 * F-42：双存储键收敛。历史上 i18next 的 LanguageDetector 写过 `i18nextLng`
 * （真机 localStorage 实证两键并存，语义漂移风险：改了 autoflow-lang 却读到
 * 旧键的值）。现收敛为**单一来源**：写入只走 STORAGE_KEY（setLanguage）；
 * 旧键保留**只读兼容**（老用户已选语言不丢），读到即一次性迁移写回新键。
 */
const LEGACY_STORAGE_KEYS: readonly string[] = ['i18nextLng'];

/**
 * 解析初始语言。优先级：**已保存的选择 > 旧键迁移 > 浏览器语言 > 默认英文**。
 *
 * 分支语义（缺一不可）：
 *   ① 已保存 'zh'/'en' → 直接返回（用户的显式选择永远最高优先，否则「设置」
 *      形同虚设——切到中文刷新又变回英文是最典型的坏体验）；
 *   ①b 旧键 `i18nextLng` 合法值 → 采用并迁移写入 STORAGE_KEY（F-42 收敛）；
 *   ② 浏览器 `zh*` → 中文（含 zh-CN / zh-TW / zh-Hans 等）；
 *   ③ 其余全部 → **英文**。刻意**不**用 `startsWith('en')` 判定：那样 fr/de/ja
 *      等未支持语言会掉进「非 en」分支拿到中文，与「默认英文」的产品要求相反。
 *      localStorage 不可用（隐私模式）时抛错被吞，走 ②/③，绝不因此崩渲染。
 */
export function detectLanguage(): 'zh' | 'en' {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'zh' || saved === 'en') return saved;
    for (const legacy of LEGACY_STORAGE_KEYS) {
      const migrated = localStorage.getItem(legacy);
      if (migrated === 'zh' || migrated === 'en') {
        try {
          localStorage.setItem(STORAGE_KEY, migrated);
        } catch {
          /* 迁移写失败不阻断本次判定（下次进入重试） */
        }
        return migrated;
      }
    }
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
  // F-42：双语资源已随入口同步注册，切换恒为同步 changeLanguage——不再存在
  // 「addResourceBundle 落定前 changeLanguage 已被消费」的时序，也无需
  // hasResourceBundle 分支（运行时切语言出现 raw key 的根因即在此）。
  return i18n.changeLanguage(lng);
}

export const availableLanguages = [
  { code: 'zh', label: '中文' },
  { code: 'en', label: 'English' },
];

/**
 * F-42：html lang 与实际界面语言同步。index.html 静态 lang="zh-CN"，EN 用户
 * 的文档语言声明失真（读屏发音规则/翻译器按 html lang 判定）。zh 产物是
 * 简体中文 → zh-CN。初始化时按检测语言设置一次，之后随 languageChanged 跟随。
 */
function applyDocumentLang(lng: string | null | undefined): void {
  try {
    document.documentElement.lang = lng === 'en' ? 'en' : 'zh-CN';
  } catch {
    /* 非 DOM 环境（测试/SSR 边界）忽略 */
  }
}

/**
 * F-42：双语资源**同步注册**。init 在模块求值期完成（无 await，i18next 纯
 * 内联资源时 isInitialized 同步置位）——首个组件渲染前资源已就绪，冷启动
 * EN / 运行时往返切换都不再有 raw key 或整块错语窗口。
 */
function initI18n(): void {
  const lng = detectLanguage();
  void i18n.use(initReactI18next).init({
    resources: {
      zh: { translation: zh },
      en: { translation: en },
    },
    lng,
    fallbackLng: 'zh',
    interpolation: { escapeValue: false }, // React 已转义，无需 i18next 二次转义
    react: { useSuspense: false },
  });
  applyDocumentLang(lng);
  i18n.on('languageChanged', applyDocumentLang);
}

initI18n();

export default i18n;
