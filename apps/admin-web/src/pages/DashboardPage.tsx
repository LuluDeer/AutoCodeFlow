import { useEffect, useState } from 'react';
import {
  Row, Col, Card, Statistic, Table, Tag, Typography, Space,
  Badge, Spin, Empty, Button, Progress, Alert,
} from 'antd';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as ReTooltip,
  Legend, ResponsiveContainer,
} from 'recharts';
import {
  ThunderboltOutlined, CheckCircleOutlined, CloseCircleOutlined,
  ClusterOutlined, ReloadOutlined, RocketOutlined, ArrowUpOutlined, ArrowDownOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { metricsApi, MetricsSummary, DailyTrend, ExecutorStat, RecentFailure } from '../api/metrics';

const { Title, Text } = Typography;

function TrendChart({ data }: { data: DailyTrend[] }) {
  if (!data.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无数据" />;
  const chartData = data.map(d => ({
    date: d.date.slice(5),
    成功: d.success,
    失败: d.failed,
  }));
  return (
    <ResponsiveContainer width="100%" height={160}>
      <BarChart data={chartData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
        <XAxis dataKey="date" tick={{ fontSize: 11 }} />
        <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
        <ReTooltip />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="成功" fill="#52c41a" radius={[3, 3, 0, 0]} maxBarSize={36} />
        <Bar dataKey="失败" fill="#ff4d4f" radius={[3, 3, 0, 0]} maxBarSize={36} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export default function DashboardPage() {
  const nav = useNavigate();
  const [summary, setSummary] = useState<MetricsSummary | null>(null);
  const [trend, setTrend] = useState<DailyTrend[]>([]);
  const [executors, setExecutors] = useState<ExecutorStat[]>([]);
  const [failures, setFailures] = useState<RecentFailure[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAll = async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, t, e, f] = await Promise.all([
        metricsApi.getSummary(),
        metricsApi.getDailyTrend(7),
        metricsApi.getExecutorStats(),
        metricsApi.getRecentFailures(),
      ]);
      setSummary(s);
      setTrend(t);
      setExecutors(e);
      setFailures(f);
    } catch (_err) {
      setError('数据加载失败，请检查服务状态');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAll();
    const timer = setInterval(fetchAll, 30_000);
    return () => clearInterval(timer);
  }, []);

  const isFirstTime = !loading && summary &&
    summary.totalTasks === 0 && summary.totalExecutors === 0;

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: 80 }}>
        <Spin size="large" />
        <div style={{ marginTop: 16, color: '#888' }}>加载中...</div>
      </div>
    );
  }

  if (error) {
    return (
      <Alert
        type="error"
        message="加载失败"
        description={error}
        action={<Button onClick={fetchAll}>重试</Button>}
      />
    );
  }

  // 新用户引导
  if (isFirstTime) {
    return (
      <div style={{ maxWidth: 700, margin: '40px auto' }}>
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{
            width: 64, height: 64,
            background: 'linear-gradient(135deg, #1677ff, #7c3aed)',
            borderRadius: 16,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            margin: '0 auto 16px',
          }}>
            <ThunderboltOutlined style={{ fontSize: 28, color: '#fff' }} />
          </div>
          <Title level={3}>欢迎使用 AutoCodeFlow</Title>
          <Text type="secondary">一个企业级工作流自动化调度平台，按以下步骤快速开始。</Text>
        </div>

        <Row gutter={[16, 16]}>
          {[
            {
              step: '1',
              title: '安装执行器',
              desc: '在目标服务器上安装执行器，它负责实际运行你的任务代码。',
              action: '安装执行器',
              path: '/executors/install',
              color: '#1677ff',
            },
            {
              step: '2',
              title: '创建应用',
              desc: '关联 Git 仓库或上传代码包，定义你的应用。',
              action: '创建应用',
              path: '/applications',
              color: '#52c41a',
            },
            {
              step: '3',
              title: '创建任务',
              desc: '配置任务触发方式（定时/手动），选择执行器运行。',
              action: '创建任务',
              path: '/tasks',
              color: '#fa8c16',
            },
          ].map(item => (
            <Col span={8} key={item.step}>
              <Card
                hoverable
                style={{ textAlign: 'center', border: `1px solid ${item.color}22` }}
                styles={{ body: { padding: '24px 16px' } }}
              >
                <div style={{
                  width: 40, height: 40, borderRadius: '50%',
                  background: `${item.color}15`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  margin: '0 auto 12px',
                  fontSize: 18, fontWeight: 700, color: item.color,
                }}>
                  {item.step}
                </div>
                <div style={{ fontWeight: 600, marginBottom: 8 }}>{item.title}</div>
                <div style={{ color: '#888', fontSize: 13, marginBottom: 16 }}>{item.desc}</div>
                <Button type="primary" size="small" onClick={() => nav(item.path)}>
                  {item.action}
                </Button>
              </Card>
            </Col>
          ))}
        </Row>
      </div>
    );
  }

  const successRate = summary?.successRate ?? 0;
  const onlineRatio = summary ? (summary.totalExecutors > 0
    ? Math.round((summary.onlineExecutors / summary.totalExecutors) * 100)
    : 0) : 0;

  const todayFailed = summary ? (summary.todayRuns > 0
    ? Math.round(summary.todayRuns * (1 - successRate / 100))
    : 0) : 0;

  const statCards = [
    {
      title: '今日执行',
      value: summary?.todayRuns ?? 0,
      icon: <ThunderboltOutlined />,
      color: '#1677ff',
      suffix: '次',
    },
    {
      title: '成功率',
      value: successRate,
      icon: successRate >= 90 ? <ArrowUpOutlined /> : <ArrowDownOutlined />,
      color: successRate >= 90 ? '#52c41a' : successRate >= 70 ? '#fa8c16' : '#ff4d4f',
      suffix: '%',
      precision: 1,
    },
    {
      title: '今日失败',
      value: todayFailed,
      icon: <CloseCircleOutlined />,
      color: todayFailed > 0 ? '#ff4d4f' : '#8c8c8c',
      suffix: '次',
    },
    {
      title: '运行中',
      value: summary?.executions.running ?? 0,
      icon: <RocketOutlined />,
      color: '#fa8c16',
      suffix: '个任务',
    },
    {
      title: '执行器',
      value: summary?.onlineExecutors ?? 0,
      icon: <ClusterOutlined />,
      color: '#52c41a',
      suffix: `/ ${summary?.totalExecutors ?? 0} 在线`,
    },
  ];

  const executorColumns = [
    {
      title: '执行器',
      key: 'name',
      render: (_: any, r: ExecutorStat) => (
        <Space direction="vertical" size={0}>
          <Text strong style={{ fontSize: 13 }}>{r.appName}</Text>
          <Text type="secondary" style={{ fontSize: 11 }}>{r.address}</Text>
        </Space>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 70,
      render: (v: string) => (
        <Badge
          status={v === 'online' ? 'success' : 'default'}
          text={v === 'online' ? '在线' : '离线'}
        />
      ),
    },
    {
      title: 'CPU/内存',
      width: 120,
      render: (_: any, r: ExecutorStat) => (
        <Space direction="vertical" size={2}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Text style={{ fontSize: 11, width: 30 }}>CPU</Text>
            <Progress
              percent={r.cpuUsage ?? 0}
              size="small"
              showInfo={false}
              strokeColor={r.cpuUsage > 80 ? '#ff4d4f' : r.cpuUsage > 60 ? '#fa8c16' : '#52c41a'}
              style={{ width: 60, margin: 0 }}
            />
            <Text style={{ fontSize: 11 }}>{(r.cpuUsage ?? 0).toFixed(0)}%</Text>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Text style={{ fontSize: 11, width: 30 }}>内存</Text>
            <Progress
              percent={r.memUsage ?? 0}
              size="small"
              showInfo={false}
              strokeColor={r.memUsage > 80 ? '#ff4d4f' : r.memUsage > 60 ? '#fa8c16' : '#52c41a'}
              style={{ width: 60, margin: 0 }}
            />
            <Text style={{ fontSize: 11 }}>{(r.memUsage ?? 0).toFixed(0)}%</Text>
          </div>
        </Space>
      ),
    },
    {
      title: '运行中',
      dataIndex: 'runningTaskCount',
      width: 60,
      render: (v: number) => <Text strong style={{ color: v > 0 ? '#1677ff' : undefined }}>{v}</Text>,
    },
  ];

  const failureColumns = [
    {
      title: '任务',
      dataIndex: 'taskName',
      render: (name: string, r: RecentFailure) => (
        <a onClick={() => nav(`/tasks/${r.taskId}`)} style={{ fontSize: 13 }}>{name}</a>
      ),
    },
    {
      title: '错误',
      dataIndex: 'errorMessage',
      ellipsis: true,
      render: (v: string) => <Text type="danger" style={{ fontSize: 12 }}>{v || '未知错误'}</Text>,
    },
    {
      title: '时间',
      dataIndex: 'createdAt',
      width: 110,
      render: (v: string) => {
        const diff = Date.now() - new Date(v).getTime();
        const mins = Math.floor(diff / 60000);
        if (mins < 1) return <Text type="secondary" style={{ fontSize: 12 }}>刚刚</Text>;
        if (mins < 60) return <Text type="secondary" style={{ fontSize: 12 }}>{mins}分钟前</Text>;
        return <Text type="secondary" style={{ fontSize: 12 }}>{Math.floor(mins / 60)}小时前</Text>;
      },
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <Title level={4} style={{ margin: 0 }}>控制台</Title>
          <Text type="secondary" style={{ fontSize: 13 }}>实时监控任务调度状态</Text>
        </div>
        <Button icon={<ReloadOutlined />} onClick={fetchAll}>刷新</Button>
      </div>

      {/* 统计卡片 */}
      <Row gutter={[16, 16]} style={{ marginBottom: 20 }}>
        {statCards.map(card => (
          <Col xs={24} sm={12} lg={5} key={card.title}>
            <Card styles={{ body: { padding: '20px 24px' } }} style={{ borderTop: `3px solid ${card.color}` }}>
              <Statistic
                title={<Text style={{ fontSize: 13, color: '#888' }}>{card.title}</Text>}
                value={card.value}
                suffix={<Text style={{ fontSize: 13, color: '#aaa' }}>{card.suffix}</Text>}
                precision={card.precision}
                valueStyle={{ fontSize: 28, fontWeight: 700, color: card.color }}
                prefix={<span style={{ color: card.color, marginRight: 4 }}>{card.icon}</span>}
              />
            </Card>
          </Col>
        ))}
      </Row>

      <Row gutter={[16, 16]}>
        {/* 执行趋势 */}
        <Col xs={24} lg={14}>
          <Card
            title="近7天执行趋势"
            styles={{ body: { padding: '16px 24px 20px' } }}
            extra={
              <Space>
                <Tag color="green">成功</Tag>
                <Tag color="red">失败</Tag>
              </Space>
            }
          >
            <TrendChart data={trend} />
          </Card>
        </Col>

        {/* 执行器概览 */}
        <Col xs={24} lg={10}>
          <Card
            title="执行器状态"
            extra={
              <>
                <Text type="secondary" style={{ fontSize: 12, marginRight: 8 }}>
                  {summary?.onlineExecutors}/{summary?.totalExecutors} 在线
                </Text>
                <Progress
                  type="circle"
                  percent={onlineRatio}
                  size={28}
                  strokeColor={onlineRatio === 100 ? '#52c41a' : onlineRatio > 50 ? '#fa8c16' : '#ff4d4f'}
                  format={() => ''}
                />
              </>
            }
          >
            {executors.length === 0 ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="暂无执行器"
              >
                <Button
                  type="primary"
                  size="small"
                  icon={<PlusOutlined />}
                  onClick={() => nav('/executors/install')}
                >
                  安装执行器
                </Button>
              </Empty>
            ) : (
              <Table
                dataSource={executors}
                columns={executorColumns}
                rowKey="id"
                size="small"
                pagination={false}
                showHeader={executors.length > 1}
              />
            )}
          </Card>
        </Col>

        {/* 最近失败 */}
        <Col span={24}>
          <Card
            title={
              <Space>
                <CloseCircleOutlined style={{ color: '#ff4d4f' }} />
                最近失败
              </Space>
            }
          >
            {failures.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '20px 0' }}>
                <CheckCircleOutlined style={{ fontSize: 32, color: '#52c41a' }} />
                <div style={{ marginTop: 8, color: '#888' }}>近期无失败记录，运行状态良好</div>
              </div>
            ) : (
              <Table
                dataSource={failures}
                columns={failureColumns}
                rowKey="id"
                size="small"
                pagination={{ pageSize: 5, showTotal: t => `共 ${t} 条` }}
              />
            )}
          </Card>
        </Col>
      </Row>
    </div>
  );
}
