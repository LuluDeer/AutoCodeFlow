/**
 * API 文档双语（API-I18N）：把 `x-i18n-en` 供应商扩展键**声明进**
 * `@nestjs/swagger` 的各 options 类型。
 *
 * ## 为什么需要这个文件
 *
 * 双语载体走的是「options 里的裸 `x-` 扩展键」——这是**唯一**同时作用于
 * `@ApiProperty`（schema 属性）与 `@ApiOperation` 的机制：`@ApiExtension` 在
 * 属性/类上会被 `SchemaObjectFactory` **静默丢弃**（已由真实引导 Nest 应用并
 * dump 文档实测确认，见 `api-i18n.ts` 头注的对照表）。
 *
 * 但裸键绕过了 TS 的类型检查：`@nestjs/swagger` 的 options 接口里没有这个键，
 * 于是 TypeScript 的**多余属性检查**（excess property check）对整个对象字面量
 * 报错 `TS2353: Object literal may only specify known properties`。实测规模：
 * 全仓 **1318 处**（`ApiPropertyOptions` 634、`ApiResponseOptions` 142、
 * `ApiResponseNoStatusOptions` 77、`ApiParamOptions` 63、`ApiQueryOptions` 27、
 * `ApiBodyOptions` 21、`ApiHeaderOptions` 1）。
 *
 * 逐个改 1318 处（加 `as any` / 拆成变量）既噪声大又**丢掉类型安全**；而模块
 * 增强是一处声明、全局生效，且保留其余字段的完整检查——`descriptoin` 这种拼写
 * 错误依然会红。
 *
 * ## 为什么值类型是联合体
 *
 * 两种挂载点的载荷形状不同，这不是随意的宽松：
 *   · schema 属性 / param / query / header：`x-i18n-en` 是**裸字符串**（英文正文）；
 *   · operation：`x-i18n-en` 是**对象** `{ summary?, description? }`——一个
 *     operation 有两个可翻译字段，必须分别携带，不能压成一个字符串；
 *   · response / body：两种形态都会出现（有的只译 description，有的兼有 summary）。
 * 故统一声明为 `string | { summary?, description?, value? }`，读取侧由
 * `readI18nEn()` 归一化。
 *
 * ## 为什么写成独立模块而不是 `.d.ts`
 *
 * 模块增强要求该文件**是模块**（含顶层 export）。放在 `src/**` 下会被
 * tsconfig 的 include 自然纳入编译；独立 `.d.ts` 则要额外确认
 * include/typeRoots 覆盖，收益为零、风险更高。
 *
 * ## 为什么不 import `I18N_EN_KEY`
 *
 * `declare module` 里的成员名必须是**字面量**，用 `import` 进来的常量做计算
 * 属性名在接口声明中不被接受（TS1169）。故此处的 `"x-i18n-en"` 与
 * `api-i18n.ts` 的 `I18N_EN_KEY` 是**同一字符串的两处书写**——由
 * `scripts/check-api-i18n.mjs` 的守卫断言两者一致，避免漂移。
 */

/**
 * `x-i18n-en` 的取值：裸字符串（属性面）或对象（operation 面）。
 */
export interface ApiI18nEnObject {
  /** 英文 summary（镜像 operation 的 `summary`）。 */
  summary?: string;
  /** 英文 description（镜像 operation 的 `description`）。 */
  description?: string;
  /** 英文正文（镜像 schema 属性的 `description`）。 */
  value?: string;
}

/** `x-i18n-en` 的取值联合。 */
export type ApiI18nEnValue = string | ApiI18nEnObject;

/**
 * ⚠️ **只能增强真正的 `interface`，不能增强 `type` 别名**。
 *
 * `@nestjs/swagger` 的这些名字**大多是 type 别名**（联合/交叉类型）：
 * ```ts
 * export type ApiPropertyOptions = ApiPropertyCommonOptions | (… & { enumName: string });
 * export type ApiResponseOptions = ApiResponseMetadata | ApiResponseSchemaHost;
 * ```
 * 对别名写 `interface ApiX { … }` **不会合并**，而是**新建一个同名接口**——于是
 * `TS2300: Duplicate identifier 'ApiX'`，且原别名依然不含新键（实测：报错从
 * 1318 → 1323，只多了 5 条重复标识符，键依然不被接受）。首版正是踩了这个坑。
 *
 * 别名最终都收敛到少数几个**接口**上，增强它们即等于增强全部派生别名：
 *   · `@ApiProperty*` → `ApiPropertyCommonOptions` = `SchemaObjectMetadata & {…}`
 *     → 根接口是 `SchemaObjectCommonMetadata`（**非导出**，见下）；
 *   · `@ApiResponse*` → `ApiResponseCommonMetadata`（**导出**，可直接增强）；
 *   · `@ApiParam/@ApiQuery` → `ApiParamMetadata` / `ApiQueryMetadata`；
 *   · `@ApiBody` → `ApiBodyMetadata`；
 *   · `@ApiHeader` → `ApiHeaderOptions`（本身就是导出接口）。
 *
 * ## 为什么这里只增强能增强的那些，剩下的用「就地展开」兜住
 *
 * `SchemaObjectCommonMetadata` / `ApiResponseMetadata` 等在 `.d.ts` 里**未导出**
 * （`interface X {…}` 无 `export`），外部无法 `declare module` 增强它——这是
 * 库的类型设计限制，不是我们写错了。
 *
 * 故分两步走：
 *   1. 本文件增强**可增强**的接口（下面列出的）；
 *   2. 不可增强的那些（`@ApiProperty` 走 `SchemaObjectCommonMetadata`），改为
 *      **在调用点用内联展开**（`i18nProperty()` 返回的对象类型已含该键），
 *      即"经 helper 构造"而非"字面量直写"——这样类型来自 helper 的返回值，
 *      不触发多余属性检查。
 *
 * 具体到本仓：`@ApiProperty` 的站点**都已经过 `i18nProperty()`**（这正是
 * codemod 的产物），故第 2 步无需再改调用点；而 `@ApiResponse/@ApiParam/
 * @ApiQuery/@ApiBody/@ApiHeader` 的站点是**字面量直写**，由第 1 步兜住。
 */

declare module "@nestjs/swagger" {
  // ── @ApiResponse / @ApiCreatedResponse / @ApiOkResponse … ──
  interface ApiResponseCommonMetadata {
    "x-i18n-en"?: string | ApiI18nEnObject;
  }
  // ── @ApiHeader（本身就是导出接口） ──
  interface ApiHeaderOptions {
    "x-i18n-en"?: string | ApiI18nEnObject;
  }
  // ⚠️ `@ApiParam` / `@ApiQuery` / `@ApiBody` **无法**在这里增强：
  // 它们的 metadata 在 `@nestjs/swagger` 里是 **type 别名**（联合/交叉类型）或
  // **未导出**的 interface，写同名 `interface` 只会新建标识符并报
  // `TS2300: Duplicate identifier`（实测 `ApiQueryMetadata` 正是如此）。
  //
  // 这也正是本仓改用「导出期注入」而非「源码内联」的原因：内联载体要求增强
  // 这些类型，而它们在库的类型设计上就封死了。详见
  // `scripts/api-i18n/inject-openapi-en.mjs` 的头注。
}
