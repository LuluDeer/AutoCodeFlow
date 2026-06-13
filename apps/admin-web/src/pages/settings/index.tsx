import { useState } from 'react';
import {
  Card, Input, Button, Space, message, Typography, Tag, Alert,
  Switch, Modal, Tabs, Table, Form, Select, Tooltip, Popconfirm,
  Spin,
} from 'antd';
import {
  KeyOutlined, CopyOutlined, EyeOutlined, EyeInvisibleOutlined,
  PlusOutlined, EditOutlined, DeleteOutlined, HistoryOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { configApi, SystemConfig, ConfigHistory } from '../../api/config';
import type { ColumnsType } from 'antd/es/table';

const { Title, Text } = Typography;

// ─── Token Section ───────────────────────────────────────────────────────────
function TokenSection() {
  const [tokenVisible, setTokenVisible] = useState(false);
  const qc = useQueryClient();

  const { data: tokenResult, isLoading } = useQuery({
    queryKey: ['executor-token'],
    queryFn: () => configApi.getExecutorToken(),
  });

  const { mutateAsync: generate, isPending: generating } = useMutation({
    mutationFn: configApi.generateExecutorToken,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['executor-token'] }),
  });

  const handleGenerate = () => {
    Modal.confirm({
      title: '生成新的共享 Token',
      content: '生成后，所有执行器需要使用新 Token 重新认证。确认继续？',
      okText: '确认生成',
      okButtonProps: { danger: true },
      onOk: async () => {
        await generate();
        message.success('新 Token 已生成');
      },
    });
  };

  if (isLoading) return <Spin />;

  const token = tokenResult?.token ?? null;
  const hasToken = tokenResult?.hasToken ?? false;

  return (
    <Card title={<Space><KeyOutlined /> 执行器共享 Token</Space>} style={{ marginBottom: 16 }}>
      <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
        执行器连接调度中心时需携带此 Token。首次使用需先生成。
      </Text>

      {hasToken ? (
        <Space direction="vertical" style={{ width: '100%' }}>
          <Space>
            <Input
              readOnly
              value={tokenVisible ? (token || '') : '•'.repeat(40)}
              style={{ width: 360, fontFamily: 'monospace', fontSize: 13 }}
            />
            <Button
              icon={tokenVisible ? <EyeInvisibleOutlined /> : <EyeOutlined />}
              onClick={() => setTokenVisible(v => !v)}
            />
            {tokenVisible && (
              <Button
                icon={<CopyOutlined />}
                onClick={() => {
                  navigator.clipboard.writeText(token || '');
                  message.success('已复制');
                }}
              >
                复制
              </Button>
            )}
          </Space>
          <Button danger loading={generating} onClick={handleGenerate}>
            重新生成 Token
          </Button>
          <Alert
            type="warning"
            message="重新生成后，所有执行器需要更新 Token 才能继续工作"
            showIcon
          />
        </Space>
      ) : (
        <Space direction="vertical">
          <Alert
            type="info"
            message="尚未生成执行器 Token，请先生成后再安装执行器"
            showIcon
          />
          <Button type="primary" icon={<KeyOutlined />} loading={generating} onClick={handleGenerate}>
            生成共享 Token
          </Button>
        </Space>
      )}
    </Card>
  );
}

// ─── Config Edit Modal ────────────────────────────────────────────────────────
interface EditModalProps {
  record: SystemConfig | null;
  onClose: () => void;
  onSaved: () => void;
}

function EditModal({ record, onClose, onSaved }: EditModalProps) {
  const [form] = Form.useForm();
  const isNew = !record;

  const { mutateAsync: save, isPending } = useMutation({
    mutationFn: configApi.upsert,
    onSuccess: () => {
      message.success(isNew ? '配置已添加' : '配置已更新');
      onSaved();
    },
  });

  const handleOk = async () => {
    const vals = await form.validateFields();
    await save(vals);
  };

  return (
    <Modal
      open
      title={isNew ? '新增配置项' : `编辑：${record?.key}`}
      onCancel={onClose}
      onOk={handleOk}
      confirmLoading={isPending}
      okText="保存"
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={record ?? { valueType: 'string', isSecret: false }}
      >
        <Form.Item name="key" label="配置键" rules={[{ required: true, message: '必填' }]}>
          <Input disabled={!isNew} placeholder="例如：feature.darkMode" />
        </Form.Item>
        <Form.Item name="value" label="值" rules={[{ required: true, message: '必填' }]}>
          <Input.TextArea rows={3} />
        </Form.Item>
        <Form.Item name="valueType" label="类型">
          <Select options={[
            { value: 'string', label: '字符串' },
            { value: 'number', label: '数字' },
            { value: 'boolean', label: '布尔' },
            { value: 'json', label: 'JSON' },
          ]} />
        </Form.Item>
        <Form.Item name="description" label="描述（可选）">
          <Input />
        </Form.Item>
        <Form.Item name="tag" label="标签（可选）">
          <Input placeholder="例如：feature / security" />
        </Form.Item>
        <Form.Item name="isSecret" label="敏感信息" valuePropName="checked">
          <Switch />
        </Form.Item>
      </Form>
    </Modal>
  );
}

