import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

type CallbackModule = typeof import('./callback');

const WORK_ADDRESS = 'public-executor:8002';

function loadCallbackModule(mockWorkDir: string): CallbackModule {
  jest.resetModules();
  jest.mock('./admin-client');
  jest.doMock('./config', () => ({
    config: {
      workDir: mockWorkDir,
      executorAddress: 'internal-executor:8002',
      executorAddressPublic: WORK_ADDRESS,
    },
  }));
  jest.mock('./logger', () => ({
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  }));

  return require('./callback') as CallbackModule;
}

/** admin ResponseInterceptor 的信封形状（{code,message,data}）。 */
function envelope(data: unknown) {
  return { data: { code: 200, message: 'success', data } };
}

describe('A6 — 死信目录定期对账', () => {
  let cb: CallbackModule;
  let dir: string;
  let deadDir: string;
  let liveDir: string;
  let get: jest.Mock;
  let post: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-dlrecon-'));
    liveDir = path.join(dir, 'callbacks');
    deadDir = path.join(liveDir, 'dead-letter');
    cb = loadCallbackModule(dir);
    const adminClient = jest.requireMock('./admin-client') as {
      get: jest.Mock;
      post: jest.Mock;
    };
    get = adminClient.get;
    post = adminClient.post;
    get.mockReset();
    post.mockReset().mockResolvedValue({ status: 200 });
  });

  afterEach(() => {
    jest.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** 直接铺一份死信文件（payload + 侧车），绕过 150 轮重发。 */
  function seedDeadLetter(
    name: string,
    executionIds: string[],
    meta?: { poison?: boolean; requeues?: number; deadLetteredAt?: number },
  ): void {
    fs.mkdirSync(deadDir, { recursive: true });
    fs.writeFileSync(
      path.join(deadDir, name),
      JSON.stringify(executionIds.map((executionId) => ({ executionId, status: 'success' }))),
    );
    fs.writeFileSync(
      path.join(deadDir, name + '.deadletter.json'),
      JSON.stringify({
        reason: 'seed',
        poison: meta?.poison ?? false,
        requeues: meta?.requeues ?? 0,
        deadLetteredAt: meta?.deadLetteredAt ?? Date.now(),
      }),
    );
  }

  const deadLetterEntries = (): string[] =>
    fs.existsSync(deadDir) ? fs.readdirSync(deadDir).sort() : [];
  const liveEntries = (): string[] =>
    fs.existsSync(liveDir) ? fs.readdirSync(liveDir).sort() : [];

  it('零死信 → 零请求（对账不是新的心跳）', async () => {
    const res = await cb.reconcileDeadLetters();
    expect(get).not.toHaveBeenCalled();
    expect(res).toEqual({
      scanned: 0,
      deleted: 0,
      requeued: 0,
      kept: 0,
      orphans: 0,
      skipped: 0,
      fetched: -1,
      hasMore: false,
    });
  });

  it('无死信目录时不创建目录（只读动作不凭空造目录）', async () => {
    await cb.reconcileDeadLetters();
    expect(fs.existsSync(deadDir)).toBe(false);
  });

  it('admin 已终态 → payload 与侧车一起删除（回调再发也只会被幂等丢弃）', async () => {
    seedDeadLetter('callback-1.json', ['exec-1']);
    get.mockResolvedValue(
      envelope({
        items: [{ executionId: 'exec-1', status: 'success', endedAt: '2026-09-14T00:00:00.000Z' }],
        hasMore: false,
        serverTime: '2026-09-14T00:00:00.000Z',
      }),
    );
    const res = await cb.reconcileDeadLetters();
    expect(res.deleted).toBe(1);
    expect(res.requeued).toBe(0);
    expect(res.fetched).toBe(1);
    expect(deadLetterEntries()).toEqual([]);
  });

  it('毒丸（超大/坏 JSON）只要已终态也照样清理——这才是对账的正收益', async () => {
    seedDeadLetter('callback-poison.json', ['exec-9'], { poison: true });
    get.mockResolvedValue(
      envelope({ items: [{ executionId: 'exec-9', status: 'failed' }], hasMore: false }),
    );
    const res = await cb.reconcileDeadLetters();
    expect(res.deleted).toBe(1);
    expect(deadLetterEntries()).toEqual([]);
  });

  it('admin 仍未终态 + 非毒丸 → 重新入队，轮数归零、救回次数 +1', async () => {
    seedDeadLetter('callback-2.json', ['exec-2']);
    get.mockResolvedValue(envelope({ items: [], hasMore: false }));
    const res = await cb.reconcileDeadLetters();
    expect(res.requeued).toBe(1);
    expect(res.deleted).toBe(0);
    expect(deadLetterEntries()).toEqual([]);
    expect(liveEntries()).toContain('callback-2.json');
    const meta = JSON.parse(
      fs.readFileSync(path.join(liveDir, 'callback-2.json.meta'), 'utf-8'),
    );
    expect(meta.retries).toBe(0);
    expect(meta.deadLetterRequeues).toBe(1);
  });

  it('未终态但救回次数用尽 → 保留在死信目录（防死信↔重发无限往返）', async () => {
    seedDeadLetter('callback-3.json', ['exec-3'], {
      requeues: cb.DEAD_LETTER_MAX_REQUEUES,
    });
    get.mockResolvedValue(envelope({ items: [], hasMore: false }));
    const res = await cb.reconcileDeadLetters();
    expect(res.requeued).toBe(0);
    expect(res.kept).toBe(1);
    expect(deadLetterEntries()).toContain('callback-3.json');
  });

  it('未终态且是毒丸 → 保留，不重发（重发永远失败）', async () => {
    seedDeadLetter('callback-4.json', ['exec-4'], { poison: true });
    get.mockResolvedValue(envelope({ items: [], hasMore: false }));
    const res = await cb.reconcileDeadLetters();
    expect(res.requeued).toBe(0);
    expect(res.kept).toBe(1);
    expect(deadLetterEntries()).toContain('callback-4.json');
  });

  it('一份 payload 含多个 executionId：只有全部终态才删', async () => {
    seedDeadLetter('callback-multi.json', ['exec-a', 'exec-b']);
    get.mockResolvedValue(
      envelope({ items: [{ executionId: 'exec-a', status: 'success' }], hasMore: false }),
    );
    const res = await cb.reconcileDeadLetters();
    expect(res.deleted).toBe(0);
    expect(res.requeued).toBe(1);
    expect(liveEntries()).toContain('callback-multi.json');
  });

  it('取不到终态清单（admin 不可达）→ 什么都不动，绝不退化成"都没终态"', async () => {
    seedDeadLetter('callback-5.json', ['exec-5']);
    get.mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await cb.reconcileDeadLetters();
    expect(res.fetched).toBe(-1);
    expect(res.deleted).toBe(0);
    expect(res.requeued).toBe(0);
    expect(res.kept).toBe(0);
    expect(deadLetterEntries()).toContain('callback-5.json');
  });

  it.each([
    ['响应形状不对（无 items）', { data: { code: 200, message: 'ok', data: {} } }],
    ['items 不是数组', { data: { code: 200, message: 'ok', data: { items: 'nope' } } }],
    ['data 为空', { data: null }],
  ])('取不到终态清单：%s → 什么都不动', async (_label, response) => {
    seedDeadLetter('callback-6.json', ['exec-6']);
    get.mockResolvedValue(response);
    const res = await cb.reconcileDeadLetters();
    expect(res.fetched).toBe(-1);
    expect(res.deleted).toBe(0);
    expect(res.requeued).toBe(0);
    expect(deadLetterEntries()).toContain('callback-6.json');
  });

  it('裸响应（无信封，旧 admin）也能读', async () => {
    seedDeadLetter('callback-7.json', ['exec-7']);
    get.mockResolvedValue({ data: { items: [{ executionId: 'exec-7', status: 'success' }] } });
    const res = await cb.reconcileDeadLetters();
    expect(res.deleted).toBe(1);
  });

  it('孤儿侧车（payload 已被 TTL 清理）被回收', async () => {
    fs.mkdirSync(deadDir, { recursive: true });
    fs.writeFileSync(
      path.join(deadDir, 'callback-gone.json.deadletter.json'),
      JSON.stringify({ reason: 'x', poison: false, requeues: 0, deadLetteredAt: Date.now() }),
    );
    const res = await cb.reconcileDeadLetters();
    expect(res.orphans).toBe(1);
    expect(deadLetterEntries()).toEqual([]);
  });

  it('请求 URL 对地址做编码、since 取最早死信时间再留余量', async () => {
    const earliest = Date.now() - 60 * 60 * 1000;
    seedDeadLetter('callback-8.json', ['exec-8'], { deadLetteredAt: earliest });
    get.mockResolvedValue(envelope({ items: [], hasMore: false }));
    await cb.reconcileDeadLetters();
    expect(get).toHaveBeenCalledTimes(1);
    const url = get.mock.calls[0][0] as string;
    // 地址含 ':' —— 不编码会破坏路径段。
    expect(url).toContain(`/api/executors/${encodeURIComponent(WORK_ADDRESS)}/terminal-states`);
    expect(url).not.toContain(WORK_ADDRESS + '/terminal-states');
    const sinceRaw = new URLSearchParams(url.split('?')[1]).get('since') ?? '';
    const since = Date.parse(sinceRaw);
    expect(Number.isFinite(since)).toBe(true);
    expect(since).toBeLessThanOrEqual(earliest);
    expect(earliest - since).toBe(cb.DEAD_LETTER_SINCE_SKEW_MS);
  });

  it('hasMore=true 时照常处置已拿到的部分，并如实上报', async () => {
    seedDeadLetter('callback-9.json', ['exec-9']);
    seedDeadLetter('callback-10.json', ['exec-10']);
    get.mockResolvedValue(
      envelope({ items: [{ executionId: 'exec-9', status: 'success' }], hasMore: true }),
    );
    const res = await cb.reconcileDeadLetters();
    expect(res.hasMore).toBe(true);
    expect(res.deleted).toBe(1);
    expect(res.requeued).toBe(1);
  });

  it('死信落盘时 poison 标记真的被写进侧车（重发预算耗尽 → 可救；坏 JSON → 毒丸）', async () => {
    // 坏 JSON → 解析失败 → deadLetterCallbackFile(reason='corrupt payload', poison=true)
    fs.mkdirSync(liveDir, { recursive: true });
    fs.writeFileSync(path.join(liveDir, 'callback-corrupt.json'), '{ not json');
    fs.writeFileSync(
      path.join(liveDir, 'callback-corrupt.json.meta'),
      JSON.stringify({ retries: 0, persistedAt: Date.now() }),
    );
    // 重发预算耗尽 → poison=false
    seedDeadLetter('callback-exhausted.json', ['exec-e']);

    // E-05 门控默认 base 5s（冻结时钟下会把首轮重发整个跳过）——注入 0 恢复
    // "即时重发"语义，与 callback.sharding.spec 同款处理。
    cb.setCallbackReplayBackoffBaseMs(0);
    cb.startCallbackThread();
    await jest.advanceTimersByTimeAsync(2_000);
    const stopping = cb.stopCallbackThread();
    await jest.advanceTimersByTimeAsync(11_000);
    await stopping;

    const corrupt = JSON.parse(
      fs.readFileSync(path.join(deadDir, 'callback-corrupt.json.deadletter.json'), 'utf-8'),
    );
    expect(corrupt.reason).toBe('corrupt payload');
    expect(corrupt.poison).toBe(true);
    expect(typeof corrupt.deadLetteredAt).toBe('number');
  });
});
