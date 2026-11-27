/** 清单元数据里的参数声明（对齐后端 manifest.params 的 userConfig 形状）。 */
export interface ManifestParam {
  type?: string;
  title?: string;
  description?: string;
  required?: boolean;
  default?: unknown;
  options?: unknown[];
  enum?: unknown[];
}

export interface TemplateManifestMeta {
  version?: string;
  capabilities?: string[];
  params?: Record<string, ManifestParam>;
  [key: string]: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 从模板 config.metadata.skillManifest 提取参数表；缺失/畸形返回 null。 */
export function readManifestParams(config: unknown): Record<string, ManifestParam> | null {
  if (!isPlainObject(config)) return null;
  const metadata = config.metadata;
  if (!isPlainObject(metadata)) return null;
  const manifest = metadata.skillManifest as TemplateManifestMeta | undefined;
  if (!manifest || !isPlainObject(manifest.params)) return null;
  return manifest.params as Record<string, ManifestParam>;
}

export type SupportedParamType = 'string' | 'number' | 'boolean' | 'select';

/** 只把清单声明的 string/number/boolean（或 options/enum 的 select）渲染为表单控件。 */
export function normalizeParam(_name: string, raw: ManifestParam): SupportedParamType | null {
  const type = String(raw.type ?? 'string').toLowerCase();
  const options = raw.options ?? raw.enum;
  if (Array.isArray(options) && options.length > 0) return 'select';
  if (type === 'string' || type === 'number' || type === 'boolean') return type;
  return null;
}

/** 默认值（complex schema 的 default 不参与，避免把对象塞进 Input）。 */
export function initialParamValue(param: ManifestParam, type: SupportedParamType): unknown {
  if (param.default !== undefined && param.default !== null) return param.default;
  if (type === 'boolean') return false;
  if (type === 'number') return undefined;
  if (type === 'select') return (param.options ?? param.enum ?? [])[0];
  return undefined;
}

/** 把 params 表单值整体作为任务 params 覆盖项，保证 instantiated task payload 合法。 */
export function buildInstantiateOverlay(
  name: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const overlay: Record<string, unknown> = { name };
  if (Object.keys(params).length > 0) overlay.params = params;
  return overlay;
}
