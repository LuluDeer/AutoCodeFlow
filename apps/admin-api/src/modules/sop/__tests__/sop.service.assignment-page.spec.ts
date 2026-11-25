/**
 * SOP-TRUNCATION-01：指派列表的静默截断回归。
 *
 * 旧 `listAssignments()` 固定 take:100 且无 total/hasMore；按 createdAt DESC
 * 排在第 101+ 的旧工单永远不可见，MCP 会误报"无待办"。这里用 101 条夹具
 * 钉住新分页读面的两个事实：第一页必须报 hasMore，offset=100 必须能取到第
 * 101 条；同时确认旧方法的裸数组契约未变。
 */
import { SopService } from "../sop.service";

const SOP_ID = "sop-1";

function harness() {
  const rows = Array.from({ length: 101 }, (_, i) => ({
    id: `a-${i + 1}`,
    sopId: SOP_ID,
    status: "assigned",
    createdAt: new Date(2026, 0, 1).toISOString(),
  }));
  const sops = {
    findOne: jest.fn(async () => ({ id: SOP_ID })),
  };
  const find = jest.fn(async (o: { skip?: number; take?: number }) => {
    const skip = o.skip ?? 0;
    return rows.slice(skip, skip + (o.take ?? rows.length));
  });
  const count = jest.fn(async (o: { where?: { status?: unknown } }) =>
    o.where?.status ? 101 : rows.length,
  );
  const assignments = { find, count };
  const svc = new (
    SopService as unknown as new (...args: unknown[]) => SopService
  )(
    sops,
    undefined,
    assignments,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  );
  return { svc, find, count, rows };
}

describe("SopService.listAssignmentsPage 指派分页（SOP-TRUNCATION-01）", () => {
  it("101 条夹具：默认第一页 100 条且 hasMore=true、total/pendingTotal=101", async () => {
    const { svc, find, count } = harness();
    const page = await svc.listAssignmentsPage(SOP_ID);
    expect(page.items).toHaveLength(100);
    expect(page.items[0].id).toBe("a-1");
    expect(page.hasMore).toBe(true);
    expect(page.total).toBe(101);
    expect(page.pendingTotal).toBe(101);
    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 101 }),
    );
    expect(count).toHaveBeenCalledTimes(2);
  });

  it("offset=100 取到第 101 条且 hasMore=false", async () => {
    const { svc, find } = harness();
    const page = await svc.listAssignmentsPage(SOP_ID, {
      offset: 100,
      limit: 100,
    });
    expect(page.items.map((r) => r.id)).toEqual(["a-101"]);
    expect(page.hasMore).toBe(false);
    expect(page.offset).toBe(100);
    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 100, take: 101 }),
    );
  });

  it("旧 listAssignments 仍只返回裸数组 100 条（向后兼容）", async () => {
    const { svc } = harness();
    const items = await svc.listAssignments(SOP_ID);
    expect(Array.isArray(items)).toBe(true);
    expect(items).toHaveLength(100);
  });
});
