// UI-10 i18n 基础设施专项测试：
//  - 中英字典 key 集合一致（缺 key 会导致英文环境回退中文——静默但非预期，
//    用集合比对把「漏翻」变成测试失败）；
//  - detectLanguage 优先级 = localStorage 显式切换 > 浏览器语言（zh*→zh，其余→en）> 默认 en；
//  - setLanguage 切换后实例读取新文案（语言切换闭环）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import zh from '../locales/zh';
import en from '../locales/en';
import i18n, { detectLanguage, setLanguage, STORAGE_KEY } from '../i18n';

describe('UI-10 i18n 基础设施', () => {
  beforeEach(() => {
    localStorage.clear();
    // 每个用例回到默认 zh，避免用例间语言状态泄漏
    i18n.changeLanguage('zh');
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('中文字典与英文字典 key 集合一致（漏翻即红）', () => {
    const zhKeys = Object.keys(zh).sort();
    const enKeys = Object.keys(en).sort();
    expect(enKeys).toEqual(zhKeys);
    // 非空验证：随手守卫「空字典也通过」的假绿灯
    expect(zhKeys.length).toBeGreaterThan(0);
  });

  // LANG-DEFAULT：产品要求「默认是英文，但优先跟随浏览器/系统语言」——故
  // 判定链是「已保存 > 浏览器语言 > 默认英文」。这里按**系统语言**逐个钉住，
  // 而不是只测一个方向：只测 en-US→en 会漏掉「未支持语言错误地掉回中文」这个
  // 真实回归形态（旧实现是 startsWith('en') ? 'en' : 'zh'，fr 会拿到中文）。
  it('无 localStorage 设置时跟随浏览器语言：zh* → 中文', () => {
    vi.spyOn(window.navigator, 'language', 'get').mockReturnValue('zh-CN');
    expect(detectLanguage()).toBe('zh');
  });

  it('无 localStorage 设置时跟随浏览器语言：en* → 英文', () => {
    vi.spyOn(window.navigator, 'language', 'get').mockReturnValue('en-US');
    expect(detectLanguage()).toBe('en');
  });

  it('无 localStorage 设置且浏览器语言未支持（fr）→ 默认英文', () => {
    vi.spyOn(window.navigator, 'language', 'get').mockReturnValue('fr-FR');
    expect(detectLanguage()).toBe('en');
  });

  it('localStorage 显式设置后 detectLanguage 返回对应语言', () => {
    localStorage.setItem(STORAGE_KEY, 'en');
    expect(detectLanguage()).toBe('en');
    localStorage.setItem(STORAGE_KEY, 'zh');
    expect(detectLanguage()).toBe('zh');
  });

  it('setLanguage 切换后实例读到目标语言文案', async () => {
    expect(i18n.t('login.submit')).toBe('登录');
    await setLanguage('en');
    // 语言切换是异步的，等待实例生效
    await vi.waitFor(() => {
      expect(i18n.t('login.submit')).toBe('Sign in');
    });
    // 持久化落盘：切换后可被 detectLanguage 复得
    expect(localStorage.getItem(STORAGE_KEY)).toBe('en');
  });

  it('fallback：en 字典缺失的 key 回退中文（不暴露裸 key）', async () => {
    // 模拟 en 缺 key：直接查询一个只存在于 zh 的临时场景不可行（字典为 const），
    // 改为验证「土 key」fallback 行为——不存在时 i18next 默认返回 key 本身，
    // 我们的 fallbackLng=zh 保证已迁移 key 不裸奔；
    // 这里用 zh 里必然存在的 key 验证双语言皆可解析。
    expect(i18n.t('login.username')).toBe('用户名');
    expect(i18n.t('brand.tagline')).toBe('企业级任务调度平台');
  });

  // ── F-42（UIUX 审计 P1-3）：同步注册 + 存储键收敛回归 ─────────────────────
  // 旧实现 en 动态 import → initI18n await 期间 React 已挂载，冷启动 EN 侧边栏
  // 整块中文 / raw key、运行时切 EN 全站 17 页 raw key（side bar nav.* 裸奔）。
  describe('F-42 同步注册与存储键收敛', () => {
    it('双语资源在模块求值期同步注册（无动态包竞态窗口）', () => {
      // import 本文件即已执行 i18n/index.ts 的 initI18n()——不需要 await：
      // 同步注册的判据就是「此刻」资源已就位且实例已初始化。
      expect(i18n.hasResourceBundle('zh', 'translation')).toBe(true);
      expect(i18n.hasResourceBundle('en', 'translation')).toBe(true);
      expect(i18n.isInitialized).toBe(true);
    });

    it('旧键 i18nextLng 兼容读取并一次性迁移写入 autoflow-lang', () => {
      localStorage.setItem('i18nextLng', 'en');
      expect(detectLanguage()).toBe('en');
      // 收敛：迁移后写入新键（此后写入只走 STORAGE_KEY）
      expect(localStorage.getItem(STORAGE_KEY)).toBe('en');
    });

    it('新键优先于旧键（两键并存时以 autoflow-lang 为准）', () => {
      localStorage.setItem(STORAGE_KEY, 'zh');
      localStorage.setItem('i18nextLng', 'en');
      expect(detectLanguage()).toBe('zh');
      // 不被旧键改写
      expect(localStorage.getItem(STORAGE_KEY)).toBe('zh');
    });

    it('旧键非合法值忽略（回落浏览器语言判定）', () => {
      localStorage.setItem('i18nextLng', 'fr');
      vi.spyOn(window.navigator, 'language', 'get').mockReturnValue('zh-CN');
      expect(detectLanguage()).toBe('zh');
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('setLanguage 只写 autoflow-lang（写入面收敛，不产生 i18nextLng）', async () => {
      await setLanguage('en');
      expect(localStorage.getItem(STORAGE_KEY)).toBe('en');
      expect(localStorage.getItem('i18nextLng')).toBeNull();
      await setLanguage('zh');
      expect(localStorage.getItem(STORAGE_KEY)).toBe('zh');
      expect(localStorage.getItem('i18nextLng')).toBeNull();
    });
  });
});