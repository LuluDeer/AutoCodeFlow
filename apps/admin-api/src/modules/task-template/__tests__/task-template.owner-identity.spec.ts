/**
 * R39-A1：`task_templates.createdBy` 归属漂移的回归断言（R32-A5 遗留）。
 *
 * ## 缺陷（本档上半部分先把它钉住）
 * 旧实现把属主落在 **username** 上，判定是
 * `tpl.createdBy !== requester.username && !isAdmin`（task-template.service.ts）。
 * username 是**可变且可回收**的标签：
 *  - `users.service.remove` 是**硬删除**（`users.remove(target)`），users.username
 *    的唯一索引随之释放 ⇒ 同名新号可以注册；
 *  - 于是「A 建模板 → A 被删 → 同名新号 B 登录」后，B 的 username 与键相同 ⇒
 *    判定放行 ⇒ **B 能删 A 的模板**（越权，不只是可用性）。
 *
 * ## 为什么下面第一条用例能直接复现缺陷
 * 历史行的 `createdBy` **就是修复前的数据形态**（裸 username）。本档第 3 条 describe
 * 对一个这样的行断言「同名新号可删」——那条断言把旧语义的漏洞固定成可执行事实；
 * 一旦有人把判定改回比名字，它就永远绿，而第 2 条 describe 的核心用例会红。
 *
 * ## 修复后应当成立的性质
 *  - 新键 `user:<id>|<username>`：只看 id → 删号后同名新号 id 不同 ⇒ 403；
 *    顺带修掉「改名即失属主」；
 *  - 历史行（裸 username）仍按 username 判 → 兼容路径，避免「谁都删不掉」；
 *  - 请求方缺 id ⇒ keyed 行恒 403（fail-closed，绝不回退比名字）。
 *
 * 判定不查 users 表（属主信息全在键里），所以「A 被删」无需在桩里模拟：
 * 服务拿不到 A 的任何行，这正是必须把 id 写进键的原因。
 */

import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ForbiddenException } from "@nestjs/common";
import { TaskTemplateService } from "../task-template.service";
import { TaskTemplate } from "../entities/task-template.entity";
import { TaskService } from "../../task/task.service";
import { Task } from "../../task/entities/task.entity";
import { UserRole } from "../../users/entities/user.entity";
import {
  buildTemplateOwnerKey,
  isTemplateOwner,
  parseTemplateOwnerKey,
  TEMPLATE_OWNER_KEY_MAX_LENGTH,
} from "../task-template.util";

type Any = Record<string, any>;

const VALID_CONFIG = {
  triggerType: "manual",
  runtime: "node",
  entrypoint: "x.js",
};

/** 内存版 repo：create→save→delete 走同一 store，便于断言「行还在/已删」。 */
async function makeService() {
  const store = new Map<string, TaskTemplate>();
  let seq = 0;
  const repo = {
    find: jest.fn(async () => Array.from(store.values())),
    findOne: jest.fn(async (opts: Any) => {
      const where: Any = opts?.where ?? {};
      if (where.id) return store.get(where.id) ?? null;
      if (where.key) {
        for (const row of store.values()) {
          if (row.key === where.key) return row;
        }
      }
      return null;
    }),
    create: jest.fn(
      (d: Any) => ({ id: `tpl-${++seq}`, ...d }) as unknown as TaskTemplate,
    ),
    save: jest.fn(async (e: TaskTemplate) => {
      store.set(e.id, e);
      return e;
    }),
    delete: jest.fn(async (crit: Any) => {
      store.delete(crit.id);
      return { affected: 1 };
    }),
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      TaskTemplateService,
      { provide: getRepositoryToken(TaskTemplate), useValue: repo },
      {
        provide: getRepositoryToken(Task),
        useValue: { findOne: jest.fn(async () => null) },
      },
      {
        provide: TaskService,
        useValue: { create: jest.fn(async () => ({ id: "task-1" })) },
      },
    ],
  }).compile();
  return {
    svc: moduleRef.get(TaskTemplateService),
    repo,
    store,
    /** 直接塞一行（模拟历史行/已存在的行）。 */
    seed(row: Partial<TaskTemplate>) {
      const full = {
        id: "seeded-1",
        key: "seeded",
        name: "seeded",
        description: null,
        category: null,
        config: { ...VALID_CONFIG },
        isOfficial: false,
        createdBy: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...row,
      } as unknown as TaskTemplate;
      store.set(full.id, full);
      return full;
    },
  };
}

const alice = { id: 1, username: "alice", role: UserRole.USER };
const bob = { id: 2, username: "bob", role: UserRole.USER };
const admin = { id: 99, username: "root", role: UserRole.ADMIN };

