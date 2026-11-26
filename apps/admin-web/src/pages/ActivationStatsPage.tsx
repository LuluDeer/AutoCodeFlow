import { useMemo, useState } from 'react';
import dayjs, { type Dayjs } from 'dayjs';
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Empty,
  Progress,
  Row,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useQuery } from '@tanstack/react-query';
import {
  getActivationStats,
  type ActivationProjectStat,
  type ActivationStatsEntry,
} from '../api/capability-activation';

const { Text, Title } = Typography;
const DEFAULT_DAYS = 30;

/**
 * 能力用量看板：showback 的可见出口。默认近 30 天，时间窗变化即重新聚合；
 * 所有聚合口径由后端 stats 端点给出，页面不做二次派生（总数直接取 total）。
 */
export default function ActivationStatsPage() {
  const [range, setRange] = useState<[Dayjs, Dayjs]>(() => [
    dayjs().subtract(DEFAULT_DAYS - 1, 'day').startOf('day'),
    dayjs().endOf('day'),
  ]);
  const from = range[0].toISOString();
  const to = range[1].toISOString();

  const { data, error, isFetching, refetch } = useQuery({
    queryKey: ['capability-activation-stats', from, to],
    queryFn: () => getActivationStats(from, to),
  });

  const capabilityColumns: ColumnsType<ActivationStatsEntry> = useMemo(
    () => [
      { title: '能力标识', dataIndex: 'capabilityKey', key: 'capabilityKey' },
      {
        title: '激活次数',
        dataIndex: 'count',
        key: 'count',
        sorter: (a, b) => a.count - b.count,
        defaultSortOrder: 'descend',
      },
      {
        title: '成功',
        dataIndex: 'success',
        key: 'success',
        render: (value: number) => <Tag color="success">成功 {value}</Tag>,
      },
      {
        title: '失败',
        dataIndex: 'failure',
        key: 'failure',
        render: (value: number) => <Tag color="error">失败 {value}</Tag>,
      },
      {
        title: '拦截',
        dataIndex: 'blocked',
        key: 'blocked',
        render: (value: number) => <Tag color="warning">拦截 {value}</Tag>,
      },
      {
        title: '用量占比',
        key: 'share',
        render: (_value, record) => (
          <Progress
            percent={data?.total ? Math.round((record.count / data.total) * 100) : 0}
            size="small"
          />
        ),
      },
    ],
    [data?.total],
  );

  const projectColumns: ColumnsType<ActivationProjectStat> = [
    {
      title: '项目标识',
      dataIndex: 'projectId',
      key: 'projectId',
      render: (value: string | null) => value ?? '未归属项目',
    },
    {
      title: '激活次数',
      dataIndex: 'count',
      key: 'count',
      sorter: (a, b) => a.count - b.count,
      defaultSortOrder: 'descend',
    },
  ];

  const empty = !!data && data.total === 0;

  return (
    <div data-testid="activation-stats-page" style={{ padding: 24 }}>
      <Title level={4}>能力用量</Title>
      <Card>
        <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
          <Space wrap>
            <Text>统计时间范围</Text>
            <DatePicker.RangePicker
              value={range}
              allowClear={false}
              onChange={(dates) => {
                if (dates?.[0] && dates?.[1]) {
                  setRange([dates[0], dates[1]]);
                }
              }}
            />
            {isFetching ? <Text type="secondary">正在更新用量数据…</Text> : null}
          </Space>
          <Row gutter={16}>
            <Col xs={24} sm={8}>
              <Statistic title="累计激活次数" value={data?.total ?? 0} />
            </Col>
            <Col xs={24} sm={8}>
              <Statistic title="覆盖能力数" value={data?.byCapability.length ?? 0} />
            </Col>
            <Col xs={24} sm={8}>
              <Statistic title="覆盖项目数" value={data?.byProject.length ?? 0} />
            </Col>
          </Row>
          {data?.dualBasis ? (
            <Alert
              style={{ marginTop: 16 }}
              type={data.dualBasis.priceReason === 'OK' ? 'success' : 'info'}
              showIcon
              message={
                data.dualBasis.priceReason === 'OK' &&
                data.dualBasis.currencyValue != null
                  ? `折算金额：${data.dualBasis.currencyValue}`
                  : '成本金额不可用（未折算）'
              }
              description={
                data.dualBasis.priceReason === 'OK'
                  ? data.dualBasis.note
                  : `原因：${data.dualBasis.priceReason}。${data.dualBasis.note}`
              }
            />
          ) : null}
        </Space>
      </Card>

      {error ? (
        <Alert
          style={{ marginTop: 16 }}
          type="error"
          message="用量数据加载失败，请稍后重试。"
          action={<Button onClick={() => void refetch()}>重试</Button>}
        />
      ) : null}

      {empty ? (
        <Card style={{ marginTop: 16 }}>
          <Empty description="暂无能力激活记录，先到工作台提交一个方案" />
        </Card>
      ) : null}

      {data && !empty ? (
        <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
          <Col xs={24} xl={14}>
            <Card title="按能力分布">
              <Table<ActivationStatsEntry>
                rowKey="capabilityKey"
                columns={capabilityColumns}
                dataSource={data.byCapability}
                pagination={false}
              />
            </Card>
          </Col>
          <Col xs={24} xl={10}>
            <Card title="按项目分布">
              <Table<ActivationProjectStat>
                rowKey={(record) => record.projectId ?? '未归属项目'}
                columns={projectColumns}
                dataSource={data.byProject}
                pagination={false}
              />
            </Card>
          </Col>
        </Row>
      ) : null}
    </div>
  );
}
