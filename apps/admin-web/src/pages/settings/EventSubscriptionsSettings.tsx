import { useState, useEffect } from 'react';
import {
  Card, Table, Button, Space, Tag, Modal, Form, Input, Select, Switch,
  Typography, Alert, Popconfirm, message, Divider, Spin, Tooltip,
} from 'antd';
import {
  PlusOutlined, BellOutlined, DeleteOutlined, ThunderboltOutlined,
  EditOutlined,
} from '@ant-design/icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  eventSubscriptionsApi,
  EVENT_TYPE_OPTIONS,
  EventSubscription,
  EventSubscriptionCreateResult,
  EventSubscriptionDeadLetter,
} from '../../api/event-subscriptions';
import type { ColumnsType } from 'antd/es/table';

const { Text, Paragraph } = Typography;

/**
 * FEAT-15: 设置区「事件订阅」Tab——webhook 出站事件订阅管理（FEAT-07）。
 * 订阅列表（事件类型/URL/enabled 开关/失败统计）+ 新建/编辑 Modal（URL 校验、
 * secret 说明：留空=服务端代生成、创建响应一次性回显展示）+ 删除确认；
 * 死信列表段（只读，按订阅展开）+ replay 按钮（确认后调 replay，成功删行、
 * 失败保留并展示 error）。
 * 形态对齐 ApiKeysSettings（AUTH-03 先例：React Query + 创建 Modal + 一次性回显弹窗）。
 */

const URL_PATTERN = /^https?:\/\/[^\s]+$/;

/** 失败统计列纯函数（导出供测试）：连续失败 >0 展示红色统计，否则健康。 */
export function subscriptionFailureStats(sub: EventSubscription): {
  label: string;
  color: string;
  detail: string | null;
} {
  if (sub.consecutiveFailures > 0) {
    return {
      label: `连续失败 ${sub.consecutiveFailures} 次`,
      color: 'red',
      detail: sub.lastFailureError ?? sub.lastFailureAt ?? null,
    };
  }
  return { label: '正常', color: 'green', detail: null };
}

/** 事件类型值 → 短标签（未知事件名原样展示——契约只增不改，容忍新事件）。 */
function eventTypeLabel(v: string): string {
  const found = EVENT_TYPE_OPTIONS.find((o) => o.value === v);
  return found ? found.value : v;
}