describe("属主键编码：buildTemplateOwnerKey / parseTemplateOwnerKey", () => {
  it("新键形如 user:<id>|<username>，可被解析回 id", () => {
    expect(buildTemplateOwnerKey({ id: 7, username: "alice" })).toBe(
      "user:7|alice",
    );
    expect(parseTemplateOwnerKey("user:7|alice")).toEqual({
      kind: "keyed",
      userId: 7,
    });
  });

  it("username 达 128（实体上限）时键仍 ≤ 列宽 100，且 id 不丢", () => {
    const long = "u".repeat(128);
    const key = buildTemplateOwnerKey({ id: 123456, username: long });
    expect(key.length).toBeLessThanOrEqual(TEMPLATE_OWNER_KEY_MAX_LENGTH);
    expect(key.startsWith("user:123456|")).toBe(true);
    expect(parseTemplateOwnerKey(key)).toEqual({ kind: "keyed", userId: 123456 });
  });

  it("username 含分隔符/冒号也不破坏解析（id 段在前、首个 | 之后全归展示段）", () => {
    const key = buildTemplateOwnerKey({ id: 5, username: "a|b:c" });
    expect(key).toBe("user:5|a|b:c");
    expect(parseTemplateOwnerKey(key)).toEqual({ kind: "keyed", userId: 5 });
  });

  it("历史行（裸 username）解析为 legacy；`user:` 但不是 `user:<digits>|` 也回退 legacy", () => {
    expect(parseTemplateOwnerKey("alice")).toEqual({
      kind: "legacy",
      username: "alice",
    });
    // 不含 | 的 user:<digits> 不算新键——避免把「名字长得像键」的历史行误判成别的 id
    expect(parseTemplateOwnerKey("user:42")).toEqual({
      kind: "legacy",
      username: "user:42",
    });
    expect(parseTemplateOwnerKey("user:abc|x")).toEqual({
      kind: "legacy",
      username: "user:abc|x",
    });
  });
});

describe("isTemplateOwner：id 权威 / 历史行回退", () => {
  it("新键：id 相同即属主——username 改了也还是属主（修掉「改名即失属主」）", () => {
    const key = buildTemplateOwnerKey({ id: 1, username: "alice" });
    expect(
      isTemplateOwner(key, { id: 1, username: "alice-renamed" }),
    ).toBe(true);
  });

  it("新键：id 不同则**即使 username 相同**也不是属主（同名新号继承的正面阻断）", () => {
    const key = buildTemplateOwnerKey({ id: 1, username: "alice" });
    expect(isTemplateOwner(key, { id: 2, username: "alice" })).toBe(false);
  });

  it("历史行：username 相等即属主（兼容路径）；不等则否", () => {
    expect(isTemplateOwner("alice", { id: 1, username: "alice" })).toBe(true);
    expect(isTemplateOwner("alice", { id: 2, username: "bob" })).toBe(false);
  });

  it("请求方缺 id：新键恒不判为属主（fail-closed，不回退比名字）", () => {
    const key = buildTemplateOwnerKey({ id: 1, username: "alice" });
    expect(
      isTemplateOwner(key, { username: "alice" } as unknown as {
        id: number;
        username: string;
      }),
    ).toBe(false);
  });
});

