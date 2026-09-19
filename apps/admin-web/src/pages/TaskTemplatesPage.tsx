import { useState } from 'react';
import {
  Card, Row, Col, Typography, Tag, Space, Button, Empty, Popconfirm,
  message, theme,
} from 'antd';
import {
  CopyOutlined, DeleteOutlined, FileTextOutlined,
  ApiOutlined, FieldTimeOutlined, CodeOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { taskTemplatesApi, TaskTemplate } from '../api/task-templates';
import { useTaskTemplates } from '../api/queries';
import PageHeader from '../components/PageHeader';
import PageSkeleton from '../components/PageSkeleton';
import StateError from '../components/StateError';
// UI-10：导入 i18n 实例（模块副作用完成初始化；树内用 useTranslation 读 key）
import '../i18n';

const { Text, Paragraph } = Typography;

type TFn = (k: string, options?: Record<string, unknown>) => string;

const TRIGGER_LABEL = (t: TFn): Record<string, string> => ({
  manual: t('templates.trigger.manual'),
  cron: t('templates.trigger.cron'),
  fixed_rate: t('templates.trigger.fixedRate'),
  api: t('templates.trigger.api'),
});
const CATEGORY_COLOR: Record<string, string> = {
  备份: 'blue', 巡检: 'green', 同步: 'purple', 清理: 'orange', 通知: 'cyan',
};

/**
 * UX-10（本轮体验审查）：模板分类的展示标签与配色。
 *
 * 缺陷：`category` 在 admin-api 里是自由文本 `varchar(32)`
 * （task-template.entity.ts），官方种子值写死为中文（task-template.constants.ts
 * 的「备份/巡检/同步/清理/通知」）。前端直接 `{tpl.category}` 渲染，于是：
 *   · **英文界面下分类标签仍是中文**——同一张卡片上的触发方式已走 t() 显示
 *     "Cron Schedule"，分类却是"备份"，中英混排；
 *   · 配色表以**中文显示名**为键，一旦有人把分类改成英文/本地化文案，配色
 *     静默退回 default 灰——即"改个文案就掉色"，键与语义错位。
 *
 * 修法：分类 → i18n key 的映射表（键仍是后端实际存的中文种子值，因为那是
 * 数据契约，不能前端擅自改），渲染时过 t()，英文界面即显示 Backup 等。
 *
 * 未知分类回退**原始值**（不显示"未知"）：分类是用户自建模板时自由填写的，
 * 露出原文才可诊断；配色回退 default 灰。
 */
const CATEGORY_T_KEY: Record<string, string> = {
  备份: 'templates.category.backup',
  巡检: 'templates.category.inspection',
  同步: 'templates.category.sync',
  清理: 'templates.category.cleanup',
  通知: 'templates.category.notify',
};

/** 分类展示文本：已知分类走 i18n，未知分类回退原始值。 */
function categoryLabel(category: string | null | undefined, t: TFn): string {
  if (!category) return '';
  const key = CATEGORY_T_KEY[category];
  return key ? t(key) : category;
}

/** 把模板 config 摘要成一行人类可读描述。 */
function configSummary(config: Record<string, unknown>, t: TFn): string {
  const bits: string[] = [];
  const trigger = config.triggerType as string | undefined;
  if (trigger) {
    let label = TRIGGER_LABEL(t)[trigger] || trigger;
    if (trigger === 'cron' && config.cronExpression) label += t('templates.config.cron', { expr: String(config.cronExpression) });
    if (trigger === 'fixed_rate' && config.fixedRate) label += t('templates.config.fixedRate', { rate: String(config.fixedRate) });
    bits.push(label);
  }
  if (config.runtime) bits.push(`${config.runtime} · ${config.entrypoint ?? '-'}`);
  if (config.timeoutSeconds) bits.push(t('templates.config.timeout', { seconds: String(config.timeoutSeconds) }));
  if (config.maxRetry != null) bits.push(t('templates.config.retry', { count: String(config.maxRetry) }));
  return bits.join('　');
}

export default function TaskTemplatesPage() {
  const { t } = useTranslation();
  // F-15（DEEP_REVIEW 0ef3bbe）：主色图标走 antd token，暗色主题自适应。
  const { token } = theme.useToken();
  const nav = useNavigate();
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // FEAT-17: useRequest 换 useTaskTemplates（模板删除后 refresh 走 refetch）。
  const { data: templates, isLoading: loading, error, refetch } = useTaskTemplates();
  const refresh = () => void refetch();

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await taskTemplatesApi.remove(id);
      message.success(t('templates.deleted'));
      refresh();
    } catch {
      message.error(t('templates.deleteFail'));
    } finally {
      setDeletingId(null);
    }
  };

  // 使用模板 = 复制 config 生成可编辑草稿：跳转创建表单并带 ?templateId=，
  // TaskFormPage 读取后预填（用户在表单里补 name 后提交即为「可运行任务」）。
  const handleUse = (tpl: TaskTemplate) => nav(`/tasks/new?templateId=${tpl.id}`);

  // UI-08：首屏加载（卡片页形态）以骨架屏替代裸 Spin
  if (loading) {
    return (
      <div>
        <PageHeader
          title={t('templates.title')}
          description={t('templates.description')}
        />
        <PageSkeleton variant="cards" rows={4} />
      </div>
    );
  }

  return (
    <div>
      {/* UI-03：页头标准化（原 Typography.Title 区块迁入 PageHeader） */}
      <PageHeader
        title={t('templates.title')}
        description={t('templates.description')}
      />

      {/* UI-08：错误态标准化——原仅 Alert 提示，升级为「重试 + 复制错误信息」错误块 */}
      {error && (
        <StateError
          error={error}
          onRetry={refresh}
          title={t('templates.error.title')}
          style={{ marginBottom: 16 }}
        />
      )}

      {!loading && !error && (!templates || templates.length === 0) && (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('templates.empty')} />
      )}

      <Row gutter={[16, 16]}>
        {(templates ?? []).map((tpl) => (
          <Col xs={24} sm={12} lg={8} xl={6} key={tpl.id}>
            <Card
              style={{ height: '100%' }}
              title={
                // UI 打磨：模板名过长时（title 为 Space 节点，antd 默认省略号
                // 不生效）用 Text ellipsis+tooltip 收口，卡片等高避免换行锯齿
                <Space style={{ maxWidth: '100%' }} size={6}>
                  <FileTextOutlined style={{ color: token.colorPrimary, flexShrink: 0 }} />
                  <Text ellipsis={{ tooltip: tpl.name }} style={{ maxWidth: '100%' }}>{tpl.name}</Text>
                </Space>
              }
              extra={
                tpl.isOfficial
                  ? <Tag color="gold">{t('templates.official')}</Tag>
                  : <Tag>{t('templates.custom')}</Tag>
              }
              actions={[
                <Button
                  key="use" type="link" size="small" icon={<CopyOutlined />}
                  onClick={() => handleUse(tpl)}
                >
                  {t('templates.use')}
                </Button>,
                tpl.isOfficial ? null : (
                  <Popconfirm
                    key="del" title={t('templates.deleteConfirm')} okText={t('templates.deleteOk')} cancelText={t('templates.cancel')}
                    okButtonProps={{ danger: true }}
                    onConfirm={() => handleDelete(tpl.id)}
                  >
                    <Button type="text" size="small" danger icon={<DeleteOutlined />}
                      loading={deletingId === tpl.id} />
                  </Popconfirm>
                ),
              ].filter(Boolean)}
            >
              <Paragraph type="secondary" ellipsis={{ rows: 2 }} style={{ minHeight: 44, marginBottom: 8 }}>
                {tpl.description || t('templates.noDesc')}
              </Paragraph>
              <Space size={4} wrap style={{ marginBottom: 8 }}>
                {tpl.category && (
                  // UX-10：此前直接渲染 {tpl.category}（中文种子值），英文界面
                  // 下与相邻已翻译的触发方式标签中英混排。
                  <Tag color={CATEGORY_COLOR[tpl.category] || 'default'}>
                    {categoryLabel(tpl.category, t)}
                  </Tag>
                )}
                <Tag icon={<ApiOutlined />}>{TRIGGER_LABEL(t)[tpl.config.triggerType as string] ?? (tpl.config.triggerType ?? '—')}</Tag>
                {tpl.config.runtime ? <Tag icon={<CodeOutlined />}>{String(tpl.config.runtime)}</Tag> : null}
              </Space>
              <div>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  <FieldTimeOutlined /> {configSummary(tpl.config, t) || '—'}
                </Text>
              </div>
            </Card>
          </Col>
        ))}
      </Row>
    </div>
  );
}
