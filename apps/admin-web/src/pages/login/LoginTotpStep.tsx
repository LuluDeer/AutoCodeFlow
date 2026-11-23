import { Form, Input, Button, theme } from 'antd';
import { SafetyOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';

export interface LoginTotpStepProps {
  loading: boolean;
  onVerify: (values: { code: string }) => Promise<boolean>;
  onBackToLogin: () => void;
}

/**
 * SEC-03：登录第二阶段（TOTP 动态验证码）。
 *
 * 从 LoginPage 外提以释放页面体量红线，并补齐：
 * 1) 验证失败后自动清空 6 位动态码输入框（用户可直接重输新码）；
 * 2) 「返回重新登录」出口（切回账号密码第一阶段，防止填错账号卡死在二阶段）；
 * 3) 前缀图标走 token.colorTextTertiary，主按钮走全局 AA 主色。
 */
export default function LoginTotpStep({
  loading,
  onVerify,
  onBackToLogin,
}: LoginTotpStepProps) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const [totpForm] = Form.useForm<{ code: string }>();

  const handleFinish = async (values: { code: string }) => {
    const ok = await onVerify(values);
    if (!ok) {
      totpForm.setFieldValue('code', '');
    }
  };

  return (
    <Form
      form={totpForm}
      layout="vertical"
      onFinish={(values) => void handleFinish(values)}
      size="large"
      aria-labelledby="login-form-title-totp"
    >
      {/* F-11（UIAUDIT P3-4）：TOTP 输入仅数字——后端 totp.dto @Matches(/^\d{6}$/)，
          双保险：① getValueFromEvent 过滤非数字；② pattern 规则对齐 ^\d{6}。 */}
      <Form.Item
        name="code"
        label={t('login.totpCode')}
        rules={[
          { required: true, message: t('login.totpCode.required') },
          { pattern: /^\d{6}$/, message: t('login.totpCode.digits') },
        ]}
        getValueFromEvent={(e: { target: { value: string } }) =>
          e.target.value.replace(/\D/g, '').slice(0, 6)}
      >
        <Input
          prefix={<SafetyOutlined style={{ color: token.colorTextTertiary }} />}
          placeholder={t('login.totpCode.placeholder')}
          autoFocus
          maxLength={6}
          inputMode="numeric"
          autoComplete="one-time-code"
          aria-label={t('login.totpCode.aria')}
        />
      </Form.Item>
      <Form.Item style={{ marginBottom: 0, marginTop: 8 }}>
        <Button
          type="primary"
          htmlType="submit"
          block
          loading={loading}
          style={{
            height: 44,
            borderRadius: 10,
            fontSize: 15,
          }}
        >
          {t('login.verifySubmit')}
        </Button>
      </Form.Item>
      <div style={{ marginTop: 8, textAlign: 'center' }}>
        <Button
          type="link"
          size="small"
          disabled={loading}
          onClick={onBackToLogin}
        >
          {t('login.backToLogin')}
        </Button>
      </div>
    </Form>
  );
}
