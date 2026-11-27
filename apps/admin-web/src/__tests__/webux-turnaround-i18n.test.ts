/**
 * WEBUX-TURNAROUND：统一状态/错误文案的 i18n 与 zh/en parity。
 * 验收级别：单测 / 内存替身（只查文案表，不触网）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import i18n, { setLanguage } from '../i18n';
import zh from '../locales/zh';
import en from '../locales/en';
import {
  sessionStatusLabel,
  routeErrorLabel,
  artifactPreviewErrorLabel,
} from '../components/workbench/statusLabel';

const t = (key: string, options?: Record<string, unknown>): string =>
  i18n.t(key, options as never) as unknown as string;

afterEach(async () => {
  await setLanguage('zh');
});

describe('统一状态文案', () => {
  it('会话状态在中文/英文下都走 i18n', async () => {
    await setLanguage('zh');
    expect(sessionStatusLabel(t, 'running')).toBe('运行中');
    expect(sessionStatusLabel(t, 'waiting_input')).toBe('等待补充信息');
    expect(sessionStatusLabel(t, 'succeeded')).toBe('已完成');
    await setLanguage('en');
    expect(sessionStatusLabel(t, 'running')).toBe('Running');
    expect(sessionStatusLabel(t, 'waiting_input')).toBe('Waiting for input');
  });

  it('HTTP 403/404/500/503 statusText 转成用户可读文案', async () => {
    await setLanguage('zh');
    expect(routeErrorLabel(t, 403)).toBe('没有访问权限');
    expect(routeErrorLabel(t, 503)).toBe('服务暂时不可用');
    await setLanguage('en');
    expect(routeErrorLabel(t, 404)).toBe('Page not found');
    expect(routeErrorLabel(t, 500)).toBe('Something went wrong on the server');
  });

  it('产物预览错误按已知形态归类，原始英文细节不被当成标题', async () => {
    await setLanguage('zh');
    expect(artifactPreviewErrorLabel(t, 'invalid artifact url')).toBe('产物地址无效');
    expect(artifactPreviewErrorLabel(t, 'Request failed with status 403')).toBe('没有权限预览该产物');
    await setLanguage('en');
    expect(artifactPreviewErrorLabel(t, '404 Not Found')).toBe('Artifact not found');
  });

  it('zh/en 键集合完全 parity', () => {
    const zhKeys = Object.keys(zh).sort();
    const enKeys = Object.keys(en).sort();
    expect(enKeys).toEqual(zhKeys);
  });
});
