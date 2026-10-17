import { Typography, theme } from 'antd';
import { useTranslation } from 'react-i18next';
import '../i18n';
import {
  PASSWORD_RULE_LABEL_KEYS,
  PASSWORD_STRENGTH_LEVELS,
  estimatePasswordStrength,
  type PasswordStrengthLevel,
} from '../utils/passwordPolicy';

const { Text } = Typography;

/**
 * SECURITY §3.1：密码强度实时反馈（零新依赖，**不用 zxcvbn**）。
 *
 * 为什么不用 zxcvbn：它是 **~800KB 的独立强度模型**，与后端
 * `validatePasswordStrength` 的**策略**是两回事——完全可能"zxcvbn 说 strong、
 * 后端 400"。本组件改为直接消费 `utils/passwordPolicy`（后端策略的逐字镜像），
 * 于是界面**永远不会**对"后端一定会拒的密码"给出 `good`/`strong`
 * （该不变量由 `estimatePasswordStrength` 的封顶逻辑保证，单测钉死；
 * 另由 `scripts/check-password-policy-sync.mjs` 与后端源码交叉核验）。
 *
 * 无障碍：强度文本挂 `role="status"` + `aria-live="polite"`（输入过程中朗读，
 * 但不打断——polite）；四段色条纯装饰 `aria-hidden`，信息完全由文本承载
 * （色盲用户与读屏用户拿到同样的信息）；规则清单用 `<ul>` + 逐条文字状态，
 * 不把"满足/未满足"仅编码成颜色或图标。
 */

/** 等级 → antd 主题色 token（暗色主题自适应，硬编码色值会在暗色下失真）。 */
function levelColor(
  level: PasswordStrengthLevel,
  token: ReturnType<typeof theme.useToken>['token'],
): string {
  switch (level) {
    case 'strong':
      return token.colorSuccess;
    case 'good':
      return token.colorPrimary;
    case 'fair':
      return token.colorWarning;
    default:
      return token.colorError;
  }
}

export interface PasswordStrengthMeterProps {
  password: string;
  /** 是否显示逐条规则清单（默认显示——它才是"后端会不会拒"的直接答案）。 */
  showChecklist?: boolean;
  /** 测试/受控场景用：强制指定 id 前缀，避免同页多实例 id 冲突。 */
  idPrefix?: string;
}

export default function PasswordStrengthMeter({
  password,
  showChecklist = true,
  idPrefix = 'pwd-strength',
}: PasswordStrengthMeterProps) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const { level, score, checks } = estimatePasswordStrength(password ?? '');
  const color = levelColor(level, token);

  const ruleIds = ['length', 'uppercase', 'digit', 'special'] as const;

  return (
    <div style={{ marginTop: 6 }} data-testid={`${idPrefix}-meter`}>
      {/* 四段色条：纯装饰，信息由下方文本承载 */}
      <div
        aria-hidden="true"
        style={{ display: 'flex', gap: 4, marginBottom: 4 }}
      >
        {[1, 2, 3, 4].map((segment) => (
          <span
            key={segment}
            data-testid={`${idPrefix}-segment-${segment}`}
            data-filled={segment <= score ? 'true' : 'false'}
            style={{
              flex: 1,
              height: 4,
              borderRadius: 2,
              background: segment <= score ? color : token.colorSplit,
              transition: 'background 0.2s',
            }}
          />
        ))}
      </div>

      <Text
        type="secondary"
        style={{ fontSize: 12 }}
        role="status"
        aria-live="polite"
        data-testid={`${idPrefix}-label`}
      >
        {t('security.password.strength.label')}
        {'：'}
        <Text style={{ fontSize: 12, color: level === 'empty' ? undefined : color }}>
          {t(PASSWORD_STRENGTH_LEVELS[level].labelKey)}
        </Text>
        {!checks.length || !checks.uppercase || !checks.digit || !checks.special ? (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {'（'}
            {t('security.password.strength.unmetHint')}
            {'）'}
          </Text>
        ) : null}
      </Text>

      {showChecklist ? (
        <ul
          data-testid={`${idPrefix}-checklist`}
          style={{
            margin: '6px 0 0',
            paddingLeft: 0,
            listStyle: 'none',
            fontSize: 12,
            lineHeight: '18px',
          }}
        >
          {ruleIds.map((ruleId) => {
            const ok = checks[ruleId];
            return (
              <li
                key={ruleId}
                data-testid={`${idPrefix}-rule-${ruleId}`}
                data-ok={ok ? 'true' : 'false'}
                style={{
                  color: ok ? token.colorSuccess : token.colorTextTertiary,
                }}
              >
                <span aria-hidden="true">{ok ? '✓ ' : '✗ '}</span>
                {t(PASSWORD_RULE_LABEL_KEYS[ruleId])}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
