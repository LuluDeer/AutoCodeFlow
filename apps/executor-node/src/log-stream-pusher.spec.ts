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
import { LogStreamPusher } from './log-stream-pusher';
import { post } from './admin-client';

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
    // 第一片（fromLine 0）已被丢弃。
    expect(bodies[0].fromLine).toBe(100);
    expect(bodies.reduce((n, b) => n + b.lines.length, 0)).toBe(901);
  });
});
