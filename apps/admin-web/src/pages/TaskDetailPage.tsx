import { useState } from 'react';
import {
  Card, Descriptions, Tag, Typography, Button, Space, Table, Badge, Tabs,
  Spin, Empty, message, Popconfirm, Tooltip, Modal, Statistic, Row, Col, Form, Alert,
} from 'antd';
import {
  ArrowLeftOutlined, ThunderboltOutlined, PauseCircleOutlined,
  PlayCircleOutlined, DeleteOutlined, ReloadOutlined, EditOutlined,
  EyeOutlined, ClockCircleOutlined, StopOutlined, RobotOutlined, CodeOutlined,
  CheckCircleOutlined, CloseCircleOutlined, FieldTimeOutlined,
} from '@ant-design/icons';
import { useParams, useNavigate } from 'react-router-dom';
import { useRequest } from 'ahooks';
import { tasksApi, TaskExecution } from '../api/tasks';
import { aiApi, ScheduleSuggestion } from '../api/ai';
import { getErrMsg } from '../utils/error';
import { formatDateTime, formatDuration, formatRelativeTime } from '../utils/timeFormat';
import GlueEditor from '../components/GlueEditor';
import ParamsEditor from '../components/ParamsEditor';

const { Text } = Typography;

const STATUS_COLOR: Record<string, string> = {
  pending: 'default', running: 'processing', success: 'green',
  failed: 'red', timeout: 'orange', killed: 'volcano', cancelled: 'default',
};
const STATUS_LABEL: Record<string, string> = {
  pending: '等待中', running: '运行中', success: '成功',
  failed: '失败', timeout: '超时', killed: '已终止', cancelled: '已取消',
};

