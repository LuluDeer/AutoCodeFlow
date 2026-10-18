/**
 * 密码策略的**前端单一真值源**——镜像后端
 * `apps/admin-api/src/modules/users/users.service.ts::validatePasswordStrength`。
 *
 * 为什么要有这个文件（SECURITY §3.1 的落地形态）：
 * 之前三个密码表单各自内联自己的规则，其中**两处写成了比后端更严的策略**
 * （`UserManagementPage` 的新建/重置密码用了 `(?=.*[a-z])`，要求小写字母），
 * 而后端**只要求**长度 ≥8 + 大写 + 数字 + 特殊字符。后果是管理台会拒绝
 * 后端本可接受的密码（如 `ADMIN2026!`），且同一个平台上的三个表单对"什么算
 * 合法密码"给出三种答案——用户看到的规则与真正生效的规则不一致，是最难自证的
 * 一类缺陷（表单拦得住、后端不认；或表单放行、后端 400）。
 *
 * 设计取舍：**不引 zxcvbn**（约 800KB，且它是**第二套真值源**——它的"strength"
 * 判定与后端**策略合规性**是两件事，完全可能出现"zxcvbn 说 strong、后端 400"
 * 的错配，那正是本文件要消灭的东西）。这里改为：
 *   1. 规则常量与后端逐字对齐（由 `scripts/check-password-policy-sync.mjs`
 *      交叉核验两侧源码，漂移即 CI 红）；
 *   2. 强度只是**启发式展示**，且**受合规性封顶**——不合规的密码永远不可能
 *      被展示为 "strong"（`estimatePasswordStrength` 的不变量，单测钉死）。
 */

/** 最小长度（与后端 `password.length < 8` 对齐）。 */
export const PASSWORD_MIN_LENGTH = 8;

/** 至少一个大写字母（后端 `/[A-Z]/`）。 */
export const PASSWORD_RULE_UPPERCASE = /[A-Z]/;
/** 至少一个数字（后端 `/[0-9]/`）。 */
export const PASSWORD_RULE_DIGIT = /[0-9]/;
/**
 * 至少一个特殊字符——字符集与后端
 * `/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/` **逐字符一致**。
 *
 * 这里刻意不写 `\[` / `\/` 的无谓转义（eslint `no-useless-escape`；字符类内的
 * 裸 `[` 与 `/` 都是字面量，语义完全相同）。"两侧字符集一致"这条纪律不靠肉眼
 * 比对字面量，而由 `scripts/check-password-policy-sync.mjs` 把两侧正则从源码里
 * 抽出来、在 ASCII 全域 + 若干 Unicode 上**逐字符执行**核验——比逐字文本比对
 * 更能抓到"抄漏一个字符"。
 */
export const PASSWORD_RULE_SPECIAL = /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/;

/**
 * 供 antd `Form.Item rules[].pattern` 用的**单条**正则（等价于四条规则合取）。
 *
 * ⚠️ 全部前瞻都用 `[\s\S]` 而非 `.`：`.` 默认**不匹配换行**，会让"数字/特殊符
 * 出现在换行之后"的密码（如 `ABCDEFG\u000A1!`）在前端被判不合规，而后端用的是
 * `/[0-9]/`、`/[special]/`（**逐字符扫描、不受换行影响**）→ 前端会比后端更严，
 * 正是本文件要消灭的那类错配。长度前瞻同理（后端看 `password.length`）。
 *
 * 该等价性由 `__tests__/password-policy.test.ts` 的**属性测试**逐条核验：
 * 确定性语料上 `PASSWORD_POLICY_PATTERN.test(p) === satisfiesPasswordPolicy(p)`
 * 必须恒成立（初始版本用 `.` 写前瞻，正是这条用例抓出的缺陷）。
 */
export const PASSWORD_POLICY_PATTERN =
  /^(?=[\s\S]{8,})(?=[\s\S]*[A-Z])(?=[\s\S]*[0-9])(?=[\s\S]*[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?])/;

/** i18n 词条键（与既有 `security.password.rule.*` 词条复用，不新造文案）。 */
export const PASSWORD_RULE_LABEL_KEYS = {
  length: 'security.password.rule.length',
  uppercase: 'security.password.rule.uppercase',
  digit: 'security.password.rule.digit',
  special: 'security.password.rule.special',
} as const;

