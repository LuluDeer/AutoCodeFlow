/**
 * tasks API 层契约测试（N13）：
 * 后端契约——pause/resume 返回保存后的 Task 实体（admin-api task.service.ts），
 * killExecution 返回 {success,message} 包装。类型断言必须与实际响应形态一致，
 * 否则下游按类型读字段会拿到 undefined（TS 不报错的契约谎言）。
 *
 * 编译期契约（由 `tsc -b` / `npm run build` 把关，运行时测试无法替代）：
 * - 若 pause/resume 断言回退为 {success,message}，读取 res.status 的行将编译失败；
 * - 若 TaskExecution.status 回退为 string，@ts-expect-error 行将因“预期错误未出现”而编译失败。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tasksApi, type Task, type TaskExecution } from '../api/tasks';
import { client } from '../api/client';

vi.mock('../api/client', () => ({
  client: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

const mockPost = vi.mocked(client.post);

const fakeTask = {
  id: 't1',
  name: 'demo',
  runtime: 'node',
  entrypoint: 'index.js',
  status: 'paused',
  triggerType: 'manual',
  maxRetry: 0,
  timeout: 60,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} satisfies Task;

beforeEach(() => {
  mockPost.mockReset();
});

describe('tasksApi.pause / resume — 后端返回 Task 实体', () => {
  it('pause 透传后端 Task，并命中 /tasks/:id/pause', async () => {
    mockPost.mockResolvedValue(fakeTask);
    const res = await tasksApi.pause('t1');
    expect(mockPost).toHaveBeenCalledWith('/tasks/t1/pause');
    // 编译期契约：res 必须具有 Task 形态
    const status: Task['status'] = res.status;
    expect(status).toBe('paused');
    // 运行时契约：响应不是 {success,message} 包装
    expect((res as unknown as Record<string, unknown>).success).toBeUndefined();
  });

  it('resume 透传后端 Task，并命中 /tasks/:id/resume', async () => {
    const resumed = { ...fakeTask, status: 'active' };
    mockPost.mockResolvedValue(resumed);
    const res = await tasksApi.resume('t1');
    expect(mockPost).toHaveBeenCalledWith('/tasks/t1/resume');
    const status: Task['status'] = res.status;
    expect(status).toBe('active');
  });
});

describe('tasksApi.killExecution — 后端返回 {success,message}', () => {
  it('透传 kill 结果形态，并命中 /tasks/:id/executions/:execId/kill', async () => {
    mockPost.mockResolvedValue({ success: true, message: '执行已终止' });
    const res = await tasksApi.killExecution('t1', 'e1');
    expect(mockPost).toHaveBeenCalledWith('/tasks/t1/executions/e1/kill');
    expect(res.success).toBe(true);
    expect(res.message).toBe('执行已终止');
  });
});

describe('TaskExecution.status — 与后端 ExecutionStatus 枚举对齐的联合类型', () => {
  it('包含 killed 终态且拒绝未知字符串', () => {
    const killed: TaskExecution['status'] = 'killed';
    // @ts-expect-error — status 是联合类型而非 string，未知值应编译报错
    const invalid: TaskExecution['status'] = 'not_a_real_status';
    expect(killed).toBe('killed');
    expect(invalid).toBe('not_a_real_status');
  });
});