export default function TaskDetailPage() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const [execPage, setExecPage] = useState(1);
  const [aiModalOpen, setAiModalOpen] = useState(false);
  const [aiSuggestion, setAiSuggestion] = useState<ScheduleSuggestion | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [triggerModalOpen, setTriggerModalOpen] = useState(false);
  const [triggerParams, setTriggerParams] = useState<Record<string, string>>({});
  const [triggering, setTriggering] = useState(false);

  const handleAiSuggest = async () => {
    if (!id) return;
    setAiLoading(true);
    setAiModalOpen(true);
    try {
      const result = await aiApi.suggestSchedule(id);
      setAiSuggestion(result);
    } catch (err: unknown) {
      message.error(getErrMsg(err, 'AI 分析失败'));
      setAiModalOpen(false);
    } finally {
      setAiLoading(false);
    }
  };

  const { data: schedulerStats } = useRequest(
    tasksApi.schedulerStats,
    { pollingInterval: 30000 },
  );

  const { data: task, loading: taskLoading, refresh: refreshTask } = useRequest(
    () => tasksApi.get(id!),
    { ready: !!id, refreshDeps: [id] },
  );

  const { data: execData, loading: execLoading, refresh: refreshExecs } = useRequest(
    () => tasksApi.executions(id!, { page: execPage, pageSize: 20 }),
    { ready: !!id, refreshDeps: [id, execPage] },
  );

  const { data: taskStats } = useRequest(
    () => tasksApi.stats(id!),
    { ready: !!id, refreshDeps: [id], pollingInterval: 60_000 },
  );

  const executions: TaskExecution[] = execData?.items ?? [];
  const execTotal: number = execData?.total ?? 0;

  const handleTrigger = () => {
    // 预填默认参数，让用户可以按需覆盖
    setTriggerParams(
      Object.fromEntries(
        Object.entries(task?.params ?? {}).map(([k, v]) => [k, String(v)])
      )
    );
    setTriggerModalOpen(true);
  };

  const handleTriggerConfirm = async () => {
    setTriggering(true);
    try {
      // 只传非空参数
      const params = Object.fromEntries(
        Object.entries(triggerParams).filter(([k]) => k.trim())
      );
      await tasksApi.trigger(id!, Object.keys(params).length > 0 ? params : undefined);
      message.success('已触发，稍后可在执行记录中查看');
      setTriggerModalOpen(false);
      setTimeout(refreshExecs, 1500);
    } catch (err: unknown) {
      message.error(getErrMsg(err, '触发失败'));
    } finally {
      setTriggering(false);
    }
  };

  const handlePause = async () => {
    try { await tasksApi.pause(id!); message.success('已暂停'); refreshTask(); }
    catch (err: unknown) { message.error(getErrMsg(err, '暂停失败')); }
  };

  const handleResume = async () => {
    try { await tasksApi.resume(id!); message.success('已恢复'); refreshTask(); }
    catch (err: unknown) { message.error(getErrMsg(err, '恢复失败')); }
  };

  const handleDelete = async () => {
    try { await tasksApi.delete(id!); message.success('已删除'); nav('/tasks'); }
    catch (err: unknown) { message.error(getErrMsg(err, '删除失败')); }
  };

  const handleEdit = () => {
    nav(`/tasks/${id}/edit`);
  };

  const handleKill = async (execId: string) => {
    try {
      await tasksApi.killExecution(id!, execId);
      message.success('已终止');
      refreshExecs();
    } catch (err: unknown) { message.error(getErrMsg(err, '终止失败')); }
  };

  if (taskLoading && !task) return <div style={{ textAlign: 'center', padding: 80 }}><Spin size="large" /></div>;
  if (!task) return <Empty description="任务不存在" />;

  const execColumns = [
    {
      title: '状态', dataIndex: 'status', width: 90,
      render: (s: string) => <Badge status={STATUS_COLOR[s] as 'success' | 'error' | 'warning' | 'processing' | 'default'} text={STATUS_LABEL[s] || s} />,
    },
    {
      title: '触发', dataIndex: 'triggerType', width: 80,
      render: (v: string) => <Text type="secondary" style={{ fontSize: 12 }}>{v || '-'}</Text>,
    },
    {
      title: '执行器', dataIndex: 'executorAddress', width: 140, ellipsis: true,
      responsive: ['md'] as import('antd/es/_util/responsiveObserver').Breakpoint[],
      render: (v: string) => v ? (
        <Tooltip title={v}>
          <Text style={{ fontSize: 11, fontFamily: 'monospace' }}>{v}</Text>
        </Tooltip>
      ) : <Text type="secondary">-</Text>,
    },
    {
      title: '开始时间', dataIndex: 'startTime', width: 140,
      render: (v: string) => v ? (
        <Tooltip title={formatDateTime(v)}>
          <Text style={{ fontSize: 12 }}>{formatRelativeTime(v)}</Text>
        </Tooltip>
      ) : '-',
    },
    {
      title: '耗时', dataIndex: 'duration', width: 80,
      render: (v: number) => v != null ? <Text style={{ fontSize: 12 }}>{formatDuration(v)}</Text> : '-',
    },
    {
      title: '错误', dataIndex: 'errorMessage', ellipsis: true,
      render: (v: string) => v ? <Text type="danger" style={{ fontSize: 12 }}>{v}</Text> : '-',
    },
    {
      title: '', key: 'actions', width: 100,
      render: (_: unknown, r: TaskExecution) => (
        <Space size={2}>
          {r.status === 'running' && (
            <Tooltip title="终止">
              <Button type="text" size="small" danger icon={<StopOutlined />}
                onClick={() => handleKill(r.id)} />
            </Tooltip>
          )}
          <Button type="link" size="small" icon={<EyeOutlined />}
            onClick={() => nav(`/tasks/${id}/executions/${r.id}`)}>详情</Button>
        </Space>
      ),
    },
  ];

  const isActive = task.status === 'active';
  const isPaused = task.status === 'paused';

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => nav('/tasks')}>返回</Button>
      </Space>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
        <div>
          <Space align="center">
            <Typography.Title level={4} style={{ margin: 0 }}>{task.name}</Typography.Title>
            <Badge
              status={isActive ? 'success' : isPaused ? 'warning' : 'default'}
              text={isActive ? '运行中' : isPaused ? '已暂停' : task.status}
            />
          </Space>
          {task.description && <Text type="secondary">{task.description}</Text>}
          {schedulerStats && (
            <Space size={4} style={{ marginTop: 4 }}>
              <Tag style={{ fontSize: 11 }}>活跃定时器 {schedulerStats.activeTimers}</Tag>
              <Tag style={{ fontSize: 11 }}>Cron {schedulerStats.activeCronTasks}</Tag>
              <Tag color="processing" style={{ fontSize: 11 }}>运行中 {schedulerStats.runningTaskCount}</Tag>
            </Space>
          )}
        </div>
        <Space>
          <Button icon={<ThunderboltOutlined />} type="primary" onClick={handleTrigger}>立即触发</Button>
          {isActive && <Button icon={<PauseCircleOutlined />} onClick={handlePause}>暂停</Button>}
          {isPaused && <Button icon={<PlayCircleOutlined />} type="primary" onClick={handleResume}>恢复</Button>}
          <Button icon={<RobotOutlined />} onClick={handleAiSuggest} loading={aiLoading}>AI 调度建议</Button>
          <Button icon={<EditOutlined />} onClick={handleEdit}>编辑</Button>
          <Popconfirm title="确认删除此任务？" onConfirm={handleDelete} okText="删除" okButtonProps={{ danger: true }}>
            <Button icon={<DeleteOutlined />} danger>删除</Button>
          </Popconfirm>
        </Space>
      </div>

      {/* Stats row */}
      {taskStats && (
        <Row gutter={[16, 12]} style={{ marginBottom: 16 }}>
          <Col xs={12} sm={6}>
            <Card size="small">
              <Statistic
                title="总执行次数"
                value={taskStats.totalRuns ?? 0}
                prefix={<FieldTimeOutlined />}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card size="small">
              <Statistic
                title="成功率"
                value={((taskStats.successRate ?? 0) * 100).toFixed(1)}
                suffix="%"
                styles={{ content: { color: (taskStats.successRate ?? 0) >= 0.95 ? '#52c41a' : (taskStats.successRate ?? 0) >= 0.8 ? '#fa8c16' : '#ff4d4f' } }}
                prefix={<CheckCircleOutlined />}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card size="small">
              <Statistic
                title="失败次数"
                value={taskStats.totalRuns > 0 ? Math.round(taskStats.totalRuns * (1 - (taskStats.successRate ?? 0))) : 0}
                styles={taskStats.totalRuns > 0 && taskStats.successRate < 1 ? { content: { color: '#ff4d4f' } } : undefined}
                prefix={<CloseCircleOutlined />}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card size="small">
              <Statistic
                title="平均耗时"
                value={taskStats.avgDuration ? (taskStats.avgDuration / 1000).toFixed(1) : '-'}
                suffix={taskStats.avgDuration ? 's' : ''}
                prefix={<FieldTimeOutlined />}
              />
            </Card>
          </Col>
        </Row>
      )}

      <Tabs
        items={[
          {
            key: 'info',
            label: '任务配置',
            children: (
              <Card>
                <Descriptions size="small" column={{ xs: 1, sm: 2, md: 3 }}>
                  <Descriptions.Item label="运行时"><Tag>{task.runtime}</Tag></Descriptions.Item>
                  <Descriptions.Item label="触发方式"><Tag>{task.triggerType}</Tag></Descriptions.Item>
                  {task.cronExpression && (
                    <Descriptions.Item label="Cron"><Text code>{task.cronExpression}</Text></Descriptions.Item>
                  )}
                  {task.fixedRate && (
                    <Descriptions.Item label="间隔">
                      {task.fixedRate >= 3600
                        ? `${(task.fixedRate / 3600).toFixed(1).replace(/\.0$/, '')} 小时`
                        : task.fixedRate >= 60
                          ? `${(task.fixedRate / 60).toFixed(1).replace(/\.0$/, '')} 分钟`
                          : `${task.fixedRate} 秒`}
                    </Descriptions.Item>
                  )}
                  <Descriptions.Item label="入口文件">{task.entrypoint || '-'}</Descriptions.Item>
                  {task.requirements && task.requirements.length > 0 && (
                    <Descriptions.Item label="依赖包">
                      <Space size={[4, 4]} wrap>
                        {task.requirements.map((r) => <Tag key={r} color="blue">{r}</Tag>)}
                      </Space>
                    </Descriptions.Item>
                  )}
                  <Descriptions.Item label="超时">{task.timeout ? `${task.timeout} 秒` : '-'}</Descriptions.Item>
                  <Descriptions.Item label="最大重试">{task.maxRetry ?? 0} 次</Descriptions.Item>
                  <Descriptions.Item label="调度模式">
                    {task.executeMode === 'broadcast' ? '广播（所有节点）' : task.executeMode === 'single' ? '单节点' : task.executeMode || '自动'}
                  </Descriptions.Item>
                  {task.executorAppName && (
                    <Descriptions.Item label="指定执行器">{task.executorAppName}</Descriptions.Item>
                  )}
                  <Descriptions.Item label="执行器分组">{task.executorGroup || '任意'}</Descriptions.Item>
                </Descriptions>
                {task.params && Object.keys(task.params).length > 0 && (
                  <div style={{ marginTop: 16 }}>
                    <Typography.Text strong style={{ fontSize: 13 }}>默认参数</Typography.Text>
                    <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      {Object.entries(task.params).map(([k, v]) => (
                        <Tag key={k} style={{ fontFamily: 'monospace', fontSize: 12 }}>
                          {k} = {String(v)}
                        </Tag>
                      ))}
                    </div>
                  </div>
                )}
              </Card>
            ),
          },
          {
            key: 'glue',
            label: (
              <span><CodeOutlined /> Glue 脚本</span>
            ),
            children: (
              <Card>
                <GlueEditor
                  taskId={id!}
                  initialSource={task.glueSource ?? undefined}
                  initialLanguage={task.glueLanguage ?? undefined}
                  taskRuntime={task.runtime}
                />
              </Card>
            ),
          },
          {
            key: 'executions',
            label: (
              <span>
                <ClockCircleOutlined /> 执行记录
              </span>
            ),
            children: (
              <Card
                extra={
                  <Space>
                    <Button size="small" icon={<ReloadOutlined />} onClick={refreshExecs}>刷新</Button>
                    <Button size="small" type="primary" icon={<ThunderboltOutlined />} onClick={handleTrigger}>手动触发</Button>
                  </Space>
                }
              >
                <Table<TaskExecution>
                  rowKey="id"
                  columns={execColumns}
                  dataSource={executions}
                  loading={execLoading}
                  size="small"
                  pagination={{
                    total: execTotal,
                    pageSize: 20,
                    current: execPage,
                    onChange: setExecPage,
                    showTotal: (t) => `共 ${t} 条`,
                  }}
                  locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无执行记录" /> }}
                />
              </Card>
            ),
          },
        ]}
      />

      {/* 触发弹窗 */}
      <Modal
        title={<Space><ThunderboltOutlined /> 立即触发任务</Space>}
        open={triggerModalOpen}
        onCancel={() => setTriggerModalOpen(false)}
        onOk={handleTriggerConfirm}
        okText="触发"
        okButtonProps={{ loading: triggering, icon: <ThunderboltOutlined /> }}
        cancelText="取消"
        width={520}
        destroyOnHidden
      >
        <Alert
          type="info"
          showIcon
          title="运行时参数（可选）"
          description="此处填写的参数会覆盖任务默认参数，以 AUTOFLOW_<KEY> 环境变量注入任务。留空则使用任务默认参数。"
          style={{ marginBottom: 16 }}
        />
        <Form layout="vertical">
          <Form.Item label="执行参数">
            <ParamsEditor
              value={triggerParams}
              onChange={setTriggerParams}
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* AI 调度建议弹窗 */}
      <Modal
        title={<Space><RobotOutlined /> AI 调度建议</Space>}
        open={aiModalOpen}
        onCancel={() => setAiModalOpen(false)}
        footer={[
          aiSuggestion?.suggestedCron && (
            <Button key="apply" type="primary" onClick={() => {
              nav(`/tasks/${id}/edit?suggestCron=${encodeURIComponent(aiSuggestion.suggestedCron)}`);
              setAiModalOpen(false);
            }}>应用建议 Cron</Button>
          ),
          <Button key="close" onClick={() => setAiModalOpen(false)}>关闭</Button>,
        ]}
        width={560}
      >
        {aiLoading ? (
          <div style={{ textAlign: 'center', padding: 40 }}><Spin tip="AI 分析中…" /></div>
        ) : aiSuggestion ? (
          <div>
            <Descriptions size="small" column={1} bordered style={{ marginBottom: 16 }}>
              <Descriptions.Item label="成功率">{(aiSuggestion.successRate * 100).toFixed(1)}%</Descriptions.Item>
              <Descriptions.Item label="P95 耗时">{aiSuggestion.p95Duration ? `${(aiSuggestion.p95Duration / 1000).toFixed(1)}s` : '-'}</Descriptions.Item>
              <Descriptions.Item label="当前 Cron">{aiSuggestion.currentCron || '无'}</Descriptions.Item>
              <Descriptions.Item label="建议 Cron"><Text code style={{ color: '#52c41a' }}>{aiSuggestion.suggestedCron || '无建议'}</Text></Descriptions.Item>
            </Descriptions>
            {aiSuggestion.reasoning && (
              <Card size="small" title="AI 分析">
                <Text style={{ whiteSpace: 'pre-wrap' }}>{aiSuggestion.reasoning}</Text>
              </Card>
            )}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