function CreateResultModal(props: {
  result: EventSubscriptionCreateResult | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  if (!props.result) return null;
  const secret = props.result.generatedSecret;
  return (
    <Modal
      open
      title="订阅已创建"
      onCancel={props.onClose}
      footer={[
        <Button key="copy" icon={undefined} onClick={() => {
          if (secret) {
            navigator.clipboard?.writeText(secret);
            setCopied(true);
          }
        }}>
          {copied ? '已复制' : '复制密钥'}
        </Button>,
        <Button key="ok" type="primary" onClick={props.onClose}>我已保存好密钥</Button>,
      ]}
    >
      {secret ? (
        <>
          <Alert
            type="warning"
            showIcon
            message="签名密钥仅此一次显示"
            description="服务端未收到自定义 secret，已代为生成。此密钥仅在本窗口显示一次，关闭后无法再次查看（读面恒为 ******），请立即复制并妥善保存——订阅方需用它校验 X-Hub-Signature-256 签名。"
            style={{ marginBottom: 16 }}
          />
          <Paragraph code copyable={false} style={{ wordBreak: 'break-all' }} data-testid="generated-secret">
            {secret}
          </Paragraph>
        </>
      ) : (
        <Alert type="success" showIcon message="订阅已创建" style={{ marginBottom: 16 }} />
      )}
      <Space>
        <Text type="secondary">URL：</Text>
        <Text code>{props.result.subscription.url}</Text>
      </Space>
    </Modal>
  );
}

/** 死信列表段：按订阅逐个拉取（属主/ADMIN 契约），只读 + replay。 */
function DeadLetterSection({ subscriptions }: { subscriptions: EventSubscription[] }) {
  const qc = useQueryClient();
  // 默认展开第一个订阅；订阅列表异步到达前用兜底 effect 补设（useState 初值
  // 只在首渲染求值一次，列表后到时恒 null → 查询 enabled=false 永不拉取）。
  const [expandedId, setExpandedId] = useState<string | null>(null);
  useEffect(() => {
    if (!expandedId && subscriptions.length > 0) setExpandedId(subscriptions[0].id);
  }, [expandedId, subscriptions]);
  const [replayingId, setReplayingId] = useState<string | null>(null);

  const { data: deadLetters, isLoading } = useQuery({
    queryKey: ['event-dead-letters', expandedId],
    queryFn: () => eventSubscriptionsApi.listDeadLetters(expandedId as string, 1, 20),
    enabled: !!expandedId,
  });

  const replayMut = useMutation({
    mutationFn: ({ subId, dlId }: { subId: string; dlId: string }) =>
      eventSubscriptionsApi.replayDeadLetter(subId, dlId),
    onSuccess: (res) => {
      if (res.ok) {
        message.success('重放成功，死信已删除');
      } else {
        message.error(`重放失败：${res.error ?? '未知错误'}（死信保留，可再次重放）`);
      }
      qc.invalidateQueries({ queryKey: ['event-dead-letters'] });
      qc.invalidateQueries({ queryKey: ['event-subscriptions'] });
    },
  });

  const handleReplay = (subId: string, dl: EventSubscriptionDeadLetter) => {
    Modal.confirm({
      title: '确认重放该死信？',
      content: '将以订阅当前的 URL 与 secret 重新签名派发一次（不自动重试）。成功后死信删除，失败则保留可再次重放。',
      okText: '重放',
      cancelText: '取消',
      onOk: () => {
        setReplayingId(dl.id);
        return replayMut.mutateAsync({ subId, dlId: dl.id }).finally(() => setReplayingId(null));
      },
    });
  };

  const cols: ColumnsType<EventSubscriptionDeadLetter> = [
    { title: '事件', dataIndex: 'eventType', width: 180, render: (v: string) => <Tag>{eventTypeLabel(v)}</Tag> },
    {
      title: '载荷', dataIndex: 'payload', ellipsis: true,
      render: (v: Record<string, unknown>) => (
        <Text code style={{ fontSize: 12 }}>{JSON.stringify(v).slice(0, 80)}</Text>
      ),
    },
    { title: '失败原因', dataIndex: 'error', ellipsis: true },
    { title: '尝试次数', dataIndex: 'attempts', width: 90 },
    {
      title: '时间', dataIndex: 'createdAt', width: 160,
      render: (v: string) => (v ? new Date(v).toLocaleString('zh-CN') : '-'),
    },
    {
      title: '操作', key: 'action', width: 90,
      render: (_: unknown, record: EventSubscriptionDeadLetter) => (
        <Button
          size="small"
          icon={<ThunderboltOutlined />}
          data-testid={`dead-letter-replay-${record.id}`}
          loading={replayingId === record.id}
          onClick={() => expandedId && handleReplay(expandedId, record)}
        >
          重放
        </Button>
      ),
    },
  ];

  if (subscriptions.length === 0) return null;

  return (
    <>
      <Divider style={{ margin: '8px 0 16px' }} />
      <div style={{ marginBottom: 8 }}>
        <Space>
          <Text strong>死信队列</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            连续 3 次投递全败的事件整包落死信（进程内重试 1s/2s/4s 退避耗尽后），可手动重放补发
          </Text>
        </Space>
      </div>
      <Space style={{ marginBottom: 8 }} wrap>
        {subscriptions.map((sub) => (
          <Button
            key={sub.id}
            size="small"
            type={expandedId === sub.id ? 'primary' : 'default'}
            onClick={() => setExpandedId(sub.id)}
          >
            {new URL(sub.url).host}
          </Button>
        ))}
      </Space>
      {isLoading ? (
        <Spin />
      ) : (
        <Table
          rowKey="id"
          size="small"
          columns={cols}
          dataSource={deadLetters?.data ?? []}
          loading={isLoading}
          pagination={false}
          data-testid="dead-letter-table"
          locale={{ emptyText: '该订阅暂无死信（投递健康或已全部重放成功）' }}
        />
      )}
    </>
  );
}

function SubscriptionFormModal(props: {
  open: boolean;
  editing: EventSubscription | null;
  onClose: () => void;
}) {
  const { open, editing, onClose } = props;
  const [form] = Form.useForm<{
    url: string;
    eventTypes: string[];
    secret?: string;
    enabled: boolean;
  }>();

  const qc = useQueryClient();
  const createMut = useMutation({
    mutationFn: (values: { url: string; eventTypes: string[]; secret?: string }) =>
      eventSubscriptionsApi.create({
        url: values.url,
        eventTypes: values.eventTypes,
        ...(values.secret ? { secret: values.secret } : {}),
      }),
    onSuccess: (result) => {
      onClose();
      setCreated(result);
      qc.invalidateQueries({ queryKey: ['event-subscriptions'] });
    },
  });
  const [created, setCreated] = useState<EventSubscriptionCreateResult | null>(null);

  const updateMut = useMutation({
    mutationFn: ({ id, values }: { id: string; values: { url?: string; eventTypes?: string[]; secret?: string; enabled?: boolean } }) =>
      eventSubscriptionsApi.update(id, {
        ...(values.url ? { url: values.url } : {}),
        ...(values.eventTypes ? { eventTypes: values.eventTypes } : {}),
        ...(values.secret ? { secret: values.secret } : {}),
        ...(values.enabled !== undefined ? { enabled: values.enabled } : {}),
      }),
    onSuccess: () => {
      message.success('订阅已更新');
      onClose();
      qc.invalidateQueries({ queryKey: ['event-subscriptions'] });
    },
  });

  const handleOk = async () => {
    const values = await form.validateFields();
    if (editing) {
      await updateMut.mutateAsync({ id: editing.id, values });
    } else {
      await createMut.mutateAsync(values);
      form.resetFields();
    }
  };

  return (
    <>
      <Modal
        open={open}
        title={editing ? '编辑订阅' : '新建订阅'}
        okText={editing ? '保存' : '创建'}
        confirmLoading={createMut.isPending || updateMut.isPending}
        onCancel={onClose}
        onOk={handleOk}
        destroyOnHidden
      >
        <Form
          form={form}
          layout="vertical"
          preserve={false}
          initialValues={editing
            ? { url: editing.url, eventTypes: editing.eventTypes, enabled: editing.enabled, secret: undefined }
            : { enabled: true }}
        >
          <Form.Item
            name="url"
            label="推送 URL"
            rules={[
              { required: true, message: '请输入推送 URL' },
              { pattern: URL_PATTERN, message: '需为公网 http(s) 地址' },
            ]}
            tooltip="服务端会做 SSRF 深校验（DNS 解析逐地址拒绝内网/环回/链路本地/云元数据），非法地址返回 400"
          >
            <Input placeholder="https://ci.example.com/hooks" data-testid="sub-url-input" />
          </Form.Item>
          <Form.Item
            name="eventTypes"
            label="订阅事件（1-10 个）"
            rules={[{ required: true, message: '请至少选择一个事件' }]}
          >
            <Select
              mode="multiple"
              placeholder="选择要订阅的平台事件"
              options={EVENT_TYPE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
            />
          </Form.Item>
          <Form.Item
            name="secret"
            label={<>签名密钥 <Text type="secondary" style={{ fontSize: 12 }}>（可选）</Text></>}
            rules={[{ min: 16, message: '至少 16 字符' }]}
            tooltip="留空 = 服务端代生成 64 字符 hex，并在创建响应中一次性回显；填写则使用自定义密钥（≥16 字符）。编辑时留空 = 保持现有密钥不变。"
            extra="订阅方用该密钥校验 X-Hub-Signature-256 签名（HMAC_SHA256(secret, `${timestamp}.${rawBody}`)）。"
          >
            <Input.Password
              placeholder={editing ? '留空保持现有密钥不变' : '留空 = 服务端代生成'}
              autoComplete="new-password"
              data-testid="sub-secret-input"
            />
          </Form.Item>
          <Form.Item name="enabled" label="启用" valuePropName="checked">
            <Switch data-testid="sub-enabled-switch" />
          </Form.Item>
        </Form>
      </Modal>
      <CreateResultModal result={created} onClose={() => setCreated(null)} />
    </>
  );
}

export default function EventSubscriptionsSettings() {
  const qc = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<EventSubscription | null>(null);

  const { data: subscriptions = [], isLoading } = useQuery({
    queryKey: ['event-subscriptions'],
    queryFn: eventSubscriptionsApi.list,
  });

  const toggleMut = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      eventSubscriptionsApi.update(id, { enabled }),
    onSuccess: (_res, vars) => {
      message.success(vars.enabled ? '订阅已启用' : '订阅已停用');
      qc.invalidateQueries({ queryKey: ['event-subscriptions'] });
    },
  });

  const removeMut = useMutation({
    mutationFn: (id: string) => eventSubscriptionsApi.remove(id),
    onSuccess: () => {
      message.success('订阅已删除（关联死信级联删除）');
      qc.invalidateQueries({ queryKey: ['event-subscriptions'] });
    },
  });

  const columns: ColumnsType<EventSubscription> = [
    {
      title: '事件类型', dataIndex: 'eventTypes', key: 'eventTypes',
      render: (v: string[]) => (
        <Space size={4} wrap>
          {(v ?? []).map((t) => <Tag key={t} data-testid="sub-event-type">{eventTypeLabel(t)}</Tag>)}
        </Space>
      ),
    },
    { title: 'URL', dataIndex: 'url', key: 'url', ellipsis: true, render: (v: string) => <Text code>{v}</Text> },
    {
      title: '启用', dataIndex: 'enabled', key: 'enabled', width: 80,
      render: (v: boolean, record: EventSubscription) => (
        <Switch
          checked={v}
          size="small"
          data-testid={`sub-enabled-${record.id}`}
          loading={toggleMut.isPending && toggleMut.variables?.id === record.id}
          onChange={(checked) => toggleMut.mutate({ id: record.id, enabled: checked })}
        />
      ),
    },
    {
      title: '投递状态', key: 'stats', width: 140,
        render: (_: unknown, record: EventSubscription) => {
          const s = subscriptionFailureStats(record);
          return (
            <Tooltip title={s.detail ?? undefined}>
              <Tag color={s.color}>{s.label}</Tag>
            </Tooltip>
          );
        },
    },
    {
      title: '操作', key: 'action', width: 130,
      render: (_: unknown, record: EventSubscription) => (
        <Space size={4}>
          <Button
            size="small"
            icon={<EditOutlined />}
            data-testid={`sub-edit-${record.id}`}
            onClick={() => { setEditing(record); setFormOpen(true); }}
          >
            编辑
          </Button>
          <Popconfirm
            title="确认删除该订阅？"
            description="删除后停止推送且关联死信级联删除，无法恢复。"
            okText="删除"
            okButtonProps={{ danger: true }}
            onConfirm={() => removeMut.mutate(record.id)}
          >
            <Button size="small" danger icon={<DeleteOutlined />} data-testid={`sub-delete-${record.id}`} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card
      title={<Space><BellOutlined /> 事件订阅（Webhook 出站）</Space>}
      extra={
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => { setEditing(null); setFormOpen(true); }}
          data-testid="sub-create"
        >
          新建订阅
        </Button>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="平台事件可订阅后以签名 webhook 推送到外部端点（如 CI 在任务失败时触发流程）"
        description={
          <Text type="secondary">
            事件信封 {'{ event, occurredAt, data }'} 携带 X-AutoCodeFlow-Event / X-AutoCodeFlow-Timestamp /
            X-Hub-Signature-256 三头（签名=HMAC_SHA256(secret, timestamp + '.' + 原始 body)）。投递超时 10s、
            禁跟随重定向；失败按 1s/2s/4s 退避重试 3 次后落死信。secret 读面恒脱敏为 ******。
          </Text>
        }
      />
      <Table
        rowKey="id"
        size="small"
        columns={columns}
        dataSource={subscriptions}
        loading={isLoading}
        pagination={false}
        data-testid="sub-table"
      />

      <SubscriptionFormModal open={formOpen} editing={editing} onClose={() => setFormOpen(false)} />

      <DeadLetterSection subscriptions={subscriptions} />
    </Card>
  );
}
