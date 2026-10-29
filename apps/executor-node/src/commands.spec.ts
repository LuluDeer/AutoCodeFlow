/**
 * ARCH-33（ADR-016）：控制面命令本地执行分派。
 *
 * 安全相关的断言集中在「路径由本模块按封闭枚举构造，绝不采信中台载荷里的
 * 路径」——这是本模块与「任意 URL 转发器」的唯一区别。
 */
jest.mock('./config', () => ({
  EXECUTOR_VERSION: '1.0.0',
  config: { port: 8002, token: 'test-token' },
}));
jest.mock('./logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const axiosPost = jest.fn();
jest.mock('axios', () => ({
  __esModule: true,
  default: { post: (...args: unknown[]) => axiosPost(...args) },
}));

import {
  CONTROL_COMMAND_TYPES,
  executeControlCommand,
  isControlCommandType,
  parseControlCommand,
  rejectUnsupportedControlCommand,
  type ControlCommandType,
} from './commands';

describe('control command routing (ARCH-33)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    axiosPost.mockResolvedValue({ status: 200, data: { ok: true } });
  });

  it('封闭枚举：六类命令，未知类型一律拒绝', () => {
    expect([...CONTROL_COMMAND_TYPES].sort()).toEqual([
      'app-stop',
      'app-uninstall',
      'config-reload',
      'deploy',
      'kill-execution',
      'update-package',
    ]);
    expect(isControlCommandType('deploy')).toBe(true);
    expect(isControlCommandType('rm-rf')).toBe(false);
    expect(isControlCommandType('')).toBe(false);
    expect(isControlCommandType(null)).toBe(false);
    expect(isControlCommandType(42)).toBe(false);
  });

  it('parseControlCommand：缺 commandId / 未知 type / 非对象 → null', () => {
    expect(parseControlCommand(null)).toBeNull();
    expect(parseControlCommand('nope')).toBeNull();
    expect(parseControlCommand({ type: 'deploy' })).toBeNull();
    expect(parseControlCommand({ commandId: 'c1' })).toBeNull();
    expect(parseControlCommand({ commandId: 'c1', type: 'evil' })).toBeNull();
    expect(parseControlCommand({ commandId: 'c1', type: 'deploy', payload: {} })).toMatchObject({
      commandId: 'c1',
      type: 'deploy',
    });
    // E-P1-P1: 切到生成 schema 后，payload 非对象属协议违例——整条命令丢弃
    // （旧手写实现宽松归一为 {}；新契约对齐 execute.ts 的 safeParse 行为）。
    expect(parseControlCommand({ commandId: 'c1', type: 'deploy', payload: 'x' })).toBeNull();
  });

  it('E-P1-P1：畸形 commandId（含空格/前导特殊符）被整条丢弃', () => {
    // 旧手写校验只查「非空字符串」，放过这些 id；生成 schema 的
    // ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ 会拒绝。
    expect(parseControlCommand({ commandId: 'bad id', type: 'deploy' })).toBeNull();
    expect(parseControlCommand({ commandId: '.leading-dot', type: 'deploy' })).toBeNull();
    expect(parseControlCommand({ commandId: 'has/slash', type: 'deploy' })).toBeNull();
    // 合法 id（字母开头、含 ._-）照常通过
    expect(parseControlCommand({ commandId: 'ok_cmd-1.a', type: 'deploy' })).toMatchObject({
      commandId: 'ok_cmd-1.a',
      type: 'deploy',
    });
  });

  it.each([
    ['deploy', '/api/deploy'],
    ['app-stop', '/api/app-stop'],
    ['app-uninstall', '/api/app-uninstall'],
    ['config-reload', '/api/config/reload'],
    ['update-package', '/api/update-package'],
  ] as Array<[ControlCommandType, string]>)('%s → 本地回环 %s（路径由类型决定）', async (type, expectedPath) => {
    const result = await executeControlCommand({
      commandId: 'c1',
      type,
      payload: { anything: 'goes' },
    });

    expect(result.ok).toBe(true);
    const [url, body, cfg] = axiosPost.mock.calls[0];
    expect(url).toBe(`http://127.0.0.1:8002${expectedPath}`);
    expect(body).toEqual({ anything: 'goes' });
    // 本执行器令牌 + 不经代理 + 不跟随重定向
    expect(cfg.headers.Authorization).toBe('Bearer test-token');
    expect(cfg.proxy).toBe(false);
    expect(cfg.maxRedirects).toBe(0);
  });

  it('kill-execution：executionId 进路径段且被编码（路径注入防御）', async () => {
    await executeControlCommand({
      commandId: 'c1',
      type: 'kill-execution',
      payload: { executionId: '../../etc/passwd' },
    });

    const [url] = axiosPost.mock.calls[0];
    expect(url).toBe(
      'http://127.0.0.1:8002/api/executions/..%2F..%2Fetc%2Fpasswd/kill',
    );
    // 原样未编码的穿越串绝不出现在 URL 里
    expect(url).not.toContain('../../');
  });

  it('kill-execution：executionId 缺失 → 编码为空串，不构造出畸形路径', async () => {
    await executeControlCommand({ commandId: 'c1', type: 'kill-execution', payload: {} });
    const [url] = axiosPost.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8002/api/executions//kill');
  });

  it('中台载荷里的 path/url 字段被忽略（不得成为任意路径转发器）', async () => {
    await executeControlCommand({
      commandId: 'c1',
      type: 'deploy',
      payload: { path: '/api/../admin/secret', url: 'http://evil.example/x' },
    });

    const [url] = axiosPost.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8002/api/deploy');
  });

  it('本地路由 4xx：ok=false，取 {error} 作为诊断信息', async () => {
    axiosPost.mockResolvedValueOnce({ status: 400, data: { error: 'appId is required' } });
    const result = await executeControlCommand({
      commandId: 'c1',
      type: 'app-uninstall',
      payload: {},
    });
    expect(result).toMatchObject({ ok: false, status: 400, error: 'appId is required' });
  });

  it('本地路由 5xx 且信封是 {message}：同样取到诊断信息', async () => {
    axiosPost.mockResolvedValueOnce({ status: 500, data: { message: 'boom' } });
    const result = await executeControlCommand({
      commandId: 'c1',
      type: 'config-reload',
      payload: {},
    });
    expect(result).toMatchObject({ ok: false, status: 500, error: 'boom' });
  });

  it('无 error/message 字段时回落到状态码文案', async () => {
    axiosPost.mockResolvedValueOnce({ status: 404, data: {} });
    const result = await executeControlCommand({
      commandId: 'c1',
      type: 'deploy',
      payload: {},
    });
    expect(result).toMatchObject({ ok: false, status: 404, error: 'HTTP 404' });
  });

  it('请求抛错（本地路由不可达）：收敛为 ok=false，绝不抛出', async () => {
    axiosPost.mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:8002'));
    const result = await executeControlCommand({
      commandId: 'c1',
      type: 'deploy',
      payload: {},
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
    expect(result.commandId).toBe('c1');
  });

  it('超时预算按类型区分：deploy 覆盖异步应答，update-package 同', async () => {
    await executeControlCommand({ commandId: 'd', type: 'deploy', payload: {} });
    await executeControlCommand({ commandId: 'u', type: 'update-package', payload: {} });
    expect(axiosPost.mock.calls[0][2].timeout).toBe(30_000);
    expect(axiosPost.mock.calls[1][2].timeout).toBe(10_000);
  });

  it('结果对象始终带 commandId 与 type（中台据此关联）', async () => {
    const result = await executeControlCommand({
      commandId: 'cmd-42',
      type: 'app-stop',
      payload: { deploymentId: 'd1' },
    });
    expect(result.commandId).toBe('cmd-42');
    expect(result.type).toBe('app-stop');
    expect(typeof result.durationMs).toBe('number');
  });
});

