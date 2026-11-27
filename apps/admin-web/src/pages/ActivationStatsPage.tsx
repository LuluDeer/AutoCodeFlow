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
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import { costReasonLabel } from '../components/dashboard/CostPostureCard';

const { Text, Title } = Typography;
const DEFAULT_DAYS = 30;

type Translate = import('i18next').TFunction;

function quotaStatusLabel(t: Translate, status: QuotaStatusRow['status']): string {
  switch (status) {
    case 'ok':
      return t('activation.quota.status.ok');
    case 'warn':
      return t('activation.quota.status.warn');
    case 'exceeded':
      return t('activation.quota.status.exceeded');
    default:
      return status;
  }
}

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

function amountUnavailableDetail(row: QuotaStatusRow, t: Translate): string {
  const parts: string[] = [];
  if (row.amountNote?.trim()) parts.push(row.amountNote.trim());
  if (row.priceReason) parts.push(t('activation.quota.reason', { reason: row.priceReason }));
  if (parts.length === 0) parts.push(t('activation.quota.noSamplePrice'));
  const notComparedZh = i18n.t('activation.quota.notComparedToZero', { lng: 'zh' }) as string;
  const notCompared = t('activation.quota.notComparedToZero');
  if (!parts.some((part) => part.includes(notComparedZh) || part.includes(notCompared))) {
    parts.push(notCompared);
  }
  return parts.join(' / ');
}

