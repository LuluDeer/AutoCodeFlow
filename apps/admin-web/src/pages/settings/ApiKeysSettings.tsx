import { useState } from 'react';
import { Card,
  Table,
  Button,
  Space,
  Tag,
  Modal,
  Form,
  Input,
  Select,
  InputNumber,
  Checkbox,
  Typography,
  Alert,
  Popconfirm } from 'antd';
import { message } from '../../utils/toast';
import {
  PlusOutlined, CopyOutlined, ApiOutlined, WarningOutlined,
} from '@ant-design/icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiKeysApi, ApiKeyView, ApiKeyScope, ApiKeyCreateResult } from '../../api/api-keys';
import { showApiError } from '../../utils/error';
// UX-04：统一剪贴板封装（返回是否**真正**复制成功，失败时降级 execCommand）。
import { copyText } from '../../utils/clipboard';
import { formatDateTime } from '../../utils/timeFormat';
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
 * 操作列按行状态二选一：活跃 key → 吊销；已吊销/已过期 → 永久删除（清理，
 * 后端对活跃 key 的删除请求返回 409）。全部操作走 JWT（/api-keys 是
 * JWT-only 面，API Key 不能自管）。
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

/**
 * 是否可**永久删除**：只有已失效的行（已吊销 / 已过期）可删。
 * 活跃 key 必须先吊销——吊销留下 `apikey.revoke` 审计行，删除只做清理；
 * 后端对活跃 key 返回 409（`API_KEY_DELETE_ACTIVE_FORBIDDEN`），前端不给出
 * 这条路径的按钮，避免用户点出一个必然失败的请求。导出供测试。
 */
