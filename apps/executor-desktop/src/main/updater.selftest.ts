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

// ── 4.2 副本：releaseNotes 归一化 + 封顶 ──────────────────────────────
// 与 src/main/updater.ts 的 normalizeReleaseNotes / sanitizeReleaseNoteText
// 逐字同构。**刻意放在 SYNC_GUARD 的提取区间之外**（源文件的提取段是
// 「预发布标识排序权重 → 解析 AUTOUPDATE_URL」，releaseNotes 段在其后），
// 否则 comparePrerelease 段的逐字符比对会因为多出这一整块而红。
// 两块实现的一致性由下方 RELEASE_NOTES SYNC 守卫单独钉住。
export const RELEASE_NOTES_MAX_CHARS = 4_000;

export function normalizeReleaseNotes(raw: unknown): string {
  try {
    const blocks: string[] = [];
    if (typeof raw === 'string') {
      blocks.push(raw);
    } else if (Array.isArray(raw)) {
      for (const item of raw) {
        if (item === null || typeof item !== 'object') continue;
        const entry = item as { version?: unknown; note?: unknown };
        const note = typeof entry.note === 'string' ? entry.note : '';
        if (note.trim() === '') continue;
        const version = typeof entry.version === 'string' ? entry.version.trim() : '';
        blocks.push(version ? `v${version}\n${note}` : note);
      }
    } else {
      return '';
    }

    const cleaned = blocks
      .map((block) => sanitizeReleaseNoteText(block))
      .filter((block) => block !== '');
    if (cleaned.length === 0) return '';

    const joined = cleaned.join('\n\n');
    if (joined.length <= RELEASE_NOTES_MAX_CHARS) return joined;
    return `${joined.slice(0, RELEASE_NOTES_MAX_CHARS - 1)}…`;
  } catch {
    return '';
  }
}

function sanitizeReleaseNoteText(text: string): string {
  return text
    // <script>/<style> 整块（含内容）删除——只删标签会把 `alert(1)` 或整段 CSS
    // 当成正文留在横幅里。这里不做 HTML 解析，但这两个标签的内容永远不是
    // 人类可读的更新说明，整块丢弃比留下更接近"纯文本"的目标。
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    // 块级/换行标签 → 换行（在删标签之前处理，否则段落边界丢失）
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|li|div|h[1-6]|tr)>/gi, '\n')
    // 其余标签整段删除（含属性里的引号内容）
    .replace(/<[^>]*>/g, '')
    // HTML 实体：只处理最常见的四个，其余保持原样（不赌完整实体表）
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    // 控制字符（含 \r、\t 之外）一律清掉，防止不可见字符撑乱布局
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  ')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 副本 releaseNotes 段（供 RELEASE_NOTES SYNC 守卫与源文件同构比对）。
function extractCopyNotesSegment(source: string): string {
  const start = source.indexOf('export function normalizeReleaseNotes');
  const end = source.indexOf('// 副本 releaseNotes 段');
  assert.ok(start >= 0, 'selftest: notes copy start marker not found');
  assert.ok(end > start, 'selftest: notes copy end marker not found');
  return source.slice(start, end);
}

