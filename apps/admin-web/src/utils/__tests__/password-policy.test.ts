/**
 * SECURITY §3.1：密码策略前端真值源（`utils/passwordPolicy`）的行为契约。
 *
 * 为什么这组用例值得写得这么细：这个模块的唯一职责是**后端策略的镜像**，
 * 而它的失效方式全部是**静默**的——
 *   · 镜像写松了 → 表单放行、后端 400（用户看到"提交失败"但不知道为什么）；
 *   · 镜像写严了 → 表单拒绝后端本可接受的密码（真实发生过：内联正则多要求
 *     小写字母，见下方"不要求小写字母"用例）；
 *   · 合并正则与逐条函数不一致 → 同一个界面里"提示"和"拦截"给出两种答案。
 * 三种都不会抛错、不会被 lint 发现，只能靠断言。
 *
 * 关键防线是**属性测试**（确定性语料上的等价性），而不是手工挑几个样例：
 * 本节第二组用例就是靠它抓出了初版用 `.` 写前瞻、因而**不匹配换行**的缺陷
 * （`.` 不跨 \n，而后端的 `/[0-9]/` 是逐字符扫描）。
 */
import { describe, it, expect } from 'vitest';
import {
  PASSWORD_MIN_LENGTH,
  PASSWORD_POLICY_PATTERN,
  PASSWORD_RULE_DIGIT,
  PASSWORD_RULE_SPECIAL,
  PASSWORD_RULE_UPPERCASE,
  PASSWORD_STRENGTH_LEVELS,
  checkPasswordRules,
  estimatePasswordStrength,
  satisfiesPasswordPolicy,
  unmetPasswordRules,
} from '../passwordPolicy';

/** 确定性语料（禁止随机：失败必须可复现）。混合字符类 + 换行/制表/非 ASCII。 */
function deterministicCorpus(): string[] {
  const fixed = [
    '',
    'a',
    '1234567',
    '12345678',
    'abcdefgh',
    'ABCDEFGH',
    'ABCDEFG1',
    'ABCDEFG!',
    'Abcdefg1!',
    'ADMIN2026!',
    // 回归：内联正则曾要求小写字母 → 本行必须合规（后端不要求小写）
    'ALLCAPS2026!',
    'ABCDEFG\n1!',
    'ABCDEFG1\n!',
    '\n1!ABCDEFG',
    '密码Password1!',
    '       1!A',
    'A1!     ',
    'A1!' + 'x'.repeat(17),
    'A1!' + 'x'.repeat(20),
  ];
  const alphabet = 'abzXYZ019!@# \n\t中？';
  const out = [...fixed];
  let seed = 20261017;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let i = 0; i < 600; i++) {
    const len = Math.floor(next() * 24);
    let s = '';
    for (let j = 0; j < len; j++) {
      s += alphabet[Math.floor(next() * alphabet.length)];
    }
    out.push(s);
  }
  return out;
}

const CORPUS = deterministicCorpus();

describe('passwordPolicy：与后端 validatePasswordStrength 逐条对齐', () => {
  it('四条规则各自的判定与后端正则同义', () => {
    expect(checkPasswordRules('abcdefgh')).toEqual({
      length: true,
      uppercase: false,
      digit: false,
      special: false,
    });
    expect(checkPasswordRules('ABCDEFG')).toEqual({
      length: false,
      uppercase: true,
      digit: false,
      special: false,
    });
    // 长度按 UTF-16 code unit 计（后端用 password.length，不看字符类别）
    expect(checkPasswordRules('密码密码密码密码')).toMatchObject({ length: true });
    expect(checkPasswordRules('')).toEqual({
      length: false,
      uppercase: false,
      digit: false,
      special: false,
    });
  });

  it('最小长度是 8，边界 7/8 各判一次（与后端 `< 8` 同界）', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(8);
    expect(satisfiesPasswordPolicy('ABCDEF1')).toBe(false); // 7 位
    expect(satisfiesPasswordPolicy('ABCDEF1!')).toBe(true); // 8 位
  });

  it('**不要求小写字母**（回归：内联正则曾多要求 (?=.*[a-z])，比后端更严）', () => {
    // 这条是真实缺陷的回归锁：后端只要求 长度+大写+数字+特殊字符
    expect(satisfiesPasswordPolicy('ALLCAPS2026!')).toBe(true);
    expect(PASSWORD_POLICY_PATTERN.test('ALLCAPS2026!')).toBe(true);
    // 反过来，只有小写也不够（后端不认）
    expect(satisfiesPasswordPolicy('alllower2026!')).toBe(false);
  });

  it('特殊字符集合与后端一致：细类抽查（含被盲区忽略的 {} | : " < > / ?）', () => {
    for (const ch of ['!', '@', '#', '=', '{', '}', '|', ':', '"', '<', '>', '/', '?', '-', '_']) {
      expect(PASSWORD_RULE_SPECIAL.test(ch)).toBe(true);
      expect(PASSWORD_RULE_SPECIAL.test(ch)).toBe(true);
    }
    // 字母与数字**不是**特殊字符
    for (const ch of ['a', 'Z', '0', '9', '中']) {
      expect(PASSWORD_RULE_SPECIAL.test(ch)).toBe(false);
    }
    // 三个单类正则与后端字面量同源（避免"抄的时候少一个字符"）
    expect(PASSWORD_RULE_UPPERCASE.source).toBe('[A-Z]');
    expect(PASSWORD_RULE_DIGIT.source).toBe('[0-9]');
  });

  it('unmetPasswordRules 按后端校验顺序给出未满足项', () => {
    expect(unmetPasswordRules('abcdefgh')).toEqual(['uppercase', 'digit', 'special']);
    // 注意 ABCDEFG1 是 **8 位**（长度已满足）——7 位请用 ABCDEF1
    expect(unmetPasswordRules('ABCDEFG1')).toEqual(['special']);
    expect(unmetPasswordRules('ABCDEF1')).toEqual(['length', 'special']);
    expect(unmetPasswordRules('ABCDEF1!')).toEqual([]);
  });
});

