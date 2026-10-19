import type { ErrorCodeDef } from "../error-code-def";

/** LANG-ERR-01 · 项目域错误码分片（project / 项目访问控制）。 */
export const PROJECT_CODES = {
  /**
   * AUTH-01：项目行取不到。
   *
   * 带 `{{id}}` 参数（而不是一句无参数的「项目不存在」）：原实现把用户点名
   * 的那个 id 写进文案（`项目 ${id} 不存在`），运维/用户据此判断"是我看错了
   * 哪个项目"还是"它真被删了"。丢掉 id 会让排障退化成猜谜，故 zh 与原文案逐字
   * 对齐。
   */
  PROJECT_NOT_FOUND: {
    status: 404,
    zh: "项目 {{id}} 不存在",
    en: "Project {{id}} not found",
  },
  /**
   * AUTH-01：默认项目（种子 uuid）不可改名/删除——迁移回填与「未分配 = 默认
   * 项目」语义都锚定这行，删掉/改名会让存量数据的归属永久悬空。
   *
   * ⚠️ `status` 是 **404**，不是 409：原实现（`projects.service.ts` 的 update /
   * remove 两处）抛的是 `NotFoundException`，且 `projects.service.spec.ts` 用
   * `rejects.toBeInstanceOf(NotFoundException)` 与用例名「默认项目拒绝改名（404
   * 拦截，与 remove 同文案）」双重钉住了这一点。迁码时**状态必须跟着旧异常类
   * 走**——改成 409 会同时打断 spec 与前端按状态分支的处置（404 走"回列表"、
   * 409 走"提示冲突"是两套 UI 行为，见 admin-web `utils/error.ts` 的
   * `isNotFoundError`）。
   */
  PROJECT_DEFAULT_IMMUTABLE: {
    status: 404,
    zh: "默认项目不能重命名或删除",
    en: "The Default project cannot be renamed or deleted",
  },
  /**
   * PROJECT-DUPNAME-01：项目重名（`UQ_projects_name` 唯一索引冲突）。
   *
   * ⚠️ 与 404 的 `PROJECT_DEFAULT_IMMUTABLE` 相邻但语义无关，别合并：
   * 本码是**写面撞唯一索引**（409），默认项目保护是**寻址被拒**（404）。
   *
   * 为什么要专门一个码而不是复用 `RESOURCE_EXISTS`：后者渲染成「资源已存在」，
   * 用户看不出是**名字**撞了——而「新建项目」正是 PROJECT-CRUD-01 新开的入口，
   * 撞重名是最高频的失败。带 `{{name}}` 参数把用户填的那个名字回显出来，
   * 才能一眼判断"是我刚建过"还是"别人占了"。
   *
   * 状态码 409 与全局 filter 的 23505 兜底保持一致（前端按 409 走"提示冲突"
   * 分支，见 admin-web `utils/error.ts`）——本码只是把兜底文案换成可读的。
   */
  PROJECT_NAME_EXISTS: {
    status: 409,
    zh: "项目名称「{{name}}」已被占用，请换一个",
    en: 'A project named "{{name}}" already exists; please choose another name',
  },
  /**
   * AUTH-02：目标用户在项目里没有成员行（`updateMember` 不静默创建）。
   *
   * ⚠️ `status` 是 **404**（原 `NotFoundException`），非 403：本码只有一个消费
   * 点（`project-access.service.updateMember`），旧行为就是 404，且
   * `project-access.service.spec.ts` 以 `toBeInstanceOf(NotFoundException)` 钉住。
   * ——"拒绝访问"（403）与"这条成员关系不存在"（404）是两件事，本码是后者。
   */
  PROJECT_NOT_MEMBER: {
    status: 404,
    zh: "用户 {{userId}} 不是项目 {{projectId}} 的成员",
    en: "User {{userId}} is not a member of project {{projectId}}",
  },
  /**
   * AUTH-02：角色值不在白名单（viewer/editor/admin）。
   *
   * zh 逐字取自 `project-access.service.ts` 的 `assertRole` 原文案——它是 DTO
   * 之外的第二道闸（防 service 被内部调用绕过），文案里带**实际收到的值**，
   * 便于定位是谁传错了。
   */
  PROJECT_INVALID_ROLE: {
    status: 400,
    zh: "项目角色非法：{{role}}；应为 viewer、editor、admin 之一",
    en: "Invalid project role: {{role}}; expected one of viewer, editor, admin",
  },
  /**
   * 读面（列项目成员）：调用方不是该项目成员 → **403**。
   *
   * ⚠️ 与 404 的 `PROJECT_NOT_MEMBER` **不是同一个码**，别看语义相近就合并：
   *   · 本码（403）：**读**一个已知存在的项目的成员列表，而你不是成员 →
   *     身份成立、**授权**被拒。旧实现是 `ForbiddenException("你不是该项目成员")`，
   *     状态码与文案都要保住（前端按 403 走"申请加入/找管理员"，按 404 走"回列表"，
   *     是两套 UI 处置）；
   *   · `PROJECT_NOT_MEMBER`（404）：**写**（`updateMember`）时那条**成员关系行**
   *     不存在 → 寻址失败，不是授权失败。
   * 两者可触发的动作不同（读越权 vs 改不存在的成员），故分列。
   *
   * zh 与旧文案逐字一致（「你不是该项目成员」）。
   */
  PROJECT_ACCESS_DENIED: {
    status: 403,
    zh: "你不是该项目成员",
    en: "You are not a member of this project",
  },
} as const satisfies Record<string, ErrorCodeDef>;
