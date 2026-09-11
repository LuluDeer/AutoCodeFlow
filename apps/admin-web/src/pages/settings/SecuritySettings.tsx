import { useState } from 'react';
import {
  Card, Button, Input, Space, Tag, Table, Alert, Typography, Popconfirm,
  Descriptions, message, Tooltip,
} from 'antd';
import {
  SafetyOutlined, UserOutlined, DesktopOutlined, ReloadOutlined,
} from '@ant-design/icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { ColumnsType } from 'antd/es/table';
import { authApi, AuthSession } from '../../api/auth';
import { getErrMsg } from '../../utils/error';
import StateError from '../../components/StateError';
import { useAuthStore } from '../../store/auth';
import { useTranslation } from 'react-i18next';
// UI-10：导入 i18n 实例（模块副作用完成初始化；树内用 useTranslation 读 key）
import '../../i18n';

const { Text } = Typography;

/** SEC-03: 把 User-Agent 缩短为可读的浏览器/设备摘要。
 *  t 可选：传参时走 i18n key（会话列表传 t）；缺省保持中文基线
 * （security-settings.test.tsx 锚定 summarizeUserAgent('curl…')==='API 客户端'）。 */
export function summarizeUserAgent(ua: string | null, t?: (k: string) => string): string {
  if (!ua) return t ? t('security.device.unknown') : '未知设备';
  const browser =
    /Edg\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) && /Version\//.test(ua) ? 'Safari'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /curl|axios|node|python|Java/i.test(ua) ? (t ? t('security.device.api') : 'API 客户端')
    : (t ? t('security.device.browser') : '浏览器');
  const os =
    /Windows/i.test(ua) ? 'Windows'
    : /Android/i.test(ua) ? 'Android'
    : /iPhone|iPad|iOS/i.test(ua) ? 'iOS'
    : /Mac OS X|Macintosh/i.test(ua) ? 'macOS'
    : /Linux/i.test(ua) ? 'Linux'
    : '';
  return os ? `${browser} · ${os}` : browser;
}

/**
 * SEC-03: TOTP 两步验证绑定卡。
 * 流程：开始绑定（setup 得到 secret + otpauth URL）→ 验证器扫码/手输 →
 * 输入一次动态码 enable 激活。admin-web 无既有 qrcode 依赖，按任务纪律
 * 不新增依赖——展示 otpauth URL 全文 + secret 供验证器手动录入。
 */
