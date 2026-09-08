import { useState, useEffect } from 'react';
import {
  Card, Input, Button, Space, message, Typography, Tag, Alert,
  Switch, Modal, Tabs, Table, Form, Select, Tooltip, Popconfirm,
  Spin, Divider, Badge,
} from 'antd';
import {
  KeyOutlined, CopyOutlined, EyeOutlined, EyeInvisibleOutlined,
  PlusOutlined, EditOutlined, DeleteOutlined, HistoryOutlined,
  ReloadOutlined, RobotOutlined, ThunderboltOutlined, SafetyCertificateOutlined,
  ApiOutlined,
} from '@ant-design/icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { configApi, SystemConfig, ConfigHistory } from '../../api/config';
import { aiApi, SaveAiConfigPayload } from '../../api/ai';
import { useAuthStore, isAdminUser } from '../../store/auth';
import type { ColumnsType } from 'antd/es/table';
import PageHeader from '../../components/PageHeader';
// SEC-03: 安全设置 Tab（TOTP 两步验证 + 登录会话管理），独立文件避免与其他 Tab 耦合
import SecuritySettings from './SecuritySettings';
// AUTH-03: API Keys Tab（限权机器凭证管理），独立文件
import ApiKeysSettings from './ApiKeysSettings';

const { Text } = Typography;

/**
 * R5 RBAC（按第四轮收紧矩阵）：
 * - 执行器共享 Token 读/生成、系统配置写（增删改）、回滚 → 后端 @Roles(ADMIN)；
 *   普通用户不可见或按钮禁用（不做无谓的 403 请求）。
 * - config 列表/详情、变更历史 → 登录即可，所有用户可用。
 * R6 更新：AI 配置读写（GET/POST /ai/config）收紧为 ADMIN-only，
 * AiConfigTab 对非管理员降级为只读提示，不发起会 403 的查询。
 */
function useIsAdmin() {
  const user = useAuthStore((s) => s.user);
  return isAdminUser(user);
}