export function apiKeyDeletable(key: ApiKeyView, now: number = Date.now()): boolean {
  if (key.revokedAt) return true;
  return !!key.expiresAt && new Date(key.expiresAt).getTime() <= now;
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
        <Button key="copy" icon={<CopyOutlined aria-hidden />} onClick={async () => {
          // UX-04（本轮体验审查）：此前是
          //   navigator.clipboard?.writeText(...); setCopied(true);
          // ——无 await、无 catch，**无条件**置「已复制」。非 HTTPS / iframe
          // 受限 / 浏览器拒绝剪贴板权限时，用户看到按钮变成「已复制」便关掉
          // 弹窗，而密钥明文此后**无法再查看**，粘贴时才发现剪贴板是空的。
          // 这是全站风险最高的一处「假成功」，必须按真实结果反馈。
          const ok = await copyText(props.result!.plaintext);
          if (ok) {
            setCopied(true);
          } else {
            message.error(t('apiKeys.result.copyFail'));
          }
        }}>
          {copied ? t('apiKeys.result.copied') : t('apiKeys.result.copyKey')}
        </Button>,
        <Button key="ok" type="primary" onClick={props.onClose}>{t('apiKeys.result.savedOk')}</Button>,
      ]}
    >
      <Alert
        type="warning"
        showIcon
        icon={<WarningOutlined aria-hidden />}
        title={t('apiKeys.result.warnTitle')}
        description={t('apiKeys.result.warnDesc')}
        style={{ marginBottom: 16 }}
      />
      <Paragraph code copyable={false} style={{ wordBreak: 'break-all' }}>
        {props.result.plaintext}
      </Paragraph>
      <Space>
        <Text type="secondary">{t('apiKeys.result.name')}</Text><Text>{props.result.name}</Text>
        {/* 第 4 轮 INDEX §3-3：此前硬编码「Scope：」，中文界面下与左右两侧
            已走 t() 的「名称：/前缀：」混排；改走同排同款 apiKeys.result.* 词条 */}
        <Text type="secondary">{t('apiKeys.result.scope')}</Text>
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
    queryFn: ({ signal }) => apiKeysApi.list(signal),
  });

  // A-14（R3-A 审计）: 表单值透传 task:trigger 附加勾选（scope=trigger 时展示）
  const createMut = useMutation({
    mutationFn: (values: {
      name: string;
      scope: ApiKeyScope;
      expiresInDays?: number | null;
      taskTrigger?: boolean;
    }) =>
      apiKeysApi.create({
        name: values.name,
        scope: values.scope,
        ...(values.expiresInDays ? { expiresInDays: values.expiresInDays } : {}),
        // A-14: 仅在 scope=trigger 且显式勾选时透传扩展域——DTO 字段名 scopes
        // （空格分隔词表）；未勾选不传，后端按 null 处理（零行为变化）。
        ...(values.scope === 'trigger' && values.taskTrigger
          ? { scopes: 'task:trigger' }
          : {}),
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
      showApiError(err, t('apiKeys.createFail'));
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
      showApiError(err, t('apiKeys.revokeFail'));
    },
  });

  // 永久删除（清理已失效行）。活跃 key 不会渲染该按钮，后端也有 409 兜底；
  // 失败同样必须有可见反馈（同 UI-15 纪律）。
  const removeMut = useMutation({
    mutationFn: (id: number) => apiKeysApi.remove(id),
    onSuccess: () => {
      message.success(t('apiKeys.deletedMsg'));
      qc.invalidateQueries({ queryKey: ['api-keys'] });
    },
    onError: (err: unknown) => {
      showApiError(err, t('apiKeys.deleteFail'));
    },
  });

  const columns: ColumnsType<ApiKeyView> = [
    // 列宽口径（2026-10-23 观感修正）：**每一列都给确定宽度**，不再让「名称」
    // 用 minWidth 吸收全部剩余宽度——宽屏下名称列会被撑成几百像素的空白，
    // 而 Scope 列（中文标签「完全（除凭证管理）」有 9 个字）只有 100px 被挤到
    // 溢出。现在按内容定宽，容器更宽时各列按比例伸展，观感均匀。
    { title: t('apiKeys.col.name'), dataIndex: 'name', key: 'name', width: 220, ellipsis: true },
    {
      // UI-09 第三轮：前缀/最后使用是次要列——窄屏（≤768px）由媒体查询隐藏
      // （onHeaderCell/onCell 双端挂类，对齐 AppDeploymentPage 既有模式；断点与
      // index.css ui09 媒体查询同值）。名称/Scope/过期/状态/操作保留，scroll.x 兜底。
      title: t('apiKeys.col.keyPrefix'), dataIndex: 'keyPrefix', key: 'keyPrefix', width: 130, ellipsis: true,
      onHeaderCell: () => ({ className: 'ui09-hide-mobile' }),
      onCell: () => ({ className: 'ui09-hide-mobile' }),
      // keyPrefix 是生成时就固定截断的展示前缀（API_KEY_DISPLAY_PREFIX_LEN），
      // 不是被 CSS 截断的——再补一个 `…` 反而让人以为还能展开，去掉。
      render: (v: string) => <Text code>{v}</Text>,
    },
    {
      // 中文标签最长 9 个字（「完全（除凭证管理）」）→ 150 才放得下 Tag 内边距；
      // 表头也走 i18n（此前硬编码英文 'Scope'，与同表其余中文表头不一致）。
      title: t('apiKeys.col.scope'), dataIndex: 'scope', key: 'scope', width: 150,
      render: (v: ApiKeyScope) => <Tag color={SCOPE_COLOR[v]}>{SCOPE_LABELS(t)[v]}</Tag>,
    },
    {
      title: t('apiKeys.col.expiresAt'), dataIndex: 'expiresAt', key: 'expiresAt', width: 165, ellipsis: true,
      render: (v: string | null) => (v ? formatDateTime(v) : t('apiKeys.neverExpires')),
    },
    {
      title: t('apiKeys.col.lastUsed'), dataIndex: 'lastUsedAt', key: 'lastUsedAt', width: 165, ellipsis: true,
      onHeaderCell: () => ({ className: 'ui09-hide-mobile' }),
      onCell: () => ({ className: 'ui09-hide-mobile' }),
      render: (v: string | null) => formatDateTime(v),
    },
    {
      title: t('apiKeys.col.status'), key: 'status', width: 90,
      render: (_: unknown, record: ApiKeyView) => {
        const s = apiKeyStatus(record, t);
        return <Tag color={s.color}>{s.label}</Tag>;
      },
    },
    {
      // 定宽列合计 1016（220+130+150+165+165+90+96）= scroll.x；操作列 fixed right
      // 与 scroll.x 成对出现，窄屏横向滚动时「吊销/删除」入口常驻可见。
      // 两种动作按行状态二选一：活跃 → 吊销；已吊销/已过期 → 删除（清理）。
      title: t('apiKeys.col.actions'), key: 'action', width: 96, fixed: 'right',
      render: (_: unknown, record: ApiKeyView) =>
        apiKeyDeletable(record) ? (
          <Popconfirm
            title={t('apiKeys.deleteConfirm')}
            okText={t('apiKeys.delete')}
            okButtonProps={{ danger: true }}
            onConfirm={() => removeMut.mutate(record.id)}
          >
            <Button size="small" type="text" danger data-testid={`apikey-delete-${record.id}`}
              loading={removeMut.isPending && removeMut.variables === record.id}>
              {t('apiKeys.delete')}
            </Button>
          </Popconfirm>
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
      title={
        // 375px 走查：长标题（「API Keys（限权机器凭证）」）此前被右侧「新建
        // API Key」按钮硬截断且无省略号——antd 卡头自带的 ellipsis 只作用于
        // 标题元素自身的文本，包一层 inline-flex Space 后失效。改 flex 容器
        // + minWidth:0 链路让 Typography.Text ellipsis 真正生效（超长出
        // 省略号，hover tooltip 保全文）。
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <ApiOutlined aria-hidden style={{ flex: 'none' }} />
          <Typography.Text ellipsis={{ tooltip: t('apiKeys.title') }} style={{ flex: 1, minWidth: 0 }}>
            {t('apiKeys.title')}
          </Typography.Text>
        </span>
      }
      extra={
        <Button type="primary" icon={<PlusOutlined aria-hidden />} onClick={() => setCreateOpen(true)} data-testid="apikey-create">
          {t('apiKeys.create')}
        </Button>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        title={t('apiKeys.alertMessage')}
        description={
          <>
            <Text type="secondary">
              {t('apiKeys.alertDescPrefix')}<code>Authorization: Bearer acf_…</code>{t('apiKeys.alertDescSuffix')}
            </Text>
            {/* 用户最常问的「这串 Key 到底填到哪」——直接把两个变量名写在页面上，
                省掉去翻文档的一步。刻意不放链接：文档站在 SPA 里没有对应路由，
                放一个 404 链接比不放更糟。 */}
            <div style={{ marginTop: 4 }}>
              <Text type="secondary">{t('apiKeys.usageHint')}</Text>
            </div>
          </>
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
          // 与列表宽合计一致（220+130+150+165+165+90+96）；tableLayout=fixed 让
          // 上面写死的列宽成为权威，宽屏下不再由某一列吞掉全部剩余宽度。
          tableLayout="fixed"
          scroll={{ x: 1016 }}
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
          {/* A-14（R3-A 审计）: task:trigger 扩展域此前后端可达（NF-01）但前端
              无入口——scope=trigger 时展示附加勾选，载荷透传 scopes='task:trigger'。
              切走 scope 后条件渲染卸载，值由载荷构造侧按 scope 判断兜底。 */}
          <Form.Item noStyle shouldUpdate={(prev, cur) => prev.scope !== cur.scope}>
            {({ getFieldValue }) =>
              getFieldValue('scope') === 'trigger' ? (
                <>
                  <Form.Item name="taskTrigger" valuePropName="checked" style={{ marginBottom: 4 }}>
                    <Checkbox data-testid="apikey-task-trigger">
                      {t('apiKeys.field.allowTaskTrigger')}
                    </Checkbox>
                  </Form.Item>
                  <Typography.Text
                    type="secondary"
                    style={{ display: 'block', marginBottom: 16, fontSize: 12 }}
                  >
                    {t('apiKeys.field.allowTaskTriggerHint')}
                  </Typography.Text>
                </>
              ) : null
            }
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