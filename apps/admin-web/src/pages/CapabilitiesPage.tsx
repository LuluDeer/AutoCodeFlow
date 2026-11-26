import { useEffect, useState } from 'react';
import type { FormInstance } from 'antd';
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import {
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import {
  capabilitiesApi,
  parseJsonObject,
  type Capability,
  type CapabilityDump,
  type CapabilityResolution,
  type CapabilityScopeMode,
  type CapabilityGuidance,
  type CapabilityVisibility,
  type CapabilitySourceType,
  type CapabilityKind,
  type ResolveLayer,
} from '../api/capabilities';
import { message } from '../utils/toast';
import { showApiError } from '../utils/error';
import { isAdminUser, useAuthStore } from '../store/auth';

const { Text, Paragraph } = Typography;

const KIND_OPTIONS: Array<{ value: CapabilityKind; label: string }> = [
  { value: 'skill', label: '技能（skill）' },
  { value: 'mcp', label: 'MCP 服务（mcp）' },
  { value: 'agent', label: '智能体（agent）' },
  { value: 'provider', label: '模型渠道（provider）' },
  { value: 'template', label: '模板（template）' },
];
const VISIBILITY_OPTIONS: Array<{ value: CapabilityVisibility; label: string }> = [
  { value: 'global', label: '全局（global）' },
  { value: 'project', label: '项目（project）' },
  { value: 'private', label: '私有（private）' },
];
const MODE_OPTIONS: Array<{ value: CapabilityScopeMode; label: string }> = [
  { value: 'managed', label: '强监管（managed）' },
  { value: 'supervised', label: '监督（supervised）' },
  { value: 'self_service', label: '自治（self_service）' },
];
const GUIDANCE_OPTIONS: Array<{ value: CapabilityGuidance; label: string }> = [
  { value: 'L1', label: 'L1 · 强引导' },
  { value: 'L2', label: 'L2 · 需确认' },
  { value: 'L3', label: 'L3 · 高自治' },
];
const SOURCE_OPTIONS: Array<{ value: CapabilitySourceType; label: string }> = [
  { value: 'builtin', label: '内置（builtin）' },
  { value: 'registry', label: '登记处（registry）' },
  { value: 'git', label: '代码库（git）' },
  { value: 'folder', label: '目录（folder）' },
];
const DECISION_LABEL: Record<string, string> = {
  allow: '允许（allow）',
  ask: '需确认（ask）',
  deny: '拒绝（deny）',
};
const DECISION_COLOR: Record<string, string> = {
  allow: 'green',
  ask: 'orange',
  deny: 'red',
};

interface CapabilityFormValues {
  key: string;
  kind: CapabilityKind;
  label: string;
  description?: string;
  version?: string;
  visibility: CapabilityVisibility;
  scopeMode: CapabilityScopeMode;
  guidance: CapabilityGuidance;
  sourceType: CapabilitySourceType;
  sourceRef?: string;
  manifestText: string;
}

type OptionalObjectResult =
  | { ok: true; value: Record<string, unknown> | null }
  | { ok: false };

/** 空串 = 不提供该下层；否则先做 JSON.parse 预检，失败只报错不发请求。 */
function parseOptionalObject(text: string, label: string): OptionalObjectResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, value: null };
  try {
    return { ok: true, value: parseJsonObject(trimmed, label) };
  } catch {
    message.error(`${label}不是合法 JSON 对象。`);
    return { ok: false };
  }
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '—';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** 列表到手后给可视化区各选一个默认 key，用户可改选。 */
function useDefaultCapabilityKey(capabilities: Capability[]) {
  const [key, setKey] = useState('');
  useEffect(() => {
    if (capabilities.length === 0) return;
    if (!key) setKey(capabilities[0].key);
  }, [capabilities, key]);
  return [key, setKey] as const;
}

