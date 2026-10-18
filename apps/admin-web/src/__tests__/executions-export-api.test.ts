/**
 * `tasksApi.exportExecutions` 的 **api 层**契约（不经组件，直接打函数）。
 *
 * 为什么单独一份：页面级用例 mock 掉了整个 `api/tasks` 模块（隔离网络），
 * 于是"请求到底打到哪个路径"在那份 spec 里是**不可判**的——页面只证明
 * "调了这个函数"。路径写错（比如照抄成 `/tasks/executions/all`，那会返回
 * JSON 而不是 CSV；或写成 `/tasks/:id/export`，那是**任务定义**导出）不会
 * 被组件测试发现。本文件把 client 层 mock 掉，逐字钉住：
 *
 * ① 路径 = `/tasks/executions/export`（后端 4cc26327 的流式端点）；
 * ② `responseType: 'blob'`（JWT 只从 Authorization 头取，`<a href>` 直链带不了
 *    头会 401——先例见 api/executor-packages.ts#download 与 api/audit.ts）；
 * ③ **参数里没有 page/pageSize/cursor**：显式白名单装配，而不是 spread 调用方
 *    对象。后端 `ExportExecutionsQueryDto` 没有分页字段，多传一个就 400
 *    （刻意的：静默忽略分页参数正是 API-07 记录的那类缺陷）；
 * ④ 空筛选 → 参数对象为空 `{}`（不发 `undefined` 成串的垃圾查询串）；
 * ⑤ blob → objectURL → `<a download>` → revoke 的完整生命周期。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { client } from '../api/client';
import { tasksApi } from '../api/tasks';

vi.mock('../api/client', () => ({
  client: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
const mockedClient = vi.mocked(client, true);

const g = globalThis as Record<string, unknown>;

describe('tasksApi.exportExecutions（api 层路径/参数契约）', () => {
  let origCreate: unknown;
  let origRevoke: unknown;
  let createSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    origCreate = (URL as unknown as Record<string, unknown>).createObjectURL;
    origRevoke = (URL as unknown as Record<string, unknown>).revokeObjectURL;
    createSpy = vi.fn(() => 'blob:mock-export');
    (URL as unknown as Record<string, unknown>).createObjectURL = createSpy;
    (URL as unknown as Record<string, unknown>).revokeObjectURL = vi.fn();
    mockedClient.get.mockReset();
    mockedClient.get.mockResolvedValue(new Blob(['id\n'], { type: 'text/csv' }) as never);
  });

  afterEach(() => {
    if (origCreate === undefined) delete (URL as unknown as Record<string, unknown>).createObjectURL;
    else (URL as unknown as Record<string, unknown>).createObjectURL = origCreate;
    if (origRevoke === undefined) delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
    else (URL as unknown as Record<string, unknown>).revokeObjectURL = origRevoke;
  });

  it('打到 /tasks/executions/export 且 responseType=blob', async () => {
    await tasksApi.exportExecutions({ status: 'failed' });

    expect(mockedClient.get).toHaveBeenCalledTimes(1);
    const [url, config] = mockedClient.get.mock.calls[0]!;
    // ① 路径逐字断言
    expect(url).toBe('/tasks/executions/export');
    // ② 必须以 blob 取回（否则 JSON 拦截器会把 CSV 文本当信封解）
    expect((config as { responseType?: string }).responseType).toBe('blob');
  });

  it('请求参数里**不存在** page / pageSize / cursor（后端 DTO 没有这三个字段）', async () => {
    // 调用方故意多塞三个非法键——白名单装配必须把它们挡掉。
    // 这不是"防御式编程"：传了就是 400（forbidNonWhitelisted），而调用方
    // 往往是把列表请求的参数对象整个转发过来的，很容易顺手带上分页。
    await tasksApi.exportExecutions({
      status: 'success',
      taskName: '备份',
      executorAddress: '10.0.0.1:3002',
      startTime: '2026-09-01T00:00:00.000Z',
      endTime: '2026-09-30T00:00:00.000Z',
      ...({ page: 2, pageSize: 50, cursor: 'CURSOR_X' } as Record<string, unknown>),
    } as never);

    const params = (mockedClient.get.mock.calls[0]![1] as { params: Record<string, unknown> }).params;
    // 用 `in` 判据：只有它能区分"键不存在"与"键存在但值为 undefined"
    expect('page' in params).toBe(false);
    expect('pageSize' in params).toBe(false);
    expect('cursor' in params).toBe(false);
    // 六个合法过滤器逐字下发（名字与后端 DTO 一致）
    expect(params).toEqual({
      status: 'success',
      taskName: '备份',
      executorAddress: '10.0.0.1:3002',
      startTime: '2026-09-01T00:00:00.000Z',
      endTime: '2026-09-30T00:00:00.000Z',
    });
  });

  it('空筛选 → params 为空对象（不把 undefined 拼进查询串）', async () => {
    await tasksApi.exportExecutions({
      status: undefined,
      taskName: undefined,
      executorAddress: undefined,
      startTime: undefined,
      endTime: undefined,
    });

    const params = (mockedClient.get.mock.calls[0]![1] as { params: unknown }).params;
    expect(params).toEqual({});
  });

  it('不传参数 → 仍然发一次请求且 params 为空对象', async () => {
    await tasksApi.exportExecutions();

    expect(mockedClient.get).toHaveBeenCalledTimes(1);
    const params = (mockedClient.get.mock.calls[0]![1] as { params: unknown }).params;
    expect(params).toEqual({});
  });

  it('limit 只在显式给数字时下发（安全阀，不是分页）', async () => {
    await tasksApi.exportExecutions({ limit: 1000 });
    expect((mockedClient.get.mock.calls[0]![1] as { params: Record<string, unknown> }).params).toEqual({
      limit: 1000,
    });

    mockedClient.get.mockClear();
    await tasksApi.exportExecutions({ limit: undefined });
    expect((mockedClient.get.mock.calls[0]![1] as { params: Record<string, unknown> }).params).toEqual({});
  });

  it('blob → objectURL → 触发下载 → revoke（JWT 只能走 Authorization 头）', async () => {
    const clickSpy = vi.fn();
    const origCreateElement = document.createElement.bind(document);
    const createElSpy = vi
      .spyOn(document, 'createElement')
      .mockImplementation(((tag: string) => {
        const el = origCreateElement(tag);
        if (tag === 'a') {
          (el as HTMLAnchorElement).click = clickSpy;
        }
        return el;
      }) as typeof document.createElement);

    try {
      await tasksApi.exportExecutions({});

      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(clickSpy).toHaveBeenCalledTimes(1);
      // revoke 与 create 配对（objectURL 泄漏会一直占着内存里的整个 CSV）
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-export');
      // 临时 <a> 不留在 DOM 里
      expect(document.querySelector('a[download]')).toBeNull();
    } finally {
      createElSpy.mockRestore();
    }
  });

  it('文件名带导出日期（objectURL 下载下浏览器不读 Content-Disposition）', async () => {
    const names: string[] = [];
    const origCreateElement = document.createElement.bind(document);
    const createElSpy = vi
      .spyOn(document, 'createElement')
      .mockImplementation(((tag: string) => {
        const el = origCreateElement(tag);
        if (tag === 'a') {
          // 在 click 时读走 download 属性（此时 api 层已赋值）
          (el as HTMLAnchorElement).click = () => {
            names.push((el as HTMLAnchorElement).download);
          };
        }
        return el;
      }) as typeof document.createElement);

    try {
      await tasksApi.exportExecutions({});
      expect(names).toHaveLength(1);
      expect(names[0]).toMatch(/^task-executions-\d{4}-\d{2}-\d{2}\.csv$/);
      void g;
    } finally {
      createElSpy.mockRestore();
    }
  });
});
