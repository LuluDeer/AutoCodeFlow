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
import type { ColumnsType } from 'antd/es/table';

const { Text, Paragraph } = Typography;

/**
 * AUTH-03: 设置区「API Keys」Tab——限权 API Key 管理（CI/CD 机器认证）。
 * 列表（name/prefix/scope/过期/最后使用/状态）+ 创建 Modal（创建成功弹
 * 一次性明文 key + 复制按钮 + 「仅显示一次」警示）+ 吊销（Popconfirm）。
 * 全部操作走 JWT（/api-keys 是 JWT-only 面，API Key 不能自管）。
 */

const SCOPE_LABEL: Record<ApiKeyScope, string> = {
  readonly: '只读（全部 GET）',
  trigger: '只读 + 任务触发',
  manage: '完全（除凭证管理）',
};

const SCOPE_COLOR: Record<ApiKeyScope, string> = {
  readonly: 'blue',
  trigger: 'green',
  manage: 'orange',
};

/** 状态列纯函数（导出供测试）：吊销 > 过期 > 正常。 */
export function apiKeyStatus(key: ApiKeyView): { label: string; color: string } {
  if (key.revokedAt) return { label: '已吊销', color: 'red' };
  if (key.expiresAt && new Date(key.expiresAt).getTime() <= Date.now()) {
    return { label: '已过期', color: 'default' };
  }
  return { label: '有效', color: 'green' };
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
  const [copied, setCopied] = useState(false);
  if (!props.result) return null;
  return (
    <Modal
      open
      title="API Key 已创建"
      okText="我已保存好密钥"
      cancelText="关闭"
      onOk={props.onClose}
      onCancel={props.onClose}
      footer={[
        <Button key="copy" icon={<CopyOutlined />} onClick={() => {
          navigator.clipboard?.writeText(props.result!.plaintext);
          setCopied(true);
        }}>
          {copied ? '已复制' : '复制密钥'}
        </Button>,
        <Button key="ok" type="primary" onClick={props.onClose}>我已保存好密钥</Button>,
      ]}
    >
      <Alert
        type="warning"
        showIcon
        icon={<WarningOutlined />}
        message="这是唯一一次显示机会"
        description="出于安全考虑，服务端只保存密钥的 SHA-256 哈希，此明文密钥在关闭本窗口后无法再次查看。请立即复制并妥善保存。"
        style={{ marginBottom: 16 }}
      />
      <Paragraph code copyable={false} style={{ wordBreak: 'break-all' }}>
        {props.result.plaintext}
      </Paragraph>
      <Space>
        <Text type="secondary">名称：</Text><Text>{props.result.name}</Text>
        <Text type="secondary">Scope：</Text>
        <Tag color={SCOPE_COLOR[props.result.scope]}>{SCOPE_LABEL[props.result.scope]}</Tag>
        <Text type="secondary">前缀：</Text><Text code>{props.result.keyPrefix}</Text>
      </Space>
    </Modal>
  );
}

export default function ApiKeysSettings() {
  const qc = useQueryClient();
  const [form] = Form.useForm();
  const [createOpen, setCreateOpen] = useState(false);
  const [created, setCreated] = useState<ApiKeyCreateResult | null>(null);

  const { data: keys = [], isLoading } = useQuery({
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
  });

  const revokeMut = useMutation({
    mutationFn: (id: number) => apiKeysApi.revoke(id),
    onSuccess: () => {
      message.success('API Key 已吊销，使用该 Key 的请求将立即 401');
      qc.invalidateQueries({ queryKey: ['api-keys'] });
    },
  });

  const columns: ColumnsType<ApiKeyView> = [
    { title: '名称', dataIndex: 'name', key: 'name' },
    {
      title: '密钥前缀', dataIndex: 'keyPrefix', key: 'keyPrefix',
      render: (v: string) => <Text code>{v}…</Text>,
    },
    {
      title: 'Scope', dataIndex: 'scope', key: 'scope',
      render: (v: ApiKeyScope) => <Tag color={SCOPE_COLOR[v]}>{SCOPE_LABEL[v]}</Tag>,
    },
    {
      title: '过期时间', dataIndex: 'expiresAt', key: 'expiresAt',
      render: (v: string | null) => (v ? formatDateTime(v) : '永不过期'),
    },
    {
      title: '最后使用', dataIndex: 'lastUsedAt', key: 'lastUsedAt',
      render: (v: string | null) => formatDateTime(v),
    },
    {
      title: '状态', key: 'status',
      render: (_: unknown, record: ApiKeyView) => {
        const s = apiKeyStatus(record);
        return <Tag color={s.color}>{s.label}</Tag>;
      },
    },
    {
      title: '操作', key: 'action',
      render: (_: unknown, record: ApiKeyView) =>
        record.revokedAt ? (
          <Text type="secondary">—</Text>
        ) : (
          <Popconfirm
            title="吊销后使用该 Key 的请求会立即收到 401，且无法恢复。确认吊销？"
            okText="吊销"
            okButtonProps={{ danger: true }}
            onConfirm={() => revokeMut.mutate(record.id)}
          >
            <Button size="small" danger data-testid={`apikey-revoke-${record.id}`}
              loading={revokeMut.isPending && revokeMut.variables === record.id}>
              吊销
            </Button>
          </Popconfirm>
        ),
    },
  ];

  return (
    <Card
      title={<Space><ApiOutlined /> API Keys（限权机器凭证）</Space>}
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)} data-testid="apikey-create">
          新建 API Key
        </Button>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="用于 CI/CD 等机器场景调用本平台 API"
        description={
          <Text type="secondary">
            请求头携带 <code>Authorization: Bearer acf_…</code>。scope 三级：只读 / 只读+任务触发 /
            完全（凭证管理端点始终仅限用户登录态）。吊销立即生效。
          </Text>
        }
      />
      <Table
        rowKey="id"
        size="small"
        columns={columns}
        dataSource={keys}
        loading={isLoading}
        pagination={false}
        data-testid="apikey-table"
      />

      <Modal
        open={createOpen}
        title="新建 API Key"
        okText="创建"
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
            label="名称"
            rules={[{ required: true, message: '请输入名称' }, { max: 100 }]}
          >
            <Input placeholder="如 ci-deploy" />
          </Form.Item>
          <Form.Item name="scope" label="权限范围" rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'readonly', label: '只读（全部 GET）' },
                { value: 'trigger', label: '只读 + 任务触发（CI/CD 推荐）' },
                { value: 'manage', label: '完全（凭证管理除外）' },
              ]}
            />
          </Form.Item>
          <Form.Item
            name="expiresInDays"
            label="有效期（天，留空 = 永不过期）"
            tooltip="到期后使用该 Key 的请求将返回 401"
          >
            <InputNumber min={1} max={3650} style={{ width: '100%' }} placeholder="留空表示永不过期" />
          </Form.Item>
        </Form>
      </Modal>

      <CreateResultModal result={created} onClose={() => setCreated(null)} />
    </Card>
  );
}
