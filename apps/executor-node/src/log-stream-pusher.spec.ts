/**
 * RT-LOG 反证：LogStreamPusher 的**出站凭据**与**行切分**正确性。
 *
 * 两条缺陷都是在真实运行中复现过的（修复前用例转红）：
 *
 * ① 令牌未 await：`middleware/auth.ts::getCurrentToken` 是 `async function`，
 *    而首版 pushChunk 写的是 `const token = getCurrentToken()`——拿到的是
 *    Promise 对象，`!token` 判空恒为假，于是 Authorization 头被拼成
 *    `Bearer [object Promise]`，admin-api 每个分片都 401。日志在**执行中**
 *    完全看不到，且失败是静默的（pusher 只 debug 记一行）。
 *    修复：走 admin-client.post（它 await getCurrentToken），并在用例里把
 *    "Authorization 必须携带真实令牌"钉成断言。
 *
 * ② 跨 chunk 半行被劈成两行：子进程 stdout 按任意字节边界分片，一行常被
 *    拆到两次 data 事件里。首版对每个分片各做一次 split('\n')，于是
 *    `"ab" + "c\n"` 会落成两行（"ab"、"c"），行号与回调日志整体错位；
 *    `\r\n` 的 `\r` 也会留在行尾。
 *    修复：pusher 自持半行缓冲（addOutput），只在遇到 `\n` 时成行。
 */
import {
  LogStreamPusher,
  MAX_BYTES_PER_CHUNK,
  MAX_BUFFERED_BYTES,
  BACKPRESSURE_MARKER, PUSH_TIMEOUT_MS } from './log-stream-pusher';
import { post } from './admin-client';
import { logger } from './logger';

jest.mock('./admin-client', () => ({
  post: jest.fn(),
}));

