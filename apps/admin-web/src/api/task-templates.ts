import { client } from './client';

/**
 * CORE-03：任务模板前端契约。config 是合法 CreateTaskDto 子集（后端落库前已校验），
 * 省略 name——实例化任务时由用户提供。key/五个官方模板与 mcp-server TASK_TEMPLATES 对齐。
 */
export interface TaskTemplate {
  id: string;
  key: string;
  name: string;
  description?: string | null;
  category?: string | null;
  config: Record<string, unknown>;
  isOfficial: boolean;
  createdAt: string;
  updatedAt: string;
}

export const taskTemplatesApi = {
  list: () => client.get('/task-templates') as Promise<TaskTemplate[]>,
  get: (id: string) => client.get(`/task-templates/${id}`) as Promise<TaskTemplate>,
  create: (data: {
    name: string;
    description?: string;
    category?: string;
    key?: string;
    config: Record<string, unknown>;
  }) => client.post('/task-templates', data) as Promise<TaskTemplate>,
  remove: (id: string) => client.delete(`/task-templates/${id}`),
  /** 从模板一键建可运行任务：body 字段覆盖模板 config，至少需 name。 */
  instantiate: (id: string, body: Record<string, unknown>) =>
    client.post(`/task-templates/${id}/instantiate`, body),
};
