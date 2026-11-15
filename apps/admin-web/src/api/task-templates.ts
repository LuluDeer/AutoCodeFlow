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

/** PATCH /task-templates/:id 的局部更新请求体（生成层 UpdateTaskTemplateDto）。 */
export type UpdateTaskTemplatePayload =
  components['schemas']['UpdateTaskTemplateDto'];

/** POST /task-templates/import 的清单载荷（生成层 ImportTaskTemplateManifestDto）。 */
export type ImportTemplatePayload =
  components['schemas']['ImportTaskTemplateManifestDto'];

/**
 * 把 DB 模板行拼成一份可被 `POST /task-templates/import` 接受的清单。
 *
 * 导入契约是**扁平清单**（name=key / version / description / capabilities /
 * params / entrypoints / config），不是 `{ template: {...} }` 包裹体；本函数
 * 只补清单必填元数据（version 缺省 1.0.0、capabilities/params/entrypoints 空集），
 * 可执行内容整体来自 DB 的 `config`。重新导入同名 key 会被后端 409 拒绝（不覆盖）。
 */
export function buildTemplateExportManifest(
  tpl: TaskTemplate,
): Record<string, unknown> {
  return {
    name: tpl.key,
    version: '1.0.0',
    description: tpl.description?.trim() || tpl.name,
    capabilities: [],
    params: {},
    entrypoints: [],
    config: tpl.config,
  };
}

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
  /** 导入清单（manifest.json / registry 条目）落成一行自定义模板；key 冲突 409，不覆盖。 */
  importTemplate: (data: ImportTemplatePayload) =>
    client.post('/task-templates/import', data) as Promise<TaskTemplate>,
  /** 编辑自定义模板（名称/说明/分类/config；key、官方标记、属主不可改）。 */
  update: (id: string, data: UpdateTaskTemplatePayload) =>
    client.patch(`/task-templates/${id}`, data) as Promise<TaskTemplate>,
  /**
   * 导出模板为清单 JSON（`buildTemplateExportManifest`）并触发浏览器下载。
   * 后端没有独立导出端点：DB 行字段即导出事实源，清单元数据由前端补齐。
   */
  exportDefinition: (tpl: TaskTemplate): string => {
    const manifest = buildTemplateExportManifest(tpl);
    const blob = new Blob([JSON.stringify(manifest, null, 2)], {
      type: 'application/json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${tpl.key || 'task-template'}-manifest.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return a.download;
  },
};