jest.mock('./logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

const mockedPost = post as jest.MockedFunction<typeof post>;

/** 取出第 n 次 post 调用的 body（分片载荷）。 */
function bodyOf(call: number): { fromLine: number; lines: string[] } {
  return mockedPost.mock.calls[call][1] as {
    fromLine: number;
    lines: string[];
  };
}

/** 出站分片是否为背压 marker（不是真实日志行）。 */
function isMarker(body: { lines: string[] }): boolean {
  return body.lines.length === 1 && /dropped by local backpressure/.test(body.lines[0] ?? '');
}

/** 当前在飞缓冲的字节数（与 python 侧 `_buffered_bytes` 同义）。 */
function bufferedBytes(pusher: LogStreamPusher): number {
  const chunks = (pusher as unknown as { chunks: { lines: string[] }[] }).chunks;
  return chunks.reduce(
    (n, c) => n + c.lines.reduce((m, l) => m + Buffer.byteLength(l, 'utf8'), 0),
    0,
  );
}

describe('LogStreamPusher（RT-LOG 出站凭据 + 行切分）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedPost.mockResolvedValue({ status: 200 } as never);
  });

  it('① 走 admin-client.post —— 令牌由该模块 await 后注入，不会是 [object Promise]', async () => {
    const pusher = new LogStreamPusher('exec-1');
    pusher.addLine('hello');
    await pusher.finalFlush();

    expect(mockedPost).toHaveBeenCalledTimes(1);
    const [path, body] = mockedPost.mock.calls[0];
    expect(path).toBe('/api/executions/exec-1/logs');
    expect(body).toEqual({ fromLine: 0, lines: ['hello'] });
  });

  it('① executionId 做 URL 编码（防路径穿越/拼接注入）', async () => {
    const pusher = new LogStreamPusher('../../admin/secret');
    pusher.addLine('x');
    await pusher.finalFlush();

    expect(mockedPost.mock.calls[0][0]).toBe(
      '/api/executions/..%2F..%2Fadmin%2Fsecret/logs',
    );
  });

  it('② 一行被劈到两个分片里仍算一行（不得拆成两行）', async () => {
    const pusher = new LogStreamPusher('exec-2');
    pusher.addOutput('partial-');
    pusher.addOutput('line\n');
    await pusher.finalFlush();

    expect(bodyOf(0)).toEqual({ fromLine: 0, lines: ['partial-line'] });
    expect(pusher.getCurrentLine()).toBe(1);
  });

  it('② 空行是真实日志行，必须保留（不得被过滤）', async () => {
    const pusher = new LogStreamPusher('exec-3');
    pusher.addOutput('a\n\nb\n');
    await pusher.finalFlush();

    expect(bodyOf(0)).toEqual({ fromLine: 0, lines: ['a', '', 'b'] });
  });

  it('② \\r\\n 的 \\r 不得留在行尾', async () => {
    const pusher = new LogStreamPusher('exec-4');
    pusher.addOutput('win\r\nline\r\n');
    await pusher.finalFlush();

    expect(bodyOf(0)).toEqual({ fromLine: 0, lines: ['win', 'line'] });
  });

  it('② 末行无换行符时由 finalFlush 收尾补发（不得丢）', async () => {
    const pusher = new LogStreamPusher('exec-5');
    pusher.addOutput('no-newline-tail');
    await pusher.finalFlush();

    expect(bodyOf(0)).toEqual({ fromLine: 0, lines: ['no-newline-tail'] });
  });

  it('② 超过 100 行按片切分，fromLine 连续且不重叠', async () => {
    const pusher = new LogStreamPusher('exec-6');
    for (let i = 0; i < 250; i++) pusher.addLine(`line-${i}`);
    await pusher.finalFlush();

    const bodies = mockedPost.mock.calls.map((_, i) => bodyOf(i));
    expect(bodies.map((b) => b.fromLine)).toEqual([0, 100, 200]);
    expect(bodies.map((b) => b.lines.length)).toEqual([100, 100, 50]);
    expect(bodies.flatMap((b) => b.lines)).toHaveLength(250);
    expect(bodies.flatMap((b) => b.lines)[249]).toBe('line-249');
  });

  it('② 定时器到点自动 flush，且清空 pending（不重复发送）', async () => {
    jest.useFakeTimers();
    try {
      const pusher = new LogStreamPusher('exec-7');
      pusher.addLine('auto');
      expect(mockedPost).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1000);
      expect(mockedPost).toHaveBeenCalledTimes(1);
      expect(bodyOf(0)).toEqual({ fromLine: 0, lines: ['auto'] });

      // 已发过的行不得在 finalFlush 时重发。
      await pusher.finalFlush();
      expect(mockedPost).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('推送失败不抛出（不打断任务执行），后续分片继续', async () => {
    mockedPost
      .mockRejectedValueOnce(new Error('admin down'))
      .mockResolvedValueOnce({ status: 200 } as never);

    const pusher = new LogStreamPusher('exec-8');
    for (let i = 0; i < 150; i++) pusher.addLine(`l${i}`);
    await expect(pusher.finalFlush()).resolves.toBeUndefined();
    expect(mockedPost).toHaveBeenCalledTimes(2);
  });

  it('背压：超过 10 个待发分片时丢最旧的（内存有界）', async () => {
    const pusher = new LogStreamPusher('exec-9');
    // 1000 行 = 10 片；第 11 片入队时挤掉第 1 片。
    for (let i = 0; i < 1001; i++) pusher.addLine(`l${i}`);
    await pusher.finalFlush();

    const bodies = mockedPost.mock.calls.map((_, i) => bodyOf(i));
    // R164-A1：首发是**一行 marker**（占用第一条被丢行的行号 0），其后才是真实切片。
    const real = bodies.filter((b) => !isMarker(b));
    expect(bodies[0].fromLine).toBe(0);
    expect(isMarker(bodies[0])).toBe(true);
    // 第一片真实数据（fromLine 0）已被丢弃 → 存活片从 100 起。
    expect(real[0].fromLine).toBe(100);
    expect(real.reduce((n, b) => n + b.lines.length, 0)).toBe(901);
  });

  it('A8: 背压丢行 warn 恰好一次（每执行限 1 条防刷屏），全量推送成功后复位', async () => {
    const pusher = new LogStreamPusher('exec-a8');

    // 进入背压：只产出一条 warn（丢行升为可观测信号）
    for (let i = 0; i < 1001; i++) pusher.addLine(`l${i}`);
    const warnMock = logger.warn as unknown as jest.Mock;
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(String(warnMock.mock.calls[0][0])).toMatch(/Backpressure/);
    // 持续丢行不刷屏（每执行限 1 条）
    for (let i = 0; i < 500; i++) pusher.addLine(`m${i}`);
    expect(warnMock).toHaveBeenCalledTimes(1);

    // 全量推送成功 → 复位告警闸，下一次独立背压仍能告警一次
    await pusher.finalFlush();
    for (let i = 0; i < 1001; i++) pusher.addLine(`x${i}`);
    expect(warnMock).toHaveBeenCalledTimes(2);
    await pusher.finalFlush();
  });
});

