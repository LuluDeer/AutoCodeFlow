import { useState } from 'react';
import {
  Card, Row, Col, Typography, Tag, Space, Button, Empty, Popconfirm,
  message, Spin, Alert,
} from 'antd';
import {
  CopyOutlined, DeleteOutlined, FileTextOutlined,
  ApiOutlined, FieldTimeOutlined, CodeOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useRequest } from 'ahooks';
import { taskTemplatesApi, TaskTemplate } from '../api/task-templates';
import PageHeader from '../components/PageHeader';

const { Text, Paragraph } = Typography;

const TRIGGER_LABEL: Record<string, string> = {
  manual: '手动', cron: 'Cron 定时', fixed_rate: '固定间隔', api: 'API 触发',
};
const CATEGORY_COLOR: Record<string, string> = {
  备份: 'blue', 巡检: 'green', 同步: 'purple', 清理: 'orange', 通知: 'cyan',
};

/** 把模板 config 摘要成一行人类可读描述。 */
function configSummary(config: Record<string, unknown>): string {
  const bits: string[] = [];
  const trigger = config.triggerType as string | undefined;
  if (trigger) {
    let t = TRIGGER_LABEL[trigger] || trigger;
    if (trigger === 'cron' && config.cronExpression) t += `（${config.cronExpression}）`;
    if (trigger === 'fixed_rate' && config.fixedRate) t += `（每 ${config.fixedRate}s）`;
    bits.push(t);
  }
  if (config.runtime) bits.push(`${config.runtime} · ${config.entrypoint ?? '-'}`);
  if (config.timeoutSeconds) bits.push(`超时 ${config.timeoutSeconds}s`);
  if (config.maxRetry != null) bits.push(`重试 ${config.maxRetry}`);
  return bits.join('　');
}

export default function TaskTemplatesPage() {
  const nav = useNavigate();
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const { data: templates, loading, error, refresh } = useRequest(
    () => taskTemplatesApi.list(),
  );

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await taskTemplatesApi.remove(id);
      message.success('已删除自定义模板');
      refresh();
    } catch {
      message.error('删除失败');
    } finally {
      setDeletingId(null);
    }
  };

  // 使用模板 = 复制 config 生成可编辑草稿：跳转创建表单并带 ?templateId=，
  // TaskFormPage 读取后预填（用户在表单里补 name 后提交即为「可运行任务」）。
  const handleUse = (tpl: TaskTemplate) => nav(`/tasks/new?templateId=${tpl.id}`);

  if (loading) {
    return <div style={{ display: 'flex', justifyContent: 'center', marginTop: 100 }}><Spin size="large" /></div>;
  }

  return (
    <div>
      {/* UI-03：页头标准化（原 Typography.Title 区块迁入 PageHeader） */}
      <PageHeader
        title="任务模板"
        description="常用任务形态固化为模板，一键复制配置生成可运行任务草稿。"
      />

      {error && (
        <Alert type="error" showIcon style={{ marginBottom: 16 }}
          title="加载模板失败" description="请稍后重试或检查后端服务。" />
      )}

      {!loading && !error && (!templates || templates.length === 0) && (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无模板" />
      )}

      <Row gutter={[16, 16]}>
        {(templates ?? []).map((tpl) => (
          <Col xs={24} sm={12} lg={8} xl={6} key={tpl.id}>
            <Card
              title={
                <Space>
                  <FileTextOutlined style={{ color: '#1677ff' }} />
                  <span>{tpl.name}</span>
                </Space>
              }
              extra={
                tpl.isOfficial
                  ? <Tag color="gold">官方</Tag>
                  : <Tag>自定义</Tag>
              }
              actions={[
                <Button
                  key="use" type="link" size="small" icon={<CopyOutlined />}
                  onClick={() => handleUse(tpl)}
                >
                  使用此模板
                </Button>,
                tpl.isOfficial ? null : (
                  <Popconfirm
                    key="del" title="确认删除该自定义模板？" okText="删除" cancelText="取消"
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
                {tpl.description || '（无描述）'}
              </Paragraph>
              <Space size={4} wrap style={{ marginBottom: 8 }}>
                {tpl.category && <Tag color={CATEGORY_COLOR[tpl.category] || 'default'}>{tpl.category}</Tag>}
                <Tag icon={<ApiOutlined />}>{TRIGGER_LABEL[tpl.config.triggerType as string] ?? (tpl.config.triggerType ?? '—')}</Tag>
                {tpl.config.runtime ? <Tag icon={<CodeOutlined />}>{String(tpl.config.runtime)}</Tag> : null}
              </Space>
              <div>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  <FieldTimeOutlined /> {configSummary(tpl.config) || '—'}
                </Text>
              </div>
            </Card>
          </Col>
        ))}
      </Row>
    </div>
  );
}
