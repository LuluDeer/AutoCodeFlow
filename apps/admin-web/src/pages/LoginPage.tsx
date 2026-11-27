import { Form, Input, Button, Typography, Card, Alert, theme } from 'antd';
import type { InputRef } from 'antd';
import { message } from '../utils/toast';
import { UserOutlined, LockOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { authApi } from '../api/auth';
// AUTH-04：SSO 整页跳转需与 axios client 同源 base（不走 client 实例）
import { getApiBaseUrl } from '../api/client';
import { useAuthStore, type AuthUser } from '../store/auth';
import { homePathForRole } from '../routes/route-registry';
import { getErrMsg } from '../utils/error';
// UX-AUDIT：SSO 可用性探测（含失败提示/重试）外提为 hook，守住本函数体行数天花板。
import { useSsoStatus } from '../hooks/useSsoStatus';
// UI-10：导入 i18n 实例（模块副作用完成初始化；树内用 useTranslation 读 key）
import '../i18n';
// SEC-03：TOTP 第二步表单外提为独立子组件（含验证失败清码 + 返回重新登录出口）
import LoginTotpStep from './login/LoginTotpStep';
// BRAND（2026-11-02）：登录页的品牌位用狐狸（产品形象），不再用绿方块 + 闪电。
import BrandFox from '../components/BrandFox';
// D-P2-16（设计审计）：品牌渐变唯一事实源——与 MainLayout 用户头像同源，
// 登录页品牌位从此只消费 token，不再内联渐变字面量。
import { BRAND_GRADIENT } from '../theme/tokens';
// P1-9：页脚版本号由构建期注入（单一事实源 version.txt），见 src/version.ts。
import { APP_VERSION } from '../version';

const { Title, Text } = Typography;

export default function LoginPage() {
  const nav = useNavigate();
  // UI-10：文案走 i18n key，中英切换即时生效（示范页；全站逐步迁移）
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const { setAuth } = useAuthStore();
  const [loading, setLoading] = useState(false);
  // SEC-03: TOTP 第二步状态——登录第一段返回 totpRequired 后进入动态码输入
  const [totpStage, setTotpStage] = useState(false);
  const [credentials, setCredentials] = useState({ username: '', password: '' });
  // UI-12：登录/验证失败的页内错误块（role=alert）。此前失败只有一闪而过的
  // toast——读屏用户看不到、低视力用户来不及读；页内常驻块可被重复阅读，
  // 并在出现时接管焦点，键盘用户不必自行搜索「到底哪错了」。
  const [formError, setFormError] = useState<string | null>(null);
  // SESSION-EXPIRED：client.ts 在 401（刷新也失败）时跳 /login?reason=expired。
  // 初始值即从 URL 读取，故首帧就能看到说明，不会闪一下才出现。
  // 仅认站内受控值 'expired'，其他一律忽略（与 ?redirect= 同款白名单姿态）。
  const [sessionExpired, setSessionExpired] = useState(
    () => new URLSearchParams(window.location.search).get('reason') === 'expired',
  );
  // AUTH-04：SSO 可用性（失败给 toast + 重试，见 hooks/useSsoStatus）。
  const { enabled: ssoEnabled, checkFailed: ssoCheckFailed, retry: retrySsoCheck } = useSsoStatus();
  const errorRef = useRef<HTMLDivElement>(null);
  // P3-3（2026-10-26 审计）：登录失败后清空并聚焦密码框所需——受控清空走
  // Form 实例，聚焦走 InputRef（antd Input.Password ref 即 InputRef 形态）。
  const [form] = Form.useForm<{ username: string; password: string }>();
  const passwordRef = useRef<InputRef>(null);
  useEffect(() => {
    if (!formError) return;
    // P3-3：登录段失败改由 handleLogin catch 聚焦**已清空的密码框**（用户
    // 直接重输），错误内容仍由 role=alert 即时播报，errorRef 不再抢焦点。
    // TOTP 段保持既有「错误块接管焦点」行为（动态码框无清空重填语义变更）。
    if (!totpStage) return;
    errorRef.current?.focus();
  }, [formError, totpStage]);
  const completeLogin = (res: { accessToken?: string; refreshToken?: string; user?: AuthUser }) => {
    if (!res.accessToken || !res.refreshToken) {
      message.error(t('login.credentialsMissing'));
      return;
    }
    setAuth(res.accessToken, res.refreshToken, res.user ?? { id: 0, username: credentials.username });
    // 401 登出跳转带 ?redirect=（仅接受站内路径，防开放重定向）——优先回跳原页面；
    // 无 redirect 且 role 已确定时直接按 homePathForRole 落到角色首页；
    // role 未随登录响应返回时先回壳层索引路由，由 MainLayout 拉 /auth/profile，
    // 再由 RoleHomeRedirect 在 role 落定后决定首页，避免把 ADMIN 首帧送进 /workbench。
    const redirect = new URLSearchParams(window.location.search).get('redirect');
    const roleHome = res.user?.role ? homePathForRole(res.user.role) : '/';
    nav(redirect && redirect.startsWith('/') && !redirect.startsWith('//') ? redirect : roleHome, { replace: true });
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
      setFormError(getErrMsg(err, t('login.badCredentials')));
      // P3-3：失败后清空密码框并聚焦（用户名保留）——错误密码不再留在输入框
      // 里，用户落点即重输位置；错误内容由上方 role=alert 块承载。
      form.setFieldValue('password', '');
      passwordRef.current?.focus();
    } finally {
      setLoading(false);
    }
  };

  const handleTotpVerify = async (values: { code: string }): Promise<boolean> => {
    setLoading(true);
    try {
      const res = await authApi.verifyLogin({ ...credentials, code: values.code });
      setFormError(null);
      completeLogin(res);
      return true;
    } catch (err: unknown) {
      // UI-12：同上——动态码错误也落到页内 role=alert 块，并返回 false 触发子组件清码
      setFormError(getErrMsg(err, t('login.totpCode.invalid')));
      return false;
    } finally {
      setLoading(false);
    }
  };

  return (
    <div role="main"
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        // UX-02（本轮体验审查）：此前硬编码亮色渐变 #f0f4ff→#f5f0ff，暗色模式
        // 下退出登录/会话过期跳回登录页时，整页是刺眼浅蓝紫，与全站暗色壳层
        // 割裂（登录页在 ThemedProviders 内，Card 容器已取暗面 #1A1E2F）。
        // 改用主题感知变量，两套主题各得其所。
        background: 'var(--color-background)',
        padding: '24px 16px',
      }}
    >
      <div style={{ width: '100%', maxWidth: 400 }}>
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          {/* BRAND（2026-11-02）：品牌位从「绿渐变方块 + 闪电」换成**狐狸**。
              登录页是狐狸的「主场」——品牌文档 §4 把形象分两层：狐狸负责产品形象
              （人看得见的地方），六边形 + 箭头负责状态语汇（托盘/状态）。此前这里
              的闪电既不表达产品，也不在品牌色板里有出处。
              为什么是 96 而不是 56：这一屏没有别的图片，56px 的狐狸在 400px 宽的
              卡片上方读起来像一枚小徽章；96px 才让人一眼认出它是一只狐狸（品牌
              文档给的尺寸下限是 32，96 是「页面级形象位」的起档）。 */}
          <BrandFox
            size={96}
            style={{ margin: '0 auto' }}
          />
          {/* UX-02 / D-P2-16：品牌位强调条与 MainLayout 用户头像同源于
              theme/tokens.ts 的 BRAND_GRADIENT——改品牌色只改 token 一处，
              本页不再内联渐变字面量。纯装饰，不进无障碍树。 */}
          <div
            aria-hidden="true"
            style={{
              width: 48,
              height: 3,
              margin: '8px auto 12px',
              borderRadius: 2,
              background: BRAND_GRADIENT,
            }}
          />
          {/* LIGHTHOUSE-HEADING（本轮）：此前品牌名 h3、表单标题 h5，页内
              没有任何 h1/h2——Lighthouse heading-order 判定为跳级（h3→h5，
              score 0，属真实 a11y 缺陷而非噪声）。品牌名改为 h1（页面级
              主标题的正当归属），表单标题改 h2（区块标题，紧随其后）。 */}
          <Title level={1} style={{ margin: 0, fontSize: 'clamp(20px, 5vw, 24px)' }}>AutoCodeFlow</Title>
          <Text type="secondary">{t('brand.tagline')}</Text>
        </div>

        <Card
          style={{
            borderRadius: 16,
            boxShadow: '0 4px 24px rgba(0,0,0,0.08)',
            border: `1px solid ${token.colorBorderSecondary}`,
          }}
          styles={{ body: { padding: 'clamp(20px, 5vw, 32px)' } }}
        >
          {/* UI-12：表单标题与 Form 建立 aria-labelledby 关联——读屏进入表单时
              先播报「登录账号/两步验证」，而不是孤立的一串输入框 */}
          <Title
            level={2}
            id={totpStage ? 'login-form-title-totp' : 'login-form-title'}
            // UX-02：此前硬编码 color: '#333'——暗色卡面 #1A1E2F 上对比度仅
            // 1.31:1，标题「登录账号」几乎看不见。去掉该属性让 antd 的
            // colorText token 生效（随主题翻转）。
            style={{
              margin: '0 0 24px',
              // 语义层级（h2）与视觉层级解耦：h5→h2 会让 antd 默认字号从
              // 14px 跳到 30px，撑破卡片排版。字号锁在原 h5 观感（16px），
              // 读屏拿到正确层级，肉眼观感零变化。
              fontSize: 16,
            }}
          >
            {totpStage ? t('login.twoFactor') : t('login.account')}
          </Title>
          {/* SESSION-EXPIRED（本轮审计）：401 且刷新失败时 client.ts 会把用户
              直接重定向到 /login 并带 ?reason=expired。此前该跳转零提示
              （拦截器显式跳过 401 的 toast），用户正在填的表单凭空消失、
              无从判断是会话过期还是系统故障。这里用常驻 info 块说明原因，
              与下方 error 块同属「可重复阅读、不依赖一闪而过的 toast」形态。 */}
          {sessionExpired && (
            <Alert
              type="info"
              showIcon
              title={t('login.sessionExpired')}
              closable
              onClose={() => setSessionExpired(false)}
              style={{ marginBottom: 16 }}
            />
          )}
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
            // SEC-03：两步验证阶段（TOTP 动态码表单外提至 pages/login/LoginTotpStep.tsx）。
            //
            // 设计要点：
            // 1. 保持 aria-labelledby="login-form-title-totp" 与卡片 h2 标题关联；
            // 2. 输入框仅保留 0-9 六位数字（getValueFromEvent + pattern 双保险）；
            // 3. 验证失败时由 handleTotpVerify 返回 false，子组件自动清空动态码输入框，
            //    同时由页内 role=alert 错误块承接后端提示并接管焦点；
            // 4. 提供「返回重新登录」（login.backToLogin）按钮，允许用户在填错账号时
            //    退回第一阶段重新输入用户名与密码，并同步清空残留错误提示。
            // 5. 前缀图标色统一走 token.colorTextTertiary，主按钮走全局 AA 主按钮色。
            //
            // 为什么保留此段契约说明：
            // 1) 登录页的两段式焦点流转（密码框聚焦 vs TOTP 错误块聚焦）是 a11y-login-page
            //    与 login-totp 两组单测的核心回归面；
            // 2) 外提子组件只负责第二阶段表单与清码，阶段状态（totpStage/credentials/formError）
            //    仍收口在本页单一真值源；
            // 3) 第一阶段（账号密码）与第二阶段（动态验证码）共享同一处页内 role=alert
            //    错误块（errorRef），从而避免两套错误提示容器在切换阶段时产生焦点竞争；
            // 4) 点击「返回重新登录」后，totpStage 归位为 false、formError 清空，
            //    第一阶段 Form 重新挂载并聚焦用户名输入框，恢复完整键盘流转。
            <LoginTotpStep
              loading={loading}
              onVerify={handleTotpVerify}
              onBackToLogin={() => {
                setTotpStage(false);
                setFormError(null);
              }}
            />
          ) : (
          <Form
            layout="vertical"
            form={form}
            onFinish={handleLogin}
            size="large"
            aria-labelledby="login-form-title"
          >
            <Form.Item
              name="username"
              label={t('login.username')}
              rules={[{ required: true, message: t('login.username.required') }]}
            >
              <Input
                prefix={<UserOutlined style={{ color: token.colorTextTertiary }} />}
                placeholder={t('login.username.placeholder')}
                autoFocus
                autoComplete="username"
                aria-label={t('login.username.aria')}
              />
            </Form.Item>

            <Form.Item
              name="password"
              label={t('login.password')}
              rules={[{ required: true, message: t('login.password.required') }]}
            >
              <Input.Password
                ref={passwordRef}
                prefix={<LockOutlined style={{ color: token.colorTextTertiary }} />}
                placeholder={t('login.password.placeholder')}
                autoComplete="current-password"
                aria-label={t('login.password.aria')}
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
                {t('login.submit')}
              </Button>
            </Form.Item>
          </Form>
          )}

          {/* AUTH-04：SSO 入口——仅后端启用 OIDC 且非 TOTP 第二步时展示。
              整页跳转（非 axios）：回调是 302 链，token 经 #fragment 回传 */}
          {!totpStage && ssoEnabled && (
            <div style={{ marginTop: 16 }}>
              <Button
                block
                data-testid="login-sso"
                style={{ height: 44, borderRadius: 10, fontSize: 15 }}
                onClick={() => {
                  window.location.href = `${getApiBaseUrl()}/auth/oidc/login`;
                }}
              >
                {t('login.sso')}
              </Button>
            </div>
          )}
          {!totpStage && ssoCheckFailed && (
            <div style={{ marginTop: 8, textAlign: 'center' }}>
              <Button type="link" size="small" data-testid="login-sso-retry" onClick={retrySsoCheck}>
                {t('login.ssoRetry')}
              </Button>
            </div>
          )}

          <div style={{ marginTop: 20, textAlign: 'center' }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {totpStage ? t('login.totpHint') : t('login.forgotHint')}
            </Text>
          </div>
        </Card>

        <div style={{ textAlign: 'center', marginTop: 24 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {APP_VERSION
              ? `AutoCodeFlow v${APP_VERSION} · ${t('brand.edition')}`
              : `AutoCodeFlow · ${t('brand.edition')}`}
          </Text>
        </div>
      </div>
    </div>
  );
}