describe('passwordPolicy：合并正则 ⇔ 逐条函数（属性测试）', () => {
  it('确定性语料上两者判定完全一致（antd pattern 规则与提示不许给出两种答案）', () => {
    const mismatches: string[] = [];
    for (const pwd of CORPUS) {
      const byRegex = PASSWORD_POLICY_PATTERN.test(pwd);
      const byRules = satisfiesPasswordPolicy(pwd);
      if (byRegex !== byRules) {
        mismatches.push(JSON.stringify(pwd));
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('换行位置不影响判定（后端按字符扫描；前瞻必须用 [\\s\\S] 而非 .）', () => {
    // 若前瞻写成 `(?=.*[0-9])`，数字落在换行之后就会被误判为不合规
    expect(PASSWORD_POLICY_PATTERN.test('ABCDEFG\n1!')).toBe(true);
    expect(satisfiesPasswordPolicy('ABCDEFG\n1!')).toBe(true);
    expect(PASSWORD_POLICY_PATTERN.test('ABCDEFG1\n!')).toBe(true);
    expect(satisfiesPasswordPolicy('ABCDEFG1\n!')).toBe(true);
  });
});

describe('passwordPolicy：强度封顶不变量（"绝不把会被后端拒的密码显示为强"）', () => {
  it('空密码 → empty / 0 分', () => {
    expect(estimatePasswordStrength('')).toMatchObject({ level: 'empty', score: 0, satisfied: false });
  });

  it('**不合规的密码，等级绝不高于 weak**（确定性语料上全量核验）', () => {
    const offenders: string[] = [];
    for (const pwd of CORPUS) {
      const result = estimatePasswordStrength(pwd);
      if (!result.satisfied && result.score > 1) {
        offenders.push(`${JSON.stringify(pwd)} → score=${result.score} level=${result.level}`);
      }
      if (!result.satisfied && result.level !== 'empty' && result.level !== 'weak') {
        offenders.push(`${JSON.stringify(pwd)} → level=${result.level}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('"强"必然蕴含"合规"（逆命题式抽样：所有 strong 的样本都满足策略）', () => {
    const strongButIllegal = CORPUS.filter(
      (p) => estimatePasswordStrength(p).level === 'strong' && !satisfiesPasswordPolicy(p),
    );
    expect(strongButIllegal).toEqual([]);
  });

  it('合规且足够长的密码可以到 strong，且利好因素确实抬分', () => {
    const long = 'Abcdefgh1234!@#$XyZ'; // 20 位 + 4 类
    expect(estimatePasswordStrength(long)).toMatchObject({ level: 'strong', score: 4, satisfied: true });
    // 同等长度下少一类字符 → 不高于 good（多样性分支只 +1，且封顶 4）
    const fewerClasses = 'ABCDEFGHIJKLMNOPQRST'; // 20 位，仅大写
    expect(estimatePasswordStrength(fewerClasses).satisfied).toBe(false);
    expect(estimatePasswordStrength(fewerClasses).score).toBeLessThanOrEqual(1);
  });

  it('等级表覆盖全部等级且分数单调不减（渲染层依赖它做分段数）', () => {
    const order = ['empty', 'weak', 'fair', 'good', 'strong'] as const;
    const scores = order.map((l) => PASSWORD_STRENGTH_LEVELS[l].score);
    expect(scores).toEqual([0, 1, 2, 3, 4]);
    for (const level of order) {
      expect(PASSWORD_STRENGTH_LEVELS[level].labelKey).toMatch(
        /^security\.password\.strength\./,
      );
    }
  });
});
