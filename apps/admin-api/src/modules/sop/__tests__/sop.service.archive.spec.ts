import { SopService } from "../sop.service";

/**
 * SOP 归档 / 恢复（2026-10-23）。
 *
 * ## 这条用例补的是什么缺口
 *
 * `SOP_STATUSES` 从 SOP 落地起就有 `deprecated`，DTO 的 enum 也一直带着它，
 * 但**全仓没有任何写入点**（`grep '"deprecated"'` 只命中实体与 DTO 定义）。
 * 于是 SOP 只增不减：实测 demo 库 19 条里 16 条是 `headless-smoke-*` 测试残留，
 * 界面上既不能删也不能下线。
 *
 * 本文件钉住四条语义边界，都是「删掉守卫也不会变红」的那类：
 *  ① 有未结束指派时拒绝归档（否则执行器手里还拿着单、中台却认为已下线）；
 *  ② 已归档再归档 → 409（不是静默 200，避免"以为归档了但没"）；
 *  ③ 归档**不删**版本 / 指派 / 澄清（只写 status 一列）；
 *  ④ 恢复按「有没有发布过」分流：发布过 → published，没发布过 → draft。
 */

type Any = Record<string, any>;

const HOUR = 60 * 60 * 1000;

/** FindOperator 语义的最小实现（in / not），其余一律报错防假绿。 */
function valueMatches(actual: unknown, expected: unknown): boolean {
  if (expected && typeof expected === "object" && "type" in (expected as Any)) {
    const op = expected as Any;
    if (op.type === "in") return (op.value as unknown[]).includes(actual);
    if (op.type === "not") return !valueMatches(actual, op.child);
    throw new Error(`fake 不支持的操作符: ${String(op.type)}`);
  }
  return actual === expected;
}

function whereMatches(row: Any, where: Any): boolean {
  return Object.entries(where ?? {}).every(([k, v]) => valueMatches(row[k], v));
}

function harness(
  options: {
    sop?: Any;
    activeAssignments?: number;
    auditThrows?: boolean;
  } = {},
) {
  const sopRow: Any = {
    id: "sop-1",
    slug: "demo-sop",
    title: "Demo",
    status: "published",
    currentVersion: "1.0.0",
    frontMatterJson: { acceptance: [] },
    bodyMarkdown: "Do the work",
    createdAt: new Date(Date.now() - HOUR),
    updatedAt: new Date(Date.now() - HOUR),
    ...options.sop,
  };

  const sops = {
    findOne: jest.fn(async () => ({ ...sopRow })),
    // 条件 UPDATE：where 不匹配 → affected=0（与真 DB 同语义）
    update: jest.fn(async (where: Any, patch: Any) => {
      if (!whereMatches(sopRow, where)) return { affected: 0 };
      Object.assign(sopRow, patch);
      return { affected: 1 };
    }),
  };
  const assignments = {
    // 未结束指派计数（归档守卫）
    count: jest.fn(async () => options.activeAssignments ?? 0),
  };
  const audit = {
    log: options.auditThrows
      ? jest.fn(async () => {
          throw new Error("audit down");
        })
      : jest.fn(async () => undefined),
  };

  const service = Object.assign(Object.create(SopService.prototype), {
    sops,
    assignments,
    auditService: audit,
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  }) as SopService;

  return { service, sopRow, sops, assignments, audit };
}

