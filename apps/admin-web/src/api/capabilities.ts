import type { components } from '../types/generated/api-types';
import { client } from './client';
// 非组件路径：与 api/client.ts / api/tasks.ts 同款，直接引用 i18n 单例。
import i18n from '../i18n';

/**
 * 中台管控 · 能力注册表前端契约。
 *
 * 后端来源（admin-api/src/modules/capability）：
 *   capability.controller.ts    — 6 条路由（list / resolve / dump / create / update / remove）
 *   dto/create-capability.dto.ts — 创建/更新字段与枚举
 *   dto/resolve-capability.dto.ts — resolve 入参与 fieldRules 取值
 *   scope/scope-engine.ts        — DumpField / Decision / FieldRule
 *
 * client 的 baseURL 已含 /api（见 api/client.ts），故这里只写相对路径。
 * 这些 DTO 在 openapi 里没有可直接消费的生成类型，按后端源码手写并逐一对应。
 */

export type CapabilityKind = 'skill' | 'mcp' | 'agent' | 'provider' | 'template';
export type CapabilityVisibility = 'global' | 'project' | 'private';
export type CapabilityScopeMode = 'managed' | 'supervised' | 'self_service';
export type CapabilityGuidance = 'L1' | 'L2' | 'L3';
// N25：与后端 capability.entity.ts 的 CapabilitySourceType（派生自 source-policy 的
// ExtendedSourceType）同源的 8 源闭包；后端空壳 schema 无法生成精确类型，故此处手写。
export type CapabilitySourceType = 'builtin' | 'registry' | 'git' | 'folder' | 'npm' | 'github' | 'server' | 'mcp:';
export type CapabilityDecision = 'allow' | 'ask' | 'deny';
export type CapabilityFieldRule =
  | 'replace'
  | 'keyMerge'
  | 'append'
  | 'replaceIfSameKey'
  | 'policyTighten';

export interface CapabilityScope {
  mode: CapabilityScopeMode;
  guidance: CapabilityGuidance;
}

export interface CapabilitySource {
  type: CapabilitySourceType;
  ref?: string;
}

/** GET /api/capabilities 返回行（对齐 capability.entity.ts）。 */
export interface Capability {
  id: string;
  key: string;
  kind: string;
  label: string;
  description: string | null;
  version: string;
  source: CapabilitySource;
  visibility: CapabilityVisibility;
  scope: CapabilityScope;
  manifest: Record<string, unknown>;
  enabled: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** POST /api/capabilities 请求体（scope/source 组合由 service 做确定性校验）。 */
export interface CreateCapabilityPayload {
  key: string;
  kind: CapabilityKind;
  label: string;
  description?: string;
  version?: string;
  source?: CapabilitySource;
  visibility: CapabilityVisibility;
  scope?: CapabilityScope;
  manifest: Record<string, unknown>;
  enabled?: boolean;
  /** N16 发布背书：owner 为发布者，backer 为部门/角色背书（非个人）。 */
  owner?: string;
  backer?: string;
  /** N16 钉死版本（语义化版本或 40/64 位 hex hash）。 */
  versionPin?: string;
  /** N16 签署声明：封闭键 {signer, at?, scope?}，signer 非空。 */
  attestation?: Record<string, unknown>;
}

/** PATCH /api/capabilities/:id 请求体（UpdateCapabilityDto = PartialType）。 */
export type UpdateCapabilityPayload = Partial<CreateCapabilityPayload>;

/** POST /api/capabilities/resolve 的层（高→低）。 */
export interface ResolveLayer {
  name: string;
  config: Record<string, unknown>;
}

/** 四语义策略层：只影响 decision 判定，不参与配置合并。合同派生，随 openapi 自动同步。 */
export type SemanticPolicyLayer = components['schemas']['SemanticPolicyLayerDto'];

export interface ResolveCapabilityPayload {
  key: string;
  layers: ResolveLayer[];
  fieldRules?: Record<string, CapabilityFieldRule>;
  /** 可选四语义层（1-8 层）：传入时 decision 由 evaluateAll 判定。 */
  semanticLayers?: SemanticPolicyLayer[];
}

export interface CapabilityResolution {
  key: string;
  effective: Record<string, unknown>;
  decision: CapabilityDecision;
  /** N9：可达性降级编排标记（缺席表示探测口未装配） */
  degradePath?: "direct" | "x11+fromVideo" | "unknown";
  /** N9：降级原因提示「可达性分级:降级编排标记」 */
  degradationHint?: string;
}

/** GET /api/capabilities/:key/dump 三栏审计行（凭据已由后端脱敏）。 */
export interface DumpLayerValue {
  name: string;
  value: unknown;
}

export interface DumpField {
  field: string;
  layers: DumpLayerValue[];
  effective: unknown;
  source: string;
  rule: CapabilityFieldRule | 'default-replace';
}

export interface CapabilityDump {
  key: string;
  dump: DumpField[];
  /** N9：可达性降级编排标记（缺席表示探测口未装配） */
  degradePath?: "direct" | "x11+fromVideo" | "unknown";
  /** N9：降级原因提示「可达性分级:降级编排标记」 */
  degradationHint?: string;
}

function parseJsonObject(text: string, fieldName: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(i18n.t('capabilities.invalidJsonObject', { field: fieldName }));
  }
  return parsed as Record<string, unknown>;
}

export const capabilitiesApi = {
  /** GET /capabilities —— 任意登录角色可读。 */
  list: (signal?: AbortSignal) =>
    client.get<Capability[]>('/capabilities', signal ? { signal } : undefined),

  /** POST /capabilities —— ADMIN。 */
  create: (data: CreateCapabilityPayload) =>
    client.post<Capability>('/capabilities', data),

  /** PATCH /capabilities/:id —— ADMIN。 */
  update: (id: string, data: UpdateCapabilityPayload) =>
    client.patch<Capability>(`/capabilities/${encodeURIComponent(id)}`, data),

  /** POST /capabilities/:id/transfer —— ADMIN，移交 owner / backer。 */
  transfer: (id: string, data: { owner: string; backer: string }) =>
    client.post<Capability>(`/capabilities/${encodeURIComponent(id)}/transfer`, data),

  /** DELETE /capabilities/:id —— ADMIN。 */
  remove: (id: string) =>
    client.delete<{ ok: true }>(`/capabilities/${encodeURIComponent(id)}`),

  /** POST /capabilities/resolve —— JWT 只读。 */
  resolve: (data: ResolveCapabilityPayload) =>
    client.post<CapabilityResolution>('/capabilities/resolve', data),

  /**
   * GET /capabilities/:key/dump —— JWT 只读。
   * 下层 JSON 作为 query 字符串原样透传，合法性交给后端 parseQueryLayer 裁定；
   * 前端在页面层先做 JSON.parse 预检，避免把明显非法的值发过去。
   */
  dump: (
    key: string,
    layers?: { projectLayer?: string; privateLayer?: string },
  ): Promise<CapabilityDump> => {
    const query = new URLSearchParams();
    if (layers?.projectLayer) query.set('projectLayer', layers.projectLayer);
    if (layers?.privateLayer) query.set('privateLayer', layers.privateLayer);
    const suffix = query.toString();
    return client.get<CapabilityDump>(
      `/capabilities/${encodeURIComponent(key)}/dump${suffix ? `?${suffix}` : ''}`,
    );
  },
};

export { parseJsonObject };
