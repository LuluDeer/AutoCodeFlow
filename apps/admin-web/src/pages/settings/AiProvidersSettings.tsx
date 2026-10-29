import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  Button,
  Card,
  Col,
  Divider,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { filterProvidersForPurpose } from './ai-provider-filter';
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { message } from '../../utils/toast';
import { showApiError } from '../../utils/error';
// WEB-5：页内原位错误态标准块（UI-16）——与 ApiKeys/EventSubscriptions/
// Security 三个同目录子页同一形态，「读失败」不再伪装成「空」。
import StateError from '../../components/StateError';
import {
  aiApi,
  type AiProviderAdminView,
  type AiProviderView,
  type AiPurpose,
  type SaveAiProviderPayload,
} from '../../api/ai';

/**
 * 模型接入与分配（推理质量轮）。
 *
 * 设计取向：**provider 只是一个 OpenAI 兼容端点**（id + baseUrl + 密钥 + 模型 +
 * 能力位），"支持视频"是接入时勾选的能力，而不是代码里的厂商分支；分配区按
 * 用途（分析 / Agent / 视频理解）各选一个模型，留空 = 跟随全局。
 *
 * 密钥读写语义：读面只有 `hasApiKey` 布尔；写面 `***`/空 = 不修改——
 * 前端不可能回显密钥，也就不该因为"没改密钥"把已保存的密钥清空。
 */
