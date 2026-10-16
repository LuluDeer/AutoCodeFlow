/**
 * i18n-DESK-01：桌面端「界面语言」设置（config 键 uiLanguage）的**唯一判定源**。
 *
 * 背景：桌面端此前只有「按系统语言自动判定」——渲染层读 navigator.language、
 * 主进程读 app.getLocale()，各自随系统语言在中/英之间切换，用户**没有任何
 * 选择权**（英文系统上想看中文、中文系统上想看英文都做不到）。产品要求是
 * 「可切换（语言设置，默认中文）」，本模块就是这条设置在三处消费面
 * （渲染层 src/renderer/i18n.ts、托盘 src/main/tray-texts.ts、崩溃兜底
 * src/main/crash-guard.ts 的 locale 注入）共用的纯函数判定层。
 *
 * 为什么独立成模块（同 path-domain.ts / config-sanitize.ts 的抽离理由）：
 * 本模块**无 electron、无 DOM 依赖**，渲染层与主进程两侧都要 import 它。放在
 * 任一侧都会被另一侧拖进不需要的依赖——例如 tray-texts.ts 一旦 import
 * config-store.ts 就会把 electron 带进纯 node 的 selftest，selftest 当场崩。
 *
 * 取值语义（与 config-store.ts 的 AppConfig.uiLanguage、config-sanitize.ts 的
 * ENUM_FIELDS 规则、ConfigPage 的下拉选项三处逐字一致）：
 *   · 'zh'   —— 显式中文；
 *   · 'en'   —— 显式英文；
 *   · 'auto' —— 跟随系统（**默认值**，见 config-store.ts 的 defaults：
 *     系统 zh* → 中文，其余（含 en* 与 fr 等未支持语言） → 英文）。
 *
 * 判定纪律（三条缺一不可）：
 *   1. **显式设置优先于系统语言**——否则「设置」形同虚设；
 *   2. 'auto' 覆盖「跟随系统」这一诉求（产品要求原文：「默认是英文，但是也优先
 *      跟随浏览器/系统语言，后面想换也可以进行更换」）；
 *   3. **非法值一律按默认英文**，而不是回落自动判定：手改 config.json 写进来的
 *      'fr' / '' / 数字，在移除 schema 校验后会静默落盘，
 *      「配置看起来生效了、行为却是另一套」是最难排查的故障形态（同
 *      config-sanitize.ts 档位消毒的理由）。
 *
 * 刻意**不**把「调用方没提供设置（undefined）」当非法值：undefined = 没给设置
 * （旧调用点 / 旧测试 / 配置读取失败前的模块级求值），此时保持既有自动判定，
 * 线上由调用方用 UI_LANGUAGE_DEFAULT 补齐默认值（见 main/index.ts 与
 * renderer/main.tsx）——这样既有渲染层调用点与既有测试都不用改。
 */
export type UiLanguage = 'zh' | 'en' | 'auto';

/** 实际生效的语言（'auto' 判定完之后）。 */
export type UiLocale = 'zh' | 'en';

/**
 * 默认界面语言：**英文**（产品要求「默认是英文」）。config-store.ts 的
 * defaults（'auto'）、config-sanitize.ts 的 ENUM_FIELDS fallback、设置页下拉的
 * 兜底值都以它为准（defaults 用 'auto' 是为了先跟随系统语言，系统语言无法判定
 * 或不属于中英时再落到本常量）。
 * 字面量类型（而非 `UiLanguage`）：判定层的返回值是 UiLocale，默认值必须能
 * 直接当 "已定语言" 用（'auto' 不是合法返回值）。
 */
export const UI_LANGUAGE_DEFAULT = 'en' as const;

/** 合法取值清单（config-sanitize 的 ENUM_FIELDS 与设置页下拉共用同一份）。 */
export const UI_LANGUAGE_VALUES: readonly UiLanguage[] = ['zh', 'en', 'auto'];

/**
 * 系统语言 → 生效语言：**`zh*` 一律中文，其余（en* / fr / 空 / 未知）回落英文**。
 *
 * ⚠️ 这与本模块首版的方向**相反**（首版 `en*` → 英文、其余 → 中文）。产品要求
 * 「默认英文，但优先跟随系统语言」意味着：只有系统**确实是中文**才给中文；
 * 系统是 en 或任何平台未支持的语言（fr/de/ja…）都给英文。若沿用「非 en 即中文」
 * 的旧口径，一台法语机器会拿到中文界面——既不是它要的，也不是默认英文。
 */
function detectFromSystemLocale(getSystemLocale: () => string): UiLocale {
  // 原实现直接 getLocale().toLowerCase()——个别平台/注入桩可能给 undefined，
  // 那会在判定层抛错（渲染层整树卸载级别的故障）。这里按"未知 locale"处理。
  return String(getSystemLocale()).toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/**
 * 解析实际生效的界面语言。
 *
 * @param getSystemLocale 系统语言读取器（渲染层传 navigator.language，主进程传
 *                        app.getLocale——两者只在 'auto'/未提供设置时才会被调用）。
 * @param setting         已落盘的 uiLanguage 取值；未提供（undefined）时按
 *                        'auto' 语义回落既有自动判定。
 */
export function resolveUiLanguage(
  getSystemLocale: () => string,
  setting?: unknown,
): UiLocale {
  // 未提供设置（唯一保留自动判定的入口，见文件头注第 3 段）——'auto' 走下面
  // 的显式分支，两条路径算出的是同一个结果。
  if (setting === undefined) return detectFromSystemLocale(getSystemLocale);

  const normalized = typeof setting === 'string' ? setting.trim().toLowerCase() : '';
  if (normalized === 'zh' || normalized === 'en') return normalized;
  if (normalized === 'auto') return detectFromSystemLocale(getSystemLocale);
  // 非法 / 空串 / 非字符串（手改 config.json、旧版残值）→ 默认英文
  return UI_LANGUAGE_DEFAULT;
}
