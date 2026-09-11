import { Form, Input, Button, Typography, Card, Alert, message } from 'antd';
import { UserOutlined, LockOutlined, ThunderboltOutlined, SafetyOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import { authApi } from '../api/auth';
import { useAuthStore, type AuthUser } from '../store/auth';
import { getErrMsg } from '../utils/error';

const { Title, Text } = Typography;

export default function LoginPage() {
  const nav = useNavigate();
  const { setAuth } = useAuthStore();
  const [loading, setLoading] = useState(false);
  // SEC-03: TOTP 第二步状态——登录第一段返回 totpRequired 后进入动态码输入
  const [totpStage, setTotpStage] = useState(false);
  const [credentials, setCredentials] = useState({ username: '', password: '' });
  // UI-12：登录/验证失败的页内错误块（role=alert）。此前失败只有一闪而过的
  // toast——读屏用户看不到、低视力用户来不及读；页内常驻块可被重复阅读，
  // 并在出现时接管焦点，键盘用户不必自行搜索「到底哪错了」。
  const [formError, setFormError] = useState<string | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (formError) errorRef.current?.focus();
  }, [formError]);

  const completeLogin = (res: { accessToken?: string; refreshToken?: string; user?: AuthUser }) => {
    if (!res.accessToken || !res.refreshToken) {
      message.error('登录响应缺少凭据');
      return;
    }
    setAuth(res.accessToken, res.refreshToken, res.user ?? { id: 0, username: credentials.username });
    // 401 登出跳转带 ?redirect=（仅接受站内路径，防开放重定向）——优先回跳原页面
    const redirect = new URLSearchParams(window.location.search).get('redirect');
    nav(redirect && redirect.startsWith('/') && !redirect.startsWith('//') ? redirect : '/dashboard', { replace: true });
  };

  const handleLogin = async (values: { username: string; password: string }) => {
    setLoading(true);
    try {
      const res = await authApi.login(values);
      // SEC-03 契约：200 + { totpRequired: true } —— 第二步收集动态码；
      // 未启用 TOTP 用户路径零变化。
      if (res.totpRequired) {
        setCredentials({ username: values.username, password: values.password });
        setFormError(null);
        setTotpStage(true);
        return;
      }
      setFormError(null);
      completeLogin(res);
    } catch (err: unknown) {
      // UI-12：错误落到页内 role=alert 块（替代瞬时 toast）
      setFormError(getErrMsg(err, '用户名或密码错误'));
    } finally {
      setLoading(false);
    }
  };

  const handleTotpVerify = async (values: { code: string }) => {
    setLoading(true);
    try {
      const res = await authApi.verifyLogin({ ...credentials, code: values.code });
      setFormError(null);
      completeLogin(res);
    } catch (err: unknown) {
      // UI-12：同上——动态码错误也落到页内 role=alert 块
      setFormError(getErrMsg(err, '动态验证码错误'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(135deg, #f0f4ff 0%, #f5f0ff 100%)',
        padding: '24px 16px',
      }}
    >
      <div style={{ width: '100%', maxWidth: 400 }}>
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 16,
              background: 'linear-gradient(135deg, #1677ff 0%, #7c3aed 100%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 16px',
              boxShadow: '0 8px 24px rgba(22,119,255,0.3)',
            }}
          >
            <ThunderboltOutlined style={{ fontSize: 24, color: '#fff' }} />
          </div>
          <Title level={3} style={{ margin: 0, fontSize: 'clamp(20px, 5vw, 24px)' }}>AutoCodeFlow</Title>
          <Text type="secondary">企业级任务调度平台</Text>
        </div>

        <Card
          style={{
            borderRadius: 16,
            boxShadow: '0 4px 24px rgba(0,0,0,0.08)',
            border: 'none',
          }}
          styles={{ body: { padding: 'clamp(20px, 5vw, 32px)' } }}
        >
          {/* UI-12：表单标题与 Form 建立 aria-labelledby 关联——读屏进入表单时
              先播报「登录账号/两步验证」，而不是孤立的一串输入框 */}
          <Title
            level={5}
            id={totpStage ? 'login-form-title-totp' : 'login-form-title'}
            style={{ margin: '0 0 24px', color: '#333' }}
          >
            {totpStage ? '两步验证' : '登录账号'}
          </Title>
          {/* UI-12：登录失败常驻错误块（role=alert 由 antd Alert 提供）。
              外层 tabIndex=-1 使其可编程聚焦但不进 Tab 序列，失败时接管焦点。 */}
          <div ref={errorRef} tabIndex={-1} style={{ outline: 'none' }}>
            {formError && (
              <Alert
                type="error"
                showIcon
                title={formError}
                closable
                onClose={() => setFormError(null)}
                style={{ marginBottom: 16 }}
              />
            )}
          </div>
          {totpStage ? (
            <Form
              layout="vertical"
              onFinish={handleTotpVerify}
              size="large"
              aria-labelledby="login-form-title-totp"
            >
              <Form.Item name="code" label="动态验证码" rules={[{ required: true, message: '请输入 6 位动态验证码' }]}>
                <Input
                  prefix={<SafetyOutlined style={{ color: '#ccc' }} />}
                  placeholder="6 位动态码"
                  autoFocus
                  maxLength={6}
                  inputMode="numeric"
                  aria-label="动态验证码"
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
                    background: 'linear-gradient(135deg, #1677ff, #7c3aed)',
                    border: 'none',
                    fontSize: 15,
                  }}
                >
                  验证并登录
                </Button>
              </Form.Item>
            </Form>
          ) : (
          <Form
            layout="vertical"
            onFinish={handleLogin}
            size="large"
            aria-labelledby="login-form-title"
          >
            <Form.Item
              name="username"
              label="用户名"
              rules={[{ required: true, message: '请输入用户名' }]}
            >
              <Input
                prefix={<UserOutlined style={{ color: '#ccc' }} />}
                placeholder="admin"
                autoFocus
                autoComplete="username"
                aria-label="用户名"
              />
            </Form.Item>

            <Form.Item
              name="password"
              label="密码"
              rules={[{ required: true, message: '请输入密码' }]}
            >
              <Input.Password
                prefix={<LockOutlined style={{ color: '#ccc' }} />}
                placeholder="密码"
                autoComplete="current-password"
                aria-label="密码"
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
                  background: 'linear-gradient(135deg, #1677ff, #7c3aed)',
                  border: 'none',
                  fontSize: 15,
                }}
              >
                登录
              </Button>
            </Form.Item>
          </Form>
          )}

          <div style={{ marginTop: 20, textAlign: 'center' }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {totpStage ? '请打开验证器应用获取动态码' : '如忘记密码请联系管理员重置'}
            </Text>
          </div>
        </Card>

        <div style={{ textAlign: 'center', marginTop: 24 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>AutoCodeFlow v1.0 · 企业版</Text>
        </div>
      </div>
    </div>
  );
}
