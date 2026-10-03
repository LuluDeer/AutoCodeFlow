import type { components } from '../types/generated/api-types';
import { client } from './client';

/**
 * CORE-03：任务模板前端契约。config 是合法 CreateTaskDto 子集（后端落库前已校验），
 * 省略 name——实例化任务时由用户提供。key/五个官方模板与 mcp-server TASK_TEMPLATES 对齐。
 *
 * B-3（契约空壳修复）：本类型此前是手写 interface——后端 openapi 对该实体只
 * emit 空壳 schema（{"type":"object"}），生成类型 Record<string, never> 不可用，
 * 手写与后端的漂移无任何检测。响应 DTO（TaskTemplateResponseDto）落地后直接
 * 取生成类型：字段名逐一相同，无需映射；相对手写版仅多出 `createdBy?: string | null`
 * （后端一直返回，手写版漏记——这正是漂移检测失效的实例）。
 */
export type TaskTemplate = components['schemas']['TaskTemplateResponseDto'];

/**
 * `POST /task-templates/{id}/instantiate` 的 201 响应（创建出的任务最小面：
 * 标识/状态/触发字段）。此前该响应在 openapi 里零 schema，前端无法类型化。
 */
export type InstantiateTaskResult =
  components['schemas']['InstantiateTaskResponseDto'];

/** 创建自定义模板的请求体（生成层 CreateTaskTemplateDto 的别名，语义同源）。 */
export type CreateTaskTemplatePayload =
  components['schemas']['CreateTaskTemplateDto'];

export const taskTemplatesApi = {
  // NETOPT-D P3: 与全站 api 层三元形态对齐（其余文件 signal 缺省时传 undefined）。
  list: (signal?: AbortSignal) =>
    client.get('/task-templates', signal ? { signal } : undefined) as Promise<
      TaskTemplate[]
    >,
  get: (id: string) => client.get(`/task-templates/${id}`) as Promise<TaskTemplate>,
  create: (data: CreateTaskTemplatePayload) =>
    client.post('/task-templates', data) as Promise<TaskTemplate>,
  remove: (id: string) => client.delete(`/task-templates/${id}`),
  /** 从模板一键建可运行任务：body 字段覆盖模板 config，至少需 name。 */
  instantiate: (id: string, body: Record<string, unknown>) =>
    client.post(`/task-templates/${id}/instantiate`, body) as Promise<InstantiateTaskResult>,
};
