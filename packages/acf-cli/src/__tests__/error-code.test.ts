/**
 * R31-E1: admin-api 稳定错误码在 CLI 侧的消费（分类 + 人读提示 + --json 结构化错误）。
 *
 * 反证说明（每个 describe 的用例都为此设计）：
 * - 删掉 `error-code.ts` 的 CATEGORY_RULES 匹配 → classify/hint/formatApiError 转红；
 * - 把 client.ts 的 `formatApiError` 还原成只返回 base → 「人读行带码」转红；
 * - 把 ui.ts 的 emitError 的 json 分支删掉（或去掉 errorCode 字段）→ 「--json
 *   错误体」转红；
 * - 把 appendErrorCodeHint 改成"未知码也追加"→ 「未知码逐字节保持现状」转红。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CATEGORY_HINTS,
  appendErrorCodeHint,
  classifyErrorCode,
  extractApiErrorInfo,
  hintForErrorCode,
  messageFromData,
} from '../error-code.js';
import { formatApiError } from '../client.js';
import { EXIT_CODES, apiErrorToJson, emitError, exitCodeFor, isJsonInvocation } from '../ui.js';

/** 造一个 axios 形状的错误（axios.isAxiosError 只认 isAxiosError 标记）。 */
function axiosError(status: number, data: unknown): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status, data },
  });
}

describe('classifyErrorCode：稳定码 → 6 类之一', () => {
  // 每条都取自 admin-api 真实码表（apps/admin-api/src/common/errors/catalog）
  it.each([
    ['INVALID_CREDENTIALS', 'auth'],
    ['REFRESH_TOKEN_INVALID', 'auth'],
    ['ACCOUNT_LOCKED', 'auth'],
    ['API_KEY_INVALID', 'auth'],
    ['ACCOUNT_DISABLED', 'auth'],
    ['TASK_NOT_OWNER', 'permission'],
    ['PROJECT_ACCESS_DENIED', 'permission'],
    ['USER_ROLE_ADMIN_ONLY', 'permission'],
    ['API_KEY_SCOPE_DENIED', 'permission'],
    ['TASK_NOT_FOUND', 'not_found'],
    ['EXECUTOR_NOT_FOUND', 'not_found'],
    ['SOP_MEDIA_NOT_FOUND', 'not_found'],
    ['TASK_NAME_EXISTS', 'conflict'],
    ['TASK_ALREADY_PAUSED', 'conflict'],
    ['TASK_UPDATE_STALE', 'conflict'],
    ['API_KEY_QUOTA_REACHED', 'capacity'],
    ['NO_AVAILABLE_EXECUTOR', 'capacity'],
    ['TASK_LOG_STREAM_LIMIT', 'capacity'],
    ['EXECUTOR_OFFLINE', 'capacity'],
    ['VALIDATION_FAILED', 'validation'],
    ['EXECUTOR_MAX_CONCURRENT_INVALID', 'validation'],
    ['TASK_CODE_SOURCE_EXCLUSIVE', 'validation'],
  ] as const)('%s → %s', (code, expected) => {
    expect(classifyErrorCode(code)).toBe(expected);
  });

  it('优先级：permission 早于 auth（否则 API_KEY_SCOPE_DENIED 会误给"去登录"）', () => {
    expect(classifyErrorCode('API_KEY_SCOPE_DENIED')).toBe('permission');
  });

  it('优先级：auth 早于 validation（INVALID_CREDENTIALS 的正确动作是重新登录）', () => {
    expect(classifyErrorCode('INVALID_CREDENTIALS')).toBe('auth');
  });

  it('优先级：conflict 早于 validation（状态冲突≠入参写错）', () => {
    expect(classifyErrorCode('TASK_ALREADY_PAUSED')).toBe('conflict');
  });

  it('未知码 / 无码 / 非字符串 → null（调用方据此保持现状，绝不猜）', () => {
    expect(classifyErrorCode('SOMETHING_NEW_FROM_FUTURE')).toBeNull();
    expect(classifyErrorCode('INTERNAL_ERROR')).toBeNull();
    // 服务端配置/内部类错误刻意不归类：给"改入参"或"去登录"都是误导
    expect(classifyErrorCode('EXECUTOR_CONFIG_PUSH_UNREACHABLE')).toBeNull();
    expect(classifyErrorCode('METRICS_ENDPOINT_DISABLED')).toBeNull();
    expect(classifyErrorCode('TASK_SECRET_DECRYPT_FAILED')).toBeNull();
    expect(classifyErrorCode(undefined)).toBeNull();
    expect(classifyErrorCode('')).toBeNull();
    expect(classifyErrorCode(404)).toBeNull();
    expect(classifyErrorCode(null)).toBeNull();
  });

  it('hintForErrorCode 给出该类的一句话处置；未知码为 null', () => {
    expect(hintForErrorCode('TASK_NOT_FOUND')).toBe(CATEGORY_HINTS.not_found);
    expect(hintForErrorCode('API_KEY_QUOTA_REACHED')).toBe(CATEGORY_HINTS.capacity);
    expect(hintForErrorCode('SOMETHING_NEW_FROM_FUTURE')).toBeNull();
    // 6 类都必须有非空建议
    for (const hint of Object.values(CATEGORY_HINTS)) {
      expect(hint.length).toBeGreaterThan(10);
    }
  });
});

