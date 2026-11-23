import React from 'react';
import Icon from '../../components/Icon';
import { formatLocaleDateTime } from '../../i18n';

type Translate = (key: string, ...args: (string | number | boolean)[]) => string;

export interface HistoryDetailRecord {
  executionId: string;
  taskId: string;
  taskName: string;
  startTime: number;
  endTime?: number;
  status?: 'running' | 'success' | 'failed';
  exitCode?: number;
  errorMessage?: string;
}

interface HistoryDetailPanelProps {
  selected: HistoryDetailRecord | null;
  isNarrow: boolean;
  detailRef: React.RefObject<HTMLElement | null>;
  closeBtnRef: React.RefObject<HTMLButtonElement | null>;
  exportingId: string | null;
  recentSameTask: HistoryDetailRecord[];
  copyIdButton: React.ReactNode;
  statusBadge: (status?: string) => React.ReactNode;
  statusTone: (status?: string) => string;
  statusText: (status?: string) => string;
  taskLabelOf: (r: HistoryDetailRecord) => string;
  formatTime: (ts?: number) => string;
  runDurationText: (run: HistoryDetailRecord) => string;
  onClose: () => void;
  onViewLog: (run: HistoryDetailRecord) => void;
  onRevealLog: (executionId: string) => void;
  onExportLog: (executionId: string) => void;
  onSelectRunId: (executionId: string) => void;
  t: Translate;
}

/**
 * 历史台账右侧详情面板（>=1400px 常驻并排；<1400px 带遮罩抽屉；<900px 整宽详情层）。
 */
export default function HistoryDetailPanel({
  selected,
  isNarrow,
  detailRef,
  closeBtnRef,
  exportingId,
  recentSameTask,
  copyIdButton,
  statusBadge,
  statusTone,
  statusText,
  taskLabelOf,
  formatTime,
  runDurationText,
  onClose,
  onViewLog,
  onRevealLog,
  onExportLog,
  onSelectRunId,
  t,
}: HistoryDetailPanelProps) {
  const titleText = selected ? taskLabelOf(selected) : t('historyx.detail.title');

  return (
    <>
      {selected && isNarrow && (
        <div className="historyx-drawer-backdrop" aria-hidden="true" onClick={onClose} />
      )}
      <aside
        id={selected ? `history-runs-${selected.executionId}` : undefined}
        ref={detailRef}
        className={`historyx-detail${selected ? ' has-selection' : ' is-empty'}${isNarrow ? ' is-drawer' : ''}`}
        aria-label={t('historyx.detail.title')}
      >
        <div className="historyx-detail-head">
          <h2 className="historyx-detail-title" title={selected ? titleText : undefined}>
            {titleText}
          </h2>
          <button
            ref={closeBtnRef}
            type="button"
            className="btn btn-sm historyx-detail-close"
            onClick={onClose}
            aria-label={t('historyx.detail.close')}
            title={t('historyx.detail.close')}
          ><Icon name="close" /></button>
        </div>

        {!selected ? (
          <p className="historyx-detail-guide">{t('historyx.detail.empty')}</p>
        ) : (
          <div className="historyx-detail-body">
            <div className="historyx-detail-status">
              {statusBadge(selected.status)}
              <span className="historyx-detail-duration">{runDurationText(selected)}</span>
            </div>

            <dl className="historyx-facts">
              <div className="historyx-fact">
                <dt>{t('historyx.detail.start')}</dt>
                <dd title={selected.startTime ? formatLocaleDateTime(selected.startTime) : undefined}>{formatTime(selected.startTime)}</dd>
              </div>
              <div className="historyx-fact">
                <dt>{t('historyx.detail.end')}</dt>
                <dd title={selected.endTime ? formatLocaleDateTime(selected.endTime) : undefined}>
                  {selected.endTime !== undefined
                    ? formatTime(selected.endTime)
                    : selected.status === 'running'
                      ? t('historyx.detail.running')
                      : '—'}
                </dd>
              </div>
              <div className="historyx-fact">
                <dt>{t('historyx.detail.duration')}</dt>
                <dd>{runDurationText(selected)}</dd>
              </div>
              <div className="historyx-fact">
                <dt>{t('historyx.detail.exitCode')}</dt>
                <dd>{selected.exitCode !== undefined ? String(selected.exitCode) : '—'}</dd>
              </div>
            </dl>

            <section className="historyx-section">
              <h3 className="historyx-section-title">{t('historyx.detail.execId')}</h3>
              <div className="historyx-id-row">
                <code className="historyx-detail-id" title={selected.executionId}>{selected.executionId}</code>
                {copyIdButton}
              </div>
            </section>

            <section className="historyx-section">
              <h3 className="historyx-section-title">{t('historyx.detail.error')}</h3>
              {selected.errorMessage ? (
                <p className="historyx-detail-error">{selected.errorMessage}</p>
              ) : selected.status === 'failed' ? (
                <p className="historyx-detail-error">
                  {selected.exitCode !== undefined ? t('history.run.exitCode', selected.exitCode) : t('historyx.detail.noError')}
                </p>
              ) : (
                <p className="historyx-detail-noerror">{t('historyx.detail.noError')}</p>
              )}
            </section>

            <div className="historyx-detail-actions">
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => onViewLog(selected)}
              ><Icon name="terminal" /> {t('historyx.detail.viewLog')}</button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => onRevealLog(selected.executionId)}
              ><Icon name="external" /> {t('historyx.detail.reveal')}</button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => onExportLog(selected.executionId)}
                disabled={exportingId === selected.executionId}
              ><Icon name="download" /> {t('history.exportLog')}</button>
            </div>

            {recentSameTask.length > 1 && (
              <section className="historyx-section">
                <h3 className="historyx-section-title">{t('historyx.detail.recent')}</h3>
                <div className="historyx-recent">
                  {recentSameTask.map((run) => {
                    const active = run.executionId === selected.executionId;
                    return (
                      <button
                        key={run.executionId}
                        type="button"
                        className={`historyx-recent-row${active ? ' is-active' : ''}`}
                        onClick={() => onSelectRunId(run.executionId)}
                        aria-current={active ? 'true' : undefined}
                      >
                        <span className={`historyx-status-dot ${statusTone(run.status)}`} aria-hidden="true" />
                        <span className="historyx-recent-time">{formatTime(run.startTime)}</span>
                        <span className="historyx-recent-dur">{runDurationText(run)}</span>
                        <span className={`historyx-recent-status ${statusTone(run.status)}`}>{statusText(run.status)}</span>
                      </button>
                    );
                  })}
                </div>
              </section>
            )}
          </div>
        )}
      </aside>
    </>
  );
}
