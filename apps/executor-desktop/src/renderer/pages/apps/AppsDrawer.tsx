import React from 'react';
import Icon from '../../components/Icon';
import AppCopyIdButton from './AppCopyIdButton';

type Translate = (key: string, ...args: (string | number | boolean)[]) => string;

export interface AppsDrawerGroup {
  appId: string;
  name: string | null;
  entriesCount: number;
  currentVersion: string | null;
  hasCurrent: boolean;
  newestAtText: string;
  versionCount: number;
  runModePrefix: string;
}

interface AppsDrawerProps {
  group: AppsDrawerGroup;
  status: 'running' | 'scheduled' | 'stopped';
  statusLabel: string;
  avatarClass: string;
  avatarInitialText: string;
  busy: string | null;
  hasPendingConfirm: boolean;
  closeRef: React.RefObject<HTMLButtonElement | null>;
  confirmBar: React.ReactNode;
  releases: React.ReactNode;
  onClose: () => void;
  onRequestUninstall: () => void;
  t: Translate;
}

/**
 * 应用详情抽屉（右侧非模态详情层；<1400px 带点击关闭遮罩，<900px 整宽展示）。
 * 根节点使用 <div role="dialog"> 而非 <aside role="dialog">，满足 ARIA role 约束。
 */
export default function AppsDrawer({
  group,
  status,
  statusLabel,
  avatarClass,
  avatarInitialText,
  busy,
  hasPendingConfirm,
  closeRef,
  confirmBar,
  releases,
  onClose,
  onRequestUninstall,
  t,
}: AppsDrawerProps) {
  return (
    <>
      <div className="appx-drawer-backdrop" aria-hidden="true" onClick={onClose} />
      <div
        className="appx-drawer"
        role="dialog"
        aria-modal="false"
        aria-labelledby="appx-detail-title"
      >
        <header className="appx-drawer-head">
          <h2 id="appx-detail-title" className="appx-drawer-title">{t('appx.detail.title')}</h2>
          <button
            ref={closeRef}
            type="button"
            className="btn btn-sm appx-drawer-close"
            onClick={onClose}
            aria-label={t('ui.close')}
            title={t('ui.close')}
          ><Icon name="close" /></button>
        </header>
        <div className="appx-drawer-body">
          {confirmBar}
          <section className="appx-detail-hero">
            <span className={avatarClass} aria-hidden="true">{avatarInitialText}</span>
            <span className="appx-detail-hero-text">
              <strong
                className={group.name ? 'appx-detail-name' : 'appx-detail-name appx-detail-name-unknown'}
                title={group.name
                  ? t('apps.nameTitle', group.name, group.appId)
                  : t('apps.nameUnknownTitle', group.appId)}
              >
                {group.name ?? t('apps.unknownName')}
              </strong>
              <span className="appx-detail-sub">
                {group.runModePrefix}{group.appId.slice(0, 8)}
              </span>
            </span>
          </section>

          {!group.name && <p className="appx-detail-hint">{t('appx.unknownHint')}</p>}

          <section className="appx-detail-section">
            <div className="appx-detail-id-row">
              <code className="appx-detail-id" title={group.appId}>{group.appId}</code>
              <AppCopyIdButton key={group.appId} appId={group.appId} t={t} />
            </div>
            <h3 className="appx-detail-heading">{t('appx.detail.overview')}</h3>
            <div className="appx-detail-grid">
              <div className="appx-detail-row">
                <span className="appx-detail-label">{t('appx.col.status')}</span>
                <span className={`appx-status appx-status-${status}`}>
                  <span className={`appx-dot appx-dot-${status}`} aria-hidden="true" />
                  {statusLabel}
                </span>
              </div>
              <div className="appx-detail-row">
                <span className="appx-detail-label">{t('appx.col.current')}</span>
                <span className="appx-detail-value">
                  {group.hasCurrent ? (
                    <span className="app-badge app-badge-current">
                      {group.currentVersion ? `v${group.currentVersion}` : t('apps.noCurrent')}
                    </span>
                  ) : t('apps.noCurrent')}
                </span>
              </div>
              <div className="appx-detail-row">
                <span className="appx-detail-label">{t('appx.col.deployedAt')}</span>
                <span className="appx-detail-value appx-num">{group.newestAtText}</span>
              </div>
              <div className="appx-detail-row">
                <span className="appx-detail-label">{t('appx.col.versions')}</span>
                <span className="appx-detail-value appx-num">{group.versionCount}</span>
              </div>
            </div>
          </section>

          <section className="appx-detail-section">
            {releases}
          </section>

          <section className="appx-detail-section appx-danger-zone">
            <h3 className="appx-detail-heading">{t('appx.detail.danger')}</h3>
            <p className="appx-danger-hint">{t('appx.detail.uninstallHint')}</p>
            <button
              type="button"
              className="btn btn-sm btn-outline-danger"
              onClick={onRequestUninstall}
              disabled={Boolean(busy) || hasPendingConfirm}
              title={t('apps.uninstallTitle')}
            >
              {busy === group.appId ? t('apps.busy') : t('apps.uninstall')}
            </button>
          </section>
        </div>
      </div>
    </>
  );
}