describe('extractApiErrorInfo：从任意抛出值里抽可机读面', () => {
  it('axios 错误：status / errorCode / params / message 全部抽到', () => {
    const e = axiosError(404, {
      code: 404,
      message: '任务不存在',
      errorCode: 'TASK_NOT_FOUND',
      params: { taskId: 't-1' },
    });
    expect(extractApiErrorInfo(e)).toEqual({
      status: 404,
      errorCode: 'TASK_NOT_FOUND',
      params: { taskId: 't-1' },
      message: '任务不存在',
    });
  });

  it('没有 response 但有 code 的响应体：用数值 code 补 status', () => {
    const e = { response: { data: { code: 409, message: 'x', errorCode: 'TASK_NAME_EXISTS' } } };
    expect(extractApiErrorInfo(e).status).toBe(409);
  });

  it('node SDK 标记过的错误：errorCode/params 直接挂在错误上（无 response）', () => {
    const e = Object.assign(new Error('Request failed with status code 404: 任务不存在'), {
      errorCode: 'TASK_NOT_FOUND',
      params: { taskId: 't-2' },
    });
    const info = extractApiErrorInfo(e);
    expect(info.errorCode).toBe('TASK_NOT_FOUND');
    expect(info.params).toEqual({ taskId: 't-2' });
    expect(info.message).toContain('任务不存在');
    expect(info.status).toBeUndefined();
  });

  it('响应体优先于错误对象自身（服务端是真值源）', () => {
    const e = Object.assign(
      axiosError(403, { message: 'x', errorCode: 'TASK_NOT_OWNER', params: { a: 1 } }),
      { errorCode: 'FORGED', params: { b: 2 } },
    );
    expect(extractApiErrorInfo(e).errorCode).toBe('TASK_NOT_OWNER');
    expect(extractApiErrorInfo(e).params).toEqual({ a: 1 });
  });

  it('class-validator 的 message[] 与空串 message 的 QA-07 兜底', () => {
    expect(messageFromData({ message: ['a 必填', 'b 非法'] })).toBe('a 必填; b 非法');
    expect(messageFromData({ message: '', error: 'fallback' })).toBe('fallback');
    expect(messageFromData({ message: [] })).toBe('');
    expect(messageFromData('plain string')).toBe('');
    expect(messageFromData(undefined)).toBe('');
    expect(extractApiErrorInfo(axiosError(400, { message: '' })).message).toBe(
      'Request failed with status code 400',
    );
  });

  it('脏输入永不抛', () => {
    for (const value of [undefined, null, 42, 'x', [], {}, { response: null }]) {
      expect(() => extractApiErrorInfo(value)).not.toThrow();
    }
    expect(extractApiErrorInfo(null)).toEqual({});
    expect(extractApiErrorInfo({ response: { data: null } })).toEqual({});
  });
});

