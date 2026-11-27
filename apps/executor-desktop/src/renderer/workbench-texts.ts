/**
 * 状态页「打开工作台」入口的双语文案（独立小表，避免把 i18n.ts /
 * StatusWindow.tsx 这两个棘轮文件继续推高）。键位由 i18n.ts 展开进 CFG_TEXTS，
 * 渲染层统一通过 t('status.openWorkbench') 读取。
 */

export const WORKBENCH_TEXTS: Record<'zh' | 'en', Record<string, string>> = {
  zh: {
    'status.openWorkbench': '打开工作台',
    'status.openWorkbenchTitle': '在独立窗口打开中台业务工作台',
    'status.workbenchOpenFailed': '工作台打开失败，请检查平台地址配置',
  },
  en: {
    'status.openWorkbench': 'Open Workbench',
    'status.openWorkbenchTitle': 'Open the business workbench in a separate window',
    'status.workbenchOpenFailed': 'Could not open the workbench; check the platform URL setting',
  },
};
