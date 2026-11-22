import { TaskContext, PARAMS_JSON_ENV_KEY } from '../context';

/**
 * SDK 示例编程式集成冒烟（R468 / R472 review 加固）。
 *
 * callback-report-node 示例的核心动作链：TaskContext.fromEnv() → taskId/
 * executionId → getParam → logger → 判定 ctx.http.enabled 降级分支 → ctx.success()。
 * 这里用真实 SDK 源码（ts-jest）复现这条链，不 build、不需要执行器/网络，
 * CI 的 autocodeflow-node-sdk-test job 会自动跑到——覆盖此前「SDK 单测绿、
 * 示例配置绿，但两者拼起来能否跑」的集成空白。
 *
 * R472 加固：① withCleanEnv 进入前**清空**所有相关 env（否则外部注入
 * ADMIN_API_URL 会让「无凭据降级」case 假红）；② RESULT 用真实 ctx.success()
 * + ctx.logger 生成（不再硬编码自证）；③ 真测 getParam 大小写不敏感分支。
 */
const ENV_KEYS = [
  'EXECUTION_ID', 'TASK_ID', 'TASK_NAME',
  'ADMIN_API_URL', 'EXECUTOR_TOKEN',
  'AUTOFLOW_ADMIN_API_URL', 'AUTOFLOW_CALLBACK_TOKEN',
  PARAMS_JSON_ENV_KEY,
] as const;

function withCleanEnv(fn: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const k of ENV_KEYS) saved.set(k, process.env[k]);
  for (const k of ENV_KEYS) delete process.env[k]; // R472 P2-1：进 fn 前清空，杜绝外部注入串扰
  try {
    fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('SDK 示例编程式集成（callback-report-node 核心链）', () => {
  it('fromEnv + getParam + logger + 降级分支：无回调凭据时 ctx.success() 产出可诊断 RESULT', () => {
    withCleanEnv(() => {
      process.env['EXECUTION_ID'] = 'exec-468';
      process.env['TASK_ID'] = 'task-468';
      process.env['TASK_NAME'] = 'sdk-example-smoke';
      process.env[PARAMS_JSON_ENV_KEY] = JSON.stringify({ source_url: 'https://example.com/data', mode: 'success' });

      const ctx = TaskContext.fromEnv();
      expect(ctx.executionId).toBe('exec-468');
      expect(ctx.taskId).toBe('task-468');
      expect(ctx.taskName).toBe('sdk-example-smoke');
      expect(String(ctx.getParam('mode', 'success'))).toBe('success');
      expect(String(ctx.getParam('source_url'))).toBe('https://example.com/data');

      // 降级分支：无 URL/token ⇒ http.enabled=false，示例走「不外发」路径。
      expect(ctx.http.enabled).toBe(false);

      // R472 P2-2：RESULT 由真实 SDK API 生成，不再是测试内硬编码。
      ctx.logger.info('生成 3 条模拟记录');
      const records = [{ id: 1, value: 'alpha' }, { id: 2, value: 'beta' }, { id: 3, value: 'gamma' }];
      const result = ctx.success('callback-report-node', { count: records.length, records, callback_used: ctx.http.enabled });
      expect(result.success).toBe(true);
      expect(result.output).toMatchObject({ count: 3, callback_used: false });
      expect((result.output as { records: unknown[] }).records[0]).toEqual({ id: 1, value: 'alpha' });
      // logger 真的被收进 result.logs（结构化日志条目，触达 flushLogs，不是空壳）
      expect(result.logs?.some((entry) => entry.message === '生成 3 条模拟记录')).toBe(true);
    });
  });

  it('降级分支遮挡：注入 ADMIN_API_URL + EXECUTOR_TOKEN 时 http.enabled=true', () => {
    withCleanEnv(() => {
      process.env['EXECUTION_ID'] = 'exec-468b';
      process.env['TASK_ID'] = 'task-468b';
      process.env['TASK_NAME'] = 'sdk-example-smoke-b';
      process.env['ADMIN_API_URL'] = 'http://127.0.0.1:3105';
      process.env['EXECUTOR_TOKEN'] = 'test-token';

      const ctx = TaskContext.fromEnv();
      expect(ctx.http.enabled).toBe(true);
    });
  });

  it('getParam 大小写不敏感（R472 P3-1：真测 context.ts:378-381 分支）', () => {
    withCleanEnv(() => {
      process.env['EXECUTION_ID'] = 'exec-468c';
      process.env['TASK_ID'] = 'task-468c';
      process.env['TASK_NAME'] = 'sdk-example-smoke-c';
      // JSON 用大写键，却用小写 key 读——强制走大小写不敏感分支
      process.env[PARAMS_JSON_ENV_KEY] = JSON.stringify({ LIMIT: 7, MODE: 'strict' });

      const ctx = TaskContext.fromEnv();
      expect(ctx.getParam('limit')).toBe(7);
      expect(ctx.getParam('mode')).toBe('strict');
    });
  });
});