interface CapabilityTableCardProps {
  capabilities: Capability[];
  isLoading: boolean;
  isFetching: boolean;
  error: Error | null;
  admin: boolean;
  busyId: string | null;
  onRefresh: () => void;
  onCreate: () => void;
  onEdit: (cap: Capability) => void;
  onToggle: (cap: Capability) => void;
  onRemove: (cap: Capability) => void;
}

/** 列表卡片：刷新 / 新建 / 错误提示 / 能力表格（含 ADMIN 操作列）。 */
function CapabilityTableCard({
  capabilities,
  isLoading,
  isFetching,
  error,
  admin,
  busyId,
  onRefresh,
  onCreate,
  onEdit,
  onToggle,
  onRemove,
}: CapabilityTableCardProps) {
  return (
    <>
      <Space style={{ marginBottom: 16 }} wrap>
        <Button icon={<ReloadOutlined />} loading={isFetching} onClick={onRefresh}>
          刷新
        </Button>
        {admin ? (
          <Button type="primary" icon={<PlusOutlined />} onClick={onCreate}>
            新建能力
          </Button>
        ) : null}
      </Space>

      {error ? (
        <Alert type="error" showIcon message="能力列表加载失败" style={{ marginBottom: 16 }} />
      ) : null}

      <Card title="能力列表" style={{ marginBottom: 16 }}>
        <Table<Capability>
          data-testid="capabilities-table"
          rowKey="id"
          loading={isLoading}
          dataSource={capabilities}
          pagination={false}
          locale={{ emptyText: '暂无已登记的能力' }}
          columns={[
            { title: '标识', dataIndex: 'key', key: 'key' },
            {
              title: '类型',
              dataIndex: 'kind',
              key: 'kind',
              render: (v: string) => <Tag color="blue">{v}</Tag>,
            },
            { title: '名称', dataIndex: 'label', key: 'label' },
            { title: '版本', dataIndex: 'version', key: 'version' },
            {
              title: '可见范围',
              dataIndex: 'visibility',
              key: 'visibility',
              render: (v: string) => <Tag>{v}</Tag>,
            },
            {
              title: '作用域',
              key: 'scope',
              render: (_: unknown, row: Capability) => (
                <span data-testid={`cap-scope-${row.key}`}>
                  {row.scope?.mode ?? '—'} × {row.scope?.guidance ?? '—'}
                </span>
              ),
            },
            {
              title: '启用',
              dataIndex: 'enabled',
              key: 'enabled',
              render: (v: boolean) => (
                <Tag color={v ? 'green' : 'default'}>{v ? '启用' : '停用'}</Tag>
              ),
            },
            ...(admin
              ? [
                  {
                    title: '操作',
                    key: 'actions',
                    render: (_: unknown, row: Capability) => (
                      <Space size={4}>
                        <Button
                          type="link"
                          size="small"
                          icon={<EditOutlined aria-hidden />}
                          onClick={() => onEdit(row)}
                        >
                          编辑
                        </Button>
                        <Button
                          type="link"
                          size="small"
                          loading={busyId === row.id}
                          onClick={() => onToggle(row)}
                        >
                          {row.enabled ? '停用' : '启用'}
                        </Button>
                        <Popconfirm
                          title="确认删除这条能力？"
                          okText="确认删除"
                          cancelText="取消"
                          onConfirm={() => onRemove(row)}
                        >
                          <Button
                            type="link"
                            size="small"
                            danger
                            icon={<DeleteOutlined aria-hidden />}
                            aria-label={`删除能力 ${row.key}`}
                          >
                            删除
                          </Button>
                        </Popconfirm>
                      </Space>
                    ),
                  },
                ]
              : []),
          ]}
        />
      </Card>
    </>
  );
}

interface CapabilityFormModalProps {
  open: boolean;
  isNew: boolean;
  form: FormInstance<CapabilityFormValues>;
  saving: boolean;
  onCancel: () => void;
  onSubmit: (values: CapabilityFormValues) => void;
}