describe("SOP 归档 deprecate（2026-10-23）", () => {
  it("已发布 SOP → status 置 deprecated，只写 status 一列", async () => {
    const h = harness();
    const out = await h.service.deprecate({ sopId: "sop-1", actor: "user:1" });

    expect(out.status).toBe("deprecated");
    expect(h.sopRow.status).toBe("deprecated");
    // 版本指针不动（归档不是发布，也不是回滚）
    expect(h.sopRow.currentVersion).toBe("1.0.0");
    // 断言写面形状：只 patch status
    const patch = (h.sops.update.mock.calls[0] as Any[])[1] as Any;
    expect(Object.keys(patch)).toEqual(["status"]);
  });

  it("有未结束指派 → 409，且不写库", async () => {
    const h = harness({ activeAssignments: 2 });
    await expect(h.service.deprecate({ sopId: "sop-1" })).rejects.toMatchObject(
      {
        errorCode: "SOP_ARCHIVE_HAS_ACTIVE_ASSIGNMENTS",
      },
    );
    expect(h.sops.update).not.toHaveBeenCalled();
    expect(h.sopRow.status).toBe("published");
  });

  it("指派统计只数「未结束」四态（assigned/in_progress/blocked/stalled）", async () => {
    const h = harness();
    await h.service.deprecate({ sopId: "sop-1" });
    const where = (h.assignments.count.mock.calls[0] as Any[])[0] as Any;
    const inOp = where.where.status as Any;
    expect(inOp.type).toBe("in");
    expect((inOp.value as string[]).sort()).toEqual(
      ["assigned", "blocked", "in_progress", "stalled"].sort(),
    );
  });

  it("已归档再归档 → 409（不是静默成功的 200）", async () => {
    const h = harness({ sop: { status: "deprecated" } });
    await expect(h.service.deprecate({ sopId: "sop-1" })).rejects.toMatchObject(
      { errorCode: "SOP_ALREADY_DEPRECATED" },
    );
    expect(h.sops.update).not.toHaveBeenCalled();
  });

  it("并发归档：条件 UPDATE 未命中 → 409（另一写者已先归档）", async () => {
    const h = harness();
    // 模拟「读快照后被别人改了状态」：条件写求值时谓词不再匹配
    h.sops.update.mockResolvedValueOnce({ affected: 0 } as never);
    await expect(h.service.deprecate({ sopId: "sop-1" })).rejects.toMatchObject(
      { errorCode: "SOP_ALREADY_DEPRECATED" },
    );
  });

  it("写审计 sop.deprecate（带 slug 与归档时的版本指针）", async () => {
    const h = harness();
    await h.service.deprecate({ sopId: "sop-1", actor: "user:9" });
    const payload = (h.audit.log.mock.calls[0] as Any[])[0] as Any;
    expect(payload.action).toBe("sop.deprecate");
    expect(payload.resourceId).toBe("sop-1");
    expect(payload.detail).toMatchObject({
      slug: "demo-sop",
      currentVersion: "1.0.0",
      actor: "user:9",
    });
  });

  it("审计失败不阻断归档（fail-open，与既有多处 safeAudit 同口径）", async () => {
    const h = harness({ auditThrows: true });
    const out = await h.service.deprecate({ sopId: "sop-1" });
    expect(out.status).toBe("deprecated");
    expect(h.sopRow.status).toBe("deprecated");
  });

  it("条件写的谓词是 status != deprecated（并发下只有一个能成功）", async () => {
    const h = harness();
    await h.service.deprecate({ sopId: "sop-1" });
    const where = (h.sops.update.mock.calls[0] as Any[])[0] as Any;
    expect(where.id).toBe("sop-1");
    expect((where.status as Any).type).toBe("not");
  });
});

describe("SOP 恢复 restore（2026-10-23）", () => {
  it("已归档 + 发布过 → 回到 published", async () => {
    const h = harness({
      sop: { status: "deprecated", currentVersion: "1.0.0" },
    });
    const out = await h.service.restore({ sopId: "sop-1", actor: "user:1" });
    expect(out.status).toBe("published");
    expect(h.sopRow.status).toBe("published");
    expect(((h.audit.log.mock.calls[0] as Any[])[0] as Any).action).toBe(
      "sop.restore",
    );
  });

  it("已归档但从未发布过 → 回到 draft（不凭空变 published）", async () => {
    const h = harness({ sop: { status: "deprecated", currentVersion: null } });
    const out = await h.service.restore({ sopId: "sop-1" });
    expect(out.status).toBe("draft");
    expect(h.sopRow.status).toBe("draft");
  });

  it("非归档态 → 409，且不写库", async () => {
    const h = harness({ sop: { status: "published" } });
    await expect(h.service.restore({ sopId: "sop-1" })).rejects.toMatchObject({
      errorCode: "SOP_NOT_DEPRECATED",
    });
    expect(h.sops.update).not.toHaveBeenCalled();
  });

  it("并发恢复：条件 UPDATE 未命中 → 409", async () => {
    const h = harness({ sop: { status: "deprecated" } });
    h.sops.update.mockResolvedValueOnce({ affected: 0 } as never);
    await expect(h.service.restore({ sopId: "sop-1" })).rejects.toMatchObject({
      errorCode: "SOP_NOT_DEPRECATED",
    });
  });
});

