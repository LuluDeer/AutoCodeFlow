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
  getQuotaStatus,
  type ActivationProjectStat,
  type ActivationStatsEntry,
  type QuotaStatusRow,
} from '../api/capability-activation';

const { Text, Title } = Typography;
const DEFAULT_DAYS = 30;

const QUOTA_STATUS_LABEL: Record<QuotaStatusRow['status'], string> = {
  ok: '正常',
  warn: '预警',
  exceeded: '已超限',
};

const QUOTA_STATUS_COLOR: Record<QuotaStatusRow['status'], string> = {
  ok: 'success',
  warn: 'warning',
  exceeded: 'error',
};

/** 只有有限数才是可得金额；null/undefined/NaN/Infinity 一律走诚实缺口文案。 */
function usableAmount(row: QuotaStatusRow): number | null {
  return typeof row.amount === 'number' && Number.isFinite(row.amount)
    ? row.amount
    : null;
}

function formatAmount(row: QuotaStatusRow, amount: number): string {
  const value = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  return row.currency ? `${row.currency} ${value}` : value;
}

function amountUnavailableDetail(row: QuotaStatusRow): string {
  const parts: string[] = [];
  if (row.amountNote?.trim()) parts.push(row.amountNote.trim());
  if (row.priceReason) parts.push(`原因：${row.priceReason}`);
  if (parts.length === 0) parts.push('零样本或缺价目');
  if (!parts.some((part) => part.includes('未与 0 比较'))) {
    parts.push('未与 0 比较');
  }
  return parts.join(' / ');
}

/** 配额状态面板：金额闸不可得时明说"硬闸已跳过"，绝不退化成 0 元/未超限。 */
function QuotaStatusPanel({ windowDays }: { windowDays: number }) {
  const { data, error, isFetching, refetch } = useQuery({
    queryKey: ['capability-activation-quota-status', windowDays],
    queryFn: () => getQuotaStatus(windowDays),
  });
  const rows = data ?? [];

  const columns: ColumnsType<QuotaStatusRow> = [
    {
      title: '范围',
      key: 'scope',
      render: (_value, row) => `${row.scope} / ${row.target}`,
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: (status: QuotaStatusRow['status']) => (
        <Tag
          color={QUOTA_STATUS_COLOR[status] ?? 'default'}
          data-testid="quota-status-badge"
        >
          {QUOTA_STATUS_LABEL[status] ?? status}
        </Tag>
      ),
    },
    {
      title: '用量 / 硬阈',
      key: 'usage',
      render: (_value, row) => `${row.usage} / ${row.hardLimit}`,
    },
    {
      title: '计量单位',
      dataIndex: 'unit',
      key: 'unit',
      render: (unit: QuotaStatusRow['unit']) => unit ?? 'invocations',
    },
    {
      title: '金额 / 闸说明',
      key: 'gate',
      render: (_value, row) => {
        if (row.unit !== 'amount') {
          return <Text type="secondary">按调用次数判定</Text>;
        }
        const amount = usableAmount(row);
        if (amount === null) {
          return (
            <Space orientation="vertical" size={0}>
              <Text type="warning">金额不可得，硬闸已跳过</Text>
              <Text type="secondary">{amountUnavailableDetail(row)}</Text>
            </Space>
          );
        }
        return <Text>{formatAmount(row, amount)}</Text>;
      },
    },
  ];

  return (
    <Card title="配额状态" style={{ marginTop: 16 }}>
      <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
        <Space wrap>
          <Text>统计窗口：近 {windowDays} 天</Text>
          {isFetching ? <Text type="secondary">正在更新配额状态…</Text> : null}
        </Space>
        {error ? (
          <Alert
            type="error"
            title="配额状态加载失败，请稍后重试。"
            action={<Button onClick={() => void refetch()}>重试</Button>}
          />
        ) : null}
        {!error && rows.length === 0 ? (
          <Empty description="暂无配额状态记录" />
        ) : null}
        {!error && rows.length > 0 ? (
          <Table<QuotaStatusRow>
            rowKey={(row) => `${row.scope}:${row.target}:${row.unit ?? 'invocations'}`}
            columns={columns}
            dataSource={rows}
            pagination={false}
          />
        ) : null}
      </Space>
    </Card>
  );
}

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
  // 与配额 API 的 windowDays（1..90）共用当前统计窗，避免两处口径漂移。
  const windowDays = Math.max(
    1,
    Math.min(90, range[1].diff(range[0], 'day') + 1),
  );

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

      <QuotaStatusPanel windowDays={windowDays} />
    </div>
  );
}