export function TotpCard() {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  const [stage, setStage] = useState<'idle' | 'staged'>('idle');
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [disablePassword, setDisablePassword] = useState('');

  const { mutateAsync: doSetup, isPending: settingUp } = useMutation({
    mutationFn: authApi.totpSetup,
    onSuccess: (res) => {
      setSetup(res);
      setStage('staged');
    },
    // UI-15：绑定起点失败不能静默（按钮 loading 复位后界面无任何反馈）
    onError: (err: unknown) => {
      message.error(getErrMsg(err, t('security.totp.setupFail')));
    },
  });

  const { mutateAsync: doEnable, isPending: enabling } = useMutation({
    mutationFn: () => authApi.totpEnable(code.trim()),
    onSuccess: () => {
      message.success(t('security.totp.enabled'));
      setStage('idle');
      setSetup(null);
      setCode('');
      qc.invalidateQueries({ queryKey: ['auth-profile'] });
    },
    // UI-15：动态码错误等失败反馈（常见失败=验证码错误/过期）
    onError: (err: unknown) => {
      message.error(getErrMsg(err, t('security.totp.enableFail')));
    },
  });

  const { mutateAsync: doDisable, isPending: disabling } = useMutation({
    mutationFn: () => authApi.totpDisable({ password: disablePassword }),
    onSuccess: () => {
      message.success(t('security.totp.disabled'));
      setDisablePassword('');
      qc.invalidateQueries({ queryKey: ['auth-profile'] });
    },
    // UI-15：密码校验失败等反馈
    onError: (err: unknown) => {
      message.error(getErrMsg(err, t('security.totp.disableFail')));
    },
  });

  // totpEnabled 由 GET /auth/profile 返回（AuthUser 增量字段，旧数据 undefined 视为未启用）
  const enabled = (user as { totpEnabled?: boolean } | null)?.totpEnabled === true;

  if (enabled) {
    return (
      <Card title={<Space><SafetyOutlined /> {t('security.totp.title')}</Space>} style={{ marginBottom: 16 }}>
        <Alert
          type="success"
          showIcon
          title={t('security.totp.alertEnabled')}
          description={t('security.totp.alertEnabledDesc')}
          style={{ marginBottom: 16 }}
        />
        <Space orientation="vertical" style={{ width: '100%' }}>
          <Input.Password
            placeholder={t('security.totp.disablePlaceholder')}
            value={disablePassword}
            onChange={(e) => setDisablePassword(e.target.value)}
            style={{ width: 320 }}
            aria-label={t('security.totp.passwordLabel')}
          />
          <Popconfirm
            title={t('security.totp.disableConfirm')}
            description={t('security.totp.disableConfirmDesc')}
            okText={t('security.totp.disableOk')}
            okButtonProps={{ danger: true }}
            disabled={!disablePassword}
            onConfirm={() => doDisable()}
          >
            <Tooltip title={disablePassword ? undefined : t('security.totp.disableTooltip')}>
              <Button danger loading={disabling} disabled={!disablePassword}>
                {t('security.totp.disable')}
              </Button>
            </Tooltip>
          </Popconfirm>
        </Space>
      </Card>
    );
  }

  return (
    <Card title={<Space><SafetyOutlined /> {t('security.totp.title')}</Space>} style={{ marginBottom: 16 }}>
      <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
        {t('security.totp.intro')}
      </Text>
      {stage !== 'staged' ? (
        <Button type="primary" loading={settingUp} onClick={() => doSetup()}>
          {t('security.totp.startBind')}
        </Button>
      ) : setup ? (
        <Space orientation="vertical" style={{ width: '100%' }} size="middle">
          <Alert
            type="info"
            showIcon
            title={t('security.totp.step1')}
            description={
              <div style={{ wordBreak: 'break-all' }}>
                <div style={{ marginBottom: 6 }}>{t('security.totp.step1Hint')}</div>
                <Text code copyable style={{ fontSize: 12 }}>{setup.otpauthUrl}</Text>
                <div style={{ marginTop: 8 }}>
                  {t('security.totp.secretLabel')}<Text code copyable style={{ fontSize: 14 }}>{setup.secret}</Text>
                </div>
              </div>
            }
          />
          <Space>
            <Input
              placeholder={t('security.totp.codePlaceholder')}
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              style={{ width: 200 }}
              aria-label={t('security.totp.codeLabel')}
            />
            <Button type="primary" loading={enabling} disabled={code.trim().length !== 6} onClick={async () => {
              // UI-15：rejection 在此消费（onError 已 toast，防 unhandled rejection）
              try {
                await doEnable();
              } catch {
                /* toast 已由 onError 呈现 */
              }
            }}>
              {t('security.totp.verifyEnable')}
            </Button>
            <Button onClick={() => { setStage('idle'); setSetup(null); setCode(''); }}>{t('security.totp.cancel')}</Button>
          </Space>
        </Space>
      ) : null}
    </Card>
  );
}

/**
 * SEC-03: 会话列表（refresh token 吊销 UI 面，DR-04 撤销语义）。
 * 展示当前登录用户所有活跃会话，可吊销单条或一键吊销其他全部。
 */