describe("SOP 取消未结束指派（2026-10-23）", () => {
  it("只取消未结束四态，返回实际条数", async () => {
    const h = harness();
    // 让 assignments.update 返回 affected=2（两条被取消）
    (h.assignments as Any).update = jest.fn(async () => ({ affected: 2 }));
    const out = await h.service.cancelOpenAssignments({
      sopId: "sop-1",
      actor: "user:1",
    });

    expect(out.cancelled).toBe(2);
    const [where, patch] = (h.assignments as Any).update.mock.calls[0] as Any[];
    expect(where.sopId).toBe("sop-1");
    // 谓词只含未结束四态（终态不得被改成 cancelled）
    expect((where.status as Any).type).toBe("in");
    expect((where.status as Any).value.sort()).toEqual(
      ["assigned", "blocked", "in_progress", "stalled"].sort(),
    );
    expect(patch).toEqual({ status: "cancelled" });
  });

  it("没有未结束指派 → cancelled=0，且不写审计（不制造空审计行）", async () => {
    const h = harness();
    (h.assignments as Any).update = jest.fn(async () => ({ affected: 0 }));
    const out = await h.service.cancelOpenAssignments({ sopId: "sop-1" });

    expect(out.cancelled).toBe(0);
    expect(h.audit.log).not.toHaveBeenCalled();
  });

  it("有取消时写 sop.assignment.cancel 审计（带实际条数）", async () => {
    const h = harness();
    (h.assignments as Any).update = jest.fn(async () => ({ affected: 1 }));
    await h.service.cancelOpenAssignments({ sopId: "sop-1", actor: "user:9" });

    const payload = (h.audit.log.mock.calls[0] as Any[])[0] as Any;
    expect(payload.action).toBe("sop.assignment.cancel");
    expect(payload.detail).toMatchObject({
      slug: "demo-sop",
      cancelled: 1,
      actor: "user:9",
    });
  });

  it("SOP 不存在 → 404，且不碰指派表", async () => {
    const h = harness();
    h.sops.findOne.mockResolvedValueOnce(null as never);
    (h.assignments as Any).update = jest.fn();
    await expect(
      h.service.cancelOpenAssignments({ sopId: "missing" }),
    ).rejects.toMatchObject({ errorCode: "SOP_NOT_FOUND" });
    expect((h.assignments as Any).update).not.toHaveBeenCalled();
  });

  it("取消后归档得以通过（端到端语义）", async () => {
    const h = harness({ activeAssignments: 2 });
    // 取消前：归档被拒
    await expect(h.service.deprecate({ sopId: "sop-1" })).rejects.toMatchObject(
      {
        errorCode: "SOP_ARCHIVE_HAS_ACTIVE_ASSIGNMENTS",
      },
    );

    // 取消指派
    (h.assignments as Any).update = jest.fn(async () => ({ affected: 2 }));
    await h.service.cancelOpenAssignments({ sopId: "sop-1" });

    // 取消后：计数归零，归档成功
    h.assignments.count.mockResolvedValue(0);
    const out = await h.service.deprecate({ sopId: "sop-1" });
    expect(out.status).toBe("deprecated");
  });
});
