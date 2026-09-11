import { client } from './client';

/**
 * FEAT-05（UI 半场）：执行产物（artifact）清单条目。
 *
 * 与 admin-api `modules/task/entities/task-execution.entity.ts` 的
 * `ExecutionArtifact` 对齐——执行器在任务工作目录 `artifacts/` 收集文件，
 * 终态回调随清单（name/size/sha256）上报，字节单独 PUT 上传，清单落库到
 * `task_executions.artifacts`（jsonb）。此处仅供管理台读取展示与下载，
 * 不重复定义到 api/tasks.ts（避免与并行会话 CORE-02 的足迹冲突）。
 */
export interface ExecutionArtifact {
  name: string;
  size: number;
  sha256: string;
}

export const artifactsApi = {
  /**
   * 读取某次执行的产物清单
   * （GET /tasks/executions/:execId/artifacts，管理台 JWT 守卫）。
   * 返回裸数组 [{ name, size, sha256 }]（client 响应拦截器已剥信封）。
   */
  listArtifacts: (execId: string, signal?: AbortSignal) =>
    signal
      ? client.get<ExecutionArtifact[]>(
          `/tasks/executions/${execId}/artifacts`,
          { signal },
        ) as Promise<ExecutionArtifact[]>
      : client.get<ExecutionArtifact[]>(
          `/tasks/executions/${execId}/artifacts`,
        ) as Promise<ExecutionArtifact[]>,

  /**
   * 下载单个产物并触发浏览器保存
   * （GET /tasks/executions/:execId/artifacts/:name）。
   *
   * ⚠️ 下载端点位于全局 JwtAuthGuard 之后、且 JWT 仅从 Authorization 头提取，
   * `<a href>` 直链无法携带鉴权头（会 401），因此用 axios blob 请求 + objectURL
   * 触发保存——与 api/executor-packages.ts 的 download() 同一写法。
   */
  downloadArtifact: async (execId: string, name: string): Promise<void> => {
    const blob = await client.get<Blob>(
      `/tasks/executions/${execId}/artifacts/${encodeURIComponent(name)}`,
      { responseType: 'blob' },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
};

// Named exports for convenience（对齐 executor-packages.ts 的导出风格）
export const listArtifacts = (execId: string, signal?: AbortSignal) =>
  artifactsApi.listArtifacts(execId, signal);
export const downloadArtifact = (execId: string, name: string) =>
  artifactsApi.downloadArtifact(execId, name);
