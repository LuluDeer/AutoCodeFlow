/**
 * UX-DSK-PORT self-check：心跳端口的合法化（node:assert，无测试框架）。
 * Run via: npm run test:main
 *
 * 反证过的真实故障：`HeartbeatMonitor.start(port)` 原样保存渲染层送来的端口，
 * 而端口来自设置页 `<input type="number">` 的 `parseInt()`——清空输入框得到
 * NaN。于是 `http.get('http://127.0.0.1:NaN/health/live')` 在**构造 URL 时
 * 同步抛出 ERR_INVALID_URL**：它不走 'error' 事件，而是直接 throw，抛点在
 * setInterval 回调里 → 未捕获异常 → 每 10s 抛一次，failCount 永不推进，
 * 托盘状态永远停在 online/pending（"显示在线、实际已死"）。
 *
 * F-3（中台↔执行器深度审查）：admin 直达探针的 URL 合法化同款反证——
 * `normalizeAdminProbeUrl` 把设置页脏值（非 http(s)、无 host、无法 parse）
 * 收敛为 null（跳过 admin 探针），绝不让 http.get 在 setInterval 回调里同步
 * 抛出。副本 + SYNC 守卫与端口归一化同款。
 *
 * 本测试用**真实的 http 模块**证明两件事：
 *   1. 未消毒的 NaN 端口确实会让 http.get 同步抛出（反证有牙）；
 *   2. 消毒后的回调不会抛，且端口落在合法区间。
 * 由于 heartbeat.ts 顶层 import electron-log（裸 node 下加载即崩），这里采用
 * 与 updater.selftest.ts 相同的副本 + SYNC 守卫形态。
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

// ── SYNC：与 src/main/heartbeat.ts 的 normalizeHeartbeatPort 等价实现 ──
const DEFAULT_PORT = 8002;

function normalizeHeartbeatPort(port: unknown): number {
  const n = typeof port === 'number' ? port : parseInt(String(port ?? ''), 10);
  if (!Number.isFinite(n)) return DEFAULT_PORT;
  const i = Math.round(n);
  if (i < 1 || i > 65535) return DEFAULT_PORT;
  return i;
}

/** 复刻 heartbeat.ts 的 normalizeAdminProbeUrl（F-3 admin 探针 URL 消毒）。 */
function normalizeAdminProbeUrl(url: unknown): string | null {
  if (typeof url !== 'string' || !url.trim()) return null;
  const trimmed = url.trim();
  // F-3 残差：`https:///path` 这种「空 authority」会被 WHATWG 解析成单标签
  // 主机名（hostname='path'），空 hostname 判定抓不到。显式拒绝 `scheme:///`
  // 形态——它不是可探针的地址，按 F-3 语义回落 null。
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/\//.test(trimmed)) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.hostname) return null;
  return parsed.toString().replace(/\/+$/, '');
}

/** 复刻 heartbeat.ts 里构造探测 URL 的那一行（故障现场）。 */
function buildProbeUrl(port: unknown): string {
  return `http://127.0.0.1:${port}/health/live`;
}

