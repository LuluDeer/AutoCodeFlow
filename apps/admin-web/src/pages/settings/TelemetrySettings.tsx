/**
 * R311：TTFV 授权设置 Tab。
 *
 * 诚实口径：这里管理的是 opt-in 匿名统计授权——只采事件名、匿名标识哈希与时间，
 * 不采凭据/正文；默认不采集，随时可撤销。界面文案按这个事实写，不夹带营销措辞。
 * 数据全部来自 admin-api R308 的两个端点；写操作是隐私动作，用 Popconfirm 二次确认。
 */
import { useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Popconfirm,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { ColumnsType } from 'antd/es/table';
import { agentApi } from '../../api/agent';
import { useAuthStore, isAdminUser } from '../../store/auth';
import { showApiError } from '../../utils/error';
import { message } from '../../utils/toast';
import { formatDateTime } from '../../utils/timeFormat';
import StateError from '../../components/StateError';
import '../../i18n';

const { Text, Title } = Typography;

/** 与后端 TelemetryOptinInstallViewDto 同形的本地视图（非生成物依赖）。 */
interface TelemetryInstall {
  installId: string;
  optIn: boolean;
  /** ISO-8601；列上线前的历史行可能为 null。 */
  optedAt: string | null;
  /** HMAC 派生哈希：后端会返回，但本界面刻意不展示。 */
  userIdHash: string | null;
  source: string;
}

/** 与后端 AgentTelemetryStatusDto 同形的本地视图。 */
interface TelemetryStatus {
  systemEnabled: boolean;
  count: number;
  /** R329 切片①契约：已知执行器总数；老后端缺席时回落到 installs.length。 */
  knownExecutorCount: number;
  /** R329 切片①契约：覆盖状态；老后端缺席时按 count/known 推导。 */
  coverage: 'no_executors' | 'partial' | 'full' | 'gate_off';
  latestOptedAt: string | null;
  installs: TelemetryInstall[];
}

/**
 * R329：后端尚未升级时的口径回落。总闸关闭一律 gate_off（不报异常）；
 * 总闸开启且已知为 0 ⇒ no_executors；否则按已授权/已知判 full 或 partial。
 */
function resolveCoverage(status: TelemetryStatus | undefined, known: number): TelemetryStatus['coverage'] {
  if (!status || !status.systemEnabled) return 'gate_off';
  if (status.coverage) return status.coverage;
  if (known === 0) return 'no_executors';
  return status.count >= known ? 'full' : 'partial';
}

const COVERAGE_TAG_COLOR: Record<TelemetryStatus['coverage'], string> = {
  full: 'green',
  partial: 'orange',
  no_executors: 'red',
  gate_off: 'default',
};

export default function TelemetrySettings() {
  const { t } = useTranslation();
  const isAdmin = useAuthStore((s) => isAdminUser(s.user));
  const qc = useQueryClient();
  /** null = 无待确认操作；true/false = 待写入的 optIn 值（Popconfirm 的载荷）。 */
  const [pendingOptIn, setPendingOptIn] = useState<boolean | null>(null);

  const {
    data: status,
    isLoading,
    isFetching,
    error,
    refetch,
  } = useQuery<TelemetryStatus>({
    queryKey: ['telemetry-status'],
    queryFn: () => agentApi.telemetryStatus(),
    // R312：status/consent 端点全局 @Roles(ADMIN)，非管理员不发会 403 的请求。
    enabled: isAdmin,
  });

  const { mutate: submitConsent, isPending: submitting } = useMutation({
    mutationFn: (optIn: boolean) => agentApi.telemetryConsent({ optIn, source: 'admin-ui' }),
    onSuccess: () => {
      message.success(t('sysSettings.telemetry.saved'));
      // 写后回到真实数据源（而非本地 set state）：总闸与各安装的授权行都以
      // status 端点为准，避免「toast 说已保存、表格还是旧值」的自相矛盾。
      void qc.invalidateQueries({ queryKey: ['telemetry-status'] });
    },
    onError: (err: unknown) => {
      showApiError(err, t('sysSettings.telemetry.saveFail'));
    },
  });

  // R312：所有 hooks 已按固定顺序调用完毕；非管理员在此提前返回只读降级提示，
  // 不渲染 Switch/表格，也不发 status/consent 请求（后端为 @Roles(ADMIN)）。
  if (!isAdmin) {
    return <Alert type="info" showIcon description={t('sysSettings.telemetry.adminOnly')} />;
  }

  const enabled = status?.systemEnabled ?? false;
  const knownExecutorCount = status?.knownExecutorCount ?? status?.installs.length ?? 0;
  const coverage = resolveCoverage(status, knownExecutorCount);

  // R329：显式重授权入口——不经 Popconfirm，由告警文案说明后果后才由用户主动点击。
  // submitConsent(true) 的请求体不带 installIds ⇒ 后端对全部 executor 重新授权。
  const reauthorizeButton = (
    <Button
      size="small"
      type="primary"
      data-testid="telemetry-reauthorize-btn"
      loading={submitting}
      onClick={() => { submitConsent(true); }}
    >
      {t('sysSettings.telemetry.coverage.reauthorize')}
    </Button>
  );

  const onConfirm = () => {
    const next = pendingOptIn;
    setPendingOptIn(null);
    if (next !== null) submitConsent(next);
  };

  const columns: ColumnsType<TelemetryInstall> = [
    {
      title: t('sysSettings.telemetry.col.install'),
      dataIndex: 'installId',
      width: 260,
      render: (v: string) => <Text code>{v}</Text>,
    },
    {
      title: t('sysSettings.telemetry.col.optIn'),
      dataIndex: 'optIn',
      width: 120,
      render: (v: boolean) => (
        <Tag color={v ? 'green' : 'default'}>
          {v ? t('sysSettings.telemetry.authorized') : t('sysSettings.telemetry.revoked')}
        </Tag>
      ),
    },
    {
      title: t('sysSettings.telemetry.col.time'),
      dataIndex: 'optedAt',
      width: 180,
      render: (v: string | null) => (v ? formatDateTime(v) : '—'),
    },
    {
      title: t('sysSettings.telemetry.col.source'),
      dataIndex: 'source',
      width: 140,
      render: (v: string) => {
        // 字面量调用：i18n-key-check 要求所有 t() 实参静态可判；未知来源露原文。
        if (v === 'admin-ui') return t('sysSettings.telemetry.source.admin-ui');
        if (v === 'api') return t('sysSettings.telemetry.source.api');
        return v;
      },
    },
  ];

  return (
    <Card
      title={<Title level={5} style={{ margin: 0 }}>{t('sysSettings.telemetry.title')}</Title>}
      extra={
        <Button size="small" loading={isFetching} onClick={() => { void refetch(); }}>
          {t('sysSettings.telemetry.refresh')}
        </Button>
      }
    >
      <Alert
        type="info"
        showIcon
        title={t('sysSettings.telemetry.intro')}
        style={{ marginBottom: 16 }}
      />
      {error ? (
        <StateError
          error={error}
          title={t('sysSettings.telemetry.loadFail')}
          onRetry={() => { void refetch(); }}
        />
      ) : (
        <>
          <Descriptions column={{ xs: 1, sm: 4 }} size="small" bordered>
            <Descriptions.Item label={t('sysSettings.telemetry.gate')}>
              <Tag color={enabled ? 'green' : 'default'}>
                {enabled ? t('sysSettings.telemetry.on') : t('sysSettings.telemetry.off')}
              </Tag>
            </Descriptions.Item>
            <Descriptions.Item label={t('sysSettings.telemetry.count')}>
              {status?.count ?? 0}
            </Descriptions.Item>
            <Descriptions.Item label={t('sysSettings.telemetry.coverage.label')}>
              <Tag color={COVERAGE_TAG_COLOR[coverage]} data-testid="telemetry-coverage-value">
                {`${status?.count ?? 0} / ${knownExecutorCount}`}
              </Tag>
            </Descriptions.Item>
            <Descriptions.Item label={t('sysSettings.telemetry.latest')}>
              {status?.latestOptedAt ? formatDateTime(status.latestOptedAt) : '—'}
            </Descriptions.Item>
          </Descriptions>
          {status && coverage === 'no_executors' && (
            <Alert
              type="warning"
              showIcon
              data-testid="telemetry-coverage-alert"
              title={t('sysSettings.telemetry.coverage.noExecutors')}
              action={reauthorizeButton}
              style={{ marginBottom: 16 }}
            />
          )}
          {status && coverage === 'partial' && (
            <Alert
              type="info"
              showIcon
              data-testid="telemetry-coverage-alert"
              title={t('sysSettings.telemetry.coverage.partial', {
                count: status.count,
                known: knownExecutorCount,
              })}
              action={reauthorizeButton}
              style={{ marginBottom: 16 }}
            />
          )}
          <Space size="middle" style={{ marginTop: 16, marginBottom: 12 }}>
            <Popconfirm
              title={pendingOptIn === true ? t('sysSettings.telemetry.confirmOn') : t('sysSettings.telemetry.confirmOff')}
              description={pendingOptIn === true ? t('sysSettings.telemetry.descOn') : t('sysSettings.telemetry.descOff')}
              okText={t('sysSettings.telemetry.ok')}
              cancelText={t('sysSettings.telemetry.cancel')}
              open={pendingOptIn !== null}
              onOpenChange={(open) => { if (!open) setPendingOptIn(null); }}
              onConfirm={onConfirm}
            >
              <Switch
                checked={enabled}
                // UX-J1：Popconfirm 待确认期间禁用，避免二次点击翻转待确认方向
                // （确认载荷与首次点击意图相反）。
                disabled={isLoading || pendingOptIn !== null}
                loading={submitting}
                onChange={(next) => {
                  if (pendingOptIn !== null) return;
                  setPendingOptIn(next);
                }}
                aria-label={t('sysSettings.telemetry.switch')}
              />
            </Popconfirm>
            <Text>{t('sysSettings.telemetry.switch')}</Text>
          </Space>
          <Table<TelemetryInstall>
            loading={isLoading}
            dataSource={status?.installs ?? []}
            rowKey="installId"
            columns={columns}
            size="small"
            pagination={false}
            scroll={{ x: 700 }}
            locale={{ emptyText: t('sysSettings.telemetry.empty') }}
          />
        </>
      )}
    </Card>
  );
}
