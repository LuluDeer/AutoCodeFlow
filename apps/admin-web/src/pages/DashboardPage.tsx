import { useQuery } from '@tanstack/react-query';
import { Row, Col, Card, Statistic, Table, Tag, Progress, Spin, Typography, Space, Button } from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  SyncOutlined,
  CloudServerOutlined,
  UnorderedListOutlined,
  PlusOutlined,
  DesktopOutlined,
  PlayCircleOutlined,
} from '@ant-design/icons';
import { metricsApi, RecentFailure, ExecutorStat } from '../api/metrics';
import { tasksApi } from '../api/tasks';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { useNavigate } from 'react-router-dom';

const { Title } = Typography;

export default function DashboardPage() {
  const navigate = useNavigate();
  const { data: summaryResponse, isLoading: loadingSummary } = useQuery({
    queryKey: ['metrics-summary'],
    queryFn: () => metricsApi.getSummary(),
    refetchInterval: 30000,
  });

  const summary = summaryResponse;

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

  const successRate = summary?.successRate ?? 0;
  const successRateColor = successRate >= 95 ? '#52c41a' : successRate >= 80 ? '#faad14' : '#ff4d4f';

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

  const isAllEmpty =
    !loadingSummary &&
    (summary?.totalTasks ?? 0) === 0 &&
    (summary?.totalExecutors ?? 0) === 0 &&
    (summary?.executions?.total ?? 0) === 0;

  if (loadingSummary) return <div style={{ textAlign: 'center', padding: 80 }}><Spin size="large" /></div>;

  return (
    <div style={{ padding: '0 4px' }}>
      <Title level={4} style={{ marginBottom: 24 }}>数据看板</Title>

      {/* 空状态快速开始引导 */}
      {isAllEmpty && (
        <Card style={{ marginBottom: 24, background: 'linear-gradient(135deg, #f0f5ff 0%, #e6f7ff 100%)', border: '1px solid #91caff' }}>
          <div style={{ textAlign: 'center', padding: '16px 0 8px' }}>
            <Typography.Title level={4} style={{ color: '#1677ff', marginBottom: 8 }}>欢迎使用 AutoCodeFlow 🎉</Typography.Title>
            <Typography.Text type="secondary">系统暂无数据，按照以下步骤快速开始吧</Typography.Text>
          </div>
          <Row gutter={[24, 16]} style={{ marginTop: 24 }} justify="center">
            <Col xs={24} sm={8}>
              <Card
                size="small"
                hoverable
                style={{ textAlign: 'center', cursor: 'pointer' }}
                onClick={() => navigate('/tasks/new')}
              >
                <PlusOutlined style={{ fontSize: 28, color: '#1677ff', marginBottom: 8, display: 'block' }} />
                <Typography.Text strong>第 1 步：创建任务</Typography.Text>
                <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>配置调度规则和执行逻辑</Typography.Text></div>
                <Button type="primary" size="small" style={{ marginTop: 12 }} onClick={(e) => { e.stopPropagation(); navigate('/tasks/new'); }}>去创建</Button>
              </Card>
            </Col>
            <Col xs={24} sm={8}>
              <Card
                size="small"
                hoverable
                style={{ textAlign: 'center', cursor: 'pointer' }}
                onClick={() => navigate('/executors/install')}
              >
                <DesktopOutlined style={{ fontSize: 28, color: '#52c41a', marginBottom: 8, display: 'block' }} />
                <Typography.Text strong>第 2 步：注册执行器</Typography.Text>
                <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>在目标服务器安装执行器程序</Typography.Text></div>
                <Button size="small" style={{ marginTop: 12 }} onClick={(e) => { e.stopPropagation(); navigate('/executors/install'); }}>去安装</Button>
              </Card>
            </Col>
            <Col xs={24} sm={8}>
              <Card
                size="small"
                style={{ textAlign: 'center', opacity: 0.6 }}
              >
                <PlayCircleOutlined style={{ fontSize: 28, color: '#fa8c16', marginBottom: 8, display: 'block' }} />
                <Typography.Text strong>第 3 步：触发执行</Typography.Text>
                <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>手动触发或等待调度器自动执行</Typography.Text></div>
                <Button size="small" disabled style={{ marginTop: 12 }}>完成前两步后可用</Button>
              </Card>
            </Col>
          </Row>
        </Card>
      )}

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
              value={successRate}
              suffix="%"
              precision={1}
              valueStyle={{ color: successRateColor }}
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
                    <SyncOutlined spin={(summary?.executions?.running ?? 0) > 0} /> {summary?.executions?.running ?? 0}
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
