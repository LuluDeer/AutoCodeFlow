import { client } from './client';
import type { components } from '../types/generated/api-types';

/**
 * P1-3：GET /artifacts 索引行（契约派生类型，与 openapi ExecutionArtifactRowDto 对齐；
 * 后端 DTO 改动时随 `gen:api-types` 同步）。
 */
export type ArtifactRow = components['schemas']['ExecutionArtifactRowDto'];

/**
 * GET /artifacts 查询参数。后端只支持这四个：page / pageSize / applicationId / taskId；
 * **没有** executionId / 时间范围 / 类型 / 关键字筛选，也不返回 total。
 */
export interface ArtifactIndexQuery {
  page?: number;
  pageSize?: number;
  applicationId?: string;
  taskId?: string;
}

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

  /**
   * P1-3：跨执行产物索引（GET /artifacts，ADMIN-only）。
   *
   * 契约事实：返回**裸数组**（不是分页信封、**没有 total**）；query 仅支持
   * page / pageSize / applicationId / taskId，**不支持** executionId / 时间范围 /
   * 类型 / 关键字筛选。前端不得在页面上做假的全局过滤（详见 ArtifactsPage 口径说明）。
   */
  listIndex: (query: ArtifactIndexQuery, signal?: AbortSignal) =>
    client.get<ArtifactRow[]>('/artifacts', { params: query, signal }),

  /**
   * 取产物原始字节（预览用；与 downloadArtifact 同一下载端点，区别是不触发保存、
   * 由调用方持有 objectURL 并在关闭时 revoke）。
   */
  fetchBlob: (execId: string, name: string, signal?: AbortSignal) =>
    client.get<Blob>(
      `/tasks/executions/${execId}/artifacts/${encodeURIComponent(name)}`,
      { responseType: 'blob', signal },
    ),
};

// Named exports for convenience（对齐 executor-packages.ts 的导出风格）
export const listArtifacts = (execId: string, signal?: AbortSignal) =>
  artifactsApi.listArtifacts(execId, signal);
export const downloadArtifact = (execId: string, name: string) =>
  artifactsApi.downloadArtifact(execId, name);
