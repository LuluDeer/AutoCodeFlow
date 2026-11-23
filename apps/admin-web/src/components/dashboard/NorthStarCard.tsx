/**
 * R328 前端切片② —— 北极星双口径看板卡片。
 *
 * ## PM 裁决（docs/plan/north-star-business-confirmed.md §8，R324）
 *
 * 严格值（口径 D · business_confirmed）与近似值（口径 A · business_results_proxy）
 * **并列展示、不混用、不互相替代**：
 *   - 严格值：本周被业务确认执行数（confirmed_events）为主指标，活跃实例数
 *     （active_install_weeks）为辅；醒目色 + 「严格」Tag。
 *   - 近似值：有产物/有证据的执行数（executions）为参考值；弱化色 + 「参考/近似」
 *     Tag，并在 strictHint/proxyHint 中逐条说明两个口径的来源差异。
 *
 * `warnings` 是「不混用」护栏（尤其「⚠️ 有产物/有证据 ≠ 被业务确认，代理值勿当
 * 严格值」），**逐字原文渲染、无条件常驻**：数据为空、周序列为空、空态时都必须
 * 出现，不因任何理由隐藏。英文界面下警告仍显示后端原文（中文），由 warning 键的
 * 标题/Tooltip 明确说明「原文来自后端，不作翻译」。
 *
 * 全局口径：本卡不接收 projectId、请求不带项目维度，切项目数值不变；卡片自带
 * 「全局口径」Tag（刻意**不复用** Dashboard 的 `scope-badge-global` testid——
 * baseline `dashboard-scope-grouping.test.tsx` 断言该徽章恰好 4 枚）。
 */