export function SessionsCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: sessions, isLoading, refetch, isFetching, error: sessionsError } = useQuery({
    queryKey: ['auth-sessions'],
    queryFn: authApi.listSessions,
  });

  const { mutateAsync: revokeOne } = useMutation({
    mutationFn: (id: number) => authApi.revokeSession(id),
    onSuccess: () => {
      message.success(t('security.session.revoked'));
      qc.invalidateQueries({ queryKey: ['auth-sessions'] });
    },
    // UI-15：吊销失败反馈（会话可能已被服务端清理）
    onError: (err: unknown) => {
      message.error(getErrMsg(err, t('security.session.revokeFail')));
    },
  });

  const { mutateAsync: revokeOthers, isPending: revokingOthers } = useMutation({
    mutationFn: authApi.revokeOtherSessions,
    onSuccess: () => {
      message.success(t('security.session.othersRevoked'));
      qc.invalidateQueries({ queryKey: ['auth-sessions'] });
    },
    // UI-15：同上，批量吊销失败同样要有可见反馈
    onError: (err: unknown) => {
      message.error(getErrMsg(err, t('security.session.revokeOthersFail')));
    },
  });

  const cols: ColumnsType<AuthSession> = [
    {
      title: t('security.session.col.device'), dataIndex: 'userAgent', width: 180,
      render: (v: string | null) => (
        <Space size={6}>
          <DesktopOutlined style={{ color: '#999' }} />
          <span>{summarizeUserAgent(v, t)}</span>
        </Space>
      ),
    },
    {
      title: 'IP', dataIndex: 'ip', width: 140,
      render: (v: string | null) => v ?? <Text type="secondary">-</Text>,
    },
    {
      title: t('security.session.col.loginTime'), dataIndex: 'createdAt', width: 170,
      render: (v: string) => (v ? new Date(v).toLocaleString('zh-CN') : '-'),
    },
    {
      title: t('security.session.col.current'), dataIndex: 'current', width: 80,
      render: (v: boolean) => (v ? <Tag color="green">{t('security.session.currentTag')}</Tag> : <Tag>{t('security.session.otherTag')}</Tag>),
    },
    {
      title: '', width: 90,
      render: (_: unknown, row: AuthSession) =>
        row.current ? (
          <Text type="secondary" style={{ fontSize: 12 }}>{t('security.session.local')}</Text>
        ) : (
          <Popconfirm
            title={t('security.session.revokeConfirm')}
            description={t('security.session.revokeConfirmDesc')}
            okText={t('security.session.revokeOk')}
            okButtonProps={{ danger: true }}
            onConfirm={async () => {
              try {
                await revokeOne(row.id);
              } catch {
                // UI-15：同 revokeOthers——rejection 已由 onError toast 呈现，防 unhandled rejection。
              }
            }}
          >
            <Button size="small" danger aria-label={t('security.session.revokeAria', { id: row.id })}>{t('security.session.revoke')}</Button>
          </Popconfirm>
        ),
    },
  ];

  const others = (sessions ?? []).filter((s) => !s.current).length;

  return (
    <Card
      title={<Space><UserOutlined /> {t('security.session.title')}</Space>}
      extra={
        <Space>
          <Button icon={<ReloadOutlined />} size="small" loading={isFetching} onClick={() => refetch()}>{t('security.session.refresh')}</Button>
          <Popconfirm
            title={t('security.session.revokeOthersConfirm')}
            description={t('security.session.revokeOthersConfirmDesc')}
            okText={t('security.session.revokeOthersOk')}
            okButtonProps={{ danger: true }}
            disabled={others === 0}
            onConfirm={async () => {
              try {
                await revokeOthers();
              } catch {
                // UI-15：Popconfirm onConfirm 返回 Promise 会被 rc 确认弹层 await，
                // rejection 已由上方 onError toast 呈现，这里吞掉防 unhandled rejection。
              }
            }}
          >
            <Button size="small" danger disabled={others === 0} loading={revokingOthers}>
              {t('security.session.revokeOthersAll', { count: others })}
            </Button>
          </Popconfirm>
        </Space>
      }
    >
      {sessionsError ? (
        // UI-16：会话读请求失败 → 页内错误块（重试=refetch），不落「暂无活跃会话」误导空态
        <StateError
          error={sessionsError}
          title={t('security.session.loadFail')}
          onRetry={() => { void refetch(); }}
        />
      ) : (
        <Table
          loading={isLoading}
          dataSource={sessions ?? []}
          rowKey="id"
          columns={cols}
          size="small"
          pagination={false}
          locale={{ emptyText: t('security.session.empty') }}
        />
      )}
      <Descriptions column={1} size="small" style={{ marginTop: 12 }}>
        <Descriptions.Item label={t('security.session.noteLabel')}>
          {t('security.session.noteDesc')}
        </Descriptions.Item>
      </Descriptions>
    </Card>
  );
}

/** 安全设置 Tab 主体（挂载进既有系统设置页 Tabs）。 */
export default function SecuritySettings() {
  const { t } = useTranslation();
  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <Text type="secondary">{t('security.title')}</Text>
      </div>
      <TotpCard />
      <SessionsCard />
    </div>
  );
}