describe('formatApiError：已知码按类给可操作提示，未知码/无码保持原文', () => {
  it('已知码：原文案 + [码] + 该类一句话处置', () => {
    const out = formatApiError(
      axiosError(404, { code: 404, message: '任务不存在', errorCode: 'TASK_NOT_FOUND' }),
    );
    expect(out.startsWith('Not found (404): 任务不存在')).toBe(true);
    expect(out).toContain('[TASK_NOT_FOUND]');
    expect(out).toContain(CATEGORY_HINTS.not_found);
  });

  it('已知码：容量类（409 的 NO_AVAILABLE_EXECUTOR）给出"重试/腾容量"而不是语义误解', () => {
    const out = formatApiError(
      axiosError(409, { message: '暂无可用执行器', errorCode: 'NO_AVAILABLE_EXECUTOR' }),
    );
    expect(out).toContain('[NO_AVAILABLE_EXECUTOR]');
    expect(out).toContain(CATEGORY_HINTS.capacity);
  });

  it('未知码：逐字节等于既有文案（不追加任何东西）', () => {
    expect(
      formatApiError(axiosError(404, { message: '任务不存在', errorCode: 'SOMETHING_NEW_FROM_FUTURE' })),
    ).toBe('Not found (404): 任务不存在');
  });

  it('无码：逐字节等于既有文案（老后端 / 非本机制错误）', () => {
    expect(formatApiError(axiosError(400, { message: 'bad payload' }))).toBe(
      'Bad request (400): bad payload',
    );
    expect(formatApiError(axiosError(401, { message: '' }))).toBe(
      'Unauthorized (401): token missing, expired or invalid — run "acf login" or pass --token / set ACF_TOKEN',
    );
    expect(formatApiError(new Error('local IO failure'))).toBe('local IO failure');
  });

  it('网络错误（无响应）形态完全不变', () => {
    const e = Object.assign(new Error('connect ECONNREFUSED'), { isAxiosError: true, response: undefined });
    expect(formatApiError(e)).toBe(
      `Network error: connect ECONNREFUSED (is the API reachable at http://localhost:3105?)`,
    );
  });

  it('appendErrorCodeHint 对未知码/无码是恒等函数（反例哨兵）', () => {
    expect(appendErrorCodeHint('base', new Error('x'))).toBe('base');
    expect(appendErrorCodeHint('base', { errorCode: 'NOPE_FROM_FUTURE' })).toBe('base');
  });
});