// ─── Token Section ───────────────────────────────────────────────────────────
function TokenSection() {
  const [tokenVisible, setTokenVisible] = useState(false);
  const qc = useQueryClient();
  const isAdmin = useIsAdmin();

  // R4 收紧矩阵：共享 Token 的读与生成为 ADMIN-only。
  // 非管理员不发起查询（GET 会 403），hooks 仍按固定顺序调用。
  const { data: tokenResult, isLoading } = useQuery({
    queryKey: ['executor-token'],
    queryFn: () => configApi.getExecutorToken(),
    enabled: isAdmin,
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

  if (!isAdmin) {
    return (
      <Card title={<Space><KeyOutlined /> 执行器共享 Token</Space>} style={{ marginBottom: 16 }}>
        <Alert
          type="info"
          title="仅管理员可查看和生成执行器共享 Token"
          description="如需管理执行器共享 Token，请联系管理员。"
          showIcon
        />
      </Card>
    );
  }

  if (isLoading) return <Spin />;

  const token = tokenResult?.token ?? null;
  const hasToken = tokenResult?.hasToken ?? false;

  return (
    <Card title={<Space><KeyOutlined /> 执行器共享 Token</Space>} style={{ marginBottom: 16 }}>
      <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
        执行器连接调度中心时需携带此 Token。首次使用需先生成。
      </Text>

      {hasToken ? (
        <Space orientation="vertical" style={{ width: '100%' }}>
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
          <Button danger loading={generating} onClick={handleGenerate} disabled={!isAdmin}>
            重新生成 Token
          </Button>
          <Alert
            type="warning"
            title="重新生成后，所有执行器需要更新 Token 才能继续工作"
            showIcon
          />
        </Space>
      ) : (
        <Space orientation="vertical">
          <Alert
            type="info"
            title="尚未生成执行器 Token，请先生成后再安装执行器"
            showIcon
          />
          <Tooltip title={isAdmin ? undefined : '仅管理员可生成共享 Token'}>
            <Button
              type="primary"
              icon={<KeyOutlined />}
              loading={generating}
              onClick={handleGenerate}
              disabled={!isAdmin}
            >
              生成共享 Token
            </Button>
          </Tooltip>
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
  const isAdmin = useIsAdmin();

  const qc = useQueryClient();
  // FEAT-08：回滚目标 id 状态实现逐行 loading（多行不共用同一个 spinner）。
  const [rollingId, setRollingId] = useState<number | null>(null);
  const { mutateAsync: rollback } = useMutation({
    mutationFn: (id: number) => configApi.rollback(id),
    onSuccess: () => {
      message.success('已回滚');
      // 刷新当前配置读面 + 历史列表（回滚本身也会写一条 rollback 历史）
      qc.invalidateQueries({ queryKey: ['system-configs'] });
      qc.invalidateQueries({ queryKey: ['config-history', configKey] });
    },
    // 失败提示由 api/client.ts 响应拦截器统一 toast（含 400/403 后端文案），
    // 这里仅复位逐行 loading，避免双重报错。
    onSettled: () => setRollingId(null),
  });

  const handleRollback = async (id: number) => {
    setRollingId(id);
    await rollback(id);
  };

  const cols: ColumnsType<ConfigHistory> = [
    { title: '时间', dataIndex: 'createdAt', width: 170,
      render: (v: string) => v ? new Date(v).toLocaleString('zh-CN') : '-' },
    { title: '操作者', dataIndex: 'username', width: 100, render: (v: string) => v ?? '系统' },
    { title: '动作', dataIndex: 'action', width: 70,
      render: (v: ConfigHistory['action']) => v === 'create' ? '创建'
        : v === 'delete' ? '删除' : v === 'rollback' ? '回滚' : '修改' },
    { title: '旧值', dataIndex: 'oldValue', ellipsis: true, render: (v: string) => v ?? <Text type="secondary">-</Text> },
    { title: '新值', dataIndex: 'newValue', ellipsis: true, render: (v: string) => v ?? <Text type="secondary">-</Text> },
    { title: '', width: 80,
      render: (_: unknown, row: ConfigHistory) => {
        if (!isAdmin) return null;
        // 创建条目（oldValue 为 null）回滚=删除该配置项，禁用并说明。
        const disabled = row.oldValue == null;
        return (
          <Popconfirm
            title="确认回滚到此版本？"
            description={row.action === 'create' ? '该条目为创建动作，回滚将删除此配置项。' : undefined}
            onConfirm={() => handleRollback(row.id)}
            okText="回滚"
            okButtonProps={{ danger: true }}
            disabled={disabled}
          >
            <Tooltip title={disabled ? '创建条目无可回滚的历史值' : undefined}>
              <Button size="small" loading={rollingId === row.id} disabled={disabled}>回滚</Button>
            </Tooltip>
          </Popconfirm>
        );
      } },
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
  const isAdmin = useIsAdmin();

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
          <Tooltip title={isAdmin ? '编辑' : '仅管理员可编辑配置'}>
            <Button size="small" icon={<EditOutlined />} onClick={() => setEditTarget(row)} disabled={!isAdmin} />
          </Tooltip>
          <Tooltip title="变更历史">
            <Button size="small" icon={<HistoryOutlined />} onClick={() => setHistoryKey(row.key)} />
          </Tooltip>
          <Popconfirm title="确认删除此配置？" onConfirm={() => remove(row.key)} okText="删除" okButtonProps={{ danger: true }} disabled={!isAdmin}>
            <Tooltip title={isAdmin ? '删除' : '仅管理员可删除配置'}>
              <Button size="small" danger icon={<DeleteOutlined />} disabled={!isAdmin} />
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
          <Tooltip title={isAdmin ? undefined : '仅管理员可新增配置'}>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditTarget('new')} disabled={!isAdmin}>
              新增配置
            </Button>
          </Tooltip>
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

// ─── AI Config Tab ───────────────────────────────────────────────────────────
function AiConfigTab() {
  const [form] = Form.useForm();
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const qc = useQueryClient();
  const isAdmin = useIsAdmin();

  // R6 收紧矩阵：GET /ai/config 为 ADMIN-only。
  // 非管理员不发起查询（GET 会 403），hooks 仍按固定顺序调用（同 TokenSection 模式）。
  const { data: cfg, isLoading } = useQuery({
    queryKey: ['ai-config'],
    queryFn: () => aiApi.getConfig(),
    enabled: isAdmin,
  });

  // Populate form once config data arrives
  useEffect(() => {
    if (cfg) {
      form.setFieldsValue({
        provider: cfg.provider ?? 'disabled',
        openaiModel: cfg.openaiModel || 'gpt-4o-mini',
        openaiBaseUrl: cfg.openaiBaseUrl || 'https://api.openai.com/v1',
        ollamaHost: cfg.ollamaHost || 'http://localhost:11434',
        ollamaModel: cfg.ollamaModel || 'llama3',
      });
    }
  }, [cfg, form]);

  const { mutateAsync: save, isPending: saving } = useMutation({
    mutationFn: (vals: SaveAiConfigPayload) => aiApi.saveConfig(vals),
    onSuccess: () => {
      message.success('AI 配置已保存');
      qc.invalidateQueries({ queryKey: ['ai-config'] });
    },
  });

  const { mutateAsync: test, isPending: testing } = useMutation({
    mutationFn: () => aiApi.testConfig(),
    onSuccess: (res) => setTestResult(res),
    onError: () => setTestResult({ ok: false, message: '请求失败，请检查配置' }),
  });

  const provider = Form.useWatch('provider', form);

  const handleSave = async () => {
    const vals = await form.validateFields();
    await save(vals as SaveAiConfigPayload);
  };

  const providerBadge = () => {
    if (!cfg) return null;
    const p = cfg.provider;
    if (p === 'disabled') return <Badge status="default" text="未启用" />;
    if (p === 'openai') return <Badge status="processing" text="OpenAI" color="green" />;
    if (p === 'ollama') return <Badge status="processing" text="Ollama" color="blue" />;
    return null;
  };

  // R6：非管理员降级为只读提示（读写端点均 ADMIN-only，隐藏表单而非报错）
  if (!isAdmin) {
    return (
      <Alert
        type="info"
        showIcon
        title="仅管理员可查看和配置 AI 分析"
        description="AI 配置的读取与保存为管理员专用接口。如需开启或调整任务失败 AI 分析能力，请联系管理员。"
      />
    );
  }

  return (
    <div>
      <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
        <Text type="secondary">配置任务失败时的 AI 分析能力，支持 OpenAI 及兼容接口和本地 Ollama。</Text>
        {providerBadge()}
      </div>

      {isLoading ? <Spin /> : (
        <Form form={form} layout="vertical" initialValues={{ provider: 'disabled', openaiModel: 'gpt-4o-mini', openaiBaseUrl: 'https://api.openai.com/v1', ollamaHost: 'http://localhost:11434', ollamaModel: 'llama3' }}>
          <Form.Item name="provider" label="AI 提供商" rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'disabled', label: '禁用（不使用 AI 分析）' },
                { value: 'openai', label: 'OpenAI / 兼容接口（如 DeepSeek、Qwen 等）' },
                { value: 'ollama', label: 'Ollama（本地模型）' },
              ]}
            />
          </Form.Item>

          {provider === 'openai' && (
            <>
              <Divider plain style={{ fontSize: 12, color: '#888' }}>OpenAI 设置</Divider>
              <Form.Item
                name="openaiBaseUrl"
                label="API Base URL"
                tooltip="可替换为 DeepSeek、Qwen 等兼容 OpenAI 格式的接口地址"
              >
                <Input placeholder="https://api.openai.com/v1" />
              </Form.Item>
              <Form.Item
                name="openaiApiKey"
                label={
                  <Space>
                    API Key
                    {cfg?.hasApiKey && <Tag color="green">已配置</Tag>}
                  </Space>
                }
                tooltip="填写新值将覆盖已保存的 Key；留空则保持不变"
              >
                <Input.Password
                  placeholder={cfg?.hasApiKey ? '已配置，留空则不修改' : '输入 API Key'}
                  visibilityToggle={{ visible: apiKeyVisible, onVisibleChange: setApiKeyVisible }}
                />
              </Form.Item>
              <Form.Item name="openaiModel" label="模型名称">
                <Input placeholder="gpt-4o-mini" />
              </Form.Item>
            </>
          )}

          {provider === 'ollama' && (
            <>
              <Divider plain style={{ fontSize: 12, color: '#888' }}>Ollama 设置</Divider>
              <Form.Item name="ollamaHost" label="Ollama Host">
                <Input placeholder="http://localhost:11434" />
              </Form.Item>
              <Form.Item name="ollamaModel" label="模型名称">
                <Input placeholder="llama3" />
              </Form.Item>
            </>
          )}

          <Form.Item style={{ marginTop: 8 }}>
            <Space>
              <Button type="primary" loading={saving} onClick={handleSave}>保存配置</Button>
              {provider !== 'disabled' && (
                <Button
                  icon={<ThunderboltOutlined />}
                  loading={testing}
                  onClick={() => { setTestResult(null); test(); }}
                >
                  测试连通性
                </Button>
              )}
            </Space>
          </Form.Item>
        </Form>
      )}

      {testResult && (
        <Alert
          type={testResult.ok ? 'success' : 'error'}
          showIcon
          title={testResult.ok ? 'AI 连接成功' : '连接失败'}
          description={<pre style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 12 }}>{testResult.message}</pre>}
          style={{ marginTop: 8 }}
          closable
          onClose={() => setTestResult(null)}
        />
      )}

      {provider !== 'disabled' && (
        <Alert
          type="info"
          showIcon
          title="任务执行失败时，AI 会自动分析错误日志并给出修复建议，结果展示在执行详情页。"
          style={{ marginTop: 16 }}
        />
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function SettingsPage() {
  const isAdmin = useIsAdmin();

  const tabs = [
    // R4 收紧矩阵：共享 Token 读/生成 ADMIN-only，非管理员直接不渲染该 Tab
    ...(isAdmin
      ? [{ key: 'token', label: <Space><KeyOutlined />执行器 Token</Space>, children: <TokenSection /> }]
      : []),
    {
      key: 'ai',
      label: <Space><RobotOutlined />AI 配置</Space>,
      children: <AiConfigTab />,
    },
    {
      key: 'config',
      label: '系统配置',
      children: <SystemConfigTab />,
    },
    // SEC-03: 安全设置（TOTP + 会话管理）——所有登录用户可用（仅涉及本人账号），
    // 置于末位 Tab：不改变既有 Tab 排序/默认激活行为（settings.ai 等既有测试依赖）
    {
      key: 'security',
      label: <Space><SafetyCertificateOutlined />安全设置</Space>,
      children: <SecuritySettings />,
    },
    // AUTH-03: 限权 API Key 管理（CI/CD 机器认证）——所有登录用户管理本人 Key；
    // 放在安全设置之后，不改变既有 Tab 默认激活行为
    {
      key: 'api-keys',
      label: <Space><ApiOutlined />API Keys</Space>,
      children: <ApiKeysSettings />,
    },
  ];

  return (
    <div style={{ maxWidth: 900 }}>
      {/* UI-03/UI-08：页头标准化（原 Title+描述迁入 PageHeader；非管理员提示保留页头下方） */}
      <PageHeader
        title="系统设置"
        description="配置调度中心的核心参数与运行时选项"
      />
      {!isAdmin && (
        <Alert
          type="info"
          showIcon
          title="您以普通用户身份查看，写操作（配置修改、回滚）与 AI 配置仅管理员可用"
          style={{ marginBottom: 16 }}
        />
      )}
      <Tabs items={tabs} />
    </div>
  );
}