import { Alert, Button, Card, Skeleton, Tag, Tooltip, Typography } from 'antd';
import { GlobalOutlined, StarFilled, WarningOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import type { NorthStarReport } from '../../api/metrics';
import { useNorthStarReport } from '../../api/queries';
import { getErrMsg } from '../../utils/error';
// UI-10：i18n 模块副作用完成初始化；树内用 useTranslation 读 key。
import '../../i18n';

const { Text } = Typography;

/**
 * 升主原因高亮的匹配标记：后端「运营前置（telemetry coverage=full）」原因句含英文
 * 子串 `coverage`。⚠️ 这是文案子串耦合——后端改措辞会静默降级；待 reasons 改为
 * 结构化类别码后应按字段判定（UX-F1）。
 */
const COVERAGE_REASON_MARKER = 'coverage';

/** 后端 as_of 是 ISO 字符串；按界面语言本地化，非法值回退原文（不吞信息）。 */
function formatAsOf(value: string | undefined, locale: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

/** 卡片外壳：加载/错误/正常三态共用同一个 data-testid 与标题区。 */
function CardShell({ children, title }: { children: React.ReactNode; title: React.ReactNode }) {
  return (
    <div data-testid="north-star-card" style={{ height: '100%' }}>
      <Card
        size="small"
        variant="borderless"
        style={{ background: 'var(--color-muted)', height: '100%' }}
        title={title}
      >
        {children}
      </Card>
    </div>
  );
}

/** 警告区：容器与标题常驻，warnings 逐条原文渲染（反证的唯一切点）。 */
function WarningRail({ warnings }: { warnings: string[] }) {
  const { t } = useTranslation();
  return (
    <div data-testid="north-star-warnings" style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <Tooltip title={t('dashboard.northStar.warning')}>
        <Text type="warning" style={{ fontSize: 11, fontWeight: 600 }}>
          <WarningOutlined style={{ marginInlineEnd: 4 }} />
          {t('dashboard.northStar.warning')}
        </Text>
      </Tooltip>
      {warnings.map((warning, index) => (
        <Alert
          key={`${index}-${warning}`}
          type="warning"
          showIcon={false}
          title={warning}
          style={{ padding: '4px 10px', borderRadius: 4, fontSize: 11 }}
          data-testid="north-star-warning"
        />
      ))}
    </div>
  );
}

/** 从报告里取数：所有字段缺失一律按 0 计（空态展示 0，不报错、不显示 '-'）。 */
function readTotals(report: NorthStarReport | undefined) {
  return {
    confirmed: report?.business_confirmed?.totals?.confirmed_events ?? 0,
    installs: report?.business_confirmed?.totals?.active_install_weeks ?? 0,
    proxy: report?.business_results_proxy?.totals?.executions ?? 0,
    warnings: report?.warnings ?? [],
  };
}

export default function NorthStarCard() {
  const { t, i18n } = useTranslation();
  const { data, isPending, isError, error, refetch } = useNorthStarReport();
  const totals = readTotals(data);
  const locale = i18n.resolvedLanguage?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US';

  const title = (
    <Text strong style={{ fontSize: 14 }}>
      <StarFilled style={{ color: 'var(--color-primary)', marginInlineEnd: 6 }} />
      {t('dashboard.northStar.title')}
      {/* 全局口径标识：普通 Tag，不复用 scope-badge-global（baseline 恰好 4 枚） */}
      <Tag
        icon={<GlobalOutlined />}
        data-testid="north-star-global-tag"
        style={{ fontSize: 10, lineHeight: '16px', marginInlineStart: 8, marginInlineEnd: 0 }}
      >
        {t('projectCtx.globalScope')}
      </Tag>
    </Text>
  );

  // 加载骨架：周级指标首屏只占一卡高度，Skeleton 行数与正常态对齐防跳动。
  if (isPending) {
    return (
      <CardShell title={title}>
        <div data-testid="north-star-loading">
          <Skeleton active paragraph={{ rows: 3 }} title={false} />
        </div>
      </CardShell>
    );
  }

  // 读取失败：友好提示 + 重试（仿 StateError 语义，但独立 testid 不污染页内错误块断言）。
  if (isError) {
    return (
      <CardShell title={title}>
        <div data-testid="north-star-read-failed" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Text type="danger" style={{ fontSize: 12 }}>{t('dashboard.northStar.readFailed')}</Text>
          <Button size="small" onClick={() => void refetch()}>{t('dashboard.refresh')}</Button>
          {error ? (
            <Text type="secondary" style={{ fontSize: 11 }}>
              {getErrMsg(error, t('dashboard.northStar.readFailed'))}
            </Text>
          ) : null}
        </div>
      </CardShell>
    );
  }

  const isEmpty = totals.confirmed === 0 && totals.installs === 0 && totals.proxy === 0;

  return (
    <CardShell title={title}>
      {/* 周口径说明：按周 + 截止 as_of（本地化时间格式） */}
      <Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 8 }}>
        {t('dashboard.northStar.asOf', { value: formatAsOf(data?.as_of, locale) })}
      </Text>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
        {/* 主指标：严格值（口径 D）—— 醒目色 + 严格 Tag，绝不混入近似值 */}
        <div data-testid="north-star-strict" style={{ flex: '1 1 220px', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <Tag color="success" data-testid="north-star-strict-tag" style={{ marginInlineEnd: 0 }}>
              {t('dashboard.northStar.strict')}
            </Tag>
            <Text type="secondary" style={{ fontSize: 11 }}>{t('dashboard.northStar.strictHint')}</Text>
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 16 }}>
            <div>
              <Text style={{ fontSize: 28, fontWeight: 700, color: 'var(--color-success)' }} data-testid="north-star-confirmed">
                {totals.confirmed}
              </Text>
              <Text type="secondary" style={{ fontSize: 11, display: 'block' }}>
                {t('dashboard.northStar.confirmedExecutions')}
              </Text>
            </div>
            <div>
              <Text style={{ fontSize: 18, fontWeight: 600 }} data-testid="north-star-installs">
                {totals.installs}
              </Text>
              <Text type="secondary" style={{ fontSize: 11, display: 'block' }}>
                {t('dashboard.northStar.activeInstalls')}
              </Text>
            </div>
          </div>
        </div>

        {/* 参考值：近似值（口径 A）—— 弱化色 + 参考/近似 Tag，独立区域不与主指标并排相加 */}
        <div
          data-testid="north-star-proxy"
          style={{ flex: '1 1 200px', minWidth: 0, opacity: 0.72, borderLeft: '1px solid var(--color-border)', paddingLeft: 12 }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <Tag data-testid="north-star-proxy-tag" style={{ marginInlineEnd: 0 }}>
              {t('dashboard.northStar.proxy')}
            </Tag>
            <Text type="secondary" style={{ fontSize: 11 }}>{t('dashboard.northStar.proxyHint')}</Text>
          </div>
          <Text type="secondary" style={{ fontSize: 20, fontWeight: 600 }} data-testid="north-star-proxy-executions">
            {totals.proxy}
          </Text>
          <Text type="secondary" style={{ fontSize: 11, display: 'block' }}>
            {t('dashboard.northStar.proxyExecutions')}
          </Text>
        </div>
      </div>

      {/* R448/R449 升主判据：只判数值阈值，运营前置 coverage=full 脚本不验证（reasons 原文如实显示） */}
      {data?.promotionEligibility && (
        <div
          data-testid="north-star-promotion"
          style={{ marginTop: 10, padding: '8px 10px', border: '1px solid var(--color-border)', borderRadius: 6 }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Text strong style={{ fontSize: 12 }}>{t('dashboard.northStar.promotion.title')}</Text>
            <Tag
              color={data.promotionEligibility.eligible ? 'success' : 'warning'}
              data-testid="north-star-promotion-tag"
              style={{ marginInlineEnd: 0 }}
            >
              {data.promotionEligibility.eligible
                ? t('dashboard.northStar.promotion.eligible')
                : t('dashboard.northStar.promotion.notEligible')}
            </Tag>
            <Text type="secondary" style={{ fontSize: 11 }} data-testid="north-star-promotion-detail">
              {t('dashboard.northStar.promotion.detail', {
                weeks: data.promotionEligibility.weeks,
                installs: data.promotionEligibility.activeInstallWeeks,
              })}
            </Text>
          </div>
          <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 2 }} data-testid="north-star-promotion-reasons">
            {data.promotionEligibility.reasons.map((reason, idx) => (
              <Text
                key={idx}
                type={reason.includes(COVERAGE_REASON_MARKER) ? 'warning' : 'secondary'}
                style={{ fontSize: 11 }}
              >
                {reason}
              </Text>
            ))}
            <Text type="secondary" style={{ fontSize: 11 }}>{t('dashboard.northStar.promotion.note')}</Text>
          </div>
        </div>
      )}

      {isEmpty && (
        <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 8 }} data-testid="north-star-empty">
          {t('dashboard.northStar.empty')}
        </Text>
      )}

      {/* 护栏常驻：空数据 / 空周序列 / 空态都不影响 warnings 渲染 */}
      <WarningRail warnings={totals.warnings} />
    </CardShell>
  );
}
