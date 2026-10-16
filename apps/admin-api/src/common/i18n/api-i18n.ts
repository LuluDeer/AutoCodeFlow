/**
 * API 文档双语（zh + en）载体 —— `x-i18n-en` 供应商扩展。
 *
 * ## 背景
 *
 * `apps/admin-api/openapi.json` 是**入库的生成物**（`npm run swagger:export`），
 * 由遍布 DTO / controller 的 `@ApiProperty({description})` /
 * `@ApiOperation({summary, description})` 装饰器字符串产出，是该 API 的公开文档面。
 *
 * 历史：这些字符串最初是英文，后经多轮（逐文件、逐个 agent）本地化改为中文，
 * 于是**中文成为产品默认**，英文读者在文档站上只能看到中文。
 *
 * ## 结构性约束与取舍
 *
 * 一个装饰器只持有一个字符串，而生成物是**入库的共享文件**、无法按用户分语言。
 * 因此两种语言必须**同行携带**在生成物里，由消费方选择：
 *
 *   - `description` / `summary` —— 保持**中文**（产品默认；既有中文消费方与
 *     `apps/admin-web/src/types/generated/api-types.ts` 的注释因此**逐字节不变**）；
 *   - `x-i18n-en` —— 携带**英文**，结构镜像被翻译的字段。
 *
 * ## 为何是「options 里的裸扩展键」而不是 `@ApiExtension`
 *
 * 实测（真实引导 Nest 应用并 dump 文档，见 `docs/` 与 CI 漂移闸）：
 *
 * | 机制                                   | schema 属性 | operation |
 * |----------------------------------------|-------------|-----------|
 * | options 里的裸 `x-` 键                 | ✅ 落地     | ✅ 落地   |
 * | `@ApiExtension` 施加于同一目标         | ❌ 被丢弃   | ✅ 落地   |
 * | `@ApiExtension` 施加于 class           | ❌          | ❌        |
 *
 * - `SchemaObjectFactory.exploreModelSchema` 对属性做 `omit(property, keysToOmit)`
 *   —— 只剔除 `name/isArray/enumName/enumSchema/selfRequired`，**其余键原样透传**；
 *   而 `API_EXTENSION` 元数据只在 **class 级**被读取（作为 `...extensionProperties`
 *   并入 typeDefinition），属性级读了也没人用。
 * - operation 侧 `SwaggerExplorer.mergeValues` 对整个 operation 元数据做浅展开
 *   （`{...globalValue, ...methodValue}`），故裸扩展键与 `@ApiExtension` **都**生效。
 *
 * 结论：**裸扩展键是唯一对两者都统一生效的机制**，因此本助手统一走它。
 * （`@ApiExtension` 不可用于属性，故不用——不是风格问题，是会被静默丢弃。）
 *
 * ## 用法
 *
 * ⚠️ 装饰器**直接**写 `description` / `summary`（中文，产品默认）；英文**不**写在
 * 装饰器里，而是导出后由 `scripts/api-i18n/inject-openapi-en.mjs` 按映射表注入
 * `x-i18n-en`：
 *
 * ```ts
 * // DTO 属性
 * @ApiProperty({ description: "执行器不存在" })
 *
 * // controller 方法
 * @ApiOperation({ summary: "用户登录", description: "……" })
 * ```
 *
 * ## `i18nProperty` / `i18nOperation` 为何在场却不被采用
 *
 * 它们是**另一种**写法：在装饰器里同批给出 zh + en，由本模块组装 options。
 * 全量迁移最终**没有**走它（原因见上方「为何是 options 里的裸扩展键」——
 * 装饰器的 options 类型没有 `x-i18n-en`，内联写法会触发 TS 多余属性检查，
 * 实测全仓 1318 处 TS2353）。两者保留是给需要"就地双语"的场景与单元测试用。
 *
 * ⚠️ 因此**绝大多数文件不应 import 它们**——import 了却不调用会被
 * `@typescript-eslint/no-unused-vars` 直接判红（CI 的 admin-api lint job 守着）。
 *
 * 非字符串选项（`example` / `enum` / `default` …）原样透传，本助手只搬运
 * 被翻译的字段。
 */

/** 文档站与守卫读取的扩展键名（单一事实源，勿在别处硬编码）。 */
export const I18N_EN_KEY = "x-i18n-en" as const;