export default function AiProvidersSettings() {
  const { t } = useTranslation();
  const [data, setData] = useState<AiProviderAdminView | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<Partial<SaveAiProviderPayload> | null>(null);
  const [form] = Form.useForm<SaveAiProviderPayload>();
  /**
   * WEB-5（第 3 轮 web-ux 审计）：读取失败的**原位**错误态。
   *
   * 此前 load() 失败只弹一条 3 秒 toast，data 保持 null，页面就如实渲染成
   * 「providers 为空 + 分配下拉全空」——用户看到的是「没配模型」，实际是
   * 「没读到」。对一个配置页这是危险的误导：最可能的下一步是**重复添加一份
   * provider**（密钥再录一次）或误判「推理能力未配置」而回滚版本。
   * 与同目录三个子页（ApiKeys/EventSubscriptions/Security）的 UI-16 约定对齐：
   * 页内原位错误块 + 重试，且**不渲染**空表与分配区（"空"不得被读成事实）。
   */
  const [loadError, setLoadError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setData(await aiApi.listProviders());
    } catch (err) {
      // toast 保留（多页共用的即时反馈），但不再**只有** toast：
      // 原位错误态才是本页的事实源。
      setLoadError(err);
      showApiError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openEditor = (row?: AiProviderView) => {
    setEditing(row ? { ...row, apiKey: '***' } : { enabled: true, supportsVideo: false });
    form.setFieldsValue(
      row
        ? { ...row, apiKey: '***' }
        : {
            id: '',
            label: '',
            baseUrl: '',
            model: '',
            maxTokens: 4096,
            timeoutMs: 60000,
            supportsVideo: false,
            enabled: true,
            apiKey: '',
          },
    );
  };

  const save = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      setData(await aiApi.saveProvider(values));
      message.success(t('aiProviders.saved'));
      setEditing(null);
    } catch (err) {
      showApiError(err);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    try {
      setData(await aiApi.deleteProvider(id));
      message.success(t('aiProviders.deleted'));
    } catch (err) {
      showApiError(err);
    }
  };

  const assign = async (purpose: AiPurpose, providerId: string) => {
    try {
      setData(await aiApi.assignRoute(purpose, providerId));
      message.success(t('aiProviders.routes.saved'));
    } catch (err) {
      showApiError(err);
    }
  };

  const providers = data?.providers ?? [];
  const routes = data?.routes;

  const columns: ColumnsType<AiProviderView> = [
    {
      title: t('aiProviders.col.id'),
      dataIndex: 'id',
      width: 150,
      render: (id: string, row) => (
        <Space size={4} wrap>
          {row.label ? <Typography.Text strong>{row.label}</Typography.Text> : null}
          <Typography.Text code>{id}</Typography.Text>
          {row.legacy ? <Tag color="default">{t('aiProviders.legacy')}</Tag> : null}
        </Space>
      ),
    },
    { title: t('aiProviders.col.model'), dataIndex: 'model', width: 160 },
    { title: 'baseUrl', dataIndex: 'baseUrl', ellipsis: true },
    {
      title: t('aiProviders.col.video'),
      dataIndex: 'supportsVideo',
      width: 96,
      render: (v: boolean) => (
        <Tag color={v ? 'green' : 'default'}>
          {v ? t('aiProviders.videoYes') : t('aiProviders.videoNo')}
        </Tag>
      ),
    },
    {
      title: t('aiProviders.col.key'),
      dataIndex: 'hasApiKey',
      width: 96,
      render: (v: boolean) => (
        <Tag color={v ? 'blue' : 'orange'}>
          {v ? t('aiProviders.keyConfigured') : t('aiProviders.keyMissing')}
        </Tag>
      ),
    },
    {
      title: t('aiProviders.col.status'),
      dataIndex: 'enabled',
      width: 88,
      render: (v: boolean) => (v ? t('aiProviders.enabled') : t('aiProviders.disabled')),
    },
    {
      title: t('aiProviders.col.actions'),
      width: 150,
      render: (_v, row) => (
        <Space size={4}>
          <Button size="small" icon={<EditOutlined aria-hidden />} onClick={() => openEditor(row)}>
            {t('aiProviders.edit')}
          </Button>
          <Button
            size="small"
            danger
            icon={<DeleteOutlined aria-hidden />}
            onClick={() => {
              Modal.confirm({
                title: t('aiProviders.deleteConfirm', { id: row.id }),
                onOk: () => remove(row.id),
              });
            }}
          >
            {t('aiProviders.delete')}
          </Button>
        </Space>
      ),
    },
  ];

  const routeSelect = (purpose: AiPurpose, options: AiProviderView[]) => (
    <Col xs={24} md={8} key={purpose}>
      <div style={{ marginBottom: 4 }}>{t(`aiProviders.routes.${purpose}`)}</div>
      <Select
        style={{ width: '100%' }}
        value={routes?.[purpose]?.provider ?? ''}
        onChange={(v) => void assign(purpose, v)}
        options={[
          { value: '', label: t('aiProviders.routes.followGlobal') },
          ...options.map((p) => ({ value: p.id, label: `${p.label || p.id} · ${p.model}` })),
        ]}
      />
    </Col>
  );

  return (
    <Card
      style={{ marginTop: 16 }}
      loading={loading}
      title={t('aiProviders.title')}
      extra={
        <Button type="primary" icon={<PlusOutlined aria-hidden />} onClick={() => openEditor()}>
          {t('aiProviders.add')}
        </Button>
      }
    >
      <Typography.Paragraph type="secondary">{t('aiProviders.description')}</Typography.Paragraph>

      {loadError ? (
        // WEB-5：读失败 = 错误态，不是空态。空表与分配区在此分支里**不渲染**
        //（否则「暂无数据」会被读成「还没接入模型」）。
        <StateError
          error={loadError}
          title={t('aiProviders.loadFailed')}
          onRetry={() => void load()}
        />
      ) : (
        <>
          {(data?.errors?.length ?? 0) > 0 && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              title={t('aiProviders.errors')}
              description={data?.errors.join('；')}
            />
          )}

          <Table
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={providers}
            columns={columns}
            scroll={{ x: 900 }}
          />

          <Divider />
          <Typography.Title level={5}>{t('aiProviders.routes.title')}</Typography.Title>
          <Typography.Paragraph type="secondary">
            {t('aiProviders.routes.description')}
          </Typography.Paragraph>
          <Row gutter={16}>
            {routeSelect('analysis', filterProvidersForPurpose('analysis', providers))}
            {routeSelect('agent', filterProvidersForPurpose('agent', providers))}
            {routeSelect('video', filterProvidersForPurpose('video', providers))}
          </Row>
        </>
      )}

      <Modal
        open={editing !== null}
        title={editing?.id ? t('aiProviders.edit') : t('aiProviders.add')}
        onCancel={() => setEditing(null)}
        onOk={() => void save()}
        okText={t('aiProviders.save')}
        cancelText={t('aiProviders.cancel')}
        confirmLoading={saving}
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item
            name="id"
            label={t('aiProviders.field.id')}
            rules={[{ required: true }, { pattern: /^[a-z0-9][a-z0-9._-]{0,63}$/, message: t('aiProviders.field.id') }]}
          >
            <Input placeholder="qwen-vl" disabled={!!editing?.id} />
          </Form.Item>
          <Form.Item name="label" label={t('aiProviders.field.label')}>
            <Input placeholder="Qwen VL" />
          </Form.Item>
          <Form.Item
            name="baseUrl"
            label={t('aiProviders.field.baseUrl')}
            rules={[{ required: true }, { pattern: /^https?:\/\//i, message: t('aiProviders.field.baseUrl') }]}
          >
            <Input placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1" />
          </Form.Item>
          <Form.Item name="model" label={t('aiProviders.field.model')} rules={[{ required: true }]}>
            <Input placeholder="qwen-vl-max" />
          </Form.Item>
          <Form.Item
            name="apiKey"
            label={t('aiProviders.field.apiKey')}
            extra={t('aiProviders.keyKeepHint')}
          >
            <Input.Password placeholder="sk-..." autoComplete="new-password" />
          </Form.Item>
          <Space size={16} wrap>
            <Form.Item name="maxTokens" label={t('aiProviders.field.maxTokens')}>
              <InputNumber min={1} max={131072} />
            </Form.Item>
            <Form.Item name="timeoutMs" label={t('aiProviders.field.timeoutMs')}>
              <InputNumber min={1000} max={600000} step={1000} />
            </Form.Item>
          </Space>
          <Space size={24} wrap>
            <Form.Item
              name="supportsVideo"
              label={t('aiProviders.field.supportsVideo')}
              valuePropName="checked"
            >
              <Switch />
            </Form.Item>
            <Form.Item name="enabled" label={t('aiProviders.field.enabled')} valuePropName="checked">
              <Switch />
            </Form.Item>
          </Space>
        </Form>
      </Modal>
    </Card>
  );
}