/**
 * EXEC-04（第 3 轮并行审计，P2）：未知命令类型的**可上报拒绝**。
 *
 * 失败模式（改动前）：未知 type 在协议闸被拒 → `parseControlCommand` 返回 null →
 * pull.ts 只 warn 后 `continue`，**不上报结果**。中台那条命令于是永远停在
 * "已下发"，运维无法区分"执行器拒了"和"命令丢了"。python 侧一直回报
 * `ok:false`，同一件事两端行为分叉。
 *
 * 语义边界（不得放宽）：
 *   - 未知类型**绝不执行任何动作**（不投递本地路由）——这里只产出一个结果对象；
 *   - 连 commandId 都拿不到（缺失/畸形）时仍然只能丢弃（没有键可关联）；
 *   - 已知类型不在此列（返回 null，交回正常执行路径）。
 */
describe('EXEC-04: 未知命令类型 → 可上报的 ok:false 结果', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('未知 type + 合法 commandId → ok:false，错误文案两端一致', () => {
    const result = rejectUnsupportedControlCommand({
      commandId: '3f1b1c1e-0000-4000-8000-000000000001',
      type: 'rm-rf-slash',
      payload: {},
    });

    expect(result).toMatchObject({
      commandId: '3f1b1c1e-0000-4000-8000-000000000001',
      type: 'rm-rf-slash',
      ok: false,
      durationMs: 0,
    });
    // 与 python commands.py 的 UNSUPPORTED_COMMAND_TYPE_ERROR 逐字一致
    expect(result!.error).toBe('unsupported command type: rm-rf-slash');
  });

  it('绝不执行任何动作：不投递本地路由（axios 零调用）', () => {
    rejectUnsupportedControlCommand({ commandId: 'c1', type: 'rm-rf-slash' });
    expect(axiosPost).not.toHaveBeenCalled();
  });

  it.each([
    'deploy',
    'app-stop',
    'app-uninstall',
    'config-reload',
    'kill-execution',
    'update-package',
  ])('已知类型 %s 不走拒绝通道（返回 null）', (type) => {
    expect(rejectUnsupportedControlCommand({ commandId: 'c1', type })).toBeNull();
  });

  it.each([
    [null],
    ['nope'],
    [42],
    [[]],
    [{ type: 'rm-rf-slash' }], // 缺 commandId：无从关联，只能丢弃
    [{ commandId: '', type: 'rm-rf-slash' }],
    [{ commandId: 'bad id', type: 'rm-rf-slash' }], // 形态不合协议（含空格）
    [{ commandId: '.leading', type: 'rm-rf-slash' }],
    [{ commandId: 'c1' }], // 缺 type
    [{ commandId: 'c1', type: 42 }],
    [{ commandId: 'c1', type: '' }],
  ])('无法关联到中台行时返回 null：%j', (raw) => {
    expect(rejectUnsupportedControlCommand(raw)).toBeNull();
  });

  it('超长未知 type：type 字段按中台 DTO 上限截断，完整原文留在 error 里', () => {
    const longType = 'x'.repeat(200);
    const result = rejectUnsupportedControlCommand({ commandId: 'c1', type: longType })!;

    // 中台 ExecutorCommandResultDto.type 是 @MaxLength(64)——不截断会被 400 丢掉，
    // 于是又回到"中台没有结果行"的原始故障。
    expect(result.type.length).toBe(64);
    expect(result.error).toContain(`unsupported command type: ${longType}`);
    expect(result.error!.length).toBeLessThanOrEqual(1000);
  });
});
