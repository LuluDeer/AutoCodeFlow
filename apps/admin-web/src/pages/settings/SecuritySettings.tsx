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

const { Text } = Typography;

/** SEC-03: 把 User-Agent 缩短为可读的浏览器/设备摘要。 */
export function summarizeUserAgent(ua: string | null): string {
  if (!ua) return '未知设备';
  const browser =
    /Edg\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) && /Version\//.test(ua) ? 'Safari'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /curl|axios|node|python|Java/i.test(ua) ? 'API 客户端'
    : '浏览器';
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
      message.error(getErrMsg(err, '获取绑定密钥失败，请稍后重试'));
    },
  });

  const { mutateAsync: doEnable, isPending: enabling } = useMutation({
    mutationFn: () => authApi.totpEnable(code.trim()),
    onSuccess: () => {
      message.success('两步验证已开启');
      setStage('idle');
      setSetup(null);
      setCode('');
      qc.invalidateQueries({ queryKey: ['auth-profile'] });
    },
    // UI-15：动态码错误等失败反馈（常见失败=验证码错误/过期）
    onError: (err: unknown) => {
      message.error(getErrMsg(err, '开启失败，请检查动态码后重试'));
    },
  });

  const { mutateAsync: doDisable, isPending: disabling } = useMutation({
    mutationFn: () => authApi.totpDisable({ password: disablePassword }),
    onSuccess: () => {
      message.success('两步验证已关闭');
      setDisablePassword('');
      qc.invalidateQueries({ queryKey: ['auth-profile'] });
    },
    // UI-15：密码校验失败等反馈
    onError: (err: unknown) => {
      message.error(getErrMsg(err, '关闭失败，请确认登录密码后重试'));
    },
  });

  // totpEnabled 由 GET /auth/profile 返回（AuthUser 增量字段，旧数据 undefined 视为未启用）
  const enabled = (user as { totpEnabled?: boolean } | null)?.totpEnabled === true;

  if (enabled) {
    return (
      <Card title={<Space><SafetyOutlined /> 两步验证（TOTP）</Space>} style={{ marginBottom: 16 }}>
        <Alert
          type="success"
          showIcon
          title="已开启"
          description="登录时除密码外还需输入验证器 6 位动态码。"
          style={{ marginBottom: 16 }}
        />
        <Space orientation="vertical" style={{ width: '100%' }}>
          <Input.Password
            placeholder="输入登录密码以确认关闭"
            value={disablePassword}
            onChange={(e) => setDisablePassword(e.target.value)}
            style={{ width: 320 }}
            aria-label="确认密码"
          />
          <Popconfirm
            title="确认关闭两步验证？"
            description="关闭后登录仅需要密码，安全性降低。"
            okText="关闭"
            okButtonProps={{ danger: true }}
            disabled={!disablePassword}
            onConfirm={() => doDisable()}
          >
            <Tooltip title={disablePassword ? undefined : '先输入登录密码'}>
              <Button danger loading={disabling} disabled={!disablePassword}>
                关闭两步验证
              </Button>
            </Tooltip>
          </Popconfirm>
        </Space>
      </Card>
    );
  }

  return (
    <Card title={<Space><SafetyOutlined /> 两步验证（TOTP）</Space>} style={{ marginBottom: 16 }}>
      <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
        开启后登录需要「密码 + 验证器动态码」双因子。请使用 Google Authenticator、
        Microsoft Authenticator 等任意 TOTP 验证器。
      </Text>
      {stage !== 'staged' ? (
        <Button type="primary" loading={settingUp} onClick={() => doSetup()}>
          开始绑定
        </Button>
      ) : setup ? (
        <Space orientation="vertical" style={{ width: '100%' }} size="middle">
          <Alert
            type="info"
            showIcon
            title="第一步：在验证器中添加密钥"
            description={
              <div style={{ wordBreak: 'break-all' }}>
                <div style={{ marginBottom: 6 }}>扫描不了二维码？将以下 otpauth 链接粘贴到验证器，或手动输入密钥：</div>
                <Text code copyable style={{ fontSize: 12 }}>{setup.otpauthUrl}</Text>
                <div style={{ marginTop: 8 }}>
                  密钥：<Text code copyable style={{ fontSize: 14 }}>{setup.secret}</Text>
                </div>
              </div>
            }
          />
          <Space>
            <Input
              placeholder="输入验证器 6 位动态码"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              style={{ width: 200 }}
              aria-label="动态验证码"
            />
            <Button type="primary" loading={enabling} disabled={code.trim().length !== 6} onClick={async () => {
              // UI-15：rejection 在此消费（onError 已 toast，防 unhandled rejection）
              try {
                await doEnable();
              } catch {
                /* toast 已由 onError 呈现 */
              }
            }}>
              验证并开启
            </Button>
            <Button onClick={() => { setStage('idle'); setSetup(null); setCode(''); }}>取消</Button>
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
  const qc = useQueryClient();
  const { data: sessions, isLoading, refetch, isFetching, error: sessionsError } = useQuery({
    queryKey: ['auth-sessions'],
    queryFn: authApi.listSessions,
  });

  const { mutateAsync: revokeOne } = useMutation({
    mutationFn: (id: number) => authApi.revokeSession(id),
    onSuccess: () => {
      message.success('会话已吊销');
      qc.invalidateQueries({ queryKey: ['auth-sessions'] });
    },
    // UI-15：吊销失败反馈（会话可能已被服务端清理）
    onError: (err: unknown) => {
      message.error(getErrMsg(err, '吊销失败，请刷新后重试'));
    },
  });

  const { mutateAsync: revokeOthers, isPending: revokingOthers } = useMutation({
    mutationFn: authApi.revokeOtherSessions,
    onSuccess: () => {
      message.success('已吊销其他所有会话');
      qc.invalidateQueries({ queryKey: ['auth-sessions'] });
    },
    // UI-15：同上，批量吊销失败同样要有可见反馈
    onError: (err: unknown) => {
      message.error(getErrMsg(err, '批量吊销失败，请刷新后重试'));
    },
  });

  const cols: ColumnsType<AuthSession> = [
    {
      title: '设备', dataIndex: 'userAgent', width: 180,
      render: (v: string | null) => (
        <Space size={6}>
          <DesktopOutlined style={{ color: '#999' }} />
          <span>{summarizeUserAgent(v)}</span>
        </Space>
      ),
    },
    {
      title: 'IP', dataIndex: 'ip', width: 140,
      render: (v: string | null) => v ?? <Text type="secondary">-</Text>,
    },
    {
      title: '登录时间', dataIndex: 'createdAt', width: 170,
      render: (v: string) => (v ? new Date(v).toLocaleString('zh-CN') : '-'),
    },
    {
      title: '当前', dataIndex: 'current', width: 80,
      render: (v: boolean) => (v ? <Tag color="green">当前会话</Tag> : <Tag>其他</Tag>),
    },
    {
      title: '', width: 90,
      render: (_: unknown, row: AuthSession) =>
        row.current ? (
          <Text type="secondary" style={{ fontSize: 12 }}>本机</Text>
        ) : (
          <Popconfirm
            title="确认吊销此会话？"
            description="该设备将被强制退出登录。"
            okText="确认吊销"
            okButtonProps={{ danger: true }}
            onConfirm={async () => {
              try {
                await revokeOne(row.id);
              } catch {
                // UI-15：同 revokeOthers——rejection 已由 onError toast 呈现，防 unhandled rejection。
              }
            }}
          >
            <Button size="small" danger aria-label={`吊销会话 ${row.id}`}>吊销</Button>
          </Popconfirm>
        ),
    },
  ];

  const others = (sessions ?? []).filter((s) => !s.current).length;

  return (
    <Card
      title={<Space><UserOutlined /> 登录设备与会话</Space>}
      extra={
        <Space>
          <Button icon={<ReloadOutlined />} size="small" loading={isFetching} onClick={() => refetch()}>刷新</Button>
          <Popconfirm
            title="吊销其他全部会话？"
            description="除当前设备外，其余所有登录将被强制退出。"
            okText="吊销其他"
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
              吊销其他全部（{others}）
            </Button>
          </Popconfirm>
        </Space>
      }
    >
      {sessionsError ? (
        // UI-16：会话读请求失败 → 页内错误块（重试=refetch），不落「暂无活跃会话」误导空态
        <StateError
          error={sessionsError}
          title="登录会话加载失败"
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
          locale={{ emptyText: '暂无活跃会话' }}
        />
      )}
      <Descriptions column={1} size="small" style={{ marginTop: 12 }}>
        <Descriptions.Item label="说明">
          吊销后对应设备的刷新令牌立即失效（下次请求被要求重新登录）。
        </Descriptions.Item>
      </Descriptions>
    </Card>
  );
}

/** 安全设置 Tab 主体（挂载进既有系统设置页 Tabs）。 */
export default function SecuritySettings() {
  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <Text type="secondary">管理账号的两步验证与登录会话（所有用户可用，仅涉及本人账号）</Text>
      </div>
      <TotpCard />
      <SessionsCard />
    </div>
  );
}
