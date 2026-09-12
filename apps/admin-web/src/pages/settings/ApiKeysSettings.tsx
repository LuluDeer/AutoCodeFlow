import { useState } from 'react';
import {
  Card, Table, Button, Space, Tag, Modal, Form, Input, Select, InputNumber,
  Typography, Alert, Popconfirm, message,
} from 'antd';
import {
  PlusOutlined, CopyOutlined, ApiOutlined, WarningOutlined,
} from '@ant-design/icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiKeysApi, ApiKeyView, ApiKeyScope, ApiKeyCreateResult } from '../../api/api-keys';
import { getErrMsg } from '../../utils/error';
import { useTranslation } from 'react-i18next';
// UI-10：导入 i18n 实例（模块副作用完成初始化；树内用 useTranslation 读 key）
import '../../i18n';
import StateError from '../../components/StateError';
import type { ColumnsType } from 'antd/es/table';

const { Text, Paragraph } = Typography;

/**
 * AUTH-03: 设置区「API Keys」Tab——限权 API Key 管理（CI/CD 机器认证）。
 * 列表（name/prefix/scope/过期/最后使用/状态）+ 创建 Modal（创建成功弹
 * 一次性明文 key + 复制按钮 + 「仅显示一次」警示）+ 吊销（Popconfirm）。
 * 全部操作走 JWT（/api-keys 是 JWT-only 面，API Key 不能自管）。
 */

const SCOPE_LABELS = (t: (k: string) => string): Record<ApiKeyScope, string> => ({
  readonly: t('apiKeys.scope.readonly'),
  trigger: t('apiKeys.scope.trigger'),
  manage: t('apiKeys.scope.manage'),
});

const SCOPE_COLOR: Record<ApiKeyScope, string> = {
  readonly: 'blue',
  trigger: 'green',
  manage: 'orange',
};

/** 状态列纯函数（导出供测试）：吊销 > 过期 > 正常。 */
export function apiKeyStatus(
  key: ApiKeyView,
  t: (k: string) => string = (k) => k,
): { label: string; color: string } {
  if (key.revokedAt) return { label: t('apiKeys.status.revoked'), color: 'red' };
  if (key.expiresAt && new Date(key.expiresAt).getTime() <= Date.now()) {
    return { label: t('apiKeys.status.expired'), color: 'default' };
  }
  return { label: t('apiKeys.status.active'), color: 'green' };
}