/** operation 上 `x-i18n-en` 的载荷形状（与被镜像的字段一一对应）。 */
export interface OperationI18nEn {
  summary?: string;
  description?: string;
}

type AnyOptions = Record<string, unknown>;

/**
 * 组装 `@ApiProperty` / `@ApiPropertyOptional` 的 options：
 * 中文进 `description`，英文进 `x-i18n-en`，其余选项原样透传。
 *
 * `zh` 为**必填**——它同时是运行时（Swagger UI 默认语言）与既有消费方看到的文案，
 * 不允许缺失。`en` 亦为必填：本仓库的纪律是「新增可翻译字段必须同批给出英文」，
 * 缺失由 `scripts/api-i18n/inject-openapi-en.mjs --check` 拦截（英文真值源是
 * `scripts/api-i18n/data/openapi-en-map.json`）。
 */
export function i18nProperty<T extends AnyOptions & { zh: string; en: string }>(
  opts: T,
): Omit<T, "zh" | "en"> & { description: string; [I18N_EN_KEY]: string } {
  const { zh, en, ...rest } = opts;
  // 展开顺序刻意固定：description / x-i18n-en 落在最后，保证 JSON 键序稳定
  // （openapi.json 的字节级幂等是 CI drift 闸的前提）。
  return {
    ...rest,
    description: zh,
    [I18N_EN_KEY]: en,
  } as Omit<T, "zh" | "en"> & { description: string; [I18N_EN_KEY]: string };
}

/**
 * `@ApiProperty` 的双语简写：`@ApiProperty(i18nPropertyOptions({ zh, en, … }))`
 * 的糖（把中英两串交给 `i18nProperty` 组装，其余选项原样透传）。
 *
 * 仅搬运字符串，不改变任何运行时行为——装饰器只是元数据，不参与校验与错误信息。
 */
export function i18nPropertyOptions(opts: {
  zh: string;
  en: string;
  [key: string]: unknown;
}) {
  return i18nProperty(opts as AnyOptions & { zh: string; en: string });
}

/**
 * 组装 `@ApiOperation` 的 options：
 * 中文进 `summary` / `description`，英文进 `x-i18n-en`，其余选项原样透传。
 *
 * 只翻译调用方实际给出的字段——`summaryEn` 与 `descriptionZh` 缺席时对应键不出现，
 * 避免产出 `summary: undefined` 这类会污染生成物的空壳。
 */
export function i18nOperation(opts: {
  summaryZh?: string;
  summaryEn?: string;
  descriptionZh?: string;
  descriptionEn?: string;
  [key: string]: unknown;
}): AnyOptions & {
  summary?: string;
  description?: string;
  [I18N_EN_KEY]?: OperationI18nEn;
} {
  const { summaryZh, summaryEn, descriptionZh, descriptionEn, ...rest } = opts;

  const out: AnyOptions & {
    summary?: string;
    description?: string;
    [I18N_EN_KEY]?: OperationI18nEn;
  } = { ...rest };

  if (summaryZh !== undefined) out.summary = summaryZh;
  if (descriptionZh !== undefined) out.description = descriptionZh;

  const en: OperationI18nEn = {};
  if (summaryEn !== undefined) en.summary = summaryEn;
  if (descriptionEn !== undefined) en.description = descriptionEn;
  if (Object.keys(en).length > 0) out[I18N_EN_KEY] = en;

  return out;
}

/**
 * 读取任意 OpenAPI 节点上的英文文案（文档站与守卫共用）。
 *
 * `kind` 选择镜像字段：schema 属性用 `"value"`（`x-i18n-en` 是裸字符串），
 * operation 用 `"summary"` / `"description"`（`x-i18n-en` 是对象）。
 * 读不到时返回 `null`，调用方自行决定回退到 `description`。
 */
export function readI18nEn(
  node: unknown,
  kind: "value" | "summary" | "description" = "value",
): string | null {
  if (!node || typeof node !== "object") return null;
  const ext = (node as AnyOptions)[I18N_EN_KEY];
  if (kind === "value")
    return typeof ext === "string" && ext.trim() ? ext : null;
  if (!ext || typeof ext !== "object") return null;
  const v = (ext as OperationI18nEn)[kind];
  return typeof v === "string" && v.trim() ? v : null;
}