export type PasswordRuleId = keyof typeof PASSWORD_RULE_LABEL_KEYS;

export interface PasswordRuleChecks {
  length: boolean;
  uppercase: boolean;
  digit: boolean;
  special: boolean;
}

/** 逐条规则判定（顺序与后端抛错顺序一致，便于按"第一个不满足"提示）。 */
export function checkPasswordRules(password: string): PasswordRuleChecks {
  const value = password ?? '';
  return {
    length: value.length >= PASSWORD_MIN_LENGTH,
    uppercase: PASSWORD_RULE_UPPERCASE.test(value),
    digit: PASSWORD_RULE_DIGIT.test(value),
    special: PASSWORD_RULE_SPECIAL.test(value),
  };
}

/** 是否满足后端策略（四条全满足）。 */
export function satisfiesPasswordPolicy(password: string): boolean {
  const checks = checkPasswordRules(password);
  return checks.length && checks.uppercase && checks.digit && checks.special;
}

/** 未满足的规则 id 列表（按后端校验顺序）。 */
export function unmetPasswordRules(password: string): PasswordRuleId[] {
  const checks = checkPasswordRules(password);
  return (['length', 'uppercase', 'digit', 'special'] as PasswordRuleId[]).filter(
    (id) => !checks[id],
  );
}

export type PasswordStrengthLevel = 'empty' | 'weak' | 'fair' | 'good' | 'strong';

/** 等级 → 分段数（0..4），供强度条渲染；与 i18n 标签键一并导出。 */
export const PASSWORD_STRENGTH_LEVELS: Record<
  PasswordStrengthLevel,
  { score: 0 | 1 | 2 | 3 | 4; labelKey: string }
> = {
  empty: { score: 0, labelKey: 'security.password.strength.empty' },
  weak: { score: 1, labelKey: 'security.password.strength.weak' },
  fair: { score: 2, labelKey: 'security.password.strength.fair' },
  good: { score: 3, labelKey: 'security.password.strength.good' },
  strong: { score: 4, labelKey: 'security.password.strength.strong' },
};

/**
 * 启发式强度评估。
 *
 * **不变量（单测钉死，也由 `scripts/check-password-policy-sync.mjs` 复核）**：
 * 只要密码**不满足后端策略**，返回的等级绝不高于 `weak`（即绝不可能是
 * `good` / `strong`）。也就是说界面永远不会对"后端一定会拒的密码"给出正向
 * 甚至"很强"的反馈——这正是引入 zxcvbn 会破坏的性质。
 *
 * 计分（刻意简单可解释，不做字典/模式库）：
 *   · 长度分档：<8 → 0；8–11 → 1；12–15 → 2；16–19 → 3；≥20 → 4
 *   · 字符类别多样性（小写/大写/数字/特殊，各计 1）≥3 类时 +1（封顶 4）
 *   · 不满足策略 → 分数压到 ≤1
 */
export function estimatePasswordStrength(password: string): {
  level: PasswordStrengthLevel;
  score: 0 | 1 | 2 | 3 | 4;
  checks: PasswordRuleChecks;
  satisfied: boolean;
} {
  const value = password ?? '';
  const checks = checkPasswordRules(value);
  const satisfied = checks.length && checks.uppercase && checks.digit && checks.special;

  if (value.length === 0) {
    return { level: 'empty', score: 0, checks, satisfied: false };
  }

  let score = 0;
  if (value.length >= 8) score = 1;
  if (value.length >= 12) score = 2;
  if (value.length >= 16) score = 3;
  if (value.length >= 20) score = 4;

  const classes = [
    /[a-z]/.test(value),
    /[A-Z]/.test(value),
    /[0-9]/.test(value),
    PASSWORD_RULE_SPECIAL.test(value),
  ].filter(Boolean).length;
  if (classes >= 3) score = Math.min(4, score + 1);

  // 关键封顶：不合规 → 至多 weak（见上方不变量）
  if (!satisfied) score = Math.min(score, 1);

  const level: PasswordStrengthLevel =
    score >= 4 ? 'strong' : score === 3 ? 'good' : score === 2 ? 'fair' : 'weak';
  return { level, score: score as 0 | 1 | 2 | 3 | 4, checks, satisfied };
}
