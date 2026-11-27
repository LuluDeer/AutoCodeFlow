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
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';

const { Text, Paragraph } = Typography;

type Translate = import('i18next').TFunction;

/** 选项/映射表的文案在渲染期由组件 hook 的 t 构造，语言切换即时生效。 */
const kindOptions = (t: Translate): Array<{ value: CapabilityKind; label: string }> => [
  { value: 'skill', label: t('capabilities.kind.skill') },
  { value: 'mcp', label: t('capabilities.kind.mcp') },
  { value: 'agent', label: t('capabilities.kind.agent') },
  { value: 'provider', label: t('capabilities.kind.provider') },
  { value: 'template', label: t('capabilities.kind.template') },
];
const visibilityOptions = (t: Translate): Array<{ value: CapabilityVisibility; label: string }> => [
  { value: 'global', label: t('capabilities.visibility.global') },
  { value: 'project', label: t('capabilities.visibility.project') },
  { value: 'private', label: t('capabilities.visibility.private') },
];
const modeOptions = (t: Translate): Array<{ value: CapabilityScopeMode; label: string }> => [
  { value: 'managed', label: t('capabilities.scope.managed') },
  { value: 'supervised', label: t('capabilities.scope.supervised') },
  { value: 'self_service', label: t('capabilities.scope.selfService') },
];
const guidanceOptions = (t: Translate): Array<{ value: CapabilityGuidance; label: string }> => [
  { value: 'L1', label: t('capabilities.guidance.l1') },
  { value: 'L2', label: t('capabilities.guidance.l2') },
  { value: 'L3', label: t('capabilities.guidance.l3') },
];
/**
 * N25：选项 value 由 CapabilitySourceType 约束；八源闭包由后端 source-policy
 * 单一事实源派生，主控统一回填前端派生类型前，新源值用类型断言保持本切片可编译。
 */
