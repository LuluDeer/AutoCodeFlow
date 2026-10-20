import { SopService } from "../sop.service";

/**
 * R34-A1（sop 审计 · 轴 4 · 失败面）：**owner 字段是 user id 还是 username**。
 *
 * ## 为什么这决定「改名 / 删号 / 同名新号」三条故障线
 * `task_templates.createdBy` 存的是 **username**（task-template.service.ts:138-142
 * 用 `tpl.createdBy !== requester.username` 判属主），于是：用户改名 → 属主判定
 * 立刻失效；用户被删 → 新注册的同名账号**继承**旧模板的删除权。
 *
 * sop 这一侧存的是 **`user:<uuid>`**（控制器在 sop.controller.ts 统一加前缀，
 * 实体列是普通文本）。本档把这条契约钉成可执行断言，并钉住它的两个随附性质：
 *  · **编辑不改归属**：draft 对已存在的 slug 不写 createdBy（编辑权 ≠ 归属权）；
 *  · **发布不改主表属主**：publishedBy 落在不可变的版本快照上。
 *
 * 为什么值得单独钉：这些性质在测试里全是「无并发也绿」的那一类，一旦被
 * 「顺手透传入参」的改动打破，症状是**属主字段静默漂移**，而不是报错。
 */

type Any = Record<string, any>;

function harness(sop?: Any) {
  const sopStore: Any = {
    id: "sop-1",
    slug: "daily-report",
    title: "日报",
    status: "draft",
    currentVersion: null,
    applicationId: null,
    frontMatterJson: {
      acceptance: [{ kind: "command", run: "echo ok" }],
    },
    bodyMarkdown: "正文",
    createdBy: "user:11111111-2222-3333-4444-555555555555",
    ...sop,
  };
  const versionRows: Any[] = [];
  const sops = {
    update: jest.fn(async (where: Any, patch: Any) => {
      Object.assign(sopStore, patch);
      return { affected: 1 };
    }),
    findOne: jest.fn(async ({ where }: Any) =>
      where.slug === sopStore.slug || where.id === sopStore.id
        ? { ...sopStore }
        : null,
    ),
    create: jest.fn((v: Any) => ({ ...v })),
    save: jest.fn(async (v: Any) => {
      Object.assign(sopStore, v);
      return v;
    }),
  };
  const versions = {
    findOne: jest.fn(async () => null),
    create: jest.fn((v: Any) => ({ ...v })),
    save: jest.fn(async (v: Any) => {
      versionRows.push({ ...v });
      return v;
    }),
  };
  const service = Object.assign(Object.create(SopService.prototype), {
    sops,
    versions,
    assignments: { create: jest.fn((v: Any) => ({ ...v })), save: jest.fn(async (v: Any) => v) },
    clarifications: {},
    scheduler: { getStats: () => ({ isLeader: true }) },
    config: { get: () => undefined },
    notifications: { notify: jest.fn(async () => undefined) },
    agentSessions: { create: jest.fn(async () => ({ id: "s" })) },
    agentQueue: { add: jest.fn(async () => undefined) },
    executors: { getAgentCapabilities: jest.fn(async () => ["agent:sop"]) },
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  }) as SopService;
  return { service, sopStore, sops, versions, versionRows };
}

const NEW_OWNER = "user:99999999-8888-7777-6666-555555555555";

describe("R34-A1 轴4 · sop 的 owner 字段（归属契约）", () => {
  it("编辑既有 SOP：即使入参给了别的 createdBy，属主也不被改写（编辑权 ≠ 归属权）", async () => {
    const h = harness();

    await h.service.draft({
      slug: "daily-report",
      title: "日报 v2",
      bodyMarkdown: "新正文",
      createdBy: NEW_OWNER,
    });

    expect(h.sopStore.createdBy).toBe(
      "user:11111111-2222-3333-4444-555555555555",
    );
    expect(h.sopStore.title).toBe("日报 v2");
  });

  it("新建 SOP：createdBy 原样落库（service 不加/不改前缀，形态由控制器统一决定）", async () => {
    const h = harness();

    await h.service.draft({
      slug: "brand-new",
      title: "新 SOP",
      createdBy: NEW_OWNER,
    });

    expect(h.sopStore.createdBy).toBe(NEW_OWNER);
    // 属主是可解析的 `user:<uuid>`，不是 username（对比 task_templates）
    expect(h.sopStore.createdBy).toMatch(
      /^user:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("发布：publishedBy 只落在不可变版本快照上，主表 createdBy 不被改写", async () => {
    const h = harness({ currentVersion: null });

    const out = await h.service.publish({
      sopId: "sop-1",
      bump: "patch",
      publishedBy: "user:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    });

    expect(h.versions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        publishedBy: "user:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      }),
    );
    expect(out.version.version).toBe("1.0.0");
    // 发布只前移 currentVersion/status，属主列保持原值
    expect(h.sopStore.createdBy).toBe(
      "user:11111111-2222-3333-4444-555555555555",
    );
    expect(h.sopStore.currentVersion).toBe("1.0.0");
  });

  it("同名新号不能继承属主：归属键是 uuid，username 变了也不影响判定", async () => {
    const h = harness({
      createdBy: "user:11111111-2222-3333-4444-555555555555",
    });
    // 同名的另一个人（新 uuid）编辑这条 SOP：属主仍是原 uuid
    await h.service.draft({
      slug: "daily-report",
      title: "被同名新号编辑过",
      createdBy: "user:22222222-3333-4444-5555-666666666666",
    });
    expect(h.sopStore.createdBy).toBe(
      "user:11111111-2222-3333-4444-555555555555",
    );
  });
});