// 源文件 releaseNotes 段（同一对函数，位于 resolveGenericFeedUrl 之后）。
function extractSourceNotesSegment(source: string): string {
  const start = source.indexOf('export function normalizeReleaseNotes');
  const end = source.indexOf('// NETOPT-C P3: updater:error');
  assert.ok(start >= 0, 'updater.ts: notes segment start marker not found');
  assert.ok(end > start, 'updater.ts: notes segment end marker not found');
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

  // ── D2-P2-4: generic feed 只允许 https: ──────────────────────
  // 复刻 resolveGenericFeedUrl 的协议白名单（updater.ts 不可直接 import——
  // 模块加载即拉 electron）。这里既跑行为断言，又结构守卫源文件确实含
  // http: 拒绝分支，防止后续改动静默放开 http:。
  const feedProtocolGuard = (raw: string | undefined): string | null => {
    if (!raw || raw.trim() === '') return null;
    try {
      const u = new URL(raw.trim());
      if (u.protocol === 'http:') return null; // D2-P2-4 拒绝
      if (u.protocol !== 'https:') return null;
      return u.toString();
    } catch {
      return null;
    }
  };
  assert.equal(
    feedProtocolGuard('https://updates.example.com/feed/latest.yml'),
    'https://updates.example.com/feed/latest.yml',
    'D2-P2-4: https feed accepted',
  );
  assert.equal(
    feedProtocolGuard('http://updates.example.com/feed/latest.yml'),
    null,
    'D2-P2-4: http feed rejected (no signature fallback on Linux)',
  );
  assert.equal(feedProtocolGuard(''), null, 'D2-P2-4: empty feed → null');
  assert.equal(feedProtocolGuard(undefined), null, 'D2-P2-4: unset feed → null');
  assert.equal(feedProtocolGuard('ftp://updates.example.com/x'), null, 'D2-P2-4: non-http(s) → null');
  // 结构守卫：源文件必须保留 http: 拒绝分支。
  assert.ok(
    source.includes("u.protocol === 'http:'") && source.includes('refusing insecure http:'),
    'D2-P2-4: updater.ts lost the http: generic-feed rejection branch',
  );

  // ── 审计二轮 B-7①: 周期自检（结构守卫）────────────────────────
  // updater.ts 拉不起 electron，行为锁放在 updater-runcheck.selftest.ts 的
  // createPeriodicCheck 状态机用例；这里守卫接线本身不被静默拆除：
  //   · 6h 周期常量存在；
  //   · initUpdater 用周期调度器启动（首轮 delay + interval 重挂）；
  //   · 旧「启动 30s 检查一次」的一次性 setTimeout 接线已移除。
  assert.ok(
    source.includes('UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000'),
    'B-7①: updater.ts lost the 6h UPDATE_CHECK_INTERVAL_MS constant',
  );
  assert.ok(
    source.includes('createPeriodicCheck') &&
      source.includes('periodicCheck.start(UPDATE_CHECK_DELAY_MS, UPDATE_CHECK_INTERVAL_MS)'),
    'B-7①: updater.ts must start the periodic check (delay + interval re-arm)',
  );
  assert.ok(
    !source.includes('checkTimer = setTimeout'),
    'B-7①: one-shot checkTimer wiring must stay removed',
  );


  // ══════════════════════════════════════════════════════════════════════
  // 4.2 更新日志展示：releaseNotes 的归一化 + 封顶 + 载荷接线
  // ══════════════════════════════════════════════════════════════════════
  // 副本与 SYNC_GUARD 同款处境：updater.ts 顶层 import electron，行为只能靠
  // 下方副本验证，再以「源文件必须包含同样的实现锚点」做接线守卫。
  {
    // ⓪ RELEASE_NOTES SYNC：副本的 normalizeReleaseNotes + sanitizeReleaseNoteText
    //    必须与源文件逐字同构（归一化后比对，同 SYNC_GUARD 的做法）。
    {
      const copyNotes = extractCopyNotesSegment(main_copySource);
      const sourceNotes = extractSourceNotesSegment(source);
      assert.equal(
        normalize(copyNotes),
        normalize(sourceNotes),
        '4.2: updater.selftest.ts 的 releaseNotes 副本与 src/main/updater.ts 不同步 —— ' +
          '改一处必须改两处（或改为直接 import）',
      );
    }

    // ① 字符串形态：原样规整（去首尾空白）
    assert.equal(
      normalizeReleaseNotes('  - 修复登录超时\n- 新增诊断导出  '),
      '- 修复登录超时\n- 新增诊断导出',
      '4.2: 字符串形态必须原样保留（仅去首尾空白）',
    );
    // ② null/undefined/脏值 → 空串（不是错误，渲染层按空串隐藏入口）
    for (const empty of [null, undefined, 42, {}, [], [null], [{ version: '1.0.0' }]]) {
      assert.equal(
        normalizeReleaseNotes(empty),
        '',
        `4.2: ${JSON.stringify(empty)} 必须归一成空串（无日志 ≠ 错误）`,
      );
    }
    // ③ 数组形态（updater.fullChangelog=true）：带版本小标题、note 为 null 的跳过
    assert.equal(
      normalizeReleaseNotes([
        { version: '1.9.0', note: '修复 A' },
        { version: '1.8.0', note: '新增 B' },
        { version: '1.7.0', note: null },
      ]),
      'v1.9.0\n修复 A\n\nv1.8.0\n新增 B',
      '4.2: 数组形态必须逐版本加 v 标题拼接，note=null 的版本跳过',
    );
    // ④ 数组里的脏元素（字符串/数字/null）必须被忽略而不是炸掉
    assert.equal(
      normalizeReleaseNotes(['junk', 42, null, { version: '2.0.0', note: 'ok' }]),
      'v2.0.0\nok',
      '4.2: 数组里的非对象元素必须被跳过',
    );
    // ⑤ HTML 标签必须剥掉（内容来自 GitHub Releases，是不可信外部输入；
    //    渲染层只做文本渲染，主进程这一层是第二道防线）
    assert.equal(
      normalizeReleaseNotes('<p>修复 <b>登录</b> 超时</p><script>alert(1)</script>'),
      '修复 登录 超时',
      '4.2: HTML 标签必须剥除（含 <script>——XSS 防线第一层）',
    );
    assert.equal(
      normalizeReleaseNotes('第一行<br>第二行'),
      '第一行\n第二行',
      '4.2: <br> 必须转成换行（否则段落黏成一行）',
    );
    // ⑥ 实体解码：&lt; &gt; &amp; &nbsp;（只处理最常见的四个）
    assert.equal(
      normalizeReleaseNotes('a &lt;b&gt; &amp; c&nbsp;d'),
      'a <b> & c d',
      '4.2: 常见 HTML 实体必须解码',
    );
    // ⑦ 控制字符清除 + CRLF 归一 + 连续空行压缩
    assert.equal(
      normalizeReleaseNotes('a\u0000b\r\n\r\n\r\n\r\nc'),
      'ab\n\nc',
      '4.2: 控制字符清除、CRLF 归一、连续空行压成一个',
    );
    // ⑧ **封顶**：超长日志必须截断到 RELEASE_NOTES_MAX_CHARS 以内
    {
      const huge = 'x'.repeat(RELEASE_NOTES_MAX_CHARS * 3);
      const out = normalizeReleaseNotes(huge);
      assert.ok(
        out.length <= RELEASE_NOTES_MAX_CHARS,
        `4.2: 超长 release notes 必须封顶到 ${RELEASE_NOTES_MAX_CHARS} 字符以内（实际 ${out.length}）`,
      );
      assert.ok(
        out.endsWith('…'),
        '4.2: 截断必须留省略标记（用户要知道"还有更多"而不是以为就这么短）',
      );
      // 边界：恰好等于上限时不截断、不加省略号
      const exact = 'y'.repeat(RELEASE_NOTES_MAX_CHARS);
      assert.equal(
        normalizeReleaseNotes(exact),
        exact,
        '4.2: 恰好等于上限时不得截断（> 而非 >=）',
      );
    }
    // ⑨ 常量本身：太小展示不了要点，太大撑爆横幅/IPC 载荷
    assert.ok(
      RELEASE_NOTES_MAX_CHARS >= 1_000 && RELEASE_NOTES_MAX_CHARS <= 16_000,
      `4.2: RELEASE_NOTES_MAX_CHARS（${RELEASE_NOTES_MAX_CHARS}）必须在 1k–16k 的合理区间`,
    );
  }

  // ── 4.2 接线守卫：源文件必须把 releaseNotes 带进 available 载荷 ──────
  {
    assert.ok(
      source.includes('normalizeReleaseNotes('),
      '4.2: updater.ts 的 update-available 分支必须调用 normalizeReleaseNotes',
    );
    assert.ok(
      // F-37（UIUX 审计）跟进：available 广播载荷抽成 lastAvailableBroadcast
      // 对象（取消下载后原样重发让横幅回 available），锚点同步为「载荷对象
      // 含 releaseNotes 字段 + broadcast 走该载荷」——意图不变：渲染层必须
      // 收到 normalizeReleaseNotes 产物的 releaseNotes。
      /lastAvailableBroadcast\s*=\s*\{[\s\S]{0,400}?releaseNotes[\s\S]{0,100}?\}/.test(source) &&
        /broadcast\(\s*UPDATE_EVENTS\.available\s*,\s*lastAvailableBroadcast\s*\)/.test(source),
      '4.2: updater:available 的广播载荷必须包含 releaseNotes 字段（F-37 起经 lastAvailableBroadcast 载荷）',
    );
    assert.ok(
      source.includes('export const RELEASE_NOTES_MAX_CHARS'),
      '4.2: updater.ts 必须导出 RELEASE_NOTES_MAX_CHARS（封顶值可被测试与渲染层引用）',
    );
    // 不得把原始 note 直接塞进载荷（绕过归一化 = 未剥 HTML + 未封顶）
    assert.ok(
      !/broadcast\(\s*UPDATE_EVENTS\.available[\s\S]{0,400}?info\.releaseNotes/.test(source),
      '4.2: available 载荷不得直接使用 info.releaseNotes（必须经 normalizeReleaseNotes）',
    );
    // preload 契约必须与主进程一致（漏字段 = 渲染层永远收不到更新日志）
    const preloadSrc = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'preload', 'index.ts'),
      'utf-8',
    );
    assert.ok(
      /onUpdateAvailable[\s\S]{0,400}?releaseNotes/.test(preloadSrc),
      '4.2: preload 的 onUpdateAvailable 载荷类型必须包含 releaseNotes（类型漂移）',
    );
  }

  console.log(
    'updater selftest: all assertions passed (pure segment in sync, ' +
      `releaseNotes normalization + ${RELEASE_NOTES_MAX_CHARS}-char cap)`,
  );
}

// 副本源码引用（SYNC_GUARD 比对用）：读 selftest 自身的 TS 源做归一化比对。
const main_copySource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'main', 'updater.selftest.ts'),
  'utf-8',
);

main();
