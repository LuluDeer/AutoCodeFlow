/**
 * UX-11（本轮体验审查）：错误提示绕过全站归一器，直接取 `e.message`。
 *
 * 缺陷：`ExecutorDetailPage` 的 `setOfflineMut.onError` 写的是
 *   `message.error(t('...', { err: e.message }))`
 * 而同一文件上方两处（rotate / remove）用的是正确的 `getErrMsg(e, ...)`。
 *
 * 为什么直接取 `e.message` 是缺陷而不是风格差异：
 *  ① 全站 API 层是 axios。axios 错误的 `message` 是
 *     **"Request failed with status code 400"** 这类英文技术串，而后端写给
 *     用户看的原因在 `response.data.message`（如「执行器正在运行任务，无法
 *     置为离线」）。用户看到的是"系统报错了"而不是"为什么错、该怎么办"。
 *  ② 同一产品里两套错误文案：同一次操作失败，本页英文技术串，别的页中文业务
 *     原因——本轮 UX 系列修的正是这类"不一致"。
 *  ③ `e` 若是非 Error 值（reject 了字符串/普通对象），`e.message` 是
 *     `undefined`，页面上会直接出现 "undefined"。
 *
 * 修法：改用 utils/error.ts 的 `getErrMsg(e)`（本文件已导入、上方两处已在用）。
 *
 * 本守卫是**全仓扫描**而非只钉这一处：同样的写法在任何页面都会产生同样的
 * 用户可见问题，钉死一处挡不住下次在别处重写。用正则扫所有非测试源码里
 * 「在 message.error/notification.error 里直接取 x.message」的形态。
 *
 * 反证：把 ExecutorDetailPage 那行改回 `{ err: e.message }`，本文件变红。
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '..');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === '__tests__' || entry === 'e2e' || entry === 'node_modules') continue;
      out.push(...walk(p));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(p);
    }
  }
  return out;
}

/** 去掉注释与字符串字面量，避免注释里举例的旧写法被判违规。 */
function stripNoise(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const FILES = walk(SRC);

describe('UX-11：错误提示必须走 getErrMsg，不得自己拼 .message', () => {
  it('全仓不存在「message.error(... x.message ...)」形态', () => {
    const offenders: string[] = [];
    // 目标形态：用户可见的错误提示里，插值直接取某个变量的 .message
    const re = /(?:message|notification)\.error\([^;]*?\b[A-Za-z_$][\w$]*\??\.message\b/g;
    for (const f of FILES) {
      const src = stripNoise(readFileSync(f, 'utf-8'));
      for (const m of src.matchAll(re)) {
        offenders.push(`${relative(SRC, f).replace(/\\/g, '/')}: ${m[0].slice(0, 120)}`);
      }
    }
    expect(offenders, `直接取 .message 的错误提示：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('有齿校验：两条正则确实能匹配到被修的旧写法', () => {
    // 防止正则写坏导致上面那条恒真（空洞通过）。
    const re1 = /(?:message|notification)\.error\([^;]*?\b[A-Za-z_$][\w$]*\??\.message\b/g;
    const old1 = "message.error(t('executorDetail.offline.offlineFail', { err: e.message }));";
    expect([...old1.matchAll(re1)].length).toBeGreaterThanOrEqual(1);
    // 新写法不得被匹配
    expect([...("message.error(t('x', { err: getErrMsg(e) }));").matchAll(re1)].length).toBe(0);

    // 第二条：手写 `x instanceof Error ? x.message : ...` 也是绕过归一
    const re2 = /(?:message|notification)\.error\(\s*[A-Za-z_$][\w$]*\s+instanceof\s+Error/g;
    const old2 = "message.error(err instanceof Error ? err.message : t('taskForm.validate.fail'));";
    expect([...old2.matchAll(re2)].length).toBeGreaterThanOrEqual(1);
    expect(
      [...("message.error(getErrMsg(err, t('taskForm.validate.fail')));").matchAll(re2)].length,
    ).toBe(0);
  });

  it('全仓不存在「message.error(x instanceof Error ? ... : ...)」形态', () => {
    const offenders: string[] = [];
    const re = /(?:message|notification)\.error\(\s*[A-Za-z_$][\w$]*\s+instanceof\s+Error/g;
    for (const f of FILES) {
      const src = stripNoise(readFileSync(f, 'utf-8'));
      for (const m of src.matchAll(re)) {
        offenders.push(`${relative(SRC, f).replace(/\\/g, '/')}: ${m[0].slice(0, 100)}`);
      }
    }
    expect(
      offenders,
      `手写 instanceof Error 分支的错误提示（应改用 getErrMsg）：\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('ExecutorDetailPage 三处 onError 全部走 getErrMsg', () => {
    const page = stripNoise(readFileSync(join(SRC, 'pages', 'ExecutorDetailPage.tsx'), 'utf-8'));
    const errs = [...page.matchAll(/onError:\s*\(e\)\s*=>\s*\{[^}]*\}/g)].map((m) => m[0]);
    expect(errs.length).toBeGreaterThanOrEqual(3); // 有齿：确实扫到了多处
    for (const e of errs) {
      expect(e, `未经 getErrMsg 的 onError：${e}`).toContain('getErrMsg(');
    }
  });
});
