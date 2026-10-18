import React, { useCallback, useEffect, useState } from 'react';
import Icon from './Icon';
import { createCfgTexts, resolveRendererLocale } from '../i18n';
// PLAN-EXECUTOR-DESKTOP-UX 5.1：面板的**判定逻辑**全部在 main/health-panel.ts
// 的纯函数里（行顺序、状态优先级、路径脱敏、畸形载荷降级都由
// health-panel.selftest.ts 钉住）。渲染层只做两件事：
//   ① 把主进程投影回来的三段数据喂给 buildHealthPanel()；
//   ② 把机器可读的 row（id/state/valueKey/args）按 hand-written 双语表查值。
// 渲染层**不探 /health、不 statfs、不 spawn uv**——那会形成第二套真值源。
import {
  buildHealthPanel,
  type HealthPanelReport,
  type HealthRow,
  type HealthRowState,
} from '../../main/health-panel';

const t = createCfgTexts(resolveRendererLocale(() => navigator.language));

/** 主进程 `diagnostics:health-panel` 的返回（只含 runtime/health/workDir 三段）。 */
interface HealthPanelPayload {
  runtime: HealthPanelReport['sections']['runtime'] | null;
  health: HealthPanelReport['sections']['health'] | null;
  workDir: HealthPanelReport['sections']['workDir'] | null;
}

/** Python 环境诊断的面板子集（既有 config:python-env-status 载荷）。 */
interface PythonEnvPanelSlice {
  uvPath: string | null;
  uvSource: 'config' | 'bundled' | 'env' | 'path';
  uvFromSystemEnv: boolean;
  uvConfiguredButMissing?: boolean;
  uvStaticallyConfirmed?: boolean;
  poolEntries: string[];
  poolReadable: boolean;
}

interface HealthApi {
  getHealthPanel?: () => Promise<{ ok: boolean; report?: HealthPanelPayload; error?: string }>;
  getPythonEnvStatus?: () => Promise<PythonEnvPanelSlice>;
  testConnection?: (url: string) => Promise<{ ok: boolean; message: string }>;
}

function api(): HealthApi {
  return ((window as any).electronAPI ?? {}) as HealthApi;
}

/** 状态 → 图标名（沿用既有 Icon 集合，不引图标库）。 */
const STATE_ICON: Record<HealthRowState, 'check-circle' | 'warning' | 'close' | 'clock'> = {
  ok: 'check-circle',
  warn: 'warning',
  bad: 'close',
  unknown: 'clock',
};

/** 行标题：`health.row.<id>` 键 + 值/说明的查表插值。 */
function HealthRowView({ row }: { row: HealthRow }) {
  // 值：valueKey 是「health.value.* 的后缀」；缺失时不渲染值区（只留状态）。
  const value = row.valueKey
    ? t(`health.value.${row.valueKey}`, ...row.args)
    : '';
  const detail = row.detailKey
    ? t(`health.detail.${row.detailKey}`, ...row.detailArgs)
    : '';
  return (
    <li className={`health-row is-${row.state}`}>
      <span className="health-row-icon" aria-hidden="true">
        <Icon name={STATE_ICON[row.state]} className="icon-xs" />
      </span>
      <span className="health-row-label">{t(`health.row.${row.id}`)}</span>
      {value && <span className="health-row-value" title={value}>{value}</span>}
      {detail && <span className="health-row-detail" title={detail}>{detail}</span>}
      {/* 状态既由色/图标表达，也必须有文字——色觉障碍用户不能靠颜色读状态 */}
      <span className="health-row-state">{t(`health.state.${row.state}`)}</span>
    </li>
  );
}

/**
 * 健康检查面板（§5.1）。
 *
 * 数据链路（三条**既有**通道，零新增采集）：
 *   · `getHealthPanel()`   → 主进程 diagnostics:health-panel（内部就是
 *                            collectDiagnosticInputs + buildDiagnosticReport，
 *                            只投影 runtime/health/workDir 三段）
 *   · `getPythonEnvStatus()` → 既有配置页诊断块的同一份载荷
 *   · `testConnection(url)`  → 既有「测试连接」，用已保存的 adminApiUrl
 *
 * 失败态：桌面端**没有 toast 体系**，因此错误必须落在页内（cfg-save-error
 * 同型错误行，role="alert"），且刷新按钮不得永久禁用（try/catch/finally）。
 * 旧版 preload 缺通道时降级为「不支持」提示，不白屏、不同步抛。
 */
