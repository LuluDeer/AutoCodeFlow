import { useParams, useNavigate } from 'react-router-dom';
import { Card, Descriptions, Table, Badge, Button, Modal, Form, Input, InputNumber, Select, message, Statistic, Row, Col, Spin, Progress, Typography, Breadcrumb, Empty, Tooltip, Space, Alert, Result } from 'antd';
import { WarningOutlined, CopyOutlined, InfoCircleOutlined, ReloadOutlined } from '@ant-design/icons';
import { useRequest } from 'ahooks';
import { executorsApi, type ExecutorExecution } from '../api/executors';
import { getErrMsg } from '../utils/error';
import { useState } from 'react';

const { Text } = Typography;

function relativeTime(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  return `${Math.floor(hours / 24)}天前`;
}

function isHeartbeatStale(isoString: string): boolean {
  return Date.now() - new Date(isoString).getTime() > 5 * 60 * 1000;
}

/** Returns Ant Design token color based on usage percent and thresholds */
function usageColor(value: number, warn =60, danger = 80): string {
  if (value >= danger) return '#cf1322';
  if (value >= warn) return '#faad14';
  return '#3f8600';
}

export default function ExecutorDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [editOpen, setEditOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [execPage, setExecPage] = useState(1);
  const [editForm] = Form.useForm();
  const [configForm] = Form.useForm();

  const { data: executor, loading: loadingExecutor, error: executorError, refresh: refreshExecutor } = useRequest(
    () => executorsApi.get(id!),
    { ready: !!id, refreshDeps: [id] },
  );

  const { data: metrics, loading: loadingMetrics } = useRequest(
    () => executorsApi.getMetrics(id!),
    { ready: !!id, refreshDeps: [id], pollingInterval: 30000, pollingWhenHidden: false },
  );

  const { data: executions, loading: loadingExecutions } = useRequest(
    () => executorsApi.getExecutions(id!, { page: execPage, pageSize: 20 }),
    { ready: !!id, refreshDeps: [id, execPage] },
  );

  const { run: updateExecutor, loading: updating } = useRequest(
    (values) => executorsApi.update(id!, values),
    { manual: true, onSuccess: () => { message.success('更新成功'); setEditOpen(false); refreshExecutor(); } },
  );

  const { run: reloadConfig, loading: reloading } = useRequest(
    (values) => executorsApi.reloadConfig(id!, values),
    { manual: true, onSuccess: () => { message.success('配置已推送'); setConfigOpen(false); } },
  );

  const { run: rotateToken, loading: rotating } = useRequest(
    () => executorsApi.rotateToken(id!),
    {
      manual: true,
      onSuccess: (res) => {
        Modal.success({
          title: '新Token（请妥善保存，关闭后不再显示）',
          content: (
            <Space>
              <Text code copyable={{ text: res.token }}>{res.token}</Text>
            </Space>
          ),
        });
      },
    },
  );

  const { run: setOffline, loading: settingOffline } = useRequest(
    () => executorsApi.setOffline(id!),
    {
      manual: true,
      onSuccess: () => { message.success('执行器已设置为离线'); refreshExecutor(); },
      onError: (e) => { message.error(`设置失败：${e.message}`); },
    },
  );

  if (loadingExecutor && !executor) return <div style={{ display: 'flex', justifyContent: 'center', marginTop: 100 }}><Spin size="large" /></div>;
  // U7: 请求失败 ≠ 执行器不存在——错误态给重试入口，数据确空才显示 Empty
  if (!executor && executorError) {
    return (
      <Result
        status="error"
        title="执行器详情加载失败"
        subTitle={getErrMsg(executorError, '请求失败，请重试')}
        extra={
          <Space>
            <Button onClick={() => navigate('/executors')}>返回执行器列表</Button>
            <Button type="primary" icon={<ReloadOutlined />} onClick={refreshExecutor}>重试</Button>
          </Space>
        }
      />
    );
  }
  if (!executor) return <div style={{ padding: 80 }}><Empty description="执行器不存在或已被删除" /></div>;

  const isOnline = executor.status === 'online';
  const maxConcurrent = executor.maxConcurrentTasks ?? 0;
  // U5: CPU/内存/运行计数取 30s 轮询的 metrics.current（首轮返回前回退进页快照）。
  // diskUsage/lastHeartbeat/runningExecutionIds 不在 metrics 接口内，仍来自 get 快照，
  // 活性区（最后心跳/运行中执行）在 UI 标注快照语义。
  const liveCpu = metrics?.current?.cpuUsage ?? executor.cpuUsage ?? 0;
  const liveMem = metrics?.current?.memUsage ?? executor.memUsage ?? 0;
  const runningCount = metrics?.current?.runningTaskCount ?? executor.runningTaskCount ?? 0;
  const runningPercent = maxConcurrent > 0 ? Math.min(100, Math.round((runningCount / maxConcurrent) * 100)) : 0;

  // CONSISTENCY-02: 执行器心跳上报的运行中 executionId（null = 旧版未上报）。
  // 与 runningTaskCount 交叉核对：长期不一致提示执行器计数或回调链路异常。
  const reportedIds = executor.runningExecutionIds;
  const reportedCount = reportedIds?.length;

  const heartbeatStale = executor.lastHeartbeat ? isHeartbeatStale(executor.lastHeartbeat) : false;
  const heartbeatText = executor.lastHeartbeat ? relativeTime(executor.lastHeartbeat) : '-';
  const heartbeatAbsolute = executor.lastHeartbeat ? new Date(executor.lastHeartbeat).toLocaleString() : '';

  type BadgeStatus = 'success' | 'processing' | 'error' | 'default' | 'warning';
  const STATUS_MAP: Record<string, { badge: BadgeStatus; label: string }> = {
    pending:   { badge: 'default',    label: '等待中' },
    running:   { badge: 'processing', label: '运行中' },
    success:   { badge: 'success',    label: '成功'   },
    failed:    { badge: 'error',      label: '失败'   },
    timeout:   { badge: 'warning',    label: '超时'   },
    killed:    { badge: 'error',      label: '已终止' },
    cancelled: { badge: 'default',    label: '已取消' },
  };
  const execColumns = [
    // U10: 补任务名/退出码列，行点击直达执行详情页
    { title: '任务', dataIndex: 'taskName', key: 'taskName', ellipsis: true, render: (v: string | undefined, r: ExecutorExecution) => (
      <a onClick={(e) => { e.stopPropagation(); navigate(`/tasks/${r.taskId}/executions/${r.id}`); }}>{v || r.taskId}</a>
    )},
    { title: '状态', dataIndex: 'status', key: 'status', width: 90, render: (v: string) => {
      const cfg = STATUS_MAP[v] || { badge: 'default' as BadgeStatus, label: v };
      return <Badge status={cfg.badge} text={cfg.label} />;
    }},
    { title: '开始时间', dataIndex: 'startTime', key: 'startTime', width: 170, render: (v: string) => v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '-' },
    { title: '耗时', dataIndex: 'duration', key: 'duration', width: 90, render: (v: number) => v != null ? (v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`) : '-' },
    { title: '退出码', dataIndex: 'exitCode', key: 'exitCode', width: 80, render: (v: number | null | undefined) => v != null ? <Text type={v !== 0 ? 'danger' : undefined} code>{v}</Text> : '-' },
    { title: '错误', dataIndex: 'errorMessage', key: 'errorMessage', ellipsis: true, render: (v: string) => v ? <Text type="danger" style={{ fontSize: 12 }}>{v}</Text> : '-' },
  ];

  return (
    <div>
      <Breadcrumb
        style={{ marginBottom: 16 }}
        items={[
          { title: <a onClick={() => navigate('/executors')}>执行器列表</a> },
          { title: executor.appName },
        ]}
      />

      <Card
        title="执行器详情"
        extra={
          <Space>
            <Button.Group>
              <Button onClick={() => { editForm.setFieldsValue(executor); setEditOpen(true); }}>编辑</Button>
              <Button onClick={() => setConfigOpen(true)}>配置热更新</Button>
              <Button
                danger
                disabled={!isOnline}
                loading={settingOffline}
                onClick={() => {
                  Modal.confirm({
                    title: '确认设置离线',
                    content: '将该执行器标记为离线，正在运行的任务不会被中断。确认继续？',
                    okText: '确认',
                    cancelText: '取消',
                    onOk: setOffline,
                  });
                }}
              >
                设置离线
              </Button>
            </Button.Group>
            <Tooltip title="轮换后旧Token 立即失效">
              <Button
                danger
                loading={rotating}
                icon={<CopyOutlined />}
                onClick={() => {
                  Modal.confirm({
                    title: '确认轮换 Token',
                    content: '所有使用旧 Token 的执行器将立即失效并掉线，需要重新注册后才能恢复连接。确认继续？',
                    okText: '确认轮换',
                    okButtonProps: { danger: true },
                    cancelText: '取消',
                    onOk: rotateToken,
                  });
                }}
              >轮换 Token</Button>
            </Tooltip>
          </Space>
        }
      >
        <Descriptions column={3}>
          <Descriptions.Item label="AppName">{executor.appName}</Descriptions.Item>
          <Descriptions.Item label="地址">{executor.address}</Descriptions.Item>
          <Descriptions.Item label="状态">
            <Badge status={isOnline ? 'success' : 'default'} text={executor.status} />
          </Descriptions.Item>
          <Descriptions.Item label="类型">{executor.type || '-'}</Descriptions.Item>
          <Descriptions.Item label="版本">{executor.executorVersion || '-'}</Descriptions.Item>
          <Descriptions.Item label="分组">{executor.groupName || '-'}</Descriptions.Item>
          <Descriptions.Item label="标签">{executor.tags?.join(', ') || '-'}</Descriptions.Item>
          <Descriptions.Item label="最大并发">{executor.maxConcurrentTasks ?? '无限制'}</Descriptions.Item>
          <Descriptions.Item label="最后心跳（进页快照）">
            <Tooltip title={heartbeatAbsolute}>
              {heartbeatStale ? (
                <Text style={{ color: '#fa8c16' }}>
                  <WarningOutlined style={{ marginRight: 4 }} />
                  {heartbeatText}
                </Text>
              ) : (
                <Text>{heartbeatText}</Text>
              )}
            </Tooltip>
          </Descriptions.Item>
          <Descriptions.Item label="描述" span={2}>{executor.description || '-'}</Descriptions.Item>
          <Descriptions.Item label="运行中执行（活性上报 · 进页快照）">
            {reportedIds === undefined || reportedIds === null ? (
              <Tooltip title="该执行器版本未上报运行中执行列表，stale 扫描对其不启用活性跳过">
                <Text type="secondary">未上报 <InfoCircleOutlined /></Text>
              </Tooltip>
            ) : reportedCount === 0 ? (
              <Text type="secondary">0（空闲）</Text>
            ) : (
              <Tooltip title={
                <div style={{ maxHeight: 240, overflowY: 'auto' }}>
                  {reportedIds.map((eid) => (
                    <div key={eid} style={{ fontFamily: 'monospace', fontSize: 12 }}>{eid}</div>
                  ))}
                </div>
              }>
                <Text>{reportedCount} 条 <InfoCircleOutlined /></Text>
              </Tooltip>
            )}
          </Descriptions.Item>
        </Descriptions>
      </Card>

      {!isOnline && (
        <Alert
          type="warning"
          showIcon
          message="执行器离线，以下指标为最后一次心跳的缓存数据，可能已过期"
          style={{ marginTop: 16 }}
        />
      )}

      <Row gutter={16} style={{ marginTop: 16 }}>
        <Col span={12}>
          <Card
            title="实时资源使用"
            loading={loadingMetrics && !metrics}
            extra={<Text type="secondary" style={{ fontSize: 12 }}>每 30s 轮询</Text>}
          >
            <Row gutter={16}>
              {([
                { title: 'CPU 使用率', value: liveCpu, warn: 60, danger: 80 },
                { title: '内存使用率', value: liveMem, warn: 60, danger: 80 },
                // diskUsage 不在 metrics 接口内：仍取进页快照
                { title: '磁盘使用率', value: executor.diskUsage ?? 0, warn: 70, danger: 90 },
              ] as const).map(({ title, value, warn, danger }) => (
                <Col span={8} key={title}>
                  <Statistic title={title} value={value} suffix="%" precision={1} styles={{ content: { color: usageColor(value, warn, danger) } }} />
                  <Progress percent={Math.round(value)} showInfo={false} strokeColor={usageColor(value, warn, danger)} style={{ marginTop: 8 }} />
                </Col>
              ))}
            </Row>
          </Card>
        </Col>
        <Col span={12}>
          <Card title="性能统计（近7天）" loading={loadingMetrics && !metrics}>
            {metrics ? (
              <Row gutter={16}>
                <Col span={8}><Statistic title="总执行次数" value={metrics.sevenDayStats.totalExecutions} /></Col>
                <Col span={8}>
                  <Statistic title="成功率" value={Number.isFinite(+metrics.sevenDayStats.successRate) ? +metrics.sevenDayStats.successRate : 0} suffix="%" styles={{ content: { color: '#3f8600' } }} precision={1} />
                  <Text type="secondary" style={{ fontSize: 12 }}>成功 {metrics.sevenDayStats.successful} / 失败 {metrics.sevenDayStats.failed}</Text>
                </Col>
                <Col span={8}><Statistic title="平均耗时" value={Number.isFinite(+metrics.sevenDayStats.averageDurationMs) ? +metrics.sevenDayStats.averageDurationMs : 0} suffix="ms" precision={0} /></Col>
              </Row>
            ) : (
              !loadingMetrics && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无性能数据，执行任务后将在此显示统计信息" />
            )}
          </Card>
        </Col>
      </Row>

      <Row gutter={16} style={{ marginTop: 16 }}>
        <Col span={8}>
          <Card>
            <Statistic title="当前运行任务" value={runningCount} suffix={`/ ${executor.maxConcurrentTasks ?? '∞'}`} />
            {maxConcurrent > 0 && (
              <Progress percent={runningPercent} showInfo={false} strokeColor={usageColor(runningPercent, 70, 90)} style={{ marginTop: 8 }} />
            )}
            {reportedCount != null && reportedCount !== runningCount && (
              <Text type="warning" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
                活性上报 {reportedCount} 条，与运行计数 {runningCount} 不一致
              </Text>
            )}
          </Card>
        </Col>
        <Col span={8}>
          <Card><Statistic title="总执行任务数" value={executor.totalTaskCount ?? 0} /></Card>
        </Col>
        <Col span={8}>
          <Card><Statistic title="失败任务数" value={executor.failedTaskCount ?? 0} styles={{ content: { color: '#cf1322' } }} /></Card>
        </Col>
      </Row>

      <Card title="历史任务执行" style={{ marginTop: 16 }}>
        <Table
          rowKey="id"
          columns={execColumns}
          dataSource={executions?.items ?? []}
          loading={loadingExecutions}
          onRow={(r: ExecutorExecution) => ({
            onClick: () => navigate(`/tasks/${r.taskId}/executions/${r.id}`),
            style: { cursor: 'pointer' },
          })}
          pagination={{
            total: executions?.total,
            pageSize: 20,
            current: execPage,
            onChange: (page) => setExecPage(page),
            showTotal: (total) => `共${total} 条`,
          }}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该执行器暂无历史执行记录" /> }}
        />
      </Card>

      <Modal title="编辑执行器" open={editOpen} onCancel={() => setEditOpen(false)} onOk={() => editForm.submit()} confirmLoading={updating}>
        <Form form={editForm} layout="vertical" onFinish={updateExecutor}>
          <Form.Item name="groupName" label="分组名称"><Input /></Form.Item>
          <Form.Item name="tags" label="标签" tooltip="输入标签名后按回车添加"><Select mode="tags" tokenSeparators={[',', ' ']} placeholder="输入后回车添加" /></Form.Item>
          <Form.Item name="description" label="描述"><Input.TextArea /></Form.Item>
          <Form.Item name="maxConcurrentTasks" label="最大并发数"><InputNumber min={1} /></Form.Item>
        </Form>
      </Modal>

      <Modal title="配置热更新" open={configOpen} onCancel={() => setConfigOpen(false)} onOk={() => configForm.submit()} confirmLoading={reloading}>
        <Form form={configForm} layout="vertical" onFinish={reloadConfig}>
          <Form.Item name="maxConcurrentTasks" label="最大并发数"><InputNumber min={1} /></Form.Item>
          <Form.Item name="taskTimeoutSeconds" label="任务超时(秒)"><InputNumber min={1} /></Form.Item>
          <Form.Item name="heartbeatIntervalSeconds" label="心跳间隔(秒)"><InputNumber min={5} /></Form.Item>
          <Form.Item name="adminApiUrl" label="Admin API地址"><Input placeholder="默认 Admin API 地址" /></Form.Item>
          <Form.Item name="adminApiUrlInternal" label="Admin API内部地址"><Input placeholder="执行器容器/内网访问地址" /></Form.Item>
          <Form.Item name="adminApiUrlExternal" label="Admin API外部地址"><Input placeholder="执行器回调优先使用的公网地址" /></Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
