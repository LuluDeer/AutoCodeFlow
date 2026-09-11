import { useState } from 'react';
import {
  Card, Descriptions, Tag, Typography, Button, Space, Table, Badge, Tabs,
  Empty, message, Popconfirm, Tooltip, Modal, Statistic, Row, Col, Form, Alert, Result, Input,
} from 'antd';
import {
  ApartmentOutlined,
  ArrowLeftOutlined, ThunderboltOutlined, PauseCircleOutlined,
  PlayCircleOutlined, DeleteOutlined, ReloadOutlined, EditOutlined,
  EyeOutlined, ClockCircleOutlined, StopOutlined, RobotOutlined, CodeOutlined,
  CheckCircleOutlined, CloseCircleOutlined, FieldTimeOutlined, SaveOutlined,
} from '@ant-design/icons';
import { useParams, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { tasksApi, TaskExecution } from '../api/tasks';
import {
  useSchedulerStats,
  useTaskDetail,
  useTaskExecutions,
  useTaskStats,
  invalidateTaskData,
} from '../api/queries';
import { taskTemplatesApi } from '../api/task-templates';
import { aiApi, ScheduleSuggestion } from '../api/ai';
import { getErrMsg } from '../utils/error';
import { formatDateTime, formatDuration, formatRelativeTime } from '../utils/timeFormat';
// CORE-03 收尾：保存为自定义模板的 config 白名单抽取
import { extractTemplateConfigFromTask } from '../utils/task-template-extract';
import { useTranslation } from 'react-i18next';
import '../i18n';
import GlueEditor from '../components/GlueEditor';
import TaskDependencyGraph from '../components/TaskDependencyGraph';
import { priorityTag } from '../utils/priority';
import ParamsEditor from '../components/ParamsEditor';
import ArtifactsList from '../components/ArtifactsList';
// CORE-02: retryableErrors 中文文案映射（与表单选项同一来源）
import { RETRYABLE_ERROR_OPTIONS } from './retry-policy';
import PageHeader from '../components/PageHeader';
import PageSkeleton from '../components/PageSkeleton';

const { Text } = Typography;

type BadgeStatus = 'success' | 'processing' | 'error' | 'default' | 'warning';
const STATUS_COLOR: Record<string, BadgeStatus> = {
  pending: 'default', running: 'processing', success: 'success',
  failed: 'error', timeout: 'warning', killed: 'error', cancelled: 'default',
};
const STATUS_LABEL = (t: (k: string) => string): Record<string, string> => ({
  pending: t('taskDetail.status.pending'), running: t('taskDetail.status.running'), success: t('taskDetail.status.success'),
  failed: t('taskDetail.status.failed'), timeout: t('taskDetail.status.timeout'), killed: t('taskDetail.status.killed'), cancelled: t('taskDetail.status.cancelled'),
});

export default function TaskDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const [execPage, setExecPage] = useState(1);
  const [aiModalOpen, setAiModalOpen] = useState(false);
  const [aiSuggestion, setAiSuggestion] = useState<ScheduleSuggestion | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [triggerModalOpen, setTriggerModalOpen] = useState(false);
  const [triggerParams, setTriggerParams] = useState<Record<string, string>>({});
  const [triggering, setTriggering] = useState(false);
  const [killingId, setKillingId] = useState<string | null>(null);
  const [toggleLoading, setToggleLoading] = useState(false);
  // CORE-03 收尾：保存为自定义模板 Modal
  const [tplModalOpen, setTplModalOpen] = useState(false);
  const [tplForm] = Form.useForm<{ name: string; description?: string; category?: string }>();
  const [tplSaving, setTplSaving] = useState(false);

  const statusLabels = STATUS_LABEL(t);

  const handleSaveAsTemplate = async () => {
    if (!task) return;
    try {
      const values = await tplForm.validateFields();
      setTplSaving(true);
      await taskTemplatesApi.create({
        name: values.name.trim(),
        description: values.description?.trim() || undefined,
        category: values.category?.trim() || undefined,
        config: extractTemplateConfigFromTask(task),
      });
      message.success(t('taskDetail.savedAsTemplate', { name: values.name.trim() }));
      setTplModalOpen(false);
    } catch (err: unknown) {
      // validateFields 的 reject 是带 errorFields 的校验对象，不是请求错误——
      // 仅对真正的请求失败弹 toast，表单校验错误由 Form 自带红字呈现。
      if (err && typeof err === 'object' && 'errorFields' in err) return;
      message.error(getErrMsg(err, t('taskDetail.saveAsTemplateFail')));
    } finally {
      setTplSaving(false);
    }
  };

  const handleAiSuggest = async () => {
    if (!id) return;
    setAiLoading(true);
    setAiModalOpen(true);
    try {
      const result = await aiApi.suggestSchedule(id);
      setAiSuggestion(result);
    } catch (err: unknown) {
      message.error(getErrMsg(err, t('taskDetail.aiAnalyzeFail')));
      setAiModalOpen(false);
    } finally {
      setAiLoading(false);
    }
  };

  // FEAT-17: TanStack Query 改造——四个 useRequest 换 queries.ts hooks：
  // - schedulerStats：30s 轮询语义由 refetchInterval 承担（queries.ts 内声明）；
  // - task/execs/stats：queryKey 带 id/分页参数（等价 ready+refreshDeps）；
  // - 写后失效：refreshTask/refreshExecs 收口为 invalidateTaskData（任务面 +
  //   执行面 + Dashboard 汇总联动，一处 invalidate 全站一致）。
  const queryClient = useQueryClient();
  const refreshTask = () => void invalidateTaskData(queryClient);
  const refreshExecs = () => void invalidateTaskData(queryClient);

  const { data: schedulerStats } = useSchedulerStats();

  const { data: task, isLoading: taskLoading, error: taskError } = useTaskDetail(id);

  const { data: execData, isLoading: execLoading } = useTaskExecutions(id, {
    page: execPage,
    pageSize: 20,
  });

  const { data: taskStats } = useTaskStats(id);

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
      message.success(t('taskDetail.triggerSuccess'));
      setTriggerModalOpen(false);
      setTimeout(refreshExecs, 1500);
    } catch (err: unknown) {
      message.error(getErrMsg(err, t('taskDetail.triggerFail')));
    } finally {
      setTriggering(false);
    }
  };

  const handlePause = async () => {
    if (toggleLoading) return;
    setToggleLoading(true);
    try { await tasksApi.pause(id!); message.success(t('taskDetail.paused')); refreshTask(); }
    catch (err: unknown) { message.error(getErrMsg(err, t('taskDetail.pauseFail'))); }
    finally { setToggleLoading(false); }
  };

  const handleResume = async () => {
    if (toggleLoading) return;
    setToggleLoading(true);
    try { await tasksApi.resume(id!); message.success(t('taskDetail.resumed')); refreshTask(); }
    catch (err: unknown) { message.error(getErrMsg(err, t('taskDetail.resumeFail'))); }
    finally { setToggleLoading(false); }
  };

  const handleDelete = async () => {
    try { await tasksApi.delete(id!); message.success(t('taskDetail.deleted')); nav('/tasks'); }
    catch (err: unknown) { message.error(getErrMsg(err, t('taskDetail.deleteFail'))); }
  };

  const handleEdit = () => {
    nav(`/tasks/${id}/edit`);
  };

  const handleKill = async (execId: string) => {
    if (killingId) return;
    setKillingId(execId);
    try {
      await tasksApi.killExecution(id!, execId);
      message.success(t('taskDetail.killed'));
      refreshExecs();
    } catch (err: unknown) { message.error(getErrMsg(err, t('taskDetail.killFail'))); }
    finally { setKillingId(null); }
  };

  // UI-08：首屏骨架屏替代裸 Spin
  if (taskLoading && !task) return <PageSkeleton variant="table" rows={6} style={{ padding: 24 }} />;
  // U7: 请求失败 ≠ 任务不存在——错误态给重试入口，数据确空才显示 Empty
  if (!task && taskError) {
    return (
      <Result
        status="error"
        title={t('taskDetail.loadErrorTitle')}
        subTitle={getErrMsg(taskError, t('taskDetail.loadErrorDesc'))}
        extra={
          <Space>
            <Button onClick={() => nav('/tasks')}>{t('taskDetail.backToList')}</Button>
            <Button type="primary" icon={<ReloadOutlined />} onClick={refreshTask}>{t('taskDetail.retry')}</Button>
          </Space>
        }
      />
    );
  }
  if (!task) return <Empty description={t('taskDetail.notFound')} />;

  // UI-09：375px 可用性——关键列=状态/开始时间/错误/操作；触发/执行器/耗时为
  // 次要列窄屏收起（CSS 侧 .ui09-hide-mobile 双保险），scroll.x 横向滚动兜底。
  const hideOnMobile = {
    onHeaderCell: () => ({ className: 'ui09-hide-mobile' }),
    onCell: () => ({ className: 'ui09-hide-mobile' }),
  } as const;
  const execColumns = [
    {
      title: t('taskDetail.col.status'), dataIndex: 'status', width: 90,
      render: (s: string) => <Badge status={STATUS_COLOR[s] ?? 'default'} text={statusLabels[s] || s} />,
    },
    {
      title: t('taskDetail.col.trigger'), dataIndex: 'triggerType', width: 80,
      ...hideOnMobile,
      render: (v: string) => <Text type="secondary" style={{ fontSize: 12 }}>{v || '-'}</Text>,
    },
    {
      title: t('taskDetail.col.executor'), dataIndex: 'executorAddress', width: 140, ellipsis: true,
      responsive: ['md'] as import('antd/es/_util/responsiveObserver').Breakpoint[],
      render: (v: string) => v ? (
        <Tooltip title={v}>
          <Text style={{ fontSize: 11, fontFamily: 'monospace' }}>{v}</Text>
        </Tooltip>
      ) : <Text type="secondary">-</Text>,
    },
    {
      title: t('taskDetail.col.startTime'), dataIndex: 'startTime', width: 140,
      render: (v: string) => v ? (
        <Tooltip title={formatDateTime(v)}>
          <Text style={{ fontSize: 12 }}>{formatRelativeTime(v)}</Text>
        </Tooltip>
      ) : '-',
    },
    {
      title: t('taskDetail.col.duration'), dataIndex: 'duration', width: 80,
      ...hideOnMobile,
      render: (v: number) => v != null ? <Text style={{ fontSize: 12 }}>{formatDuration(v)}</Text> : '-',
    },
    {
      title: t('taskDetail.col.error'), dataIndex: 'errorMessage', ellipsis: true,
      render: (v: string) => v ? <Text type="danger" style={{ fontSize: 12 }}>{v}</Text> : '-',
    },
    {
      title: '', key: 'actions', width: 100,
      render: (_: unknown, r: TaskExecution) => (
        <Space size={2}>
          {r.status === 'running' && (
            <Popconfirm
              title={t('taskDetail.killConfirmTitle')}
              description={t('taskDetail.killConfirmDesc')}
              onConfirm={() => handleKill(r.id)}
              okText={t('taskDetail.kill')} okButtonProps={{ danger: true }}
            >
              <Tooltip title={t('taskDetail.kill')}>
                <Button type="text" size="small" danger icon={<StopOutlined />}
                  loading={killingId === r.id} />
              </Tooltip>
            </Popconfirm>
          )}
          <Button type="link" size="small" icon={<EyeOutlined />}
            onClick={() => nav(`/tasks/${id}/executions/${r.id}`)}>{t('taskDetail.detail')}</Button>
        </Space>
      ),
    },
  ];

  const isActive = task.status === 'active';
  const isPaused = task.status === 'paused';

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => nav('/tasks')}>{t('taskDetail.back')}</Button>
      </Space>

      {/* UI-03：页头标准化（原 Typography.Title 区块迁入 PageHeader，面包屑语义=任务→详情（≤2 跳），
          操作按钮整体进 extra；返回按钮与状态 Badge/调度 Tag 原样保留） */}
      <PageHeader
        title={task.name}
        description={task.description}
        breadcrumb={[
          { title: t('taskDetail.breadcrumb.scheduler'), to: '/tasks' },
          { title: task.name },
        ]}
        extra={
          <>
            <Button icon={<ThunderboltOutlined />} type="primary" onClick={handleTrigger}>{t('taskDetail.triggerNow')}</Button>
            {isActive && <Button icon={<PauseCircleOutlined />} loading={toggleLoading} disabled={toggleLoading} onClick={handlePause}>{t('taskDetail.pause')}</Button>}
            {isPaused && <Button icon={<PlayCircleOutlined />} type="primary" loading={toggleLoading} disabled={toggleLoading} onClick={handleResume}>{t('taskDetail.resume')}</Button>}
            <Button icon={<RobotOutlined />} onClick={handleAiSuggest} loading={aiLoading}>{t('taskDetail.aiSuggestion')}</Button>
            {/* CORE-03 收尾：把当前任务配置固化为自定义模板（POST /task-templates） */}
            <Button
              icon={<SaveOutlined />}
              data-testid="save-as-template"
              onClick={() => { tplForm.setFieldsValue({ name: t('taskDetail.templateNameFormat', { name: task.name }) }); setTplModalOpen(true); }}
            >
              {t('taskDetail.saveAsTemplate')}
            </Button>
            <Button icon={<EditOutlined />} onClick={handleEdit}>{t('taskDetail.edit')}</Button>
            <Popconfirm title={t('taskDetail.confirmDelete')} onConfirm={handleDelete} okText={t('taskDetail.delete')} okButtonProps={{ danger: true }}>
              <Button icon={<DeleteOutlined />} danger>{t('taskDetail.delete')}</Button>
            </Popconfirm>
          </>
        }
      />
      {/* UI-09：状态行 Tag 群窄屏换行（Space wrap） */}
      <div style={{ marginBottom: 16 }}>
        <Space wrap>
          <Badge
            status={isActive ? 'success' : isPaused ? 'warning' : 'default'}
            text={isActive ? t('taskDetail.state.running') : isPaused ? t('taskDetail.state.paused') : task.status}
          />
          {schedulerStats && (
            <>
              <Tag style={{ fontSize: 11 }}>{t('taskDetail.stat.activeTimers', { count: schedulerStats.activeTimers })}</Tag>
              <Tag style={{ fontSize: 11 }}>{t('taskDetail.stat.activeCron', { count: schedulerStats.activeCronTasks })}</Tag>
              <Tag color="processing" style={{ fontSize: 11 }}>{t('taskDetail.stat.running', { count: schedulerStats.runningTaskCount })}</Tag>
            </>
          )}
        </Space>
      </div>

      {/* Stats row */}
      {taskStats && (
        <Row gutter={[16, 12]} style={{ marginBottom: 16 }}>
          <Col xs={12} sm={6}>
            <Card size="small">
              <Statistic
                title={t('taskDetail.stats.totalRuns')}
                value={taskStats.totalRuns ?? 0}
                prefix={<FieldTimeOutlined />}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card size="small">
              <Statistic
                title={t('taskDetail.stats.successRate')}
                value={(taskStats.successRate ?? 0).toFixed(1)}
                suffix="%"
                styles={{ content: { color: (taskStats.successRate ?? 0) >= 95 ? '#52c41a' : (taskStats.successRate ?? 0) >= 80 ? '#fa8c16' : '#ff4d4f' } }}
                prefix={<CheckCircleOutlined />}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card size="small">
              <Statistic
                title={t('taskDetail.stats.failed')}
                value={taskStats.totalRuns > 0 ? Number((taskStats.totalRuns * (1 - (taskStats.successRate ?? 0) / 100)).toFixed(1)) : 0}
                styles={taskStats.totalRuns > 0 && (taskStats.successRate ?? 0) < 100 ? { content: { color: '#ff4d4f' } } : undefined}
                prefix={<CloseCircleOutlined />}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card size="small">
              <Statistic
                title={t('taskDetail.stats.avgDuration')}
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
            label: t('taskDetail.tab.info'),
            children: (
              <Card>
                <Descriptions size="small" column={{ xs: 1, sm: 2, md: 3 }}>
                  <Descriptions.Item label={t('taskDetail.field.runtime')}><Tag>{task.runtime}</Tag></Descriptions.Item>
                  <Descriptions.Item label={t('taskDetail.field.triggerType')}><Tag>{task.triggerType}</Tag></Descriptions.Item>
                  {task.cronExpression && (
                    <Descriptions.Item label={t('taskDetail.field.cron')}><Text code>{task.cronExpression}</Text></Descriptions.Item>
                  )}
                  {task.fixedRate && (
                    <Descriptions.Item label={t('taskDetail.field.interval')}>
                      {task.fixedRate >= 3600
                        ? t('taskDetail.unit.hour', { n: (task.fixedRate / 3600).toFixed(1).replace(/\.0$/, '') })
                        : task.fixedRate >= 60
                          ? t('taskDetail.unit.minute', { n: (task.fixedRate / 60).toFixed(1).replace(/\.0$/, '') })
                          : t('taskDetail.unit.second', { n: task.fixedRate })}
                    </Descriptions.Item>
                  )}
                  {/* FEAT-06: 任务级维护窗口（命中时调度计划触发被跳过） */}
                  {task.maintenanceWindows && task.maintenanceWindows.length > 0 && (
                    <Descriptions.Item label={t('taskDetail.field.maintenance')} span={2}>
                      <Space size={[4, 4]} wrap>
                        {task.maintenanceWindows.map((w, i) => (
                          <Tag key={i} color="orange" style={{ fontFamily: 'monospace' }}>
                            {`${w.start} → ${w.end}${w.description ? t('taskDetail.maintenance.descFmt', { desc: w.description }) : ''}`}
                          </Tag>
                        ))}
                      </Space>
                    </Descriptions.Item>
                  )}
                  <Descriptions.Item label={t('taskDetail.field.entrypoint')}>{task.entrypoint || '-'}</Descriptions.Item>
                  {task.requirements && task.requirements.length > 0 && (
                    <Descriptions.Item label={t('taskDetail.field.requirements')}>
                      <Space size={[4, 4]} wrap>
                        {task.requirements.map((r) => <Tag key={r} color="blue">{r}</Tag>)}
                      </Space>
                    </Descriptions.Item>
                  )}
                  {/* FEAT-11: 运行手册（markdown 排障知识） */}
                  {task.runbook && (
                    <Descriptions.Item label={t('taskDetail.field.runbook')} span={2}>
                      <Typography.Paragraph
                        style={{ marginBottom: 0, whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: 12 }}
                      >
                        {task.runbook}
                      </Typography.Paragraph>
                    </Descriptions.Item>
                  )}
                  <Descriptions.Item label={t('taskDetail.field.timeout')}>{task.timeout ? t('taskDetail.unit.second', { n: task.timeout }) : '-'}</Descriptions.Item>
                  {/* CORE-04: 超时策略分级展示 */}
                  <Descriptions.Item label={t('taskDetail.field.timeoutAction')}>
                    {task.timeoutAction === 'kill_retry'
                      ? t('taskDetail.timeoutAction.killRetry')
                      : task.timeoutAction === 'notify_only'
                        ? t('taskDetail.timeoutAction.notifyOnly')
                        : t('taskDetail.timeoutAction.terminate')}
                  </Descriptions.Item>
                  <Descriptions.Item label={t('taskDetail.field.timeoutWarn')}>
                    {typeof task.timeoutWarnRatio === 'number'
                      ? t('taskDetail.timeoutWarn.format', { pct: task.timeoutWarnRatio })
                      : t('taskDetail.notEnabled')}
                  </Descriptions.Item>
                  <Descriptions.Item label={t('taskDetail.field.maxRetry')}>{t('taskDetail.countTimes', { count: task.maxRetry ?? 0 })}</Descriptions.Item>
                  {/* CORE-02: 可重试错误类型白名单展示（null/[] = 全部可重试） */}
                  <Descriptions.Item label={t('taskDetail.field.retryableErrors')} span={2}>
                    {task.retryableErrors && task.retryableErrors.length > 0 ? (
                      <Space size={[4, 4]} wrap>
                        {task.retryableErrors.map((r) => (
                          <Tag key={r} color="orange">
                            {RETRYABLE_ERROR_OPTIONS.find((o) => o.value === r)?.label ?? r}
                          </Tag>
                        ))}
                      </Space>
                    ) : (
                      <Text type="secondary">{t('taskDetail.allRetryable')}</Text>
                    )}
                  </Descriptions.Item>
                  <Descriptions.Item label={t('taskDetail.field.priority')}>
                    <Tag color={priorityTag(task.priority).color}>{priorityTag(task.priority).label}</Tag>
                  </Descriptions.Item>
                  <Descriptions.Item label={t('taskDetail.field.executeMode')}>
                    {task.executeMode === 'broadcast' ? t('taskDetail.executeMode.broadcast') : task.executeMode === 'single' ? t('taskDetail.executeMode.single') : task.executeMode || t('taskDetail.executeMode.auto')}
                  </Descriptions.Item>
                  {task.executorAppName && (
                    <Descriptions.Item label={t('taskDetail.field.executorApp')}>{task.executorAppName}</Descriptions.Item>
                  )}
                  <Descriptions.Item label={t('taskDetail.field.executorGroup')}>{task.executorGroup || t('taskDetail.any')}</Descriptions.Item>
                </Descriptions>
                {task.params && Object.keys(task.params).length > 0 && (
                  <div style={{ marginTop: 16 }}>
                    <Typography.Text strong style={{ fontSize: 13 }}>{t('taskDetail.defaultParams')}</Typography.Text>
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
              <span><CodeOutlined /> {t('taskDetail.tab.glue')}</span>
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
            key: 'deps',
            label: (
              <span><ApartmentOutlined /> {t('taskDetail.tab.deps')}</span>
            ),
            children: (
              <Card>
                <TaskDependencyGraph taskId={id!} />
              </Card>
            ),
          },
          {
            key: 'executions',
            label: (
              <span>
                <ClockCircleOutlined /> {t('taskDetail.tab.executions')}
              </span>
            ),
            children: (
              <Card
                extra={
                  <Space>
                    <Button size="small" icon={<ReloadOutlined />} onClick={refreshExecs}>{t('taskDetail.refresh')}</Button>
                    <Button size="small" type="primary" icon={<ThunderboltOutlined />} onClick={handleTrigger}>{t('taskDetail.manualTrigger')}</Button>
                  </Space>
                }
              >
                {/* FEAT-05（UI 半场）：最近一次执行的产物列表；无产物时组件返回 null，整段不渲染 */}
                {executions.length > 0 && (
                  <div style={{ marginBottom: 12 }}>
                    <ArtifactsList execId={executions[0].id} />
                  </div>
                )}
                <Table<TaskExecution>
                  rowKey="id"
                  columns={execColumns}
                  dataSource={executions}
                  loading={execLoading}
                  size="small"
                  // UI-09：次要列窄屏收起（CSS 媒体查询 .ui09-hide-mobile）+ 横向滚动兜底（值班手机看失败原因）
                  scroll={{ x: 620 }}
                  pagination={{
                    total: execTotal,
                    pageSize: 20,
                    current: execPage,
                    onChange: setExecPage,
                    showTotal: (count) => t('taskDetail.countTotal', { count }),
                  }}
                  locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('taskDetail.noExecutions')} /> }}
                />
              </Card>
            ),
          },
        ]}
      />

      {/* 触发弹窗 */}
      <Modal
        title={<Space><ThunderboltOutlined /> {t('taskDetail.triggerTitle')}</Space>}
        open={triggerModalOpen}
        onCancel={() => setTriggerModalOpen(false)}
        onOk={handleTriggerConfirm}
        okText={t('taskDetail.trigger')}
        okButtonProps={{ loading: triggering, icon: <ThunderboltOutlined /> }}
        cancelText={t('taskDetail.cancel')}
        width={520}
        destroyOnHidden
      >
        <Alert
          type="info"
          showIcon
          title={t('taskDetail.runtimeParamsTitle')}
          description={t('taskDetail.runtimeParamsDesc')}
          style={{ marginBottom: 16 }}
        />
        <Form layout="vertical">
          <Form.Item label={t('taskDetail.field.execParams')}>
            <ParamsEditor
              value={triggerParams}
              onChange={setTriggerParams}
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* AI 调度建议弹窗 */}
      <Modal
        title={<Space><RobotOutlined /> {t('taskDetail.aiSuggestion')}</Space>}
        open={aiModalOpen}
        onCancel={() => setAiModalOpen(false)}
        footer={[
          aiSuggestion?.suggestedCron && (
            <Button key="apply" type="primary" onClick={() => {
              nav(`/tasks/${id}/edit?suggestCron=${encodeURIComponent(aiSuggestion.suggestedCron)}`);
              setAiModalOpen(false);
            }}>{t('taskDetail.applyCron')}</Button>
          ),
          <Button key="close" onClick={() => setAiModalOpen(false)}>{t('taskDetail.close')}</Button>,
        ]}
        width={560}
      >
        {aiLoading ? (
          <div style={{ textAlign: 'center', padding: 40 }}><PageSkeleton variant="table" rows={2} /></div>
        ) : aiSuggestion ? (
          <div>
            <Descriptions size="small" column={1} bordered style={{ marginBottom: 16 }}>
              <Descriptions.Item label={t('taskDetail.ai.successRate')}>{(aiSuggestion.successRate * 100).toFixed(1)}%</Descriptions.Item>
              <Descriptions.Item label={t('taskDetail.ai.p95')}>{aiSuggestion.p95Duration ? `${(aiSuggestion.p95Duration / 1000).toFixed(1)}s` : '-'}</Descriptions.Item>
              <Descriptions.Item label={t('taskDetail.ai.currentCron')}>{aiSuggestion.currentCron || t('taskDetail.ai.none')}</Descriptions.Item>
              <Descriptions.Item label={t('taskDetail.ai.suggestedCron')}><Text code style={{ color: '#52c41a' }}>{aiSuggestion.suggestedCron || t('taskDetail.ai.noSuggestion')}</Text></Descriptions.Item>
            </Descriptions>
            {aiSuggestion.reasoning && (
              <Card size="small" title={t('taskDetail.ai.analysisTitle')}>
                <Text style={{ whiteSpace: 'pre-wrap' }}>{aiSuggestion.reasoning}</Text>
              </Card>
            )}
          </div>
        ) : null}
      </Modal>

      {/* CORE-03 收尾：保存为自定义模板弹窗——config 由 extractTemplateConfigFromTask
          白名单抽取（CreateTaskDto 子集，后端 forbidNonWhitelisted 校验），此处只填模板元信息 */}
      <Modal
        title={<Space><SaveOutlined /> {t('taskDetail.tpl.title')}</Space>}
        open={tplModalOpen}
        onCancel={() => setTplModalOpen(false)}
        onOk={handleSaveAsTemplate}
        okText={t('taskDetail.tpl.ok')}
        okButtonProps={{ loading: tplSaving, 'data-testid': 'tpl-save-confirm' } as never}
        cancelText={t('taskDetail.cancel')}
        width={520}
        destroyOnHidden
      >
        <Form form={tplForm} layout="vertical">
          <Form.Item
            name="name"
            label={t('taskDetail.tpl.name')}
            rules={[{ required: true, whitespace: true, message: t('taskDetail.tpl.nameRequired') }]}
          >
            <Input placeholder={t('taskDetail.tpl.namePlaceholder')} maxLength={128} data-testid="tpl-name-input" />
          </Form.Item>
          <Form.Item name="description" label={t('taskDetail.tpl.description')}>
            <Input.TextArea rows={2} placeholder={t('taskDetail.tpl.descriptionPlaceholder')} maxLength={500} data-testid="tpl-desc-input" />
          </Form.Item>
          <Form.Item name="category" label={t('taskDetail.tpl.category')}>
            <Input placeholder={t('taskDetail.tpl.categoryPlaceholder')} maxLength={32} data-testid="tpl-category-input" />
          </Form.Item>
        </Form>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t('taskDetail.tpl.note')}
        </Typography.Text>
      </Modal>
    </div>
  );
}