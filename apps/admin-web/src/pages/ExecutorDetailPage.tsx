import { useParams, Link } from 'react-router-dom';
import { Card, Descriptions, Table, Badge, Button, Modal, Form, Input, InputNumber, Select, message, Statistic, Row, Col, Spin, Progress, Typography, Breadcrumb, Empty } from 'antd';
import { useRequest } from 'ahooks';
import { executorsApi } from '../api/executors';
import { useState } from 'react';

const { Text } = Typography;

export default function ExecutorDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [editOpen, setEditOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [editForm] = Form.useForm();
  const [configForm] = Form.useForm();

  const { data: executor, loading: loadingExecutor, refresh: refreshExecutor } = useRequest(
    () => executorsApi.get(id!),
    { ready: !!id, refreshDeps: [id] },
  );

  const { data: metrics, loading: loadingMetrics } = useRequest(
    () => executorsApi.getMetrics(id!),
    { ready: !!id, refreshDeps: [id], pollingInterval: 30000 },
  );

  const { data: executions, loading: loadingExecutions } = useRequest(
    () => executorsApi.getExecutions(id!, { page: 1, limit: 20 }),
    { ready: !!id, refreshDeps: [id] },
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
    { manual: true, onSuccess: (res) => { Modal.success({ title: '新Token', content: res.token }); } },
  );

  if (loadingExecutor) return <Spin style={{ display: 'flex', justifyContent: 'center', marginTop: 100 }} />;
  if (!executor) return <div>执行器不存在</div>;

  const breadcrumbItems = [
    { title: <Link to="/dashboard">首页</Link> },
    { title: <Link to="/executors">执行器管理</Link> },
    { title: '执行器详情' },
  ];

  const execColumns = [
    { title: '任务ID', dataIndex: 'taskId', key: 'taskId', width: 280 },
    { title: '状态', dataIndex: 'status', key: 'status', width: 100, render: (v: string) => (
      <Badge status={v === 'success' ? 'success' : v === 'failed' ? 'error' : 'processing'} text={v} />
    )},
    { title: '开始时间', dataIndex: 'startTime', key: 'startTime', width: 180, render: (v: string) => v ? new Date(v).toLocaleString() : '-' },
    { title: '耗时(ms)', dataIndex: 'duration', key: 'duration', width: 100, render: (v: number) => v ?? '-' },
    { title: '错误', dataIndex: 'errorMessage', key: 'errorMessage', ellipsis: true },
  ];

  return (
    <div>
      <Breadcrumb items={breadcrumbItems} style={{ marginBottom: 16 }} />
      <Card title="执行器详情" extra={
        <Button.Group>
          <Button onClick={() => { editForm.setFieldsValue(executor); setEditOpen(true); }}>编辑</Button>
          <Button onClick={() => setConfigOpen(true)}>配置热更新</Button>
          <Button danger loading={rotating} onClick={rotateToken}>轮换Token</Button>
        </Button.Group>
      }>
        <Descriptions column={3}>
          <Descriptions.Item label="AppName">{executor.appName}</Descriptions.Item>
          <Descriptions.Item label="地址">{executor.address}</Descriptions.Item>
          <Descriptions.Item label="状态">
            <Badge status={executor.status === 'online' ? 'success' : 'default'} text={executor.status} />
          </Descriptions.Item>
          <Descriptions.Item label="分组">{executor.groupName || '-'}</Descriptions.Item>
          <Descriptions.Item label="标签">{executor.tags?.join(', ') || '-'}</Descriptions.Item>
          <Descriptions.Item label="最大并发">{executor.maxConcurrentTasks ?? '无限制'}</Descriptions.Item>
          <Descriptions.Item label="最后心跳">{executor.lastHeartbeat ? new Date(executor.lastHeartbeat).toLocaleString() : '-'}</Descriptions.Item>
          <Descriptions.Item label="描述" span={2}>{executor.description || '-'}</Descriptions.Item>
        </Descriptions>
      </Card>

      <Row gutter={16} style={{ marginTop: 16 }}>
        <Col span={12}>
          <Card title="实时资源使用" loading={loadingMetrics}>
            {executor && (
              <Row gutter={16}>
                <Col span={8}>
                  <Statistic
                    title="CPU 使用率"
                    value={executor.cpuUsage ?? 0}
                    suffix="%"
                    valueStyle={{ color: (executor.cpuUsage ?? 0) > 80 ? '#cf1322' : (executor.cpuUsage ?? 0) > 60 ? '#faad14' : '#3f8600' }}
                  />
                  <Progress percent={executor.cpuUsage ?? 0} showInfo={false} strokeColor={(executor.cpuUsage ?? 0) > 80 ? '#cf1322' : '#3f8600'} style={{ marginTop: 8 }} />
                </Col>
                <Col span={8}>
                  <Statistic
                    title="内存使用率"
                    value={executor.memUsage ?? 0}
                    suffix="%"
                    valueStyle={{ color: (executor.memUsage ?? 0) > 80 ? '#cf1322' : (executor.memUsage ?? 0) > 60 ? '#faad14' : '#3f8600' }}
                  />
                  <Progress percent={executor.memUsage ?? 0} showInfo={false} strokeColor={(executor.memUsage ?? 0) > 80 ? '#cf1322' : '#3f8600'} style={{ marginTop: 8 }} />
                </Col>
                <Col span={8}>
                  <Statistic
                    title="磁盘使用率"
                    value={executor.diskUsage ?? 0}
                    suffix="%"
                    valueStyle={{ color: (executor.diskUsage ?? 0) > 90 ? '#cf1322' : (executor.diskUsage ?? 0) > 70 ? '#faad14' : '#3f8600' }}
                  />
                  <Progress percent={executor.diskUsage ?? 0} showInfo={false} strokeColor={(executor.diskUsage ?? 0) > 90 ? '#cf1322' : '#3f8600'} style={{ marginTop: 8 }} />
                </Col>
              </Row>
            )}
          </Card>
        </Col>
        <Col span={12}>
          <Card title="性能统计（近7天）" loading={loadingMetrics}>
            {metrics ? (
              <Row gutter={16}>
                <Col span={8}><Statistic title="总执行次数" value={metrics.sevenDayStats.totalExecutions} /></Col>
                <Col span={8}>
                  <Statistic title="成功率" value={parseFloat(metrics.sevenDayStats.successRate)} suffix="%" valueStyle={{ color: '#3f8600' }} precision={1} />
                  <Text type="secondary" style={{ fontSize: 12 }}>成功 {metrics.sevenDayStats.successful} / 失败 {metrics.sevenDayStats.failed}</Text>
                </Col>
                <Col span={8}><Statistic title="平均耗时" value={parseFloat(metrics.sevenDayStats.averageDurationMs)} suffix="ms" precision={0} /></Col>
              </Row>
            ) : (
              !loadingMetrics && (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="暂无性能数据，执行任务后将在此显示统计信息"
                />
              )
            )}
          </Card>
        </Col>
      </Row>

      <Row gutter={16} style={{ marginTop: 16 }}>
        <Col span={8}>
          <Card loading={loadingMetrics}>
            <Statistic
              title="当前运行任务"
              value={executor.runningTaskCount ?? 0}
              suffix={`/ ${executor.maxConcurrentTasks ?? '∞'}`}
            />
          </Card>
        </Col>
        <Col span={8}>
          <Card loading={loadingMetrics}>
            <Statistic
              title="总执行任务数"
              value={executor.totalTaskCount ?? 0}
            />
          </Card>
        </Col>
        <Col span={8}>
          <Card loading={loadingMetrics}>
            <Statistic
              title="失败任务数"
              value={executor.failedTaskCount ?? 0}
              valueStyle={{ color: '#cf1322' }}
            />
          </Card>
        </Col>
      </Row>

      <Card title="历史任务执行" style={{ marginTop: 16 }}>
        <Table
          rowKey="id"
          columns={execColumns}
          dataSource={executions?.items ?? []}
          loading={loadingExecutions}
          pagination={{ total: executions?.total, pageSize: 20 }}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="该执行器暂无历史执行记录"
              />
            ),
          }}
        />
      </Card>

      <Modal title="编辑执行器" open={editOpen} onCancel={() => setEditOpen(false)} onOk={() => editForm.submit()} confirmLoading={updating}>
        <Form form={editForm} layout="vertical" onFinish={updateExecutor}>
          <Form.Item name="groupName" label="分组名称"><Input /></Form.Item>
          <Form.Item name="tags" label="标签"><Select mode="tags" /></Form.Item>
          <Form.Item name="description" label="描述"><Input.TextArea /></Form.Item>
          <Form.Item name="maxConcurrentTasks" label="最大并发数"><InputNumber min={1} /></Form.Item>
        </Form>
      </Modal>

      <Modal title="配置热更新" open={configOpen} onCancel={() => setConfigOpen(false)} onOk={() => configForm.submit()} confirmLoading={reloading}>
        <Form form={configForm} layout="vertical" onFinish={reloadConfig}>
          <Form.Item name="maxConcurrentTasks" label="最大并发数"><InputNumber min={1} /></Form.Item>
          <Form.Item name="taskTimeoutSeconds" label="任务超时(秒)"><InputNumber min={1} /></Form.Item>
          <Form.Item name="heartbeatIntervalSeconds" label="心跳间隔(秒)"><InputNumber min={5} /></Form.Item>
          <Form.Item name="adminApiUrl" label="Admin API地址"><Input /></Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
