/**
 * DSK-03 self-check for updater.ts 的纯函数面（node:assert，无测试框架）。
 * updater.ts 顶部 import electron/electron-updater——selftest 只拷贝/独立验证
 * 纯函数逻辑不可行（模块加载即拉 electron），因此这里以内联副本 + 「与源文件
 * 逐字节一致」双闸守卫：源码漂移时本测试红，提醒同步副本（对齐既有
 * path-domain/token-crypto selftest 形态，见下方 SYNC 注记）。
 * Run via: npm run test:main
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ── SYNC 注记：与 src/main/updater.ts 保持一致的实现副本 ──────────────
// 提取规则：源文件中从「/** 预发布标识排序权重」到「resolveGenericFeedUrl
// 之前的 parseVersion 结束大括号」区间，是纯函数段（无 electron 依赖）。
// 本副本与其不一致时，下方 SYNC_GUARD 断言立即红。

function comparePrerelease(l: string[], r: string[]): number {
  if (l.length === 0 && r.length === 0) return 0;
  // 无预发布段 > 有预发布段（1.0.0 > 1.0.0-alpha）
  if (l.length === 0) return 1;
  if (r.length === 0) return -1;
  const len = Math.max(l.length, r.length);
  for (let i = 0; i < len; i++) {
    const li = l[i];
    const ri = r[i];
    if (li === undefined) return -1; // 更短的一方更小
    if (ri === undefined) return 1;
    const ln = /^\d+$/.test(li);
    const rn = /^\d+$/.test(ri);
    if (ln && rn) {
      const d = Number(li) - Number(ri);
      if (d !== 0) return d > 0 ? 1 : -1;
    } else if (ln !== rn) {
      return ln ? -1 : 1; // 数字段 < 字符串段（semver 规则）
    } else {
      if (li !== ri) return li < ri ? -1 : 1;
    }
  }
  return 0;
}

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  pre: string[];
  cmp(other: ParsedVersion): number;
}

function parseVersion(v: string): ParsedVersion | null {
  if (typeof v !== 'string') return null;
  const m = v.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  const pre = m[4] ? m[4].split('.') : [];
  return {
    major,
    minor,
    patch,
    pre,
    cmp(o: ParsedVersion): number {
      if (major !== o.major) return major > o.major ? 1 : -1;
      if (minor !== o.minor) return minor > o.minor ? 1 : -1;
      if (patch !== o.patch) return patch > o.patch ? 1 : -1;
      return comparePrerelease(pre, o.pre);
    },
  };
}

export function isNewerVersion(a: string, b: string): boolean {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return false;
  if (pa.cmp(pb) !== 0) return pa.cmp(pb) > 0;
  return false;
}

// ── SYNC_GUARD：副本纯函数段必须与 src/main/updater.ts 一致 ───────────
// 从 src/main/updater.ts 提取纯函数段（预发布比较 + parseVersion + isNewerVersion）
// 与上方副本比对，防止两处实现漂移后 selftest 静默失真。
function extractPureSegment(source: string): string {
  const startMarker = '/** 预发布标识排序权重';
  const endMarker = '/** 解析 AUTOUPDATE_URL';
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  assert.ok(start >= 0, 'updater.ts: pure segment start marker not found');
  assert.ok(end > start, 'updater.ts: pure segment end marker not found');
  return source.slice(start, end);
}

// 副本中的可执行段：从 comparePrerelease 定义到 SYNC_GUARD 注释前的全部
// （与源文件提取段同构：comparePrerelease + parseVersion + isNewerVersion）
function extractCopySegment(source: string): string {
  const start = source.indexOf('function comparePrerelease');
  const end = source.indexOf('// ── SYNC_GUARD');
  assert.ok(start >= 0, 'selftest: copy segment start marker not found');
  assert.ok(end > start, 'selftest: copy segment end marker not found');
  return source.slice(start, end);
}

function main(): void {
  // selftest 产物位于 apps/executor-desktop/dist-selftest/，源码在其上级 src/
  const srcPath = path.join(__dirname, '..', 'src', 'main', 'updater.ts');
  const source = fs.readFileSync(srcPath, 'utf-8');
  const pure = extractPureSegment(source);

  // 副本段与源提取段做同构归一化（去空白/去 JSDoc/去 export）后逐字符比对。
  // 副本段多出 isNewerVersion 自身（源提取段以 parseVersion 结束）——归一化时
  // 从副本段裁掉 isNewerVersion 定义（其行为由下方断言直接验证），
  // SYNC_GUARD 只防 comparePrerelease/parseVersion 两处实现漂移。
  const normalize = (s: string): string =>
    s
      .replace(/\/\*\*[\s\S]*?\*\//g, '') // JSDoc
      .replace(/\/\/[^\n]*/g, '') // 行注释
      .replace(/\bexport\s+/g, '')
      .replace(/\s+/g, '');

  let copyPure = normalize(extractCopySegment(main_copySource));
  // 裁掉副本段尾部的 isNewerVersion 定义（源提取段不含它）
  const ivIdx = copyPure.indexOf('functionisNewerVersion');
  if (ivIdx >= 0) copyPure = copyPure.slice(0, ivIdx);
  assert.equal(
    copyPure,
    normalize(pure),
    'updater selftest copy is out of sync with src/main/updater.ts — ' +
      'update the pure-function copy in updater.selftest.ts',
  );

  // ── 严格升级语义 ──────────────────────────────────────────
  assert.equal(isNewerVersion('1.0.1', '1.0.0'), true, 'patch bump');
  assert.equal(isNewerVersion('1.1.0', '1.0.9'), true, 'minor bump');
  assert.equal(isNewerVersion('2.0.0', '1.9.9'), true, 'major bump');
  assert.equal(isNewerVersion('1.0.0', '1.0.0'), false, 'equal → false');
  assert.equal(isNewerVersion('1.0.0', '1.0.1'), false, 'downgrade → false');
  assert.equal(isNewerVersion('0.9.9', '1.0.0'), false, 'downgrade major → false');

  // v 前缀容错（GitHub tag 形态）
  assert.equal(isNewerVersion('v1.2.3', '1.2.2'), true, 'v-prefix remote');
  assert.equal(isNewerVersion('1.2.3', 'v1.2.2'), true, 'v-prefix local');

  // 预发布段语义（semver：pre < 正式版；同 pre 通道内比数字/字典序）
  assert.equal(isNewerVersion('1.1.0-alpha.1', '1.1.0-alpha.0'), true, 'pre numeric bump');
  assert.equal(isNewerVersion('1.1.0-alpha.2', '1.1.0-alpha.10'), false, 'pre numeric compare (2 < 10)');
  assert.equal(isNewerVersion('1.1.0', '1.1.0-alpha.1'), true, 'release > prerelease');
  assert.equal(isNewerVersion('1.1.0-alpha.1', '1.1.0'), false, 'prerelease < release');
  assert.equal(isNewerVersion('1.1.0-beta', '1.1.0-alpha'), true, 'pre lexicographic');

  // 非法输入绝不触发升级
  assert.equal(isNewerVersion('', '1.0.0'), false, 'empty remote');
  assert.equal(isNewerVersion('latest', '1.0.0'), false, 'non-semver remote');
  assert.equal(isNewerVersion('1.0', '1.0.0'), false, 'two-segment remote');
  assert.equal(isNewerVersion('1.0.0', ''), false, 'empty local');
  assert.equal(isNewerVersion('abc', 'def'), false, 'both garbage');
  assert.equal(isNewerVersion(undefined as any, '1.0.0'), false, 'undefined remote');
  assert.equal(isNewerVersion(42 as any, '1.0.0'), false, 'number remote');

  console.log('updater selftest: all assertions passed (pure segment in sync)');
}

// 副本源码引用（SYNC_GUARD 比对用）：读 selftest 自身的 TS 源做归一化比对。
const main_copySource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'main', 'updater.selftest.ts'),
  'utf-8',
);

main();
