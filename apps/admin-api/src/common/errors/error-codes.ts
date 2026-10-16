import { renderTemplate, type ErrorCodeDef } from "./error-code-def";
import { COMMON_CODES } from "./catalog/common";
import { EXECUTOR_CODES } from "./catalog/executor";
import { TASK_CODES } from "./catalog/task";
import { PROJECT_CODES } from "./catalog/project";
import { AUTH_CODES } from "./catalog/auth";
import { APPLICATION_CODES } from "./catalog/application";

/**
 * LANG-ERR-01：**错误码目录（合并点）**。
 *
 * ## 为什么需要它
 *
 * 产品要求「用户配置了哪个语言就展示哪个语言」。但后端报错文案在**抛出的
 * 那一刻**由源码决定，服务端并不知道请求者的语言偏好——文案写死在 `throw`
 * 实参里，一旦落地就只可能是**一种**语言。之前的形态就是中文，于是把界面切成
 * English 的用户会看到「英文外壳 + 中文报错 toast」（`apps/admin-web/src/
 * utils/error.ts` 的 `getErrMsg` 直接透传后端 `message`）。
 *
 * 解法（用户拍板「全量错误码化」）：后端**只抛稳定码 + 参数**，文案由**前端**
 * 用它自己的 i18n 表翻译。本文件是那张码表的合并点。
 *
 * ## 分片结构（并发安全的关键）
 *
 * 码表按域拆在 `catalog/*.ts`，本文件只做合并。理由：全量迁移要把数百个码写进
 * 来，若都写在这一个文件里，**并行迁移必然互相覆盖**（各自 read-modify-write
 * 同一文件）。分片后每个迁移者只碰自己那一片。
 *
 * ⚠️ 新增码请改**自己域的分片**，不要往本文件里塞条目。
 *
 * ## `zh` 为什么必须留着、且必须自洽
 *
 * 不是所有消费者都会翻译：
 *   · 裸 API 调用方（curl / 脚本 / 第三方集成）；
 *   · `mcp-server` / `acf-cli`（本仓的两个一等消费者）；
 *   · 服务端日志、审计留痕、`task_executions.errorMessage` 这类**落库字段**。
 * 它们只拿得到 `message`。故 `zh` 的人读文案必须始终存在且**自足**（不能是
 * 裸码、不能依赖前端补全）——它同时是"未知码"场景的兜底（前端不认识的码就回落
 * 服务端 `message`，绝不把裸码渲染给用户）。
 *
 * ## 与响应体既有 `code` 字段的关系（**极易搞错，务必分清**）
 *
 * `http-exception.filter.ts` 的响应体里 `code` 一直是**数字 HTTP 状态码**
 * （404/409…），并被 `mcp-server` / `acf-cli` 消费（`check-consumer-routes.mjs`
 * 守着这条契约）。**不要**把它改成业务码、也不要复用它——业务码走**新增**字段
 * `errorCode`。
 */
export const ERROR_CATALOG = {
  ...COMMON_CODES,
  ...EXECUTOR_CODES,
  ...TASK_CODES,
  ...PROJECT_CODES,
  ...AUTH_CODES,
  ...APPLICATION_CODES,
} as const satisfies Record<string, ErrorCodeDef>;

/** 全部错误码的联合类型——`AppError` 的入参用它，拼错码即**编译期**报错。 */
export type ErrorCode = keyof typeof ERROR_CATALOG;

/**
 * 错误码的**运行时常量**（与同名类型 `ErrorCode` 借助 TS 声明合并共存）。
 *
 * ## 为什么必须同时有值形态（这不是冗余，是迁移能收敛的前提）
 *
 * 全量迁移要写 `throw new AppError(ErrorCode.TASK_NOT_FOUND)` 这种**取值**写法
 * ——这是所有人（以及所有并行的迁移 agent）最自然的直觉写法，且与
 * `HttpStatus.NOT_FOUND` / `TaskStatus.RUNNING` 等本仓既有枚举风格一致。
 *
 * 但首版只导出了**类型** `ErrorCode`（`keyof typeof ERROR_CATALOG`），于是
 * `ErrorCode.X` 是**编译错误** `TS2693: 'ErrorCode' only refers to a type`。
 * 实测后果：13 个文件、**118 处**编译错误，且各 agent 各自的修法不同，把一次
 * 机械迁移变成了风格分裂。
 *
 * ## ⚠️ 必须是「码名 → 码名」，不能是「码名 → 定义对象」
 *
 * 第二版曾写成 `export const ErrorCode = ERROR_CATALOG`——**错的**：那样
 * `ErrorCode.TASK_NOT_FOUND` 求值成 `{status, zh, en}` **定义对象**，而
 * `AppError` 的首参是 `code: ErrorCode`（= `keyof typeof ERROR_CATALOG`，
 * 即字符串字面量联合）。结果是**每一处** `new AppError(ErrorCode.X)` 都报
 * `TS2345`（实测 228 处编译错误）——比不导出值形态更糟，因为它看起来"能用"。
 *
 * 正确形态是**把键映射回键自身**（`{TASK_NOT_FOUND: "TASK_NOT_FOUND", …}`）：
 *   · `ErrorCode.X === "X"`，满足 `AppError` 的首参类型；
 *   · 映射类型 `{ [K in keyof typeof ERROR_CATALOG]: K }` 保留**字面量类型**，
 *     故拼错的码名仍是编译期错误（不会退化成 `string` 而放过笔误）；
 *   · 键集合由 `ERROR_CATALOG` **推导**而来（不是手写第二份清单），故新增码
 *     自动出现在这里，不存在"两处清单漂移"。
 *
 * `ERROR_CATALOG` 仍是**唯一真值源**（文案与状态码都在它那里）；本常量只提供
 * 取值语法糖，零信息重复。
 */
export const ErrorCode = Object.fromEntries(
  Object.keys(ERROR_CATALOG).map((k) => [k, k]),
) as { readonly [K in keyof typeof ERROR_CATALOG]: K };

/** 全部错误码清单（门禁与生成脚本共用，避免各自遍历方式不同）。 */
export const ERROR_CODES = Object.keys(ERROR_CATALOG) as ErrorCode[];

/**
 * 把 `{{name}}` 占位替换成 `params.name`（实现见 `error-code-def.ts`）。
 * 在这里再导出一次，让调用方只需 import 本模块（单一入口）。
 */
export const renderZh = (
  code: ErrorCode,
  params?: Record<string, unknown> | null,
) => renderTemplate(ERROR_CATALOG[code].zh, params);

export type { ErrorCodeDef };