function main(): void {
  // ── 1. 反证：未消毒的 NaN 端口会让 http.get **同步抛出** ─────────────
  {
    let threw: Error | null = null;
    try {
      http.get(buildProbeUrl(NaN), { timeout: 100 }, () => undefined)
        .on('error', () => undefined);
    } catch (err) {
      threw = err as Error;
    }
    assert.ok(
      threw,
      'NaN 端口必须让 http.get 同步抛出（否则本反证无牙——那就是另一回事了）',
    );
    assert.match(
      String((threw as NodeJS.ErrnoException)?.code ?? ''),
      /ERR_INVALID_URL|ERR_INVALID_ARG_TYPE|ERR_SOCKET_BAD_PORT/,
      `应以 URL/端口非法为因，实际：${(threw as NodeJS.ErrnoException)?.code} ${threw?.message}`,
    );
  }

  // ── 2. 消毒后：同一调用不得抛，且端口合法 ─────────────────────────────
  {
    for (const bad of [NaN, Infinity, -Infinity, null, undefined, '', 'abc', 0, -1, 99999]) {
      const p = normalizeHeartbeatPort(bad);
      assert.ok(
        Number.isInteger(p) && p >= 1 && p <= 65535,
        `${JSON.stringify(bad)} 消毒后必须落在 1–65535，实际 ${p}`,
      );
      // 消毒后的端口必须能安全构造 URL 并发出请求（不抛）
      let threw: Error | null = null;
      let req: http.ClientRequest | null = null;
      try {
        req = http.get(buildProbeUrl(p), { timeout: 100 }, (res) => res.resume());
        req.on('error', () => undefined); // 连接失败属正常（本机没跑执行器）
      } catch (err) {
        threw = err as Error;
      }
      assert.strictEqual(threw, null, `消毒后的端口 ${p} 不得让 http.get 抛出：${threw?.message}`);
      req?.destroy();
    }

    // 合法端口原样保留（不得被"归一化"改写）
    assert.strictEqual(normalizeHeartbeatPort(8002), 8002, '默认端口原样');
    assert.strictEqual(normalizeHeartbeatPort(9001), 9001, '自定义端口原样');
    assert.strictEqual(normalizeHeartbeatPort('9001'), 9001, '数字字符串解析');
    // 回落语义：非法一律回落到默认端口（而不是 0 / 1 这种"看似合法"的值）
    for (const bad of [NaN, null, undefined, '', 'abc', 0, 99999, -5]) {
      assert.strictEqual(
        normalizeHeartbeatPort(bad),
        DEFAULT_PORT,
        `${JSON.stringify(bad)} 必须回落 ${DEFAULT_PORT}`,
      );
    }
  }

  // ── 3. SYNC 守卫：heartbeat.ts 必须真的调用该归一化 ──────────────────
  {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'main', 'heartbeat.ts'),
      'utf-8',
    );
    assert.ok(
      src.includes('normalizeHeartbeatPort('),
      'SYNC: heartbeat.ts 未定义/未使用 normalizeHeartbeatPort',
    );
    // start() 里必须用它包住入参（只定义不调用 = 修了个寂寞）
    const startBlock = src.slice(src.indexOf('start(port: number'));
    assert.ok(
      /this\.port\s*=\s*normalizeHeartbeatPort\(/.test(startBlock),
      'SYNC: HeartbeatMonitor.start() 必须把端口过一遍 normalizeHeartbeatPort',
    );
    // F-3: start() 必须把 adminApiUrl 过一遍 normalizeAdminProbeUrl
    assert.ok(
      /this\.adminApiUrl\s*=\s*normalizeAdminProbeUrl\(/.test(startBlock),
      'SYNC: HeartbeatMonitor.start() 必须把 adminApiUrl 过一遍 normalizeAdminProbeUrl',
    );
    // 副本与源实现必须逐字符同构（防两处漂移）。
    // 用"匹配到配对的收尾大括号"截出函数体，避免 slice 到下一个声明。
    const normalize = (s: string): string =>
      s.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').replace(/\s+/g, '');
    const extractFn = (text: string, header: string): string => {
      const start = text.indexOf(header);
      assert.ok(start >= 0, `找不到函数头：${header}`);
      let depth = 0;
      let i = text.indexOf('{', start);
      for (; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') {
          depth--;
          if (depth === 0) return text.slice(start, i + 1);
        }
      }
      throw new Error(`函数体未闭合：${header}`);
    };
    const copy = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'main', 'heartbeat.selftest.ts'),
      'utf-8',
    );
    assert.equal(
      normalize(extractFn(copy, 'function normalizeHeartbeatPort')),
      normalize(extractFn(src, 'function normalizeHeartbeatPort')),
      'heartbeat selftest 副本与 src/main/heartbeat.ts 实现漂移',
    );
    assert.equal(
      normalize(extractFn(copy, 'function normalizeAdminProbeUrl')),
      normalize(extractFn(src, 'function normalizeAdminProbeUrl')),
      'heartbeat selftest 的 normalizeAdminProbeUrl 副本与实现漂移',
    );
  }

  // ── 4. F-3：normalizeAdminProbeUrl 的合法化语义 ───────────────────────
  {
    // 合法 http(s) URL 保留（尾部斜杠归一化）
    assert.strictEqual(
      normalizeAdminProbeUrl('http://admin.example.com:3000'),
      'http://admin.example.com:3000',
      '合法 http URL 原样',
    );
    assert.strictEqual(
      normalizeAdminProbeUrl(' https://admin.example.com/ '),
      'https://admin.example.com',
      'https URL 去空白 + 去尾部斜杠',
    );
    // 非法一律回落 null（调用方跳过 admin 探针，绝不抛）
    for (const bad of [null, undefined, '', '   ', 42, 'not-a-url', 'ftp://x', 'http://', 'https:///path']) {
      assert.strictEqual(
        normalizeAdminProbeUrl(bad),
        null,
        `${JSON.stringify(bad)} 必须回落 null`,
      );
    }
  }

  // ── 5. EXP-03：心跳只能经 startHeartbeat() 启动（防再次漏传 adminApiUrl）──
  {
    const read = (rel: string): string =>
      fs.readFileSync(path.join(__dirname, '..', 'src', 'main', rel), 'utf-8');

    // 唯一入口必须存在且把两个参数都传上。
    const handlers = read('ipc-handlers.ts');
    assert.ok(
      /export function startHeartbeat\(/.test(handlers),
      'EXP-03: ipc-handlers.ts 必须导出 startHeartbeat()（全仓唯一心跳启动入口）',
    );
    const fnBody = handlers.slice(handlers.indexOf('export function startHeartbeat('));
    const fn = fnBody.slice(0, fnBody.indexOf('\n}') + 2);
    assert.ok(
      /heartbeat\.start\(/.test(fn) && /adminApiUrl/.test(fn),
      'EXP-03: startHeartbeat() 必须把 adminApiUrl 一起传给 heartbeat.start()'
      + '——只传端口会让中台直达探针静默失效（F-3 修的正是这个）',
    );

    // 生产代码里不得再出现任何"直接调 heartbeat.start(...)"的第二条路径：
    // F-3 给 start() 加了 adminApiUrl 参数后，全仓 5 处调用点只有 1 处传了它，
    // 漏传的恰好是用户最常走的路径（开机自启 / 点启动 / 改配置保存），
    // 于是中台直达探针形同虚设。收敛为单一入口后再加参数就不会漏。
    for (const rel of ['ipc-handlers.ts', 'index.ts']) {
      const src = read(rel);
      // 去掉注释，避免注释里引用的旧写法被判违规
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      // startHeartbeat() 内部那一处是**唯一**允许的直接调用（在 ipc-handlers 里）
      const direct = [...code.matchAll(/heartbeat\.start\(/g)].length;
      const allowed = rel === 'ipc-handlers.ts' ? 1 : 0;
      assert.strictEqual(
        direct,
        allowed,
        `EXP-03: ${rel} 里出现了 ${direct} 处 heartbeat.start() 直接调用`
        + `（应为 ${allowed} 处）——请改用 startHeartbeat()，`
        + '否则新加的心跳参数会再次在某些路径上漏传',
      );
    }
  }

  console.log('heartbeat selftest: all assertions passed (NaN port → no uncaught throw; admin probe URL sanitized; EXP-03 single start entrypoint)');
}

main();