export default function HealthPanelCard({ apiUrl }: { apiUrl: string }) {
  const [rows, setRows] = useState<HealthRow[] | null>(null);
  const [summary, setSummary] = useState<ReturnType<typeof buildHealthPanel>['summary'] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const supported = typeof api().getHealthPanel === 'function';

  const refresh = useCallback(async () => {
    if (loading) return;
    setLoading(true);
    setLoadError(null);
    try {
      // 三条通道并行：任何一条失败都只降级对应的那几行（unknown），
      // 不让整块面板失败——诊断不能因为一个可选项挂掉。
      const [panelRes, pyEnv, conn] = await Promise.all([
        api().getHealthPanel!(),
        typeof api().getPythonEnvStatus === 'function'
          ? api().getPythonEnvStatus!().catch(() => null)
          : Promise.resolve(null),
        apiUrl && typeof api().testConnection === 'function'
          ? api().testConnection(apiUrl).catch(() => null)
          : Promise.resolve(null),
      ]);
      if (!panelRes || panelRes.ok !== true || !panelRes.report) {
        // 主进程明确失败：页内可见，且不覆盖上一次成功的行（保留可比对的旧值）
        setLoadError(t('health.error', panelRes?.error ?? ''));
        return;
      }
      // 主进程返回的是三段投影（不是整份报告）——这里喂给同一个纯函数，
      // 由它决定行顺序与状态优先级（与 selftest 断言的是同一段代码）。
      // 缺段时用空对象占位：buildHealthPanel 对缺字段一律降级为 unknown，
      // 这里不做第二套判空分支（否则判定逻辑就分裂成两份了）。
      const built = buildHealthPanel(
        { sections: {
          runtime: (panelRes.report.runtime ?? {}) as HealthPanelReport['sections']['runtime'],
          health: (panelRes.report.health ?? {}) as HealthPanelReport['sections']['health'],
          workDir: (panelRes.report.workDir ?? {}) as HealthPanelReport['sections']['workDir'],
        } },
        pyEnv,
        conn,
      );
      setRows(built.rows);
      setSummary(built.summary);
      setCheckedAt(new Date());
    } catch (err) {
      setLoadError(t('health.error', err instanceof Error ? err.message : String(err)));
    } finally {
      // reject 后按钮必须能再点（本仓反复出现的缺陷形态：永久 disabled）
      setLoading(false);
    }
  }, [apiUrl, loading]);

  useEffect(() => {
    if (!supported) return;
    void refresh();
    // 只在挂载/换中台地址时自动跑一次；后续由用户点刷新（面板不轮询——
    // 它是要人读的一览，不是实时仪表，避免每 10s 一次 statfs 写入探测）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supported, apiUrl]);

  if (!supported) {
    return (
      <div className="cfg-save-error" role="alert">
        <Icon name="warning" className="icon-xs" /> {t('health.unsupported')}
      </div>
    );
  }

  const overall = summary?.overall ?? 'unknown';

  return (
    <div className="health-panel" role="region" aria-label={t('health.title')}>
      <div className="health-panel-head">
        <div className="health-panel-title">
          <Icon name="activity" className="icon-xs" /> {t('health.title')}
          <span className={`health-badge is-${overall}`}>{t(`health.overall.${overall}`)}</span>
        </div>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => void refresh()}
          disabled={loading}
        >
          <Icon name="refresh" className={loading ? 'icon-spin' : undefined} />
          {loading ? t('health.refreshing') : t('health.refresh')}
        </button>
      </div>
      <p className="health-panel-hint">{t('health.subtitle')}</p>
      {loadError && (
        <div className="cfg-save-error" role="alert">
          <Icon name="warning" className="icon-xs" /> {loadError}
        </div>
      )}
      {summary && (
        <div className="health-summary">
          {t('health.summary', summary.ok, summary.warn, summary.bad, summary.unknown)}
          {checkedAt && (
            <span className="health-summary-time">
              {t('health.loadedAt', checkedAt.toLocaleTimeString('zh-CN', { hour12: false }))}
            </span>
          )}
        </div>
      )}
      {rows && rows.length > 0 && (
        <ul className="health-rows">
          {rows.map((row) => <HealthRowView key={row.id} row={row} />)}
        </ul>
      )}
    </div>
  );
}