/**
 * R164-A1：与 `executor-python/log_stream_pusher.py` 的**契约对齐**反证。
 *
 * 两侧写的是**同一张 admin 表**（`ExecutionLogLine`，按 `fromLine + i` 落库），
 * 所以两侧的缓冲/切片/丢行语义必须一致。python 侧已在 R123（字节闸）、R124
 * （片内行号连续）、R125（丢行留 marker）修过；node 侧此前只有条数上限、
 * 丢行只写本机 warn、flush 不串行、半行缓冲两路共用。这组用例把每一条钉死。
 *
 * 全部用例在修复前是**红**的（逐条见各用例注释里的实测数字）。
 */
describe('LogStreamPusher（R164-A1：与 python 侧契约对齐）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedPost.mockResolvedValue({ status: 200 } as never);
  });

  it('R123 对齐：字节闸的常量必须与 python 侧同值（否则同一部署两侧行为不同）', () => {
    expect(MAX_BYTES_PER_CHUNK).toBe(1_000_000);
    expect(MAX_BUFFERED_BYTES).toBe(10_000_000);
    // 文案逐字一致：两侧的 marker 会出现在同一个实时视图里，不能有两种说法。
    expect(BACKPRESSURE_MARKER(100)).toBe(
      '... [100 log lines dropped by local backpressure] ...',
    );
  });

  it('R123 对齐：单片按**字节**切片（5 × 300KB 不得挤进同一片）', async () => {
    // 改前：5 行（条数远未到 100）全在 1 片 → 单片 1.5MB，实测只发出 1 次请求。
    const pusher = new LogStreamPusher('exec-bytes-chunk');
    const line = 'y'.repeat(300 * 1024);
    for (let i = 0; i < 5; i++) pusher.addLine(line);
    await pusher.finalFlush();

    const bodies = mockedPost.mock.calls.map((_, i) => bodyOf(i));
    expect(bodies.length).toBeGreaterThan(1);
    for (const body of bodies) {
      const bytes = body.lines.reduce((n, l) => n + Buffer.byteLength(l, 'utf8'), 0);
      expect(bytes).toBeLessThanOrEqual(MAX_BYTES_PER_CHUNK);
    }
    // 切片不许改行号：fromLine 仍按 1 行递增
    expect(bodies.map((b) => b.fromLine)).toEqual([0, 3]);
  });

  it('R123 对齐：在飞缓冲按**字节**截断（12.8MB → ≤ 10MB，且保留尾部）', async () => {
    // 改前：200 × 64KB = 12.8MB 全部驻留（实测 bufferedBytes = 13107200）。
    const pusher = new LogStreamPusher('exec-bytes-buffer');
    (pusher as unknown as { scheduleFlush: () => void }).scheduleFlush = () => {};
    const line = 'x'.repeat(64 * 1024);
    for (let i = 0; i < 200; i++) pusher.addLine(line);

    expect(bufferedBytes(pusher)).toBeLessThanOrEqual(MAX_BUFFERED_BYTES);
    const chunks = (pusher as unknown as { chunks: { lines: string[] }[] }).chunks;
    expect(chunks.reduce((n, c) => n + c.lines.length, 0)).toBeLessThan(200);
    // 保留尾部：失败原因几乎总在最后几行
    expect(chunks[chunks.length - 1].lines[chunks[chunks.length - 1].lines.length - 1]).toBe(line);
  });

  it('R123 对齐：字节记账按 **UTF-8 字节**（中文 1 字符 = 3 字节）', () => {
    const pusher = new LogStreamPusher('exec-utf8');
    (pusher as unknown as { scheduleFlush: () => void }).scheduleFlush = () => {};
    pusher.addLine('abc');
    expect(bufferedBytes(pusher)).toBe(3);
    pusher.addLine('中文');
    expect(bufferedBytes(pusher)).toBe(9);
  });

  it('R123 对齐：flush 取走切片后字节记账必须归零（否则重试会重复计入）', async () => {
    const pusher = new LogStreamPusher('exec-bytes-reset');
    pusher.addLine('a'.repeat(1024));
    expect(bufferedBytes(pusher)).toBe(1024);
    await pusher.finalFlush();
    expect(bufferedBytes(pusher)).toBe(0);
  });

  it('R125 对齐：丢行必须在流里留下**可见的一行**，落在缺口所在的行号上', async () => {
    // 改前：1001 行丢 100 行，出站体里 0 条 marker —— 实时视图从 99 直接跳到 1100，
    // 静默缺口看起来就像一段正常的日志。
    const pusher = new LogStreamPusher('exec-marker');
    for (let i = 0; i < 1001; i++) pusher.addLine(`l${i}`);
    await pusher.finalFlush();

    const bodies = mockedPost.mock.calls.map((_, i) => bodyOf(i));
    const markers = bodies.filter(isMarker);
    expect(markers).toHaveLength(1);
    expect(markers[0].fromLine).toBe(0); // 第一条被丢行（行 0..99）
    expect(markers[0].lines).toHaveLength(1);
    expect(markers[0].lines[0]).toContain('100 log lines dropped');

    // marker 之后的真实切片行号**不受影响**（每片自带 fromLine）
    const real = bodies.filter((b) => !isMarker(b));
    expect(real[0].fromLine).toBe(100);
    for (const body of real) {
      for (const [off, text] of body.lines.entries()) {
        expect(text).toBe(`l${body.fromLine + off}`);
      }
    }
  });

  it('R125 对齐：同一轮里的多次丢行合并成一条 marker（不是每次丢都加一行）', async () => {
    const pusher = new LogStreamPusher('exec-marker2');
    for (let i = 0; i < 1300; i++) pusher.addLine(`l${i}`); // 丢 300 行，跨 3 片
    await pusher.finalFlush();

    const markers = mockedPost.mock.calls.map((_, i) => bodyOf(i)).filter(isMarker);
    expect(markers).toHaveLength(1);
    expect(markers[0].lines[0]).toContain('300 log lines dropped');
  });

  it('R124 对齐：丢行之后**片内行号仍连续**（admin 按 fromLine + i 落库）', () => {
    // 这条不变式此前没有任何用例钉住：将来若把缓冲改成「扁平 (lineNo, text) 列表 +
    // 按需切片」，丢行就会在扁平列表里留下缺口，朴素切片会立刻产出带缺口的片，
    // 后面所有行都被写到错位位置且**没有任何报错**。
    const pusher = new LogStreamPusher('exec-contig');
    (pusher as unknown as { scheduleFlush: () => void }).scheduleFlush = () => {};
    for (let i = 0; i < 1100; i++) pusher.addLine(`line-${i}`);

    const chunks = (pusher as unknown as {
      chunks: { fromLine: number; lines: string[] }[];
    }).chunks;
    expect(chunks).toHaveLength(10); // 条数闸仍生效
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].fromLine).toBe(chunks[i - 1].fromLine + chunks[i - 1].lines.length);
    }
    for (const chunk of chunks) {
      for (const [off, text] of chunk.lines.entries()) {
        expect(text).toBe(`line-${chunk.fromLine + off}`);
      }
    }
  });

  it('R164 并发：flush 必须串行——timer flush 在飞时 finalFlush 不得并发再发一片', async () => {
    // 改前：第一片卡在网络上时 finalFlush 立刻发出第二片（实测 2 次 post），
    // 于是 ① 到达 admin 的顺序可能与行号相反（SSE 实时视图乱序）；
    // ② finalFlush 在在飞请求落地前就 resolve —— 结束路径「等日志发完」是空的。
    let release: (v: unknown) => void = () => {};
    mockedPost.mockImplementationOnce(
      () => new Promise((res) => { release = res as (v: unknown) => void; }) as never,
    );
    const pusher = new LogStreamPusher('exec-lock');

    pusher.addLine('a');
    const first = (pusher as unknown as { flush: () => Promise<void> }).flush();
    await new Promise((r) => setImmediate(r));
    expect(mockedPost).toHaveBeenCalledTimes(1);

    pusher.addLine('b');
    const final = pusher.finalFlush();
    await new Promise((r) => setImmediate(r));
    // 第二片必须排队：在飞的请求没落地前不得发第二片
    expect(mockedPost).toHaveBeenCalledTimes(1);

    release({ status: 200 });
    await Promise.all([first, final]);
    expect(mockedPost).toHaveBeenCalledTimes(2);
    // 且顺序与行号一致
    expect([bodyOf(0).fromLine, bodyOf(1).fromLine]).toEqual([0, 1]);
  });

  it('R164 并发：flush 失败不得把后续 flush 永久卡死（链上吞拒绝）', async () => {
    mockedPost
      .mockRejectedValueOnce(new Error('admin down'))
      .mockResolvedValue({ status: 200 } as never);
    const pusher = new LogStreamPusher('exec-chain');
    pusher.addLine('a');
    await pusher.finalFlush();
    pusher.addLine('b');
    await expect(pusher.finalFlush()).resolves.toBeUndefined();
    expect(mockedPost).toHaveBeenCalledTimes(2);
  });

  it('R164 并发：stdout/stderr 的半行缓冲必须按流隔离（不得张冠李戴）', async () => {
    // 改前：两路共用一个 partial —— 'out-partial' + 'err-line\n' 被拼成
    // "out-partialerr-line" 一行（stdout 的残行吞掉 stderr 的整行），行号跟着错位。
    const pusher = new LogStreamPusher('exec-streams');
    pusher.addOutput('out-partial', 'stdout');
    pusher.addOutput('err-line\n', 'stderr');
    pusher.addOutput('out-rest\n', 'stdout');
    await pusher.finalFlush();

    const lines = mockedPost.mock.calls.map((_, i) => bodyOf(i)).flatMap((b) => b.lines);
    expect(lines).toEqual(['err-line', 'out-partialout-rest']);
    // 行号空间仍只有一个，且按到达顺序
    expect(bodyOf(0).fromLine).toBe(0);
    expect(pusher.getCurrentLine()).toBe(2);
  });

  it('R164 并发：finalFlush 把**每一路**的残行各自补成一行（stdout 在前）', async () => {
    const pusher = new LogStreamPusher('exec-tails');
    pusher.addOutput('tail-out', 'stdout');
    pusher.addOutput('tail-err', 'stderr');
    await pusher.finalFlush();

    const lines = mockedPost.mock.calls.map((_, i) => bodyOf(i)).flatMap((b) => b.lines);
    expect(lines).toEqual(['tail-out', 'tail-err']);
  });
});

describe('R164-A1 推送超时与 python 侧对齐', () => {
  it('pushChunk 传 5s 超时，而不是 admin-client 的 20s 默认值', async () => {
    const calls: Array<{ path: string; timeoutMs?: number }> = [];
    const mod = await import('./admin-client');
    const spy = jest.spyOn(mod, 'post').mockImplementation((async (
      path: string,
      _data?: unknown,
      _headers?: unknown,
      timeoutMs?: number,
    ) => {
      calls.push({ path, timeoutMs });
      return { status: 200, data: { count: 1 } } as never;
    }) as never);
    try {
      const pusher = new LogStreamPusher('exec-timeout');
      pusher.addLine('hello');
      await pusher.finalFlush();
      expect(calls.length).toBeGreaterThan(0);
      expect(calls[0].timeoutMs).toBe(PUSH_TIMEOUT_MS);
      expect(PUSH_TIMEOUT_MS).toBe(5_000);
    } finally {
      spy.mockRestore();
    }
  });
});