const sourceOptions = (t: Translate): Array<{ value: CapabilitySourceType; label: string }> => [
  { value: 'builtin', label: t('capabilities.source.builtin') },
  { value: 'registry', label: t('capabilities.source.registry') },
  { value: 'git', label: t('capabilities.source.git') },
  { value: 'folder', label: t('capabilities.source.folder') },
  { value: 'npm' as CapabilitySourceType, label: t('capabilities.source.npm') },
  { value: 'github' as CapabilitySourceType, label: t('capabilities.source.github') },
  { value: 'server' as CapabilitySourceType, label: t('capabilities.source.server') },
  { value: 'mcp:' as CapabilitySourceType, label: t('capabilities.source.mcp') },
];
function decisionLabel(t: Translate, decision: string): string {
  switch (decision) {
    case 'allow':
      return t('capabilities.decision.allow');
    case 'ask':
      return t('capabilities.decision.ask');
    case 'deny':
      return t('capabilities.decision.deny');
    default:
      return decision;
  }
}
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
    message.error(i18n.t('capabilities.parse.invalidJson', { label }));
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
  onTransfer: (cap: Capability) => void;
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
  onTransfer,
}: CapabilityTableCardProps) {
  const { t } = useTranslation();
  return (
    <>
      <Space style={{ marginBottom: 16 }} wrap>
        <Button icon={<ReloadOutlined />} loading={isFetching} onClick={onRefresh}>
          {t('capabilities.refresh')}
        </Button>
        {admin ? (
          <Button type="primary" icon={<PlusOutlined />} onClick={onCreate}>
            {t('capabilities.create')}
          </Button>
        ) : null}
      </Space>

      {error ? (
        <Alert type="error" showIcon message={t('capabilities.loadFailed')} style={{ marginBottom: 16 }} />
      ) : null}

      <Card title={t('capabilities.list.title')} style={{ marginBottom: 16 }}>
        <Table<Capability>
          data-testid="capabilities-table"
          rowKey="id"
          loading={isLoading}
          dataSource={capabilities}
          pagination={false}
          locale={{ emptyText: t('capabilities.empty') }}
          columns={[
            { title: t('capabilities.col.key'), dataIndex: 'key', key: 'key' },
            {
              title: t('capabilities.col.kind'),
              dataIndex: 'kind',
              key: 'kind',
              render: (v: string) => <Tag color="blue">{v}</Tag>,
            },
            { title: t('capabilities.col.label'), dataIndex: 'label', key: 'label' },
            { title: t('capabilities.col.version'), dataIndex: 'version', key: 'version' },
            {
              title: t('capabilities.col.visibility'),
              dataIndex: 'visibility',
              key: 'visibility',
              render: (v: string) => <Tag>{v}</Tag>,
            },
            {
              title: t('capabilities.col.scope'),
              key: 'scope',
              render: (_: unknown, row: Capability) => (
                <span data-testid={`cap-scope-${row.key}`}>
                  {row.scope?.mode ?? '—'} × {row.scope?.guidance ?? '—'}
                </span>
              ),
            },
            {
              title: t('capabilities.col.enabled'),
              dataIndex: 'enabled',
              key: 'enabled',
              render: (v: boolean) => (
                <Tag color={v ? 'green' : 'default'}>{v ? t('capabilities.enabled') : t('capabilities.disabled')}</Tag>
              ),
            },
            ...(admin
              ? [
                  {
                    title: t('capabilities.col.actions'),
                    key: 'actions',
                    render: (_: unknown, row: Capability) => (
                      <Space size={4}>
                        <Button
                          type="link"
                          size="small"
                          icon={<EditOutlined aria-hidden />}
                          onClick={() => onEdit(row)}
                        >
                          {t('capabilities.edit')}
                        </Button>
                        <Button
                          type="link"
                          size="small"
                          aria-label={t('capabilities.transfer.aria', { key: row.key })}
                          onClick={() => onTransfer(row)}
                        >
                          {t('capabilities.transfer')}
                        </Button>
                        <Button
                          type="link"
                          size="small"
                          loading={busyId === row.id}
                          onClick={() => onToggle(row)}
                        >
                          {row.enabled ? t('capabilities.toggle.disable') : t('capabilities.toggle.enable')}
                        </Button>
                        <Popconfirm
                          title={t('capabilities.delete.confirm')}
                          okText={t('capabilities.delete.confirmOk')}
                          cancelText={t('capabilities.cancel')}
                          onConfirm={() => onRemove(row)}
                        >
                          <Button
                            type="link"
                            size="small"
                            danger
                            icon={<DeleteOutlined aria-hidden />}
                            aria-label={t('capabilities.delete.aria', { key: row.key })}
                          >
                            {t('capabilities.delete')}
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
  const { t } = useTranslation();
  return (
    <Modal
      title={isNew ? t('capabilities.form.create') : t('capabilities.form.edit')}
      open={open}
      forceRender
      okText={t('capabilities.submit')}
      cancelText={t('capabilities.cancel')}
      confirmLoading={saving}
      onCancel={onCancel}
      onOk={() => void form.submit()}
      data-testid="capability-form-modal"
    >
      <Form form={form} layout="vertical" onFinish={onSubmit}>
        <Form.Item
          label={t('capabilities.field.key')}
          name="key"
          rules={[{ required: true, message: t('capabilities.field.key.required') }]}
        >
          <Input data-testid="cap-key" disabled={!isNew} />
        </Form.Item>
        <Form.Item label={t('capabilities.field.kind')} name="kind" rules={[{ required: true }]}>
          <Select data-testid="cap-kind" options={kindOptions(t)} />
        </Form.Item>
        <Form.Item
          label={t('capabilities.field.label')}
          name="label"
          rules={[{ required: true, message: t('capabilities.field.label.required') }]}
        >
          <Input data-testid="cap-label" />
        </Form.Item>
        <Form.Item label={t('capabilities.field.description')} name="description">
          <Input.TextArea data-testid="cap-description" rows={2} />
        </Form.Item>
        <Form.Item label={t('capabilities.field.version')} name="version">
          <Input data-testid="cap-version" />
        </Form.Item>
        <Form.Item label={t('capabilities.field.visibility')} name="visibility" rules={[{ required: true }]}>
          <Select data-testid="cap-visibility" options={visibilityOptions(t)} />
        </Form.Item>
        <Form.Item label={t('capabilities.field.scopeMode')} name="scopeMode" rules={[{ required: true }]}>
          <Select data-testid="cap-scope-mode" options={modeOptions(t)} />
        </Form.Item>
        <Form.Item label={t('capabilities.field.guidance')} name="guidance" rules={[{ required: true }]}>
          <Select data-testid="cap-guidance" options={guidanceOptions(t)} />
        </Form.Item>
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message={t('capabilities.form.managedWarning')}
        />
        <Form.Item label={t('capabilities.field.sourceType')} name="sourceType" rules={[{ required: true }]}>
          <Select data-testid="cap-source-type" options={sourceOptions(t)} />
        </Form.Item>
        <Form.Item label={t('capabilities.field.sourceRef')} name="sourceRef">
          <Input data-testid="cap-source-ref" />
        </Form.Item>
        <Form.Item
          label={t('capabilities.field.manifest')}
          name="manifestText"
          rules={[{ required: true, message: t('capabilities.field.manifest.required') }]}
        >
          <Input.TextArea data-testid="cap-manifest" rows={8} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

/** 配置解析（resolve）区：三层配置 → 生效值与策略结论；状态自治。 */
function CapabilityResolveCard({ capabilities }: { capabilities: Capability[] }) {
  const { t } = useTranslation();
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
      setResolveError(t('capabilities.resolve.selectFirst'));
      return;
    }
    const managed = parseOptionalObject(managedText, t('capabilities.layer.managed'));
    const project = parseOptionalObject(projectText, t('capabilities.layer.project'));
    const privateLayer = parseOptionalObject(privateText, t('capabilities.layer.private'));
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
      setResolveError(t('capabilities.resolve.failed'));
      showApiError(err, t('capabilities.resolve.failedToast'));
    } finally {
      setResolving(false);
    }
  }

  return (
    <Card title={t('capabilities.resolve.title')} style={{ marginBottom: 16 }}>
      <Paragraph type="secondary">
        {t('capabilities.resolve.desc')}
      </Paragraph>
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <div>
          <div style={{ marginBottom: 4 }}>{t('capabilities.field.capability')}</div>
          <Select
            data-testid="resolve-key"
            showSearch
            style={{ width: 320 }}
            value={resolveKey || undefined}
            onChange={setResolveKey}
            options={keyOptions}
            placeholder={t('capabilities.selectCapability')}
          />
        </div>
        <div>
          <div style={{ marginBottom: 4 }}>{t('capabilities.layer.managedJson')}</div>
          <Input.TextArea
            data-testid="resolve-managed"
            rows={3}
            value={managedText}
            onChange={(e) => setManagedText(e.target.value)}
          />
        </div>
        <div>
          <div style={{ marginBottom: 4 }}>{t('capabilities.layer.projectJsonEmpty')}</div>
          <Input.TextArea
            data-testid="resolve-project"
            rows={3}
            value={projectText}
            onChange={(e) => setProjectText(e.target.value)}
          />
        </div>
        <div>
          <div style={{ marginBottom: 4 }}>{t('capabilities.layer.privateJsonEmpty')}</div>
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
          {t('capabilities.resolve.run')}
        </Button>
      </Space>
      {resolveError ? (
        <Alert type="error" showIcon message={resolveError} style={{ marginTop: 12 }} />
      ) : null}
      {resolveResult ? (
        <div data-testid="resolve-result" style={{ marginTop: 12 }}>
          <Space style={{ marginBottom: 8 }}>
            <Text>{t('capabilities.resolve.decisionLabel')}</Text>
            <Tag
              data-testid="resolve-decision"
              color={DECISION_COLOR[resolveResult.decision] ?? 'default'}
            >
              {decisionLabel(t, resolveResult.decision)}
            </Tag>
          </Space>
          <div style={{ marginBottom: 4 }}>{t('capabilities.resolve.effectiveLabel')}</div>
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
  const { t } = useTranslation();
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
      setDumpError(t('capabilities.resolve.selectFirst'));
      return;
    }
    const project = parseOptionalObject(dumpProjectText, t('capabilities.layer.project'));
    const privateLayer = parseOptionalObject(dumpPrivateText, t('capabilities.layer.private'));
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
      setDumpError(t('capabilities.dump.failed'));
      showApiError(err, t('capabilities.dump.failedToast'));
    } finally {
      setDumping(false);
    }
  }

  return (
    <Card title={t('capabilities.dump.title')}>
      <Paragraph type="secondary">
        {t('capabilities.dump.desc')}
      </Paragraph>
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <div>
          <div style={{ marginBottom: 4 }}>{t('capabilities.field.capability')}</div>
          <Select
            data-testid="dump-key"
            showSearch
            style={{ width: 320 }}
            value={dumpKey || undefined}
            onChange={setDumpKey}
            options={keyOptions}
            placeholder={t('capabilities.selectCapability')}
          />
        </div>
        <div>
          <div style={{ marginBottom: 4 }}>{t('capabilities.layer.projectJsonEmpty')}</div>
          <Input.TextArea
            data-testid="dump-project"
            rows={3}
            value={dumpProjectText}
            onChange={(e) => setDumpProjectText(e.target.value)}
          />
        </div>
        <div>
          <div style={{ marginBottom: 4 }}>{t('capabilities.layer.privateJsonEmpty')}</div>
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
          {t('capabilities.dump.export')}
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
            { title: t('capabilities.dump.col.field'), dataIndex: 'field', key: 'field' },
            {
              title: t('capabilities.dump.col.layers'),
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
              title: t('capabilities.dump.col.effective'),
              key: 'effective',
              render: (_: unknown, row: CapabilityDump['dump'][number]) =>
                formatValue(row.effective),
            },
            { title: t('capabilities.dump.col.source'), dataIndex: 'source', key: 'source' },
            { title: t('capabilities.dump.col.rule'), dataIndex: 'rule', key: 'rule' },
          ]}
        />
      ) : null}
    </Card>
  );
}

export default function CapabilitiesPage() {
  const { t } = useTranslation();
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
  const [transferTarget, setTransferTarget] = useState<Capability | null>(null);
  const [transferOwner, setTransferOwner] = useState('');
  const [transferBacker, setTransferBacker] = useState('');

  function openTransfer(cap: Capability) {
    setTransferOwner('');
    setTransferBacker('');
    setTransferTarget(cap);
  }

  function closeTransfer() {
    setTransferTarget(null);
    setTransferOwner('');
    setTransferBacker('');
  }

  async function submitTransfer() {
    if (!transferTarget || !transferOwner.trim() || !transferBacker.trim()) return;
    setBusyId(transferTarget.id);
    try {
      await capabilitiesApi.transfer(transferTarget.id, {
        owner: transferOwner.trim(),
        backer: transferBacker.trim(),
      });
      message.success(t('capabilities.transfer.success'));
      closeTransfer();
      void refetch();
    } catch (err) {
      showApiError(err, t('capabilities.transfer.failed'));
    } finally {
      setBusyId(null);
    }
  }

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
      message.error(t('capabilities.form.managedError'));
      return;
    }
    let manifest: Record<string, unknown>;
    try {
      manifest = parseJsonObject(values.manifestText, t('capabilities.form.manifestLabel'));
    } catch {
      message.error(t('capabilities.form.invalidManifest'));
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
        message.success(t('capabilities.update.success'));
      } else {
        await capabilitiesApi.create(payload);
        message.success(t('capabilities.create.success'));
      }
      setEditing(null);
      void refetch();
    } catch (err) {
      showApiError(err, t('capabilities.save.failed'));
    } finally {
      setSaving(false);
    }
  }

  async function toggleEnabled(cap: Capability) {
    setBusyId(cap.id);
    try {
      await capabilitiesApi.update(cap.id, { enabled: !cap.enabled });
      message.success(cap.enabled ? t('capabilities.toggle.disabled') : t('capabilities.toggle.enabled'));
      void refetch();
    } catch (err) {
      showApiError(err, t('capabilities.toggle.failed'));
    } finally {
      setBusyId(null);
    }
  }

  async function removeCap(cap: Capability) {
    setBusyId(cap.id);
    try {
      await capabilitiesApi.remove(cap.id);
      message.success(t('capabilities.remove.success'));
      void refetch();
    } catch (err) {
      showApiError(err, t('capabilities.remove.failed'));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div data-testid="capabilities-page">
      <Typography.Title level={3}>{t('capabilities.page.title')}</Typography.Title>
      <Paragraph type="secondary">
        {t('capabilities.page.desc')}
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
        onTransfer={openTransfer}
      />

      <CapabilityFormModal
        open={editing !== null}
        isNew={editing === 'new'}
        form={form}
        saving={saving}
        onCancel={() => setEditing(null)}
        onSubmit={(v) => void submitForm(v)}
      />

      <Modal
        title={t('capabilities.transfer.title')}
        open={transferTarget !== null}
        okText={t('capabilities.submit')}
        cancelText={t('capabilities.cancel')}
        okButtonProps={{ disabled: !transferOwner.trim() || !transferBacker.trim() }}
        confirmLoading={busyId === transferTarget?.id}
        onCancel={closeTransfer}
        onOk={() => void submitTransfer()}
        data-testid="capability-transfer-modal"
      >
        <Form layout="vertical">
          <Form.Item label={t('capabilities.transfer.owner')} required>
            <Input
              data-testid="transfer-owner"
              value={transferOwner}
              onChange={(e) => setTransferOwner(e.target.value)}
              placeholder={t('capabilities.transfer.publisher')}
            />
          </Form.Item>
          <Form.Item label={t('capabilities.transfer.backer')} required>
            <Input
              data-testid="transfer-backer"
              value={transferBacker}
              onChange={(e) => setTransferBacker(e.target.value)}
              placeholder={t('capabilities.transfer.role')}
            />
          </Form.Item>
        </Form>
      </Modal>

      <CapabilityResolveCard capabilities={capabilities} />
      <CapabilityDumpCard capabilities={capabilities} />
    </div>
  );
}