describe("TaskTemplateService.remove：删号后同名新号不得继承归属", () => {
  it("A(id=1,'alice') 建模板 → 落库键 user:1|alice", async () => {
    const h = await makeService();
    const created = await h.svc.create(
      { name: "Owned", config: { ...VALID_CONFIG } },
      { id: 1, username: "alice" },
    );
    expect(created.createdBy).toBe("user:1|alice");
  });

  it("核心回归：A 建模板 → A 被删 → 同名新号 B(同 username、不同 id) 删除 → 403 且行仍在", async () => {
    const h = await makeService();
    const tpl = await h.svc.create(
      { name: "A 的模板", config: { ...VALID_CONFIG } },
      { id: alice.id, username: alice.username },
    );

    // A 被删号（users.service.remove 是硬删除，username 唯一索引释放）。
    // 此处无需模拟：服务判定只读键里的 id。
    // 同名新号 B 注册，id 与 A 不同（自增主键不会复用）。
    const sameName = { id: 2, username: "alice", role: UserRole.USER };

    // 状态码 403（instanceof 由 AppError 的原型映射保住）
    await expect(h.svc.remove(tpl.id, sameName)).rejects.toThrow(
      ForbiddenException,
    );
    // 业务码：确认拒绝原因是「非属主」，而不是被别的分支（官方模板/历史行）挡掉
    await expect(h.svc.remove(tpl.id, sameName)).rejects.toMatchObject({
      errorCode: "TASK_TEMPLATE_NOT_OWNER",
    });
    expect(h.repo.delete).not.toHaveBeenCalled();
    expect(h.store.has(tpl.id)).toBe(true);
  });

  it("对照：同一个 A 自己删（同 id）→ 放行（用例测的是身份而非「一律拒绝」）", async () => {
    const h = await makeService();
    const tpl = await h.svc.create(
      { name: "A 的模板", config: { ...VALID_CONFIG } },
      { id: alice.id, username: alice.username },
    );
    await h.svc.remove(tpl.id, alice);
    expect(h.repo.delete).toHaveBeenCalledWith({ id: tpl.id });
    expect(h.store.has(tpl.id)).toBe(false);
  });

  it("A 改名后仍是属主（判定按 id，不按名字）", async () => {
    const h = await makeService();
    const tpl = await h.svc.create(
      { name: "A 的模板", config: { ...VALID_CONFIG } },
      { id: 1, username: "alice" },
    );
    await h.svc.remove(tpl.id, {
      id: 1,
      username: "alice-renamed",
      role: UserRole.USER,
    });
    expect(h.repo.delete).toHaveBeenCalledWith({ id: tpl.id });
  });

  it("他人（不同 id 不同名）删除 → 403", async () => {
    const h = await makeService();
    const tpl = await h.svc.create(
      { name: "A 的模板", config: { ...VALID_CONFIG } },
      { id: 1, username: "alice" },
    );
    await expect(h.svc.remove(tpl.id, bob)).rejects.toThrow(
      ForbiddenException,
    );
    expect(h.repo.delete).not.toHaveBeenCalled();
  });

  it("请求方缺 id 时新键行不被放行（fail-closed，防内部调用漏传 id 静默退化为比名字）", async () => {
    const h = await makeService();
    const tpl = await h.svc.create(
      { name: "A 的模板", config: { ...VALID_CONFIG } },
      { id: 1, username: "alice" },
    );
    await expect(
      h.svc.remove(tpl.id, {
        username: "alice",
        role: UserRole.USER,
      } as unknown as { id: number; username: string; role: UserRole }),
    ).rejects.toThrow(ForbiddenException);
    expect(h.repo.delete).not.toHaveBeenCalled();
  });

  it("ADMIN 可删任意属主（新键/历史行）", async () => {
    const h = await makeService();
    const keyed = h.seed({ id: "k-1", key: "k1", createdBy: "user:1|alice" });
    const legacy = h.seed({ id: "l-1", key: "l1", createdBy: "alice" });
    await h.svc.remove(keyed.id, admin);
    await h.svc.remove(legacy.id, admin);
    expect(h.repo.delete).toHaveBeenCalledTimes(2);
  });
});

describe("历史行兼容 + 残余风险（未回填前不可消除）", () => {
  it("历史行（裸 username）仍可被正确的人管理——兼容路径，避免「谁都删不掉」", async () => {
    const h = await makeService();
    const tpl = h.seed({ id: "legacy-1", key: "legacy", createdBy: "alice" });
    await h.svc.remove(tpl.id, alice);
    expect(h.repo.delete).toHaveBeenCalledWith({ id: "legacy-1" });
  });

  it(
    "缺陷复现（历史行形态）：同名新号 B 能删 A 的模板——旧判定只比 username 的实证；" +
      "修复只对新写入的行生效，历史行需回填才能一并堵住",
    async () => {
    const h = await makeService();
    // 修复前**所有**行都是这个形态，所以这条断言等价于「旧实现的越权可复现」。
    const tpl = h.seed({ id: "legacy-2", key: "legacy2", createdBy: "alice" });
    const sameName = { id: 2, username: "alice", role: UserRole.USER };
    await h.svc.remove(tpl.id, sameName);
    expect(h.repo.delete).toHaveBeenCalledWith({ id: "legacy-2" });
  });
});

describe("create 缺省创建者：沿用历史行语义（createdBy=NULL，仅 ADMIN 可删）", () => {
  it("不传 creator → createdBy=null；普通用户删 → 403 LEGACY_ADMIN_ONLY", async () => {
    const h = await makeService();
    const tpl = await h.svc.create({ name: "anon", config: { ...VALID_CONFIG } });
    expect(tpl.createdBy).toBeNull();
    await expect(h.svc.remove(tpl.id, alice)).rejects.toThrow(
      ForbiddenException,
    );
  });
});
