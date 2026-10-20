/**
 * R138-A1（数据层审计 · 轴 2）：乐观更新回滚的**并发安全**。
 *
 * 缺陷（已证明存在）：`optimisticallySetTaskStatus` 的回滚是"整条缓存条目
 * 快照恢复"（`setQueryData(key, prev)`）。在任务列表页这是可复现的互相踩：
 *
 *  · 用户在 1 秒内先后暂停 A、B 两个任务（同一条分页缓存）→
 *    A.onMutate 快照 = {A:active, B:active}；B.onMutate 快照 = {A:paused, B:paused}；
 *  · A 的请求先失败 → A 的回滚把整条快照写回 → **B 的乐观值被抹掉**，
 *    B 的开关在用户眼前弹回 active（而 B 的请求还在飞，且大概率会成功）；
 *  · 同理，回滚也会把期间由 refetch/SSE 写入的**无关字段**（别的任务、同一
 *    任务的 updatedAt 等）一起倒回旧值——回滚的语义越界了。
 *
 * 修法：回滚只还原"本次乐观写入的那一个任务的 status"，且仅当它当前仍是
 * 我写入的目标值（有人已经改过 → 不覆盖，交给 onSettled 的失效取服务端真相）。
 *
 * 反证：把回滚改回 `setQueryData(key, prev)` 快照恢复 → 前两条用例变红。
 */
import { describe, it, expect } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { optimisticallySetTaskStatus, queryKeys } from '../api/queries';
import type { PageResult, Task } from '../api/tasks';

const makeTask = (over: Partial<Task> = {}): Task =>
  ({
    id: 'task-1',
    name: '备份任务',
    runtime: 'python',
    entrypoint: 'src/main.py',
    status: 'active',
    triggerType: 'cron',
    cronExpression: '0 2 * * *',
    maxRetry: 3,
    timeout: 300,
    priority: 2,
    createdAt: '2026-09-01T08:00:00Z',
    updatedAt: '2026-09-07T08:00:00Z',
    ...over,
  }) as Task;

const page = (items: Task[]): PageResult<Task> => ({
  items,
  total: items.length,
  page: 1,
  pageSize: 20,
});

const key = queryKeys.tasks.list({ page: 1, pageSize: 20 });

function seed(client: QueryClient, items: Task[]): void {
  client.setQueryData(key, page(items));
}

function items(client: QueryClient): Task[] {
  return client.getQueryData<PageResult<Task>>(key)!.items;
}

describe('R138-A1 乐观回滚不得踩别人的写入', () => {
  it('同页并发暂停 A、B：A 失败回滚不能抹掉 B 仍在飞的乐观值', () => {
    const client = new QueryClient();
    seed(client, [makeTask({ id: 'a', status: 'active' }), makeTask({ id: 'b', status: 'active' })]);

    const rollbackA = optimisticallySetTaskStatus(client, 'a', 'paused');
    const rollbackB = optimisticallySetTaskStatus(client, 'b', 'paused');
    expect(items(client).map((t) => t.status)).toEqual(['paused', 'paused']);

    // A 的请求失败 → 只回滚 A
    rollbackA();
    expect(items(client)[0].status).toBe('active');
    // B 的请求还在飞：它的乐观值必须存活（此前被 A 的整条快照抹成 active）
    expect(items(client)[1].status).toBe('paused');

    // B 随后也失败 → 各自只回滚自己那一次写入，最终回到各自的原始值
    rollbackB();
    expect(items(client).map((t) => t.status)).toEqual(['active', 'active']);
    // 反证方向：若回滚仍是"整条快照恢复"，上面的 B 会被 A 提前抹成 active，
    // 而 B 的回滚再把 A 写回 paused（互相踩），最终状态与真实意图不一致。
  });

  it('回滚不得把期间由别处写入的无关字段倒回旧值', () => {
    const client = new QueryClient();
    seed(client, [
      makeTask({ id: 'a', status: 'active' }),
      makeTask({ id: 'b', status: 'active', name: 'B-old' }),
    ]);

    const rollback = optimisticallySetTaskStatus(client, 'a', 'paused');

    // onMutate 与 onError 之间：另一个查询/SSE 写入了更新的数据
    client.setQueryData(
      key,
      page([
        { ...makeTask({ id: 'a', status: 'paused' }) },
        { ...makeTask({ id: 'b', status: 'active' }), name: 'B-new' },
      ]),
    );

    rollback();
    // 只还原 a 的 status，b 上的新数据（B-new）必须保留
    expect(items(client)[0].status).toBe('active');
    expect(items(client)[1].name).toBe('B-new');
  });

  it('同一实体上更晚的写入优先：迟到的旧回滚不覆盖新状态', () => {
    const client = new QueryClient();
    seed(client, [makeTask({ id: 'a', status: 'active' })]);

    const rollbackPause = optimisticallySetTaskStatus(client, 'a', 'paused');
    // 用户紧接着点了恢复（更晚的写入）——它的乐观值才是当前意图
    optimisticallySetTaskStatus(client, 'a', 'active');
    expect(items(client)[0].status).toBe('active');

    // 更早那次 pause 的请求此刻才失败，回滚迟到
    rollbackPause();
    expect(items(client)[0].status).toBe('active');
  });

  it('钉子：没有并发时回滚仍然精确还原（含 detail 与 DAG 两种形态）', () => {
    const client = new QueryClient();
    const detailKey = queryKeys.tasks.detail('a');
    seed(client, [makeTask({ id: 'a', status: 'active' })]);
    client.setQueryData(detailKey, makeTask({ id: 'a', status: 'active' }));
    client.setQueryData(queryKeys.tasks.allForDag, page([makeTask({ id: 'a', status: 'active' })]));

    const rollback = optimisticallySetTaskStatus(client, 'a', 'paused');
    expect(client.getQueryData<Task>(detailKey)!.status).toBe('paused');

    rollback();
    expect(items(client)[0].status).toBe('active');
    expect(client.getQueryData<Task>(detailKey)!.status).toBe('active');
    expect(
      client.getQueryData<PageResult<Task>>(queryKeys.tasks.allForDag)!.items[0].status,
    ).toBe('active');
  });

  it('钉子：回滚是幂等的（DAG 条目被 list 前缀扫描 + 显式步骤各命中一次）', () => {
    const client = new QueryClient();
    const dagKey = queryKeys.tasks.allForDag;
    client.setQueryData(dagKey, page([makeTask({ id: 'a', status: 'active' })]));

    const rollback = optimisticallySetTaskStatus(client, 'a', 'paused');
    rollback();
    expect(() => rollback()).not.toThrow();
    expect(client.getQueryData<PageResult<Task>>(dagKey)!.items[0].status).toBe('active');
  });
});