// ─── Config History Drawer ────────────────────────────────────────────────────
function HistoryModal({ configKey, onClose }: { configKey: string; onClose: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['config-history', configKey],
    queryFn: () => configApi.getHistory({ key: configKey, pageSize: 50 }),
  });

  const qc = useQueryClient();
  const { mutateAsync: rollback, isPending: rolling } = useMutation({
    mutationFn: (id: number) => configApi.rollback(id),
    onSuccess: () => {
      message.success('已回滚');
      qc.invalidateQueries({ queryKey: ['system-configs'] });
      qc.invalidateQueries({ queryKey: ['config-history', configKey] });
    },
  });

  const cols: ColumnsType<ConfigHistory> = [
    { title: '时间', dataIndex: 'changedAt', width: 170,
      render: (v: string) => new Date(v).toLocaleString('zh-CN') },
    { title: '操作者', dataIndex: 'changedBy', width: 100, render: (v: string) => v ?? '系统' },
    { title: '旧值', dataIndex: 'oldValue', ellipsis: true, render: (v: string) => v ?? <Text type="secondary">-</Text> },
    { title: '新值', dataIndex: 'newValue', ellipsis: true, render: (v: string) => v ?? <Text type="secondary">-</Text> },
    { title: '', width: 80,
      render: (_: unknown, row: ConfigHistory) => (
        <Popconfirm title="确认回滚到此版本？" onConfirm={() => rollback(row.id)} okText="回滚">
          <Button size="small" loading={rolling}>回滚</Button>
        </Popconfirm>
      ) },
  ];

  return (
    <Modal open title={`变更历史：${configKey}`} onCancel={onClose} footer={null} width={720}>
      <Table
        loading={isLoading}
        dataSource={data?.data ?? []}
        rowKey="id"
        columns={cols}
        size="small"
        pagination={false}
        scroll={{ y: 400 }}
      />
    </Modal>
  );
}

// ─── System Config Tab ────────────────────────────────────────────────────────
function SystemConfigTab() {
  const [editTarget, setEditTarget] = useState<SystemConfig | null | 'new'>();
  const [historyKey, setHistoryKey] = useState<string | null>(null);
  const qc = useQueryClient();

  const { data: configs, isLoading, refetch } = useQuery({
    queryKey: ['system-configs'],
    queryFn: () => configApi.findAll(),
  });

  const { mutateAsync: remove } = useMutation({
    mutationFn: configApi.remove,
    onSuccess: () => {
      message.success('已删除');
      qc.invalidateQueries({ queryKey: ['system-configs'] });
    },
  });

  const cols: ColumnsType<SystemConfig> = [
    { title: '键', dataIndex: 'key', width: 220, ellipsis: true,
      render: (v: string) => <Text code style={{ fontSize: 12 }}>{v}</Text> },
    { title: '值', dataIndex: 'value', ellipsis: true,
      render: (v: string, r: SystemConfig) => r.isSecret
        ? <Text type="secondary">••••••</Text>
        : (v ?? <Text type="secondary">-</Text>) },
    { title: '类型', dataIndex: 'valueType', width: 80,
      render: (v: string) => <Tag>{v}</Tag> },
    { title: '标签', dataIndex: 'tag', width: 100,
      render: (v: string) => v ? <Tag color="blue">{v}</Tag> : null },
    { title: '描述', dataIndex: 'description', ellipsis: true,
      render: (v: string) => v ? <Text type="secondary" style={{ fontSize: 12 }}>{v}</Text> : null },
    { title: '', width: 120,
      render: (_: unknown, row: SystemConfig) => (
        <Space size={4}>
          <Tooltip title="编辑">
            <Button size="small" icon={<EditOutlined />} onClick={() => setEditTarget(row)} />
          </Tooltip>
          <Tooltip title="变更历史">
            <Button size="small" icon={<HistoryOutlined />} onClick={() => setHistoryKey(row.key)} />
          </Tooltip>
          <Popconfirm title="确认删除此配置？" onConfirm={() => remove(row.key)} okText="删除" okButtonProps={{ danger: true }}>
            <Tooltip title="删除">
              <Button size="small" danger icon={<DeleteOutlined />} />
            </Tooltip>
          </Popconfirm>
        </Space>
      ) },
  ];

  const list: SystemConfig[] = Array.isArray(configs) ? configs : [];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
        <Text type="secondary">管理系统运行时配置项，支持热更新。敏感值（密钥等）显示为 ••••••</Text>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => refetch()}>刷新</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditTarget('new')}>新增配置</Button>
        </Space>
      </div>
      <Table
        loading={isLoading}
        dataSource={list}
        rowKey="id"
        columns={cols}
        size="small"
        pagination={{ pageSize: 20, showTotal: t => `共 ${t} 项` }}
      />
      {editTarget != null && (
        <EditModal
          record={editTarget === 'new' ? null : editTarget}
          onClose={() => setEditTarget(undefined)}
          onSaved={() => {
            setEditTarget(undefined);
            qc.invalidateQueries({ queryKey: ['system-configs'] });
          }}
        />
      )}
      {historyKey && (
        <HistoryModal configKey={historyKey} onClose={() => setHistoryKey(null)} />
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function SettingsPage() {
  const tabs = [
    {
      key: 'token',
      label: <Space><KeyOutlined />执行器 Token</Space>,
      children: <TokenSection />,
    },
    {
      key: 'config',
      label: '系统配置',
      children: <SystemConfigTab />,
    },
  ];

  return (
    <div style={{ maxWidth: 900 }}>
      <div style={{ marginBottom: 24 }}>
        <Title level={4} style={{ margin: 0 }}>系统设置</Title>
        <Text type="secondary">配置调度中心的核心参数与运行时选项</Text>
      </div>
      <Tabs items={tabs} />
    </div>
  );
}