function formatDateTime(v: string | null): string {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

function CreateResultModal(props: {
  result: ApiKeyCreateResult | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  if (!props.result) return null;
  return (
    <Modal
      open
      title={t('apiKeys.result.title')}
      okText={t('apiKeys.result.savedOk')}
      cancelText={t('apiKeys.result.close')}
      onOk={props.onClose}
      onCancel={props.onClose}
      footer={[
        <Button key="copy" icon={<CopyOutlined />} onClick={() => {
          navigator.clipboard?.writeText(props.result!.plaintext);
          setCopied(true);
        }}>
          {copied ? t('apiKeys.result.copied') : t('apiKeys.result.copyKey')}
        </Button>,
        <Button key="ok" type="primary" onClick={props.onClose}>{t('apiKeys.result.savedOk')}</Button>,
      ]}
    >
      <Alert
        type="warning"
        showIcon
        icon={<WarningOutlined />}
        message={t('apiKeys.result.warnTitle')}
        description={t('apiKeys.result.warnDesc')}
        style={{ marginBottom: 16 }}
      />
      <Paragraph code copyable={false} style={{ wordBreak: 'break-all' }}>
        {props.result.plaintext}
      </Paragraph>
      <Space>
        <Text type="secondary">{t('apiKeys.result.name')}</Text><Text>{props.result.name}</Text>
        <Text type="secondary">Scope：</Text>
        <Tag color={SCOPE_COLOR[props.result.scope]}>{SCOPE_LABELS(t)[props.result.scope]}</Tag>
        <Text type="secondary">{t('apiKeys.result.prefix')}</Text><Text code>{props.result.keyPrefix}</Text>
      </Space>
    </Modal>
  );
}

export default function ApiKeysSettings() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [form] = Form.useForm();
  const [createOpen, setCreateOpen] = useState(false);
  const [created, setCreated] = useState<ApiKeyCreateResult | null>(null);

  // UI-16：读请求失败要页内可见（此前失败只留空表，与「尚未创建 Key」不可区分）
  const { data: keys = [], isLoading, error: keysError, refetch: refetchKeys } = useQuery({
    queryKey: ['api-keys'],
    queryFn: apiKeysApi.list,
  });

  const createMut = useMutation({
    mutationFn: (values: { name: string; scope: ApiKeyScope; expiresInDays?: number | null }) =>
      apiKeysApi.create({
        name: values.name,
        scope: values.scope,
        ...(values.expiresInDays ? { expiresInDays: values.expiresInDays } : {}),
      }),
    onSuccess: (result) => {
      // 创建成功：关闭表单，弹一次性明文回显
      setCreateOpen(false);
      form.resetFields();
      setCreated(result);
      qc.invalidateQueries({ queryKey: ['api-keys'] });
    },
    // UI-15：失败必须有可见反馈（QA-03 前科收口——静默失败会让用户误以为
    // 创建成功）。getErrMsg 取后端文案（client 拦截器会再叠一层全局 toast，
    // 但 mutation 层文案更贴动作语义，与 UserManagementPage 同形态）。
    onError: (err: unknown) => {
      message.error(getErrMsg(err, t('apiKeys.createFail')));
    },
  });

  const revokeMut = useMutation({
    mutationFn: (id: number) => apiKeysApi.revoke(id),
    onSuccess: () => {
      message.success(t('apiKeys.revokedMsg'));
      qc.invalidateQueries({ queryKey: ['api-keys'] });
    },
    // UI-15：吊销失败补 onError（QA-03 前科：此前失败静默，按钮 loading 复位
    // 但无任何提示）。文案走 getErrMsg（axios 错误取 response.data.message）。
    onError: (err: unknown) => {
      message.error(getErrMsg(err, t('apiKeys.revokeFail')));
    },
  });

  const columns: ColumnsType<ApiKeyView> = [
    { title: t('apiKeys.col.name'), dataIndex: 'name', key: 'name' },
    {
      title: t('apiKeys.col.keyPrefix'), dataIndex: 'keyPrefix', key: 'keyPrefix',
      render: (v: string) => <Text code>{v}…</Text>,
    },
    {
      title: 'Scope', dataIndex: 'scope', key: 'scope',
      render: (v: ApiKeyScope) => <Tag color={SCOPE_COLOR[v]}>{SCOPE_LABELS(t)[v]}</Tag>,
    },
    {
      title: t('apiKeys.col.expiresAt'), dataIndex: 'expiresAt', key: 'expiresAt',
      render: (v: string | null) => (v ? formatDateTime(v) : t('apiKeys.neverExpires')),
    },
    {
      title: t('apiKeys.col.lastUsed'), dataIndex: 'lastUsedAt', key: 'lastUsedAt',
      render: (v: string | null) => formatDateTime(v),
    },
    {
      title: t('apiKeys.col.status'), key: 'status',
      render: (_: unknown, record: ApiKeyView) => {
        const s = apiKeyStatus(record, t);
        return <Tag color={s.color}>{s.label}</Tag>;
      },
    },
    {
      title: t('apiKeys.col.actions'), key: 'action',
      render: (_: unknown, record: ApiKeyView) =>
        record.revokedAt ? (
          <Text type="secondary">—</Text>
        ) : (
          <Popconfirm
            title={t('apiKeys.revokeConfirm')}
            okText={t('apiKeys.revoke')}
            okButtonProps={{ danger: true }}
            onConfirm={() => revokeMut.mutate(record.id)}
          >
            <Button size="small" danger data-testid={`apikey-revoke-${record.id}`}
              loading={revokeMut.isPending && revokeMut.variables === record.id}>
              {t('apiKeys.revoke')}
            </Button>
          </Popconfirm>
        ),
    },
  ];

  return (
    <Card
      title={<Space><ApiOutlined />{t('apiKeys.title')}</Space>}
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)} data-testid="apikey-create">
          {t('apiKeys.create')}
        </Button>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message={t('apiKeys.alertMessage')}
        description={
          <Text type="secondary">
            {t('apiKeys.alertDescPrefix')}<code>Authorization: Bearer acf_…</code>{t('apiKeys.alertDescSuffix')}
          </Text>
        }
      />
      {keysError ? (
        <StateError
          error={keysError}
          title={t('apiKeys.loadFail')}
          onRetry={() => { void refetchKeys(); }}
        />
      ) : (
        <Table
          rowKey="id"
          size="small"
          columns={columns}
          dataSource={keys}
          loading={isLoading}
          pagination={false}
          data-testid="apikey-table"
        />
      )}

      <Modal
        open={createOpen}
        title={t('apiKeys.modal.title')}
        okText={t('apiKeys.modal.ok')}
        confirmLoading={createMut.isPending}
        onCancel={() => setCreateOpen(false)}
        onOk={() => form.submit()}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(v) => createMut.mutate(v)}
          initialValues={{ scope: 'readonly', expiresInDays: null }}
        >
          <Form.Item
            name="name"
            label={t('apiKeys.field.name')}
            rules={[{ required: true, message: t('apiKeys.field.nameRequired') }, { max: 100 }]}
          >
            <Input placeholder={t('apiKeys.field.namePlaceholder')} />
          </Form.Item>
          <Form.Item name="scope" label={t('apiKeys.field.scope')} rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'readonly', label: t('apiKeys.scopeOption.readonly') },
                { value: 'trigger', label: t('apiKeys.scopeOption.trigger') },
                { value: 'manage', label: t('apiKeys.scopeOption.manage') },
              ]}
            />
          </Form.Item>
          <Form.Item
            name="expiresInDays"
            label={t('apiKeys.field.expiresInDays')}
            tooltip={t('apiKeys.field.expiresTooltip')}
          >
            <InputNumber min={1} max={3650} style={{ width: '100%' }} placeholder={t('apiKeys.field.expiresPlaceholder')} />
          </Form.Item>
        </Form>
      </Modal>

      <CreateResultModal result={created} onClose={() => setCreated(null)} />
    </Card>
  );
}