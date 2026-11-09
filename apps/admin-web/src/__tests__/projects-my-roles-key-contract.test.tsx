/**
 * D-24 缓存键契约：`['projects','me','roles']` 必须走工厂，且成员变更必须**显式**失效它。
 *
 * ## 为什么需要这个文件（缺陷类型，不是假想）
 *
 * TanStack Query 的失效是**纯前缀字符串匹配**：
 *   `invalidateQueries({ queryKey: ['projects','list'] })` 只命中以
 *   `['projects','list', …]` 开头的查询。
 * 而 `['projects','list']` **不是** `['projects','me','roles']` 的前缀（第二段就不同）
 * ⇒ 两者在缓存树上是**兄弟**，不是父子。
 *
 * 真实缺陷（本轮修复前）：
 *   · `ExecutorDetailPage.tsx` **内联裸写** `['projects','me','roles']`（不在工厂里）；
 *   · `ProjectsPage` 的成员增删只失效 `projects.members(id)` 与 `projects.list`；
 *   ⇒ **成员变更后，非 admin 用户在执行器详情页的「编辑 / 配置热更新」入口可见性
 *     停在旧快照**，必须整页刷新才更新。**全程无报错**——失效打空是静默空操作。
 *
 * ## 断言分两层（刻意如此）
 *
 * ① **运行时语义层**：用真实 `QueryClient`，把 myRoles 注册进缓存，然后用
 *    `projects.list` 的键去失效 ⇒ 断言**没有**被失效（钉住"兄弟不是父子"这个事实）；
 *    再用 `projects.myRoles` 失效 ⇒ 断言**真的**被失效。这一层不依赖源码文本，
 *    改实现细节（换函数名/换写法）不会误报。
 * ② **结构层**：断言 `ExecutorDetailPage.tsx` **不再**内联裸写该键，且
 *    `ProjectsPage.tsx` 的成员失效路径**包含** `myRoles`。这一层挡"有人把工厂键删了
 *    或绕过工厂内联重写"。
 *
 * ## 反向验证（本轮的强制纪律）
 *
 * 把 `ProjectsPage` 里那行 `invalidateQueries({ queryKey: queryKeys.projects.myRoles })`
 * 注释掉 ⇒ 本文件第 ② 层立刻红。这是「守卫能挡住回归」的实证，不是声称。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "../api/queries";

const HERE = dirname(new URL(import.meta.url).pathname);
const SRC = resolve(HERE, "..");

function read(rel: string): string {
  return readFileSync(join(SRC, rel), "utf8");
}

/**
 * 剥注释后再判定——**这不是洁癖，是反向实证抓出来的真洞**：
 * 第一版守卫直接对原始源码 `toMatch(/queryKeys\.projects\.myRoles/)`，
 * 于是把 `invalidateQueries(...myRoles)` 那行**注释掉**后，注释里仍有这段文本
 * ⇒ 守卫**仍然通过** ⇒ 守卫证明不了任何事。
 * （与本轮 F-8 的教训同族：`grep` 到 3 处但全在注释里 ⇒ 误判「代码已接」。）
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("D-24 缓存键契约：projects.myRoles", () => {
  it("工厂键形状不变（改名会让失效方静默打空）", () => {
    expect(queryKeys.projects.myRoles).toEqual(["projects", "me", "roles"]);
  });

  it("运行时语义：projects.list 不前缀匹配 projects.myRoles（兄弟不是父子）", async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const rolesKey = [...queryKeys.projects.myRoles];

    // 注册一个 myRoles 查询（不真的发请求：queryFn 返回固定值）
    await qc.prefetchQuery({
      queryKey: rolesKey,
      queryFn: () => ({ memberships: [] }),
    });
    expect(qc.getQueryData(rolesKey)).toBeDefined();

    // ① 用 list 键失效 ⇒ 不得命中（这正是修复前的缺陷形态）
    await qc.invalidateQueries({ queryKey: queryKeys.projects.list });
    expect(qc.getQueryState(rolesKey)?.isInvalidated).toBe(false);

    // ② 用 myRoles 键失效 ⇒ 必须命中（这是修复后的正确失效路径）
    await qc.invalidateQueries({ queryKey: queryKeys.projects.myRoles });
    expect(qc.getQueryState(rolesKey)?.isInvalidated).toBe(true);

    qc.clear();
  });

  it("ExecutorDetailPage 不得内联裸写该键（必须走工厂）", () => {
    const src = stripComments(read("pages/ExecutorDetailPage.tsx"));
    // 内联形态：['projects', 'me', 'roles'] —— 引号/空格容错
    expect(src).not.toMatch(
      /\[\s*['"]projects['"]\s*,\s*['"]me['"]\s*,\s*['"]roles['"]\s*\]/,
    );
    expect(src).toMatch(/queryKeys\.projects\.myRoles/);
  });

  it("ProjectsPage 的成员失效必须显式覆盖 myRoles（不能靠 projects.all 级联）", () => {
    const src = stripComments(read("pages/ProjectsPage.tsx"));
    expect(src).toMatch(/queryKeys\.projects\.myRoles/);
    // 反向：不允许用 projects.all 这种整前缀级联（本仓已移除该键）
    expect(src).not.toMatch(/queryKeys\.projects\.all\b/);
  });

  /**
   * **删除项目**同样会让 myRoles 陈旧——这一条极易漏，因为「成员变更」
   * 直觉上只指成员抽屉里的增删。
   *
   * 事实依据：`project_members` 的外键是 `ON DELETE CASCADE`
   * （apps/admin-api/src/migrations/1790000000015-CreateProjectMembers.ts:32），
   * 项目一删，成员行随之清理 ⇒ `GET /projects/me/roles` 的返回变了。
   * 而删除走的是 `invalidateList()`（与新建/编辑共用），若那里不失效 myRoles，
   * ExecutorDetailPage 的入口可见性会停在删除前的快照。
   *
   * 断言方式：从**去注释后**的源码里定位 `invalidateList` 的函数体，
   * 断言其内部含 `queryKeys.projects.myRoles`——比「全文件出现一次」更严
   * （全文件出现一次不足以说明删除路径被覆盖）。
   */
  it("删除项目走的 invalidateList() 必须失效 myRoles（成员行 ON DELETE CASCADE）", () => {
    const src = stripComments(read("pages/ProjectsPage.tsx"));
    // 定位 invalidateList 的函数体（到下一个 `}, [queryClient])` 之前）
    const start = src.indexOf("const invalidateList = useCallback(");
    expect(start, "未找到 invalidateList 定义").toBeGreaterThan(-1);
    const end = src.indexOf("}, [queryClient]);", start);
    expect(end, "未找到 invalidateList 的结尾").toBeGreaterThan(start);
    const body = src.slice(start, end);
    expect(
      body,
      "invalidateList() 内必须失效 queryKeys.projects.myRoles：" +
        "删除项目会因 project_members 的 ON DELETE CASCADE 清掉成员行，" +
        "roles 读面随之陈旧",
    ).toMatch(/queryKeys\.projects\.myRoles/);
  });
});
