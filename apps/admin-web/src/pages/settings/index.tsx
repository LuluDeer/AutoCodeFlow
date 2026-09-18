import { useState, useEffect } from 'react';
import {
  Card, Input, Button, Space, message, Typography, Tag, Alert,
  Switch, Modal, Tabs, Table, Form, Select, Tooltip, Popconfirm,
  Divider, Badge, theme,
} from 'antd';
import {
  KeyOutlined, CopyOutlined, EyeOutlined, EyeInvisibleOutlined,
  PlusOutlined, EditOutlined, DeleteOutlined, HistoryOutlined,
  ReloadOutlined, RobotOutlined, ThunderboltOutlined, SafetyCertificateOutlined,
  ApiOutlined, BellOutlined,
} from '@ant-design/icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { configApi, SystemConfig, ConfigHistory } from '../../api/config';
import { aiApi, SaveAiConfigPayload } from '../../api/ai';
import { getErrMsg } from '../../utils/error';
// F-26（DEEP_REVIEW 0ef3bbe）：locale 单一来源，不再硬编码 zh-CN
import { currentLocale } from '../../utils/locale';
import { copyText } from '../../utils/clipboard';
import { useAuthStore, isAdminUser } from '../../store/auth';
import type { ColumnsType } from 'antd/es/table';
import PageHeader from '../../components/PageHeader';
// UX-08：整页加载改用骨架屏（UI-08 契约「骨架屏替代 Spin」）。
import PageSkeleton from '../../components/PageSkeleton';
import StateError from '../../components/StateError';
// SEC-03: 安全设置 Tab（TOTP 两步验证 + 登录会话管理），独立文件避免与其他 Tab 耦合
import SecuritySettings from './SecuritySettings';
// AUTH-03: API Keys Tab（限权机器凭证管理），独立文件
import ApiKeysSettings from './ApiKeysSettings';
// FEAT-15: 事件订阅 Tab（webhook 出站事件 + 死信 replay），独立文件
import EventSubscriptionsSettings from './EventSubscriptionsSettings';
import { useTranslation } from 'react-i18next';
// UI-10：导入 i18n 实例（模块副作用完成初始化；树内用 useTranslation 读 key）
import '../../i18n';

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
  const { t } = useTranslation();

  // R4 收紧矩阵：共享 Token 的读与生成为 ADMIN-only。
  // 非管理员不发起查询（GET 会 403），hooks 仍按固定顺序调用。
  const { data: tokenResult, isLoading, error: tokenError, refetch: refetchToken } = useQuery({
    queryKey: ['executor-token'],
    queryFn: () => configApi.getExecutorToken(),
    enabled: isAdmin,
  });

  const { mutateAsync: generate, isPending: generating } = useMutation({
    mutationFn: configApi.generateExecutorToken,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['executor-token'] }),
    // UI-15：生成失败反馈（handleGenerate 的 onOk await 链会 reject，
    // 但 antd Modal.confirm 静默吞掉该 rejection——必须显式 onError）
    onError: (err: unknown) => {
      message.error(getErrMsg(err, t('sysSettings.token.genFail')));
    },
  });

  const handleGenerate = () => {
    Modal.confirm({
      title: t('sysSettings.token.genTitle'),
      content: t('sysSettings.token.genContent'),
      okText: t('sysSettings.token.genOk'),
      okButtonProps: { danger: true },
      onOk: async () => {
        await generate();
        message.success(t('sysSettings.token.genSuccess'));
      },
    });
  };

  if (!isAdmin) {
    return (
      <Card title={<Space><KeyOutlined /> {t('sysSettings.token.cardTitle')}</Space>} style={{ marginBottom: 16 }}>
        <Alert
          type="info"
          title={t('sysSettings.token.adminOnly')}
          description={t('sysSettings.token.contactAdmin')}
          showIcon
        />
      </Card>
    );
  }

  // UX-08（本轮体验审查）：整页加载此前是裸 <Spin />（无文案、无骨架、无
  // 占位尺寸）——页面内容区从 0 高度突然撑开，且与全站其它页的骨架屏不一致。
  // UI-08 契约明确要求「骨架屏替代 Spin」。
  if (isLoading) return <PageSkeleton variant="table" rows={6} />;

  // UI-16：Token 读请求失败 → 页内错误块（重试=refetch）；此前失败只会停在一个空 Spin
  if (tokenError) {
    return (
      <Card title={<Space><KeyOutlined /> {t('sysSettings.token.cardTitle')}</Space>} style={{ marginBottom: 16 }}>
        <StateError
          error={tokenError}
          title={t('sysSettings.token.loadFail')}
          onRetry={() => { void refetchToken(); }}
        />
      </Card>
    );
  }

  const token = tokenResult?.token ?? null;
  const hasToken = tokenResult?.hasToken ?? false;

  return (
    <Card title={<Space><KeyOutlined /> {t('sysSettings.token.cardTitle')}</Space>} style={{ marginBottom: 16 }}>
      <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
        {t('sysSettings.token.desc')}
      </Text>

      {hasToken ? (
        <Space orientation="vertical" style={{ width: '100%' }}>
          {/* UI 打磨：原 Input 定宽 360 + 两按钮在窄屏（≤480）撑破卡片 →
              flex 容器 + Input 弹性伸缩（minWidth 180）+ 换行兜底 */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <Input
              readOnly
              value={tokenVisible ? (token || '') : '•'.repeat(40)}
              style={{ flex: 1, minWidth: 180, width: 'auto', fontFamily: 'monospace', fontSize: 13 }}
            />
            <Button
              icon={tokenVisible ? <EyeInvisibleOutlined /> : <EyeOutlined />}
              onClick={() => setTokenVisible(v => !v)}
            />
            {tokenVisible && (
              <Button
                icon={<CopyOutlined />}
                onClick={async () => {
                  // F-18（DEEP_REVIEW 0ef3bbe）：补错误处理——失败不弹成功提示。
                  const ok = await copyText(token || '');
                  if (ok) message.success(t('sysSettings.token.copied'));
                  else message.error(t('common.copyFailed'));
                }}
              >
                {t('sysSettings.token.copy')}
              </Button>
            )}
          </div>
          <Button danger loading={generating} onClick={handleGenerate} disabled={!isAdmin}>
            {t('sysSettings.token.regenerate')}
          </Button>
          <Alert
            type="warning"
            title={t('sysSettings.token.regenerateWarning')}
            showIcon
          />
        </Space>
      ) : (
        <Space orientation="vertical">
          <Alert
            type="info"
            title={t('sysSettings.token.notGenerated')}
            showIcon
          />
          <Tooltip title={isAdmin ? undefined : t('sysSettings.token.genAdminOnly')}>
            <Button
              type="primary"
              icon={<KeyOutlined />}
              loading={generating}
              onClick={handleGenerate}
              disabled={!isAdmin}
            >
              {t('sysSettings.token.generate')}
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
  const { t } = useTranslation();

  const { mutateAsync: save, isPending } = useMutation({
    mutationFn: configApi.upsert,
    onSuccess: () => {
      message.success(isNew ? t('sysSettings.config.added') : t('sysSettings.config.updated'));
      onSaved();
    },
    // UI-15：保存失败反馈（Modal 保持打开由 handleOk await 链承担，
    // onError 补 toast 保证失败原因可见且不依赖调用形态）
    onError: (err: unknown) => {
      message.error(getErrMsg(err, isNew ? t('sysSettings.config.addFail') : t('sysSettings.config.updateFail')));
    },
  });

  const handleOk = async () => {
    const vals = await form.validateFields();
    await save(vals);
  };

  return (
    <Modal
      open
      title={isNew ? t('sysSettings.modal.addTitle') : t('sysSettings.modal.editTitle', { key: record?.key })}
      onCancel={onClose}
      onOk={handleOk}
      confirmLoading={isPending}
      okText={t('sysSettings.save')}
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={record ?? { valueType: 'string', isSecret: false }}
      >
        <Form.Item name="key" label={t('sysSettings.config.field.key')} rules={[{ required: true, message: t('sysSettings.required') }]}>
          <Input disabled={!isNew} placeholder={t('sysSettings.config.field.keyPlaceholder')} />
        </Form.Item>
        <Form.Item name="value" label={t('sysSettings.config.field.value')} rules={[{ required: true, message: t('sysSettings.required') }]}>
          <Input.TextArea rows={3} />
        </Form.Item>
        <Form.Item name="valueType" label={t('sysSettings.config.field.type')}>
          <Select options={[
            { value: 'string', label: t('sysSettings.config.type.string') },
            { value: 'number', label: t('sysSettings.config.type.number') },
            { value: 'boolean', label: t('sysSettings.config.type.boolean') },
            { value: 'json', label: t('sysSettings.config.type.json') },
          ]} />
        </Form.Item>
        <Form.Item name="description" label={t('sysSettings.config.field.desc')}>
          <Input />
        </Form.Item>
        <Form.Item name="tag" label={t('sysSettings.config.field.tag')}>
          <Input placeholder={t('sysSettings.config.field.tagPlaceholder')} />
        </Form.Item>
        <Form.Item name="isSecret" label={t('sysSettings.config.field.secret')} valuePropName="checked">
          <Switch />
        </Form.Item>
      </Form>
    </Modal>
  );
}

// ─── Config History Drawer ────────────────────────────────────────────────────
function HistoryModal({ configKey, onClose }: { configKey: string; onClose: () => void }) {
  // SEC-CFG-01 收紧 GET /config/history 为 ADMIN-only 后，本查询同样不做 enabled
  // 门控：非管理员本就不渲染「回滚」按钮（既有用例钉住），但仍可打开历史抽屉
  // 看到只读记录；服务端 403 由下方 historyError 呈现。
  const isAdmin = useIsAdmin();
  const { data, isLoading, error: historyError, refetch: refetchHistory } = useQuery({
    queryKey: ['config-history', configKey],
    queryFn: () => configApi.getHistory({ key: configKey, pageSize: 50 }),
  });
  const { t } = useTranslation();

  const qc = useQueryClient();
  // FEAT-08：回滚目标 id 状态实现逐行 loading（多行不共用同一个 spinner）。
  const [rollingId, setRollingId] = useState<number | null>(null);
  const { mutateAsync: rollback } = useMutation({
    mutationFn: (id: number) => configApi.rollback(id),
    onSuccess: () => {
      message.success(t('sysSettings.history.rolledBack'));
      // 刷新当前配置读面 + 历史列表（回滚本身也会写一条 rollback 历史）
      qc.invalidateQueries({ queryKey: ['system-configs'] });
      qc.invalidateQueries({ queryKey: ['config-history', configKey] });
    },
    // 失败提示由 api/client.ts 响应拦截器统一 toast（含 400/403 后端文案），
    // 这里仅复位逐行 loading，避免双重报错。
    onSettled: () => setRollingId(null),
    // UI-15：兜底 onError 补齐（与上方注记一致——统一 toast 已覆盖，
    // 显式 onError 保证不依赖 client 拦截器行为也必有反馈）。
    onError: (err: unknown) => {
      message.error(getErrMsg(err, t('sysSettings.history.rollbackFail')));
    },
  });

  const handleRollback = (id: number) => {
    // UI-15：Popconfirm onConfirm 返回 Promise 时 rc-confirm 会 await 并在
    // reject 时静默复位按钮——reject 链必须有终点（mutation onError 已 toast）。
    setRollingId(id);
    rollback(id).catch(() => undefined);
  };

  const cols: ColumnsType<ConfigHistory> = [
    { title: t('sysSettings.history.col.time'), dataIndex: 'createdAt', width: 170,
      render: (v: string) => v ? new Date(v).toLocaleString(currentLocale()) : '-' },
    { title: t('sysSettings.history.col.operator'), dataIndex: 'username', width: 100, render: (v: string) => v ?? t('sysSettings.history.system') },
    { title: t('sysSettings.history.col.action'), dataIndex: 'action', width: 70,
      render: (v: ConfigHistory['action']) => v === 'create' ? t('sysSettings.history.action.create')
        : v === 'delete' ? t('sysSettings.history.action.delete') : v === 'rollback' ? t('sysSettings.history.action.rollback') : t('sysSettings.history.action.update') },
    { title: t('sysSettings.history.col.old'), dataIndex: 'oldValue', ellipsis: true, minWidth: 110, render: (v: string) => v ?? <Text type="secondary">-</Text> },
    { title: t('sysSettings.history.col.new'), dataIndex: 'newValue', ellipsis: true, minWidth: 110, render: (v: string) => v ?? <Text type="secondary">-</Text> },
    { title: '', width: 80,
      render: (_: unknown, row: ConfigHistory) => {
        if (!isAdmin) return null;
        // 创建条目（oldValue 为 null）回滚=删除该配置项，禁用并说明。
        const disabled = row.oldValue == null;
        return (
          <Popconfirm
            title={t('sysSettings.history.rollbackConfirm')}
            description={row.action === 'create' ? t('sysSettings.history.rollbackCreateDesc') : undefined}
            onConfirm={() => handleRollback(row.id)}
            okText={t('sysSettings.history.rollback')}
            okButtonProps={{ danger: true }}
            disabled={disabled}
          >
            <Tooltip title={disabled ? t('sysSettings.history.noRollbackValue') : undefined}>
              <Button size="small" loading={rollingId === row.id} disabled={disabled}>{t('sysSettings.history.rollback')}</Button>
            </Tooltip>
          </Popconfirm>
        );
      } },
  ];

  return (
    <Modal open title={t('sysSettings.history.title', { key: configKey })} onCancel={onClose} footer={null} width={720}>
      {historyError ? (
        <StateError
          error={historyError}
          title={t('sysSettings.history.loadFail')}
          onRetry={() => { void refetchHistory(); }}
        />
      ) : (
        <Table
          loading={isLoading}
          dataSource={data?.data ?? []}
          rowKey="id"
          columns={cols}
          size="small"
          pagination={false}
          // UI 打磨：定宽列合计 420（170+100+70+80）+ 新旧值两弹性列最小宽 ≈110×2
          // → 640，窄 Modal 下横向滚动兜底（纵向 y 保留）
          scroll={{ x: 640, y: 400 }}
        />
      )}
    </Modal>
  );
}

// ─── System Config Tab ────────────────────────────────────────────────────────
function SystemConfigTab() {
  const [editTarget, setEditTarget] = useState<SystemConfig | null | 'new'>();
  const [historyKey, setHistoryKey] = useState<string | null>(null);
  const qc = useQueryClient();
  const isAdmin = useIsAdmin();
  const { t } = useTranslation();

  // SEC-CFG-01 收紧 GET /config 为 ADMIN-only 后，本查询**不做** enabled 门控：
  // 本页对非管理员是「只读视图 + 禁用写入口」的既有设计（下方所有写按钮都按
  // isAdmin 禁用，非管理员本就看不到回滚入口——既有用例
  // settings.history-rollback「非管理员：不渲染回滚入口」钉住了该契约）。
  // 服务端 403 由下方 configError → StateError 呈现，比空列表更诚实。
  const { data: configs, isLoading, refetch, error: configError } = useQuery({
    queryKey: ['system-configs'],
    queryFn: () => configApi.findAll(),
  });

  const { mutateAsync: remove } = useMutation({
    mutationFn: configApi.remove,
    onSuccess: () => {
      message.success(t('sysSettings.config.deleted'));
      qc.invalidateQueries({ queryKey: ['system-configs'] });
    },
    // UI-15：删除失败反馈（对齐回滚 onError 形态）
    onError: (err: unknown) => {
      message.error(getErrMsg(err, t('sysSettings.config.deleteFail')));
    },
  });

  const cols: ColumnsType<SystemConfig> = [
    { title: t('sysSettings.config.col.key'), dataIndex: 'key', width: 220, ellipsis: true,
      render: (v: string) => <Text code style={{ fontSize: 12 }}>{v}</Text> },
    { title: t('sysSettings.config.col.value'), dataIndex: 'value', ellipsis: true,
      render: (v: string, r: SystemConfig) => r.isSecret
        ? <Text type="secondary">••••••</Text>
        : (v ?? <Text type="secondary">-</Text>) },
    { title: t('sysSettings.config.col.type'), dataIndex: 'valueType', width: 80,
      render: (v: string) => <Tag>{v}</Tag> },
    { title: t('sysSettings.config.col.tag'), dataIndex: 'tag', width: 100,
      render: (v: string) => v ? <Tag color="blue">{v}</Tag> : null },
    { title: t('sysSettings.config.col.desc'), dataIndex: 'description', ellipsis: true,
      render: (v: string) => v ? <Text type="secondary" style={{ fontSize: 12 }}>{v}</Text> : null },
    { title: '', width: 120,
      render: (_: unknown, row: SystemConfig) => (
        <Space size={4}>
          <Tooltip title={isAdmin ? t('sysSettings.config.edit') : t('sysSettings.config.editAdminOnly')}>
            <Button size="small" icon={<EditOutlined />} onClick={() => setEditTarget(row)} disabled={!isAdmin} />
          </Tooltip>
          <Tooltip title={t('sysSettings.history.tooltip')}>
            <Button size="small" icon={<HistoryOutlined />} onClick={() => setHistoryKey(row.key)} />
          </Tooltip>
          <Popconfirm title={t('sysSettings.config.deleteConfirm')} onConfirm={() => remove(row.key)} okText={t('sysSettings.config.delete')} okButtonProps={{ danger: true }} disabled={!isAdmin}>
            <Tooltip title={isAdmin ? t('sysSettings.config.delete') : t('sysSettings.config.deleteAdminOnly')}>
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
        <Text type="secondary">{t('sysSettings.config.desc')}</Text>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => refetch()}>{t('sysSettings.refresh')}</Button>
          <Tooltip title={isAdmin ? undefined : t('sysSettings.config.addAdminOnly')}>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditTarget('new')} disabled={!isAdmin}>
              {t('sysSettings.config.add')}
            </Button>
          </Tooltip>
        </Space>
      </div>
      {/* UI-16：配置列表请求失败 → 页内错误块（重试=refetch）；失败态不再落「暂无数据」空表 */}
      {configError ? (
        <StateError
          error={configError}
          title={t('sysSettings.config.loadFail')}
          onRetry={() => { void refetch(); }}
        />
      ) : (
        <Table
          loading={isLoading}
          dataSource={list}
          rowKey="id"
          columns={cols}
          size="small"
          pagination={{ pageSize: 20, showTotal: (n) => t('sysSettings.config.count', { count: n }) }}
        />
      )}
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
  const { t } = useTranslation();
  // F-15（DEEP_REVIEW 0ef3bbe）：分隔文字次要色走 antd token，暗色主题自适应。
  const { token } = theme.useToken();

  // R6 收紧矩阵：GET /ai/config 为 ADMIN-only。
  // 非管理员不发起查询（GET 会 403），hooks 仍按固定顺序调用（同 TokenSection 模式）。
  const { data: cfg, isLoading, error: cfgError, refetch: refetchCfg } = useQuery({
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
      message.success(t('sysSettings.ai.saved'));
      qc.invalidateQueries({ queryKey: ['ai-config'] });
    },
    // UI-15：保存失败反馈（handleSave await 链的 rejection 无人消费时兜底）
    onError: (err: unknown) => {
      message.error(getErrMsg(err, t('sysSettings.ai.saveFail')));
    },
  });

  const { mutateAsync: test, isPending: testing } = useMutation({
    mutationFn: () => aiApi.testConfig(),
    onSuccess: (res) => setTestResult(res),
    onError: () => setTestResult({ ok: false, message: t('sysSettings.ai.testFailMsg') }),
  });
  const provider = Form.useWatch('provider', form);

  const handleSave = async () => {
    // UI-15：保存失败反馈（rejection 在此消费，防 unhandled rejection）
    try {
      const vals = await form.validateFields();
      await save(vals as SaveAiConfigPayload);
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'errorFields' in err) return;
      message.error(getErrMsg(err, t('sysSettings.ai.saveFail')));
    }
  };

  const providerBadge = () => {
    if (!cfg) return null;
    const p = cfg.provider;
    if (p === 'disabled') return <Badge status="default" text={t('sysSettings.ai.provider.disabled')} />;
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
        title={t('sysSettings.ai.adminOnly')}
        description={t('sysSettings.ai.adminDetail')}
      />
    );
  }

  return (
    <div>
      <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
        <Text type="secondary">{t('sysSettings.ai.desc')}</Text>
        {providerBadge()}
      </div>

      {isLoading ? (
        // UX-08（本轮体验审查）：UI-08 契约是「骨架屏替代 Spin」——本页是
        // 整块表单，裸 Spin 会让内容区从 0 高度突然撑开（布局跳动），
        // 用户也看不出"将要出现什么"。改用与最终形态同构的表单骨架。
        <PageSkeleton variant="table" rows={5} />
      ) : cfgError ? (
        // UI-16：AI 配置读请求失败 → 页内错误块（重试=refetch），不落在永久 Spin 上
        <StateError
          error={cfgError}
          title={t('sysSettings.ai.loadFail')}
          onRetry={() => { void refetchCfg(); }}
        />
      ) : (
        <Form form={form} layout="vertical" initialValues={{ provider: 'disabled', openaiModel: 'gpt-4o-mini', openaiBaseUrl: 'https://api.openai.com/v1', ollamaHost: 'http://localhost:11434', ollamaModel: 'llama3' }}>
          <Form.Item name="provider" label={t('sysSettings.ai.providerLabel')} rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'disabled', label: t('sysSettings.ai.provider.disabledOption') },
                { value: 'openai', label: t('sysSettings.ai.provider.openaiOption') },
                { value: 'ollama', label: t('sysSettings.ai.provider.ollamaOption') },
              ]}
            />
          </Form.Item>

          {provider === 'openai' && (
            <>
              <Divider plain style={{ fontSize: 12, color: token.colorTextTertiary }}>{t('sysSettings.ai.openaiSection')}</Divider>
              <Form.Item
                name="openaiBaseUrl"
                label="API Base URL"
                tooltip={t('sysSettings.ai.baseUrlTooltip')}
              >
                <Input placeholder="https://api.openai.com/v1" />
              </Form.Item>
              <Form.Item
                name="openaiApiKey"
                label={
                  <Space>
                    API Key
                    {cfg?.hasApiKey && <Tag color="green">{t('sysSettings.ai.configured')}</Tag>}
                  </Space>
                }
                tooltip={t('sysSettings.ai.apiKeyTooltip')}
              >
                <Input.Password
                  placeholder={cfg?.hasApiKey ? t('sysSettings.ai.apiKeyConfiguredPlaceholder') : t('sysSettings.ai.apiKeyPlaceholder')}
                  visibilityToggle={{ visible: apiKeyVisible, onVisibleChange: setApiKeyVisible }}
                />
              </Form.Item>
              <Form.Item name="openaiModel" label={t('sysSettings.ai.modelLabel')}>
                <Input placeholder="gpt-4o-mini" />
              </Form.Item>
            </>
          )}

          {provider === 'ollama' && (
            <>
              <Divider plain style={{ fontSize: 12, color: token.colorTextTertiary }}>{t('sysSettings.ai.ollamaSection')}</Divider>
              <Form.Item name="ollamaHost" label="Ollama Host">
                <Input placeholder="http://localhost:11434" />
              </Form.Item>
              <Form.Item name="ollamaModel" label={t('sysSettings.ai.modelLabel')}>
                <Input placeholder="llama3" />
              </Form.Item>
            </>
          )}

          <Form.Item style={{ marginTop: 8 }}>
            <Space>
              <Button type="primary" loading={saving} onClick={handleSave}>{t('sysSettings.ai.save')}</Button>
              {provider !== 'disabled' && (
                <Button
                  icon={<ThunderboltOutlined />}
                  loading={testing}
                  onClick={() => { setTestResult(null); test(); }}
                >
                  {t('sysSettings.ai.test')}
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
          title={testResult.ok ? t('sysSettings.ai.testSuccess') : t('sysSettings.ai.testFailed')}
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
          title={t('sysSettings.ai.analysisNote')}
          style={{ marginTop: 16 }}
        />
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function SettingsPage() {
  const isAdmin = useIsAdmin();
  const { t } = useTranslation();

  const tabs = [
    // R4 收紧矩阵：共享 Token 读/生成 ADMIN-only，非管理员直接不渲染该 Tab
    ...(isAdmin
      ? [{ key: 'token', label: <Space><KeyOutlined />{t('sysSettings.tab.token')}</Space>, children: <TokenSection /> }]
      : []),
    {
      key: 'ai',
      label: <Space><RobotOutlined />{t('sysSettings.tab.ai')}</Space>,
      children: <AiConfigTab />,
    },
    {
      key: 'config',
      label: t('sysSettings.tab.config'),
      children: <SystemConfigTab />,
    },
    // SEC-03: 安全设置（TOTP + 会话管理）——所有登录用户可用（仅涉及本人账号），
    // 置于末位 Tab：不改变既有 Tab 排序/默认激活行为（settings.ai 等既有测试依赖）
    {
      key: 'security',
      label: <Space><SafetyCertificateOutlined />{t('sysSettings.tab.security')}</Space>,
      children: <SecuritySettings />,
    },
    // AUTH-03: 限权 API Key 管理（CI/CD 机器认证）——所有登录用户管理本人 Key；
    // 放在安全设置之后，不改变既有 Tab 默认激活行为
    {
      key: 'api-keys',
      label: <Space><ApiOutlined />{t('sysSettings.tab.apikeys')}</Space>,
      children: <ApiKeysSettings />,
    },
    // FEAT-15: 事件订阅（webhook 出站 + 死信 replay）——ADMIN 看全部、普通用户
    // 看自己的 + 系统级（后端读面语义），置于末位不改变既有 Tab 默认激活行为
    {
      key: 'event-subscriptions',
      label: <Space><BellOutlined />{t('sysSettings.tab.events')}</Space>,
      children: <EventSubscriptionsSettings />,
    },
  ];

  return (
    // UI 打磨（用户反馈）：去掉 maxWidth 900——本页多数 Tab（系统配置/API Keys/
    // 安全/事件订阅）是宽表格，900 上限在宽屏右侧留大片空白，与其它整宽页不一致
    <div>
      {/* UI-03/UI-08：页头标准化（原 Title+描述迁入 PageHeader；非管理员提示保留页头下方） */}
      <PageHeader
        title={t('sysSettings.title')}
        description={t('sysSettings.description')}
      />
      {!isAdmin && (
        <Alert
          type="info"
          showIcon
          title={t('sysSettings.nonAdminTip')}
          style={{ marginBottom: 16 }}
        />
      )}
      <Tabs items={tabs} />
    </div>
  );
}
