import { useQuery } from '@tanstack/react-query';
import { Row, Col, Card, Statistic, Table, Tag, Progress, Spin, Typography } from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  SyncOutlined,
  CloudServerOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons';
import { metricsApi, RecentFailure, ExecutorStat } from '../api/metrics';
import { tasksApi } from '../api/tasks';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';

const { Title } = Typography;

export default function DashboardPage() {
  const { data: summary, isLoading: loadingSummary } = useQuery({
    queryKey: ['metrics-summary'],
    queryFn: () => metricsApi.getSummary(),
    refetchInterval: 30000,
  });

  const { data: trend = [], isLoading: loadingTrend } = useQuery({
    queryKey: ['metrics-trend'],
    queryFn: () => metricsApi.getDailyTrend(7),
    refetchInterval: 60000,
  });

  const { data: executors = [], isLoading: loadingExecutors } = useQuery({
    queryKey: ['metrics-executors'],
    queryFn: () => metricsApi.getExecutorStats(),
    refetchInterval: 15000,
  });

  const { data: failures = [], isLoading: loadingFailures } = useQuery({
    queryKey: ['metrics-failures'],
    queryFn: () => metricsApi.getRecentFailures(),
    refetchInterval: 30000,
  });

  const { data: schedulerStats } = useQuery({
    queryKey: ['scheduler-stats'],
    queryFn: () => tasksApi.schedulerStats(),
    refetchInterval: 30000,
  });

  const executorColumns = [
    { title: '名称', dataIndex: 'appName', key: 'appName' },
    { title: '地址', dataIndex: 'address', key: 'address' },
    {
      title: '状态', dataIndex: 'status', key: 'status',
      render: (s: string) => <Tag color={s === 'online' ? 'green' : 'red'}>{s}</Tag>,
    },
    {
      title: 'CPU', dataIndex: 'cpuUsage', key: 'cpu',
      render: (v: number) => v != null ? <Progress percent={Math.round(v)} size="small" strokeColor={v > 80 ? '#ff4d4f' : '#52c41a'} /> : '-',
    },
    {
      title: '内存', dataIndex: 'memUsage', key: 'mem',
      render: (v: number) => v != null ? <Progress percent={Math.round(v)} size="small" strokeColor={v > 80 ? '#ff4d4f' : '#1677ff'} /> : '-',
    },
    { title: '运行任务', dataIndex: 'runningTaskCount', key: 'running' },
  ];

  const failureColumns = [
    { title: '任务名', dataIndex: 'taskName', key: 'taskName' },
    {
      title: '错误', dataIndex: 'errorMessage', key: 'errorMessage',
      ellipsis: true,
      render: (v: string) => <Typography.Text type="danger" ellipsis={{ tooltip: v }}>{v || '-'}</Typography.Text>,
    },
    {
      title: '耗时(ms)', dataIndex: 'duration', key: 'duration',
      render: (v: number) => v ?? '-',
    },
    {
      title: '时间', dataIndex: 'createdAt', key: 'createdAt',
      render: (v: string) => new Date(v).toLocaleString(),
    },
  ];

  if (loadingSummary) return <div style={{ textAlign: 'center', padding: 80 }}><Spin size="large" /></div>;

  return (
    <div style={{ padding: '0 4px' }}>
      <Title level={4} style={{ marginBottom: 24 }}>数据看板</Title>

      {/* 统计卡片 */}
      <Row gutter={[16, 16]}>
        <Col xs={12} sm={8} md={4}>
          <Card>
            <Statistic
              title="任务总数"
              value={summary?.totalTasks ?? 0}
              prefix={<UnorderedListOutlined />}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={4}>
          <Card>
            <Statistic
              title="在线执行器"
              value={summary?.onlineExecutors ?? 0}
              suffix={`/ ${summary?.totalExecutors ?? 0}`}
              prefix={<CloudServerOutlined />}
              valueStyle={{ color: (summary?.onlineExecutors ?? 0) > 0 ? '#52c41a' : '#ff4d4f' }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={4}>
          <Card>
            <Statistic
              title="执行总次数"
              value={summary?.executions.total ?? 0}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={4}>
          <Card>
            <Statistic
              title="成功"
              value={summary?.executions.success ?? 0}
              valueStyle={{ color: '#52c41a' }}
              prefix={<CheckCircleOutlined />}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={4}>
          <Card>
            <Statistic
              title="失败"
              value={summary?.executions.failed ?? 0}
              valueStyle={{ color: '#ff4d4f' }}
              prefix={<CloseCircleOutlined />}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={4}>
          <Card>
            <Statistic
              title="成功率"
              value={summary?.successRate ?? 0}
              suffix="%"
              precision={1}
              valueStyle={{ color: (summary?.successRate ?? 0) >= 90 ? '#52c41a' : '#faad14' }}
            />
          </Card>
        </Col>
      </Row>

      {/* 趋势图 */}
      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} md={14}>
          <Card title="最近 7 天执行趋势" loading={loadingTrend}>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={trend}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                <YAxis allowDecimals={false} />
                <Tooltip />
                <Legend />
                <Line type="monotone" dataKey="success" stroke="#52c41a" name="成功" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="failed" stroke="#ff4d4f" name="失败" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </Card>
        </Col>
        <Col xs={24} md={10}>
          <Card title="平均执行耗时">
            <div style={{ textAlign: 'center', paddingTop: 20 }}>
              <Statistic
                value={summary?.avgDurationMs ?? 0}
                suffix="ms"
                valueStyle={{ fontSize: 40 }}
              />
              <div style={{ marginTop: 16, color: '#888' }}>仅统计成功执行</div>
            </div>
            <div style={{ marginTop: 24 }}>
              <Row justify="space-around">
                <Col style={{ textAlign: 'center' }}>
                  <div style={{ color: '#888', fontSize: 12 }}>运行中</div>
                  <div style={{ fontSize: 24, color: '#1677ff' }}>
                    <SyncOutlined spin={summary?.executions.running > 0} /> {summary?.executions.running ?? 0}
                  </div>
                </Col>
                <Col style={{ textAlign: 'center' }}>
                  <div style={{ color: '#888', fontSize: 12 }}>在线执行器</div>
                  <div style={{ fontSize: 24, color: '#52c41a' }}>{summary?.onlineExecutors ?? 0}</div>
                </Col>
              </Row>
            </div>
          </Card>
        </Col>
      </Row>

      {/* 调度器状态 */}
      {schedulerStats && (
        <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
          <Col span={24}>
            <Card
              title={
                <Space>
                  调度器状态
                  <Tag color={schedulerStats.healthy ? 'green' : 'red'}>
                    {schedulerStats.healthy ? '正常' : '异常'}
                  </Tag>
                </Space>
              }
              size="small"
            >
              <Row gutter={[24, 8]}>
                <Col xs={12} sm={6}>
                  <Statistic title="定时器任务" value={schedulerStats.activeTimers} suffix="个" />
                </Col>
                <Col xs={12} sm={6}>
                  <Statistic title="Cron 任务" value={schedulerStats.activeCronTasks} suffix="个" />
                </Col>
                <Col xs={12} sm={6}>
                  <Statistic title="调度总数" value={schedulerStats.totalScheduledTasks} suffix="个" />
                </Col>
                <Col xs={12} sm={6}>
                  <Statistic
                    title="运行时长"
                    value={Math.floor(schedulerStats.uptime / 3600)}
                    suffix={`h ${Math.floor((schedulerStats.uptime % 3600) / 60)}m`}
                  />
                </Col>
              </Row>
            </Card>
          </Col>
        </Row>
      )}

      {/* 执行器状态 */}
      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col span={24}>
          <Card title="执行器状态" loading={loadingExecutors}>
            <Table<ExecutorStat>
              dataSource={executors}
              columns={executorColumns}
              rowKey="id"
              size="small"
              pagination={false}
            />
          </Card>
        </Col>
      </Row>

      {/* 最近失败 */}
      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col span={24}>
          <Card title="最近失败执行（Top 10）" loading={loadingFailures}>
            <Table<RecentFailure>
              dataSource={failures}
              columns={failureColumns}
              rowKey="id"
              size="small"
              pagination={false}
            />
          </Card>
        </Col>
      </Row>
    </div>
  );
}
