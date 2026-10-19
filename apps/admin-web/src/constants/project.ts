/**
 * 前端共享常量：项目域。
 *
 * 为什么单独成文件（而不是放在 `api/projects.ts` 里）：项目页的**单元测试**
 * 普遍把 `../api/projects` 整个 `vi.mock` 掉（13 个用例文件），mock 只提供
 * 被调用的那几个方法。若页面从该模块 import 一个**运行时常量**，mock 下它就是
 * undefined，`id === undefined` 恒假——默认项目的「不可改名/删除」置灰直接
 * 静默失效，且会在测试里抛
 * `No "DEFAULT_PROJECT_ID" export is defined on the "../api/projects" mock`。
 * 常量放进不被 mock 的独立模块，页面与 API 层都从这里取，单点且无副作用。
 */

/**
 * 默认项目 id —— 与后端 `apps/admin-api/src/modules/project/project.entity.ts`
 * 的 `DEFAULT_PROJECT_ID` **必须逐字一致**（后端迁移 1790000000007 种子 /
 * 1790000000008 回填 SQL 同样引用该值）。
 *
 * 语义：所有「未分配项目」的任务/应用在读写面上都归到这个项目；它恒不可改名、
 * 不可删除（后端返回 404 `PROJECT_DEFAULT_IMMUTABLE`），且对**所有**用户可读
 * （包括非成员）。
 *
 * ⚠️ 这个 id 的 UUID 版本位是 `0`，不是 RFC 4122 的 1–8。任何「按标准 UUID
 * 校验」的路径都会拒绝它——后端为此专门有 `ParseUuidShapePipe` /
 * `@IsUuidShape`（见 `common/pipes/parse-uuid-shape.pipe.ts` 头注）。前端若新增
 * 该 id 的校验，同样不能直接套 `isUUID` 类规则。
 */
export const DEFAULT_PROJECT_ID = '00000000-0000-0000-0000-000000000001';
