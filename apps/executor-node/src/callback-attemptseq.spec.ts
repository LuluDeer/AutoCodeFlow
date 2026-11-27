import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import type { CallbackRequest } from './callback';

type CallbackModule = typeof import('./callback');

function loadCallbackModule(mockWorkDir: string): CallbackModule {
  jest.resetModules();
  jest.mock('./admin-client');
  jest.doMock('./config', () => ({
    config: {
      workDir: mockWorkDir,
      executorAddress: 'internal-executor:8002',
      executorAddressPublic: 'public-executor:8002',
    },
  }));
  jest.mock('./device-identity', () => ({
    getDeviceFingerprint: () => null,
  }));
  jest.mock('./logger', () => ({
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  }));
  return require('./callback') as CallbackModule;
}

describe('callback attemptSeq (dispatch generation echo)', () => {
  let cb: CallbackModule;
  let registry: typeof import('./callback-attemptseq');
  let dir: string;
  let post: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-cb-attemptseq-'));
    cb = loadCallbackModule(dir);
    registry = require('./callback-attemptseq') as typeof import('./callback-attemptseq');
    post = (jest.requireMock('./admin-client') as { post: jest.Mock }).post;
    post.mockReset().mockResolvedValue({ status: 200 });
  });

  afterEach(async () => {
    const stopping = cb.stopCallbackThread();
    await jest.advanceTimersByTimeAsync(10_000);
    await stopping;
    jest.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function postedBody(): Promise<CallbackRequest[]> {
    cb.startCallbackThread();
    await cb.stopCallbackThread();
    expect(post).toHaveBeenCalled();
    return post.mock.calls[0][1] as CallbackRequest[];
  }

  it('echoes attemptSeq=7 from the dispatch context into the terminal callback body', async () => {
    registry.noteDispatchAttemptSeq('exec-7', 7);
    cb.pushCallback({ executionId: 'exec-7', status: 'success', exitCode: 0 });

    const body = await postedBody();
    expect(body).toHaveLength(1);
    expect(body[0].attemptSeq).toBe(7);

    // 新字段已落 protocol.json ⇒ 合法载荷不得触发 CallbackPayload 对账 warn。
    const loggerMock = jest.requireMock('./logger') as { logger: { warn: jest.Mock } };
    const drift = loggerMock.logger.warn.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .filter((m: string) => m.includes('CallbackPayload'));
    expect(drift).toEqual([]);
  });

  it('does not add attemptSeq (not even null/undefined) when dispatch omitted it', async () => {
    cb.pushCallback({ executionId: 'legacy', status: 'success' });

    const body = await postedBody();
    expect(Object.prototype.hasOwnProperty.call(body[0], 'attemptSeq')).toBe(false);
    expect(JSON.stringify(body[0])).not.toContain('attemptSeq');
  });

  it('safely ignores malformed dispatch attemptSeq instead of echoing a fake generation', async () => {
    registry.noteDispatchAttemptSeq('bad-str', '7');
    registry.noteDispatchAttemptSeq('bad-float', 7.5);
    registry.noteDispatchAttemptSeq('bad-nan', Number.NaN);
    registry.noteDispatchAttemptSeq('bad-inf', Number.POSITIVE_INFINITY);
    cb.pushCallback({ executionId: 'bad-str', status: 'failed' });
    cb.pushCallback({ executionId: 'bad-float', status: 'failed' });
    cb.pushCallback({ executionId: 'bad-nan', status: 'failed' });
    cb.pushCallback({ executionId: 'bad-inf', status: 'failed' });

    const body = await postedBody();
    expect(body).toHaveLength(4);
    for (const item of body) {
      expect(Object.prototype.hasOwnProperty.call(item, 'attemptSeq')).toBe(false);
    }
  });

  it('forgets the generation on terminal release; explicit request field still wins', async () => {
    registry.noteDispatchAttemptSeq('forget-me', 3);
    registry.forgetDispatchAttemptSeq('forget-me');
    cb.pushCallback({ executionId: 'forget-me', status: 'success' });
    // 显式字段（例如死信重放的落盘载荷）优先于登记表。
    registry.noteDispatchAttemptSeq('explicit', 3);
    cb.pushCallback({ executionId: 'explicit', status: 'success', attemptSeq: 9 });

    const body = await postedBody();
    const byId = new Map(body.map(item => [item.executionId, item]));
    expect(Object.prototype.hasOwnProperty.call(byId.get('forget-me')!, 'attemptSeq')).toBe(false);
    expect(byId.get('explicit')!.attemptSeq).toBe(9);
  });
});
