import { useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useExecutionsStream } from '../../hooks/useExecutionsStream';
import { queryKeys } from '../../api/queries';
import { tasksApi } from '../../api/tasks';
import { latestExecutionByTask, type LiveExecutionStatus } from './dagLiveStatus';

/**
 * DAG 节点最近执行状态：选中节点后按任务维度拉取最近 5 条执行；
 * SSE 终态事件使全局执行缓存失效，streamStatus 改变时本 hook 重新渲染并重取。
 */
export function useDagLiveStatus(taskId: string | null): {
  statuses: Map<string, LiveExecutionStatus>;
  streamStatus: ReturnType<typeof useExecutionsStream>;
} {
  const queryClient = useQueryClient();
  const streamStatus = useExecutionsStream();

  const { data } = useQuery({
    queryKey: [...queryKeys.executions.byTask(taskId ?? '', { page: 1, pageSize: 5 }), 'dag-live'],
    queryFn: ({ signal }) => tasksApi.executions(taskId!, { page: 1, pageSize: 5 }, signal),
    enabled: !!taskId,
    refetchInterval: streamStatus === 'live' ? false : 30_000,
  });

  useEffect(() => {
    if (!taskId) return;
    void queryClient.invalidateQueries({
      queryKey: [...queryKeys.executions.byTask(taskId, { page: 1, pageSize: 5 }), 'dag-live'],
    });
  }, [queryClient, taskId, streamStatus]);

  const statuses = useMemo(
    () => latestExecutionByTask(data?.items),
    [data?.items],
  );

  return { statuses, streamStatus };
}
