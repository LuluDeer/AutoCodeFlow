import { SopService } from "../sop.service";

/**
 * F-54（UIAUDIT 后端轮 P3-1）：sop list 的 page 上限钳制单测。
 *
 * sop.service.list 与 agent-session.service.list 是同一份 clamp 模式（NaN 守卫
 * + page≥1 + pageSize≤100）。本批补 page≤10000（NETOPT-3④ 口径，同 events
 * 先例 2ea869fc），钉住两点：
 *   · ?page=99999999 钳到 10000（不再生成 OFFSET ~2e9 的深 OFFSET + 全量 COUNT）；
 *   · 超限走**钳制回落**而非 400——与两处 service 头注「非法深链安全回落」
 *     契约一致（故本批不做 DTO 层 @Max，见 fix-b1 报告的偏差说明）。
 *
 * harness 说明：list() 只触碰 this.sops（createQueryBuilder 链），其余构造
 * 依赖以 undefined 占位（同文件其他 spec 用 Object.create/直 new 的既有口径
 * ——审计旁路语义见 sop.service 头注的 @Optional auditService 注释）。
 */
function sopListHarness() {
  const listQb: Record<string, jest.Mock> = {
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn(async () => [[{ id: "sop-1" }], 1]),
  };
  const sops = {
    createQueryBuilder: jest.fn(() => listQb),
  };
  const svc = new (SopService as unknown as new (
    ...args: unknown[]
  ) => SopService)(
    sops,
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
  return { svc, listQb };
}

describe("SopService.list 的 page 上限钳制（F-54）", () => {
  it("page=99999999 钳到 10000（skip=(10000-1)*pageSize）", async () => {
    const { svc, listQb } = sopListHarness();
    await svc.list({ page: 99999999, pageSize: 20 });
    expect(listQb.skip).toHaveBeenCalledWith(9999 * 20);
    expect(listQb.take).toHaveBeenCalledWith(20);
  });

  it("边界内不钳：page=10000 原样（对齐 PageQueryDto @Max(10000) 口径）", async () => {
    const { svc, listQb } = sopListHarness();
    await svc.list({ page: 10000, pageSize: 20 });
    expect(listQb.skip).toHaveBeenCalledWith(9999 * 20);
  });

  it("NaN 回落契约不回退：非有限 page 仍回落 1（不 400）", async () => {
    const { svc, listQb } = sopListHarness();
    await svc.list({ page: Number.NaN, pageSize: 20 });
    expect(listQb.skip).toHaveBeenCalledWith(0);
  });
});