describe('--json 失败输出：结构化错误体（含 errorCode）', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  let stderr: string[];

  beforeEach(() => {
    stderr = [];
    errSpy = vi.spyOn(console, 'error').mockImplementation(((...a: unknown[]) => {
      stderr.push(a.map(String).join(' '));
    }) as never);
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
  });

  afterEach(() => {
    errSpy.mockRestore();
    vi.restoreAllMocks();
  });

  const apiError = () =>
    axiosError(404, {
      code: 404,
      message: '任务不存在',
      errorCode: 'TASK_NOT_FOUND',
      params: { taskId: 't-1' },
    });

  it('opts.json: stderr 是单行 JSON，含 code/errorCode/params/category/message/exitCode', () => {
    expect(() => emitError('Failed', apiError(), { json: true })).toThrow(/process\.exit\(1\)/);
    expect(stderr).toHaveLength(1);
    const payload = JSON.parse(stderr[0]);
    expect(payload).toMatchObject({
      ok: false,
      scope: 'Failed',
      code: 404,
      errorCode: 'TASK_NOT_FOUND',
      category: 'not_found',
      params: { taskId: 't-1' },
      message: '任务不存在',
      exitCode: EXIT_CODES.GENERIC,
    });
    // 人类可读的 "✗ scope" 行不得混进 JSON stderr（会破坏 jq）
    expect(stderr[0]).not.toContain('✗');
  });

  it('opts.json + 无码：不出现 errorCode/category 键，message 与退出码仍正确', () => {
    expect(() =>
      emitError('Failed', axiosError(400, { message: 'bad payload' }), { json: true }),
    ).toThrow(/process\.exit\(1\)/);
    const payload = JSON.parse(stderr[0]);
    expect('errorCode' in payload).toBe(false);
    expect('category' in payload).toBe(false);
    expect(payload.message).toBe('bad payload');
    expect(payload.code).toBe(400);
  });

  it('退出码不受 JSON 化影响：401 → 3（auth）', () => {
    const e = axiosError(401, { message: '令牌失效', errorCode: 'REFRESH_TOKEN_INVALID' });
    expect(() => emitError('Failed', e, { json: true })).toThrow(/process\.exit\(3\)/);
    expect(JSON.parse(stderr[0])).toMatchObject({ exitCode: EXIT_CODES.AUTH, category: 'auth' });
    expect(exitCodeFor(e)).toBe(EXIT_CODES.AUTH);
  });

  it('真实 `--json` 调用（argv 检测）：自动走 JSON，无需调用点传参', () => {
    const original = process.argv;
    process.argv = ['node', 'acf', 'task', 'get', 't1', '--json'];
    try {
      expect(() => emitError('Failed', apiError())).toThrow(/process\.exit\(1\)/);
      expect(JSON.parse(stderr[0]).errorCode).toBe('TASK_NOT_FOUND');
    } finally {
      process.argv = original;
    }
  });

  it('无 --json 时仍是人类可读两行（✗ scope + 详情），不输出 JSON', () => {
    expect(() => emitError('Failed', apiError(), { json: false })).toThrow(/process\.exit\(1\)/);
    expect(stderr).toHaveLength(2);
    expect(stderr[0]).toContain('✗ Failed');
    expect(stderr[1]).toContain('[TASK_NOT_FOUND]');
    expect(() => JSON.parse(stderr[1])).toThrow();
  });

  it('isJsonInvocation 只看用户参数（避免把 vitest 自身的 flag 当 --json）', () => {
    expect(isJsonInvocation(['node', 'acf', 'task', 'list'])).toBe(false);
    expect(isJsonInvocation(['node', 'acf', 'task', 'list', '--json'])).toBe(true);
    expect(isJsonInvocation(['node', 'acf', '--json', 'task', 'list'])).toBe(true);
    expect(isJsonInvocation(['node', 'acf'])).toBe(false);
  });

  it('spinner 在 JSON 模式用 stop() 收尾（不用 fail(scope) 污染 stderr）', () => {
    const spinner = { stop: vi.fn(), fail: vi.fn() };
    expect(() => emitError('Failed', apiError(), { spinner, json: true })).toThrow(/process\.exit/);
    expect(spinner.stop).toHaveBeenCalledTimes(1);
    expect(spinner.fail).not.toHaveBeenCalled();
    expect(JSON.parse(stderr[0]).errorCode).toBe('TASK_NOT_FOUND');
  });

  it('apiErrorToJson 是纯函数（可直接给脚本复用）', () => {
    const payload = apiErrorToJson('Boom', axiosError(409, {
      message: '已存在',
      errorCode: 'TASK_NAME_EXISTS',
    }));
    expect(payload).toEqual({
      ok: false,
      scope: 'Boom',
      code: 409,
      errorCode: 'TASK_NAME_EXISTS',
      category: 'conflict',
      message: '已存在',
      exitCode: EXIT_CODES.GENERIC,
    });
  });
});