/** 配额状态面板：金额闸不可得时明说"硬闸已跳过"，绝不退化成 0 元/未超限。 */
function QuotaStatusPanel({ windowDays }: { windowDays: number }) {
  const { t } = useTranslation();
  const { data, error, isFetching, refetch } = useQuery({
    queryKey: ['capability-activation-quota-status', windowDays],
    queryFn: () => getQuotaStatus(windowDays),
  });
  const rows = data ?? [];

  const columns: ColumnsType<QuotaStatusRow> = [
    {
      title: t('activation.quota.col.scope'),
      key: 'scope',
      render: (_value, row) => `${row.scope} / ${row.target}`,
    },
    {
      title: t('activation.quota.col.status'),
      dataIndex: 'status',
      key: 'status',
      render: (status: QuotaStatusRow['status']) => (
        <Tag
          color={QUOTA_STATUS_COLOR[status] ?? 'default'}
          data-testid="quota-status-badge"
        >
          {quotaStatusLabel(t, status)}
        </Tag>
      ),
    },
    {
      title: t('activation.quota.col.usage'),
      key: 'usage',
      render: (_value, row) => `${row.usage} / ${row.hardLimit}`,
    },
    {
      title: t('activation.quota.col.unit'),
      dataIndex: 'unit',
      key: 'unit',
      render: (unit: QuotaStatusRow['unit']) => unit ?? 'invocations',
    },
    {
      title: t('activation.quota.col.gate'),
      key: 'gate',
      render: (_value, row) => {
        if (row.unit !== 'amount') {
          return <Text type="secondary">{t('activation.quota.byCount')}</Text>;
        }
        const amount = usableAmount(row);
        if (amount === null) {
          return (
            <Space orientation="vertical" size={0}>
              <Text type="warning">{t('activation.quota.amountUnavailable')}</Text>
              <Text type="secondary">{amountUnavailableDetail(row, t)}</Text>
            </Space>
          );
        }
        return <Text>{formatAmount(row, amount)}</Text>;
      },
    },
  ];

  return (
    <Card title={t('activation.quota.title')} style={{ marginTop: 16 }}>
      <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
        <Space wrap>
          <Text>{t('activation.quota.window', { days: windowDays })}</Text>
          {isFetching ? <Text type="secondary">{t('activation.quota.updating')}</Text> : null}
        </Space>
        {error ? (
          <Alert
            type="error"
            title={t('activation.quota.loadFailed')}
            action={<Button onClick={() => void refetch()}>{t('activation.retry')}</Button>}
          />
        ) : null}
        {!error && rows.length === 0 ? (
          <Empty description={t('activation.quota.empty')} />
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
  const { t } = useTranslation();
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
      { title: t('activation.col.capability'), dataIndex: 'capabilityKey', key: 'capabilityKey' },
      {
        title: t('activation.col.count'),
        dataIndex: 'count',
        key: 'count',
        sorter: (a, b) => a.count - b.count,
        defaultSortOrder: 'descend',
      },
      {
        title: t('activation.status.success'),
        dataIndex: 'success',
        key: 'success',
        render: (value: number) => <Tag color="success">{t('activation.success.count', { count: value })}</Tag>,
      },
      {
        title: t('activation.status.failure'),
        dataIndex: 'failure',
        key: 'failure',
        render: (value: number) => <Tag color="error">{t('activation.failure.count', { count: value })}</Tag>,
      },
      {
        title: t('activation.status.blocked'),
        dataIndex: 'blocked',
        key: 'blocked',
        render: (value: number) => <Tag color="warning">{t('activation.blocked.count', { count: value })}</Tag>,
      },
      {
        title: t('activation.col.share'),
        key: 'share',
        render: (_value, record) => (
          <Progress
            percent={data?.total ? Math.round((record.count / data.total) * 100) : 0}
            size="small"
          />
        ),
      },
    ],
    [data?.total, t],
  );

  const projectColumns: ColumnsType<ActivationProjectStat> = [
    {
      title: t('activation.col.project'),
      dataIndex: 'projectId',
      key: 'projectId',
      render: (value: string | null) => value ?? t('activation.unassigned'),
    },
    {
      title: t('activation.col.count'),
      dataIndex: 'count',
      key: 'count',
      sorter: (a, b) => a.count - b.count,
      defaultSortOrder: 'descend',
    },
  ];

  const empty = !!data && data.total === 0;

  return (
    <div data-testid="activation-stats-page" style={{ padding: 24 }}>
      <Title level={4}>{t('activation.page.title')}</Title>
      <Card>
        <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
          <Space wrap>
            <Text>{t('activation.range.label')}</Text>
            <DatePicker.RangePicker
              value={range}
              allowClear={false}
              onChange={(dates) => {
                if (dates?.[0] && dates?.[1]) {
                  setRange([dates[0], dates[1]]);
                }
              }}
            />
            {isFetching ? <Text type="secondary">{t('activation.updating')}</Text> : null}
          </Space>
          <Row gutter={16}>
            <Col xs={24} sm={8}>
              <Statistic title={t('activation.total')} value={data?.total ?? 0} />
            </Col>
            <Col xs={24} sm={8}>
              <Statistic title={t('activation.capabilities')} value={data?.byCapability.length ?? 0} />
            </Col>
            <Col xs={24} sm={8}>
              <Statistic title={t('activation.projects')} value={data?.byProject.length ?? 0} />
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
                  ? t('activation.convertedAmount', { amount: data.dualBasis.currencyValue })
                  : t('activation.costUnavailable')
              }
              description={
                data.dualBasis.priceReason === 'OK'
                  ? data.dualBasis.note
                  : t('activation.costReason', {
                    reason: costReasonLabel(data.dualBasis.priceReason, t),
                    note: data.dualBasis.note,
                  })
              }
            />
          ) : null}
        </Space>
      </Card>

      {error ? (
        <Alert
          style={{ marginTop: 16 }}
          type="error"
          message={t('activation.loadFailed')}
          action={<Button onClick={() => void refetch()}>{t('activation.retry')}</Button>}
        />
      ) : null}

      {empty ? (
        <Card style={{ marginTop: 16 }}>
          <Empty description={t('activation.empty')} />
        </Card>
      ) : null}

      {data && !empty ? (
        <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
          <Col xs={24} xl={14}>
            <Card title={t('activation.byCapability')}>
              <Table<ActivationStatsEntry>
                rowKey="capabilityKey"
                columns={capabilityColumns}
                dataSource={data.byCapability}
                pagination={false}
              />
            </Card>
          </Col>
          <Col xs={24} xl={10}>
            <Card title={t('activation.byProject')}>
              <Table<ActivationProjectStat>
                rowKey={(record) => record.projectId ?? t('activation.unassigned')}
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
