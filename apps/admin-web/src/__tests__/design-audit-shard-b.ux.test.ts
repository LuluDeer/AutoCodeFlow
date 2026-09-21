/**
 * D-设计审计 2026-09-22 分片B：应用/执行器/包/设置族修复的源码层守卫。
 *
 * 与分片A 同形态：断言「源码形态」——把任一处改回旧写法，对应用例立即变红。
 * 行为层（渲染结果）由既有用例覆盖；这里钉住反模式不回流。
 *
 * 覆盖分片B 全部条目：
 *  D-P1-2   两处裸 clipboard → copyText（ux04 另加守卫，此处补源码断言）
 *  D-P2-01b Alert message= → title=（antd 6.6.2 message= 已 deprecated）
 *  D-P2-02b runtime/包类型读面走 runtimeLabel 唯一事实源
 *  D-P2-08  删掉无效 background: `${cfg.color}15`
 *  D-P2-09  手写 toLocaleString 统一为 formatDateTime
 *  D-P2-10  主表/TasksTab 补 showTotal
 *  D-P2-11  硬编码英文补 i18n（Attempt # / CPU % / API 标签 / URL 列）
 *  D-P2-12  e.message 改 getErrMsg
 *  D-P2-13  index.css 追加 prefers-reduced-motion 块
 *  D-P2-14  设置/通知 Tabs 走 useSearchParams ?tab=
 *  D-P2-15  删除死令牌 --color-ring
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf-8');
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const APP_DEPLOY = stripComments(read('pages/AppDeploymentPage.tsx'));
const EXEC_DETAIL = stripComments(read('pages/ExecutionDetailPage.tsx'));
const EXECUTOR_DETAIL = stripComments(read('pages/ExecutorDetailPage.tsx'));
const APP_DETAIL = stripComments(read('pages/ApplicationDetailPage.tsx'));
const APP_LIST = stripComments(read('pages/ApplicationListPage.tsx'));
const EXEC_PKG = stripComments(read('pages/ExecutorPackagesPage.tsx'));
const NOTIF_SETTINGS = stripComments(read('pages/NotificationSettingsPage.tsx'));
const SETTINGS_INDEX = stripComments(read('pages/settings/index.tsx'));
const EVENT_SUB = stripComments(read('pages/settings/EventSubscriptionsSettings.tsx'));
const API_KEYS = stripComments(read('pages/settings/ApiKeysSettings.tsx'));
const INDEX_CSS = read('index.css');
const ZH = read('locales/zh.ts');
const EN = read('locales/en.ts');

describe('D-P1-2: 两处裸 clipboard 走 copyText 并按返回值分支', () => {
  it('AppDeploymentPage / ExecutionDetailPage 不再裸调 navigator.clipboard.writeText', () => {
    for (const [name, src] of [
      ['AppDeploymentPage', APP_DEPLOY],
      ['ExecutionDetailPage', EXEC_DETAIL],
    ] as const) {
      expect(/navigator\.clipboard\??\.writeText/.test(src), `${name} 仍裸调 navigator.clipboard.writeText`).toBe(false);
      expect(src, `${name} 未用 copyText`).toContain('copyText(');
      expect(/if\s*\(\s*ok\s*\)/.test(src), `${name} 未按返回值分支`).toBe(true);
    }
  });
});

describe('D-P2-01b: Alert 用 title= 而非 deprecated 的 message=', () => {
  it('各目标 Alert 已迁 title=', () => {
    expect(APP_DEPLOY).toContain("t('appDeploy.alert.pendingApprovalAdmin'");
    expect(APP_DEPLOY).toContain("title={t('appDeploy.modal.smartScheduling')}");
    expect(APP_DEPLOY).not.toMatch(/message=\{t\('appDeploy\.(alert|modal\.smartScheduling)/);

    expect(EXEC_DETAIL).toContain("title={t('execDetail.retriggerConfirm.differs')}");
    expect(EXEC_DETAIL).not.toContain("message={t('execDetail.retriggerConfirm.differs')}");

    expect(EXECUTOR_DETAIL).toContain("title={t('executorDetail.highrisk.title')}");
    expect(EXECUTOR_DETAIL).toContain("title={t('executorDetail.highrisk.irreversible')}");

    expect(APP_DETAIL).toContain("title={t('appDetail.ai.conclusion')}");

    expect(EVENT_SUB).toContain("title={t('eventSub.createResult.alertTitle')}");
    expect(EVENT_SUB).toContain("title={t('eventSub.createResult.title')}");
    expect(EVENT_SUB).toContain("title={t('eventSub.alertMessage')}");

    expect(API_KEYS).toContain("title={t('apiKeys.result.warnTitle')}");
    expect(API_KEYS).toContain("title={t('apiKeys.alertMessage')}");
  });
});

describe('D-P2-02b: runtime/包类型读面走唯一事实源 runtimeLabel', () => {
  it('ApplicationListPage / ApplicationDetailPage / ExecutorPackagesPage 均映射且引入', () => {
    expect(APP_LIST).toContain("runtimeLabel(v, t)");
    expect(APP_LIST).toContain("from '../utils/runtime-label'");
    expect(APP_LIST).not.toContain('<Tag color="blue">{v}</Tag>');

    expect(APP_DETAIL).toContain("runtimeLabel(app.runtime, t)");
    expect(APP_DETAIL).toContain("runtimeLabel(v, t)");
    expect(APP_DETAIL).toContain("from '../utils/runtime-label'");

    expect(EXEC_PKG).toContain("runtimeLabel(v, t)");
    expect(EXEC_PKG).toContain("from '../utils/runtime-label'");
  });
});

describe('D-P2-08: 删掉无效 background: `${cfg.color}15`', () => {
  it('AppDeploymentPage 不再拼接非法十六进制底色', () => {
    expect(APP_DEPLOY).not.toContain('background: `${cfg.color}15`');
    expect(APP_DEPLOY).not.toContain('${cfg.color}15');
  });
});

describe('D-P2-09: 手写 toLocaleString 统一为 formatDateTime', () => {
  it('四个设置/详情族文件不再残留 currentLocale，且引入 formatDateTime', () => {
    for (const [name, src] of [
      ['ApplicationDetailPage', APP_DETAIL],
      ['settings/index', SETTINGS_INDEX],
      ['EventSubscriptionsSettings', EVENT_SUB],
      ['NotificationSettingsPage', NOTIF_SETTINGS],
    ] as const) {
      expect(src, `${name} 仍残留 currentLocale`).not.toContain('currentLocale');
      expect(src, `${name} 未引入 formatDateTime`).toContain('formatDateTime');
    }
  });

  it('ExecutorDetailPage 历史 startTime 列走 formatDateTime（tooltip 仍用 currentLocale）', () => {
    expect(EXECUTOR_DETAIL).toContain('formatDateTime(v)');
  });
});

describe('D-P2-10: 主表 / TasksTab 补 showTotal', () => {
  it('ApplicationListPage 主表与 ApplicationDetailPage TasksTab 均带 showTotal', () => {
    expect(APP_LIST).toMatch(/showTotal:\s*\(n\)\s*=>\s*t\('appList\.total'/);
    expect(APP_DETAIL).toMatch(/showTotal:\s*\(n\)\s*=>\s*t\('appDetail\.tasks\.total'/);
  });
});

describe('D-P2-11: 硬编码英文补 i18n（zh/en 双键）', () => {
  it('新增 i18n 键在 zh/en 两套词条里都存在', () => {
    for (const key of [
      'appList.total',
      'appDetail.tasks.total',
      'execDetail.retry.attempt',
      'executorDetail.trend.cpu',
      'execPkg.pushFail',
      'sysSettings.ai.baseUrlLabel',
      'sysSettings.ai.apiKeyLabel',
      'sysSettings.ai.ollamaHostLabel',
      'eventSub.col.url',
    ]) {
      expect(ZH, `${key} 在 zh 词条缺失`).toContain(`'${key}'`);
      expect(EN, `${key} 在 en 词条缺失`).toContain(`'${key}'`);
    }
  });

  it('源码不再直出硬编码英文', () => {
    expect(EXEC_DETAIL).toContain("t('execDetail.retry.attempt', { n: link.retryCount })");
    expect(EXEC_DETAIL).not.toContain('Attempt #{link.retryCount}');
    expect(EXECUTOR_DETAIL).not.toContain('name="CPU %"');
    expect(SETTINGS_INDEX).not.toContain('label="API Base URL"');
    expect(SETTINGS_INDEX).not.toContain('Ollama Host');
    expect(EVENT_SUB).not.toContain("title: 'URL'");
  });
});

describe('D-P2-12: e.message 改 getErrMsg', () => {
  it('ExecutorPackagesPage 推送兜底走 getErrMsg + 专属键', () => {
    expect(EXEC_PKG).not.toContain('(e as Error).message');
    expect(EXEC_PKG).toContain("getErrMsg(e, t('execPkg.pushFail'))");
  });
});

describe('D-P2-13: index.css 追加 prefers-reduced-motion 块', () => {
  it('存在 reduced-motion 媒体查询且只压 transition/animation', () => {
    expect(INDEX_CSS).toContain('@media (prefers-reduced-motion: reduce)');
    expect(INDEX_CSS).toContain('transition-duration: 0.01ms');
    expect(INDEX_CSS).toContain('animation-duration: 0.01ms');
  });
});

describe('D-P2-14: 设置/通知 Tabs 走 useSearchParams ?tab=', () => {
  it('settings/index 不再非受控 <Tabs items={tabs} />，改 useSearchParams', () => {
    expect(SETTINGS_INDEX).toContain('useSearchParams');
    expect(SETTINGS_INDEX).not.toContain('<Tabs items={tabs} />');
    expect(SETTINGS_INDEX).toContain("next.set('tab', key)");
  });

  it('NotificationSettingsPage Tabs 进 URL ?tab=', () => {
    expect(NOTIF_SETTINGS).toContain('useSearchParams');
    expect(NOTIF_SETTINGS).toContain("next.set('tab', k)");
    expect(NOTIF_SETTINGS).not.toContain('setActiveTab(k)');
  });
});

describe('D-P2-15: 删除死令牌 --color-ring', () => {
  it('index.css 不再定义 --color-ring 变量', () => {
    expect(INDEX_CSS).not.toMatch(/--color-ring\s*:/);
  });
});
