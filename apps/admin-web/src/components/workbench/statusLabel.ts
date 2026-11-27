/**
 * 工作台/路由错误的统一面向用户文案。
 *
 * 后端状态与 HTTP statusText 是英文 jargon；这里把它们收敛成静态 i18n 键，
 * 原始 message/status/stack 由调用方放进可折叠「技术详情」，既不丢诊断信息，
 * 也不让普通用户先看一屏英文异常。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
// 兼容 i18next TFunction 与测试替身：两者都能安全调用下面这些静态键。
type Translate = (...args: any[]) => any;

/** 会话/步骤状态（别名归一到同一组 i18n 文案）。 */
export function sessionStatusLabel(t: Translate, status: string): string {
  switch (status) {
    case 'pending':
    case 'queued':
      return t('workbench.session.status.pending');
    case 'running':
      return t('workbench.session.status.running');
    case 'succeeded':
    case 'completed':
      return t('workbench.session.status.succeeded');
    case 'failed':
    case 'error':
      return t('workbench.session.status.failed');
    case 'waiting_input':
      return t('workbench.session.status.waiting_input');
    case 'cancelled':
    case 'canceled':
      return t('workbench.session.status.cancelled');
    default:
      return t('statusLabel.status.unknown', { status });
  }
}

/** 工具调用状态。 */
export function toolStatusLabel(t: Translate, status: string): string {
  switch (status) {
    case 'ok':
    case 'success':
    case 'succeeded':
    case 'completed':
      return t('workbench.tool.status.ok');
    case 'running':
    case 'pending':
    case 'awaiting_approval':
      return t('workbench.tool.status.running');
    case 'error':
    case 'failed':
      return t('workbench.tool.status.error');
    default:
      return t('statusLabel.status.unknown', { status });
  }
}

/** 审批单状态。 */
export function approvalStatusLabel(t: Translate, status: string): string {
  switch (status) {
    case 'pending':
      return t('workbench.approval.status.pending');
    case 'granted':
    case 'approved':
      return t('workbench.approval.status.granted');
    case 'denied':
      return t('workbench.approval.status.denied');
    case 'consumed':
      return t('workbench.approval.status.consumed');
    case 'expired':
      return t('workbench.approval.status.expired');
    default:
      return t('statusLabel.status.unknown', { status });
  }
}

/** 路由错误：403/404/500/503 的 statusText 换成可读文案，其余走统一兜底。 */
export function routeErrorLabel(t: Translate, status: number | string): string {
  switch (Number(status)) {
    case 403:
      return t('statusLabel.route.403');
    case 404:
      return t('statusLabel.route.404');
    case 500:
      return t('statusLabel.route.500');
    case 503:
      return t('statusLabel.route.503');
    default:
      return t('statusLabel.route.unknown');
  }
}

/** 产物预览失败：只按已知形态归类；原始 error 由调用方收进技术详情。 */
export function artifactPreviewErrorLabel(t: Translate, error: string | null | undefined): string {
  const raw = (error ?? '').toLowerCase();
  if (raw.includes('invalid artifact url') || raw.includes('invalid url')) {
    return t('statusLabel.artifact.invalidUrl');
  }
  if (raw.includes('403') || raw.includes('forbidden')) {
    return t('statusLabel.artifact.forbidden');
  }
  if (raw.includes('404') || raw.includes('not found')) {
    return t('statusLabel.artifact.notFound');
  }
  if (raw.includes('503') || raw.includes('network') || raw.includes('fetch')) {
    return t('statusLabel.artifact.unavailable');
  }
  return t('statusLabel.artifact.failed');
}