/** 创建 / 编辑 Modal：字段布局与校验；DTO 组装与请求在父组件 submitForm。 */
function CapabilityFormModal({
  open,
  isNew,
  form,
  saving,
  onCancel,
  onSubmit,
}: CapabilityFormModalProps) {
  return (
    <Modal
      title={isNew ? '新建能力' : '编辑能力'}
      open={open}
      forceRender
      okText="提交"
      cancelText="取消"
      confirmLoading={saving}
      onCancel={onCancel}
      onOk={() => void form.submit()}
      data-testid="capability-form-modal"
    >
      <Form form={form} layout="vertical" onFinish={onSubmit}>
        <Form.Item
          label="标识（key）"
          name="key"
          rules={[{ required: true, message: '请填写标识。' }]}
        >
          <Input data-testid="cap-key" disabled={!isNew} />
        </Form.Item>
        <Form.Item label="类型" name="kind" rules={[{ required: true }]}>
          <Select data-testid="cap-kind" options={KIND_OPTIONS} />
        </Form.Item>
        <Form.Item
          label="名称"
          name="label"
          rules={[{ required: true, message: '请填写名称。' }]}
        >
          <Input data-testid="cap-label" />
        </Form.Item>
        <Form.Item label="说明" name="description">
          <Input.TextArea data-testid="cap-description" rows={2} />
        </Form.Item>
        <Form.Item label="版本" name="version">
          <Input data-testid="cap-version" />
        </Form.Item>
        <Form.Item label="可见范围" name="visibility" rules={[{ required: true }]}>
          <Select data-testid="cap-visibility" options={VISIBILITY_OPTIONS} />
        </Form.Item>
        <Form.Item label="作用域模式" name="scopeMode" rules={[{ required: true }]}>
          <Select data-testid="cap-scope-mode" options={MODE_OPTIONS} />
        </Form.Item>
        <Form.Item label="引导档位" name="guidance" rules={[{ required: true }]}>
          <Select data-testid="cap-guidance" options={GUIDANCE_OPTIONS} />
        </Form.Item>
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="强监管（managed）模式不允许最高自治档 L3，只能选择 L1 或 L2。"
        />
        <Form.Item label="来源类型" name="sourceType" rules={[{ required: true }]}>
          <Select data-testid="cap-source-type" options={SOURCE_OPTIONS} />
        </Form.Item>
        <Form.Item label="来源引用" name="sourceRef">
          <Input data-testid="cap-source-ref" />
        </Form.Item>
        <Form.Item
          label="能力声明（JSON）"
          name="manifestText"
          rules={[{ required: true, message: '请填写能力声明。' }]}
        >
          <Input.TextArea data-testid="cap-manifest" rows={8} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

/** 配置解析（resolve）区：三层配置 → 生效值与策略结论；状态自治。 */
function CapabilityResolveCard({ capabilities }: { capabilities: Capability[] }) {
  const [resolveKey, setResolveKey] = useDefaultCapabilityKey(capabilities);
  const [managedText, setManagedText] = useState('{}');
  const [projectText, setProjectText] = useState('');
  const [privateText, setPrivateText] = useState('');
  const [resolveResult, setResolveResult] = useState<CapabilityResolution | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);

  const keyOptions = capabilities.map((cap) => ({
    value: cap.key,
    label: `${cap.key} · ${cap.label}`,
  }));

  async function runResolve() {
    if (!resolveKey) {
      setResolveError('请先选择一个能力标识。');
      return;
    }
    const managed = parseOptionalObject(managedText, '托管层配置');
    const project = parseOptionalObject(projectText, '项目层配置');
    const privateLayer = parseOptionalObject(privateText, '私有层配置');
    if (!managed.ok || !project.ok || !privateLayer.ok) return;
    const layers: ResolveLayer[] = [{ name: 'managed', config: managed.value ?? {} }];
    if (project.value) layers.push({ name: 'project', config: project.value });
    if (privateLayer.value) layers.push({ name: 'private', config: privateLayer.value });
    setResolving(true);
    setResolveError(null);
    setResolveResult(null);
    try {
      setResolveResult(await capabilitiesApi.resolve({ key: resolveKey, layers }));
    } catch (err) {
      setResolveError('配置解析失败，请检查标识与层配置后重试。');
      showApiError(err, '配置解析失败。');
    } finally {
      setResolving(false);
    }
  }

  return (
    <Card title="配置解析（resolve）" style={{ marginBottom: 16 }}>
      <Paragraph type="secondary">
        选择能力并给出三层配置，查看最终生效值与策略结论；托管层来自能力声明与作用域。
      </Paragraph>
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <div>
          <div style={{ marginBottom: 4 }}>能力标识</div>
          <Select
            data-testid="resolve-key"
            showSearch
            style={{ width: 320 }}
            value={resolveKey || undefined}
            onChange={setResolveKey}
            options={keyOptions}
            placeholder="请选择能力"
          />
        </div>
        <div>
          <div style={{ marginBottom: 4 }}>托管层配置（JSON）</div>
          <Input.TextArea
            data-testid="resolve-managed"
            rows={3}
            value={managedText}
            onChange={(e) => setManagedText(e.target.value)}
          />
        </div>
        <div>
          <div style={{ marginBottom: 4 }}>项目层配置（JSON，可留空）</div>
          <Input.TextArea
            data-testid="resolve-project"
            rows={3}
            value={projectText}
            onChange={(e) => setProjectText(e.target.value)}
          />
        </div>
        <div>
          <div style={{ marginBottom: 4 }}>私有层配置（JSON，可留空）</div>
          <Input.TextArea
            data-testid="resolve-private"
            rows={3}
            value={privateText}
            onChange={(e) => setPrivateText(e.target.value)}
          />
        </div>
        <Button
          type="primary"
          data-testid="resolve-submit"
          loading={resolving}
          onClick={() => void runResolve()}
        >
          解析
        </Button>
      </Space>
      {resolveError ? (
        <Alert type="error" showIcon message={resolveError} style={{ marginTop: 12 }} />
      ) : null}
      {resolveResult ? (
        <div data-testid="resolve-result" style={{ marginTop: 12 }}>
          <Space style={{ marginBottom: 8 }}>
            <Text>策略结论：</Text>
            <Tag
              data-testid="resolve-decision"
              color={DECISION_COLOR[resolveResult.decision] ?? 'default'}
            >
              {DECISION_LABEL[resolveResult.decision] ?? resolveResult.decision}
            </Tag>
          </Space>
          <div style={{ marginBottom: 4 }}>生效配置：</div>
          <pre data-testid="resolve-effective" style={{ margin: 0 }}>
            {JSON.stringify(resolveResult.effective, null, 2)}
          </pre>
        </div>
      ) : null}
    </Card>
  );
}

/** 配置审计（dump）区：三栏表格；状态自治。 */
function CapabilityDumpCard({ capabilities }: { capabilities: Capability[] }) {
  const [dumpKey, setDumpKey] = useDefaultCapabilityKey(capabilities);
  const [dumpProjectText, setDumpProjectText] = useState('');
  const [dumpPrivateText, setDumpPrivateText] = useState('');
  const [dumpResult, setDumpResult] = useState<CapabilityDump | null>(null);
  const [dumpError, setDumpError] = useState<string | null>(null);
  const [dumping, setDumping] = useState(false);

  const keyOptions = capabilities.map((cap) => ({
    value: cap.key,
    label: `${cap.key} · ${cap.label}`,
  }));

  async function runDump() {
    if (!dumpKey) {
      setDumpError('请先选择一个能力标识。');
      return;
    }
    const project = parseOptionalObject(dumpProjectText, '项目层配置');
    const privateLayer = parseOptionalObject(dumpPrivateText, '私有层配置');
    if (!project.ok || !privateLayer.ok) return;
    setDumping(true);
    setDumpError(null);
    setDumpResult(null);
    try {
      setDumpResult(
        await capabilitiesApi.dump(dumpKey, {
          ...(project.value ? { projectLayer: JSON.stringify(project.value) } : {}),
          ...(privateLayer.value ? { privateLayer: JSON.stringify(privateLayer.value) } : {}),
        }),
      );
    } catch (err) {
      setDumpError('配置审计导出失败，请稍后重试。');
      showApiError(err, '配置审计导出失败。');
    } finally {
      setDumping(false);
    }
  }

  return (
    <Card title="配置审计（dump）">
      <Paragraph type="secondary">
        三栏展示每个字段在各层的来源值、最终生效值、生效来源与合并规则；凭据字段由后端脱敏。
      </Paragraph>
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <div>
          <div style={{ marginBottom: 4 }}>能力标识</div>
          <Select
            data-testid="dump-key"
            showSearch
            style={{ width: 320 }}
            value={dumpKey || undefined}
            onChange={setDumpKey}
            options={keyOptions}
            placeholder="请选择能力"
          />
        </div>
        <div>
          <div style={{ marginBottom: 4 }}>项目层配置（JSON，可留空）</div>
          <Input.TextArea
            data-testid="dump-project"
            rows={3}
            value={dumpProjectText}
            onChange={(e) => setDumpProjectText(e.target.value)}
          />
        </div>
        <div>
          <div style={{ marginBottom: 4 }}>私有层配置（JSON，可留空）</div>
          <Input.TextArea
            data-testid="dump-private"
            rows={3}
            value={dumpPrivateText}
            onChange={(e) => setDumpPrivateText(e.target.value)}
          />
        </div>
        <Button
          type="primary"
          data-testid="dump-submit"
          loading={dumping}
          onClick={() => void runDump()}
        >
          导出三栏审计
        </Button>
      </Space>
      {dumpError ? (
        <Alert type="error" showIcon message={dumpError} style={{ marginTop: 12 }} />
      ) : null}
      {dumpResult ? (
        <Table<CapabilityDump['dump'][number]>
          data-testid="dump-table"
          style={{ marginTop: 12 }}
          rowKey="field"
          pagination={false}
          dataSource={dumpResult.dump}
          columns={[
            { title: '字段', dataIndex: 'field', key: 'field' },
            {
              title: '各层来源值',
              key: 'layers',
              render: (_: unknown, row: CapabilityDump['dump'][number]) => (
                <Space direction="vertical" size={0}>
                  {row.layers.map((layer) => (
                    <span key={layer.name} data-testid={`dump-layer-${layer.name}`}>
                      {layer.name}：{formatValue(layer.value)}
                    </span>
                  ))}
                </Space>
              ),
            },
            {
              title: '生效值',
              key: 'effective',
              render: (_: unknown, row: CapabilityDump['dump'][number]) =>
                formatValue(row.effective),
            },
            { title: '生效来源', dataIndex: 'source', key: 'source' },
            { title: '合并规则', dataIndex: 'rule', key: 'rule' },
          ]}
        />
      ) : null}
    </Card>
  );
}

export default function CapabilitiesPage() {
  const user = useAuthStore((s) => s.user);
  const admin = isAdminUser(user);
  const [form] = Form.useForm<CapabilityFormValues>();

  const {
    data: capabilities = [],
    isLoading,
    error,
    isFetching,
    refetch,
  } = useQuery({
    queryKey: ['capabilities'],
    queryFn: ({ signal }) => capabilitiesApi.list(signal),
  });

  const [editing, setEditing] = useState<Capability | 'new' | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  function openCreate() {
    form.setFieldsValue({
      key: '',
      kind: 'skill',
      label: '',
      description: '',
      version: '1.0.0',
      visibility: 'private',
      scopeMode: 'supervised',
      guidance: 'L2',
      sourceType: 'builtin',
      sourceRef: '',
      manifestText: '{}',
    });
    setEditing('new');
  }

  function openEdit(cap: Capability) {
    form.setFieldsValue({
      key: cap.key,
      kind: (cap.kind as CapabilityKind) ?? 'skill',
      label: cap.label,
      description: cap.description ?? '',
      version: cap.version,
      visibility: cap.visibility,
      scopeMode: cap.scope?.mode ?? 'supervised',
      guidance: cap.scope?.guidance ?? 'L2',
      sourceType: cap.source?.type ?? 'builtin',
      sourceRef: cap.source?.ref ?? '',
      manifestText: JSON.stringify(cap.manifest ?? {}, null, 2),
    });
    setEditing(cap);
  }

  async function submitForm(values: CapabilityFormValues) {
    // 前端先挡住后端必拒的组合，避免一次注定 400 的写请求。
    if (values.scopeMode === 'managed' && values.guidance === 'L3') {
      message.error('强监管模式（managed）不允许最高自治档 L3，请选择 L1 或 L2。');
      return;
    }
    let manifest: Record<string, unknown>;
    try {
      manifest = parseJsonObject(values.manifestText, '能力声明');
    } catch {
      message.error('能力声明不是合法 JSON 对象。');
      return;
    }
    const scope = { mode: values.scopeMode, guidance: values.guidance };
    const source = {
      type: values.sourceType,
      ...(values.sourceRef?.trim() ? { ref: values.sourceRef.trim() } : {}),
    };
    const payload = {
      key: values.key.trim(),
      kind: values.kind,
      label: values.label.trim(),
      ...(values.description?.trim() ? { description: values.description.trim() } : {}),
      ...(values.version?.trim() ? { version: values.version.trim() } : {}),
      visibility: values.visibility,
      scope,
      source,
      manifest,
    };
    setSaving(true);
    try {
      if (editing !== null && editing !== 'new') {
        const { key: _ignored, ...changes } = payload;
        void _ignored;
        await capabilitiesApi.update(editing.id, changes);
        message.success('能力已更新。');
      } else {
        await capabilitiesApi.create(payload);
        message.success('能力已创建。');
      }
      setEditing(null);
      void refetch();
    } catch (err) {
      showApiError(err, '保存能力失败，请稍后重试。');
    } finally {
      setSaving(false);
    }
  }

  async function toggleEnabled(cap: Capability) {
    setBusyId(cap.id);
    try {
      await capabilitiesApi.update(cap.id, { enabled: !cap.enabled });
      message.success(cap.enabled ? '能力已停用。' : '能力已启用。');
      void refetch();
    } catch (err) {
      showApiError(err, '更新启用状态失败，请稍后重试。');
    } finally {
      setBusyId(null);
    }
  }

  async function removeCap(cap: Capability) {
    setBusyId(cap.id);
    try {
      await capabilitiesApi.remove(cap.id);
      message.success('能力已删除。');
      void refetch();
    } catch (err) {
      showApiError(err, '删除能力失败，请稍后重试。');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div data-testid="capabilities-page">
      <Typography.Title level={3}>中台管控 · 能力注册表</Typography.Title>
      <Paragraph type="secondary">
        登记 skill / MCP / 智能体 / 模型渠道等能力，查看分层配置如何合并生效与策略结论。
      </Paragraph>

      <CapabilityTableCard
        capabilities={capabilities}
        isLoading={isLoading}
        isFetching={isFetching}
        error={error}
        admin={admin}
        busyId={busyId}
        onRefresh={() => void refetch()}
        onCreate={openCreate}
        onEdit={openEdit}
        onToggle={(cap) => void toggleEnabled(cap)}
        onRemove={(cap) => void removeCap(cap)}
      />

      <CapabilityFormModal
        open={editing !== null}
        isNew={editing === 'new'}
        form={form}
        saving={saving}
        onCancel={() => setEditing(null)}
        onSubmit={(v) => void submitForm(v)}
      />

      <CapabilityResolveCard capabilities={capabilities} />
      <CapabilityDumpCard capabilities={capabilities} />
    </div>
  );
}
