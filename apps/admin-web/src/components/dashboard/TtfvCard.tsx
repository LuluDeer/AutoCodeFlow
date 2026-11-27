/**
 * 老板驾驶舱 · TTFV（Time to First Value / 首次成功用时）诚实三态卡。
 *
 * 数据源复用 GET /agent/north-star/metrics（useNorthStarReport），不新增 hook、
 * 不带项目维度。响应尚未生成 ttfv 字段时（后端并行上线窗口）走 unknown 分支：
 * 字段缺席 / 状态未知 / ok 但 medianMinutes 为 null 一律标缺，绝不显示 0。
 */
import { Card, Skeleton, Tooltip, Typography } from 'antd';
import { ClockCircleOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useNorthStarReport } from '../../api/queries';
import '../../i18n';

const { Text } = Typography;

/**
 * 后端 DTO 的局部防御视图：ttfv 字段未随生成物落盘前，NorthStarReport 上读不到它；
 * 这里只声明本卡消费的字段，全部可选，任何缺字段都不猜值。
 */
interface TtfvView {
  dataStatus?: 'gate_off' | 'no_data' | 'ok';
  medianMinutes?: number | null;
  /** 后端口径是比率（0~1，如 0.5），渲染层才换算成百分数。 */
  activation24h?: number | null;
  sampleSize?: number;
  asOf?: string;
  note?: string;
}

function finiteOrUndefined(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** 比率 → 百分数：一位小数内收敛，避免 0.1*100=10.000000000000002 这类浮点尾数。 */
function toPercent(ratio: number): number {
  return Math.round(ratio * 1000) / 10;
}

function NoteLine({ note }: { note: string }) {
  const { t } = useTranslation();
  return (
    <Tooltip title={note}>
      <div
        data-testid="boss-ttfv-note"
        style={{
          fontSize: 11,
          color: 'var(--color-text-secondary)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {t('dashboard.cockpit.ttfv.note', { note })}
      </div>
    </Tooltip>
  );
}

export default function TtfvCard() {
  const { t } = useTranslation();
  const { data, isPending, isError } = useNorthStarReport();
  const ttfv = (data as { ttfv?: TtfvView } | undefined)?.ttfv;

  const status = ttfv?.dataStatus;
  const median = finiteOrUndefined(ttfv?.medianMinutes);
  const activation = finiteOrUndefined(ttfv?.activation24h);
  const sampleSize = finiteOrUndefined(ttfv?.sampleSize);
  const asOf = nonEmpty(ttfv?.asOf);
  const note = nonEmpty(ttfv?.note);
  const known = status === 'gate_off' || status === 'no_data' || status === 'ok';
  const unusable = isError || !ttfv || !known || (status === 'ok' && median === undefined);

  const title = (
    <Text strong style={{ fontSize: 14 }}>
      <ClockCircleOutlined style={{ color: 'var(--color-primary)', marginInlineEnd: 6 }} />
      {t('dashboard.cockpit.ttfv.title')}
    </Text>
  );

  let body;
  if (isPending) {
    body = (
      <div data-testid="boss-ttfv-loading">
        <Skeleton active paragraph={{ rows: 3 }} title={false} />
      </div>
    );
  } else if (unusable) {
    body = (
      <div data-testid="boss-ttfv-unknown" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <Text type="warning" style={{ fontSize: 16, fontWeight: 600 }}>
          {t('dashboard.cockpit.ttfv.unknown')}
        </Text>
      </div>
    );
  } else if (status === 'gate_off') {
    body = (
      <div data-testid="boss-ttfv-gate-off" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <Text type="warning" style={{ fontSize: 16, fontWeight: 600 }}>
          {t('dashboard.cockpit.ttfv.gateOff')}
        </Text>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {t('dashboard.cockpit.ttfv.gateOffHint')}
        </Text>
        {note ? <NoteLine note={note} /> : null}
      </div>
    );
  } else if (status === 'no_data') {
    body = (
      <div data-testid="boss-ttfv-no-data" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <Text type="warning" style={{ fontSize: 16, fontWeight: 600 }}>
          {t('dashboard.cockpit.ttfv.noData')}
        </Text>
        {sampleSize === undefined ? null : (
          <div data-testid="boss-ttfv-sample-size" style={{ fontSize: 12 }}>
            {t('dashboard.cockpit.ttfv.sampleSize', { count: sampleSize })}
          </div>
        )}
        {note ? <NoteLine note={note} /> : null}
      </div>
    );
  } else {
    body = (
      <div data-testid="boss-ttfv-ok" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div data-testid="boss-ttfv-median">
          <Text style={{ fontSize: 28, fontWeight: 700, color: 'var(--color-success)' }}>
            {t('dashboard.cockpit.ttfv.median', { value: median })}
          </Text>
        </div>
        <div data-testid="boss-ttfv-activation">
          <Text type="secondary" style={{ fontSize: 12 }}>
            {activation === undefined
              ? t('dashboard.cockpit.ttfv.activationPending')
              : t('dashboard.cockpit.ttfv.activation', { value: toPercent(activation) })}
          </Text>
        </div>
        {sampleSize === undefined ? null : (
          <div data-testid="boss-ttfv-sample-size" style={{ fontSize: 12 }}>
            {t('dashboard.cockpit.ttfv.sampleSize', { count: sampleSize })}
          </div>
        )}
        {asOf ? (
          <div data-testid="boss-ttfv-as-of" style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
            {t('dashboard.cockpit.ttfv.asOf', { value: asOf })}
          </div>
        ) : null}
        {note ? <NoteLine note={note} /> : null}
      </div>
    );
  }

  return (
    <div data-testid="boss-ttfv-card" style={{ height: '100%' }}>
      <Card size="small" variant="borderless" title={title} style={{ background: 'var(--color-muted)', height: '100%' }}>
        {body}
        <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 8 }}>
          {t('dashboard.cockpit.ttfv.subtitle')}
        </Text>
      </Card>
    </div>
  );
}
