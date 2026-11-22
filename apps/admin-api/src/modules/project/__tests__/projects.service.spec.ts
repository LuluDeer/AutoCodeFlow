import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { ProjectsService } from "../projects.service";
import { Project, DEFAULT_PROJECT_ID } from "../project.entity";
import { ProjectMember } from "../entities/project-member.entity";
import { Task } from "../../task/entities/task.entity";
import {
  TaskExecution,
  FAILED_EXECUTION_STATUSES,
} from "../../task/entities/task-execution.entity";
import { Application } from "../../application/entities/application.entity";

/**
 * AUTH-01: ProjectsService 单测——CRUD + 默认项目删除/改名拦截。
 * 仓库桩与 task.service.spec 的 makeRepo 同形态（轻量 jest.fn 表）。
 *
 * PROJECT-IMPACT-01 起本服务还注入 Task / ProjectMember 两条只读仓储
 * （删除影响面统计），故测试模块要一并提供——两者都标了 `@Optional()`，
 * 缺省也能编译，但**不提供就无法验证计数口径**，故此处给全。
 */
describe("ProjectsService（AUTH-01）", () => {
  let service: ProjectsService;
  let repo: Record<string, jest.Mock>;
  let taskRepo: Record<string, jest.Mock>;
  let memberRepo: Record<string, jest.Mock>;
  let appRepo: Record<string, jest.Mock>;
  let execRepo: Record<string, jest.Mock>;
  // summary 执行聚合走 QueryBuilder 链；共享一个链桩，每个方法返回 this。
  let execQb: Record<string, jest.Mock>;

  const makeRow = (over: Partial<Project> = {}): Project =>
    ({
      id: "11111111-1111-4111-8111-111111111111",
      name: "Proj A",
      description: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...over,
    }) as Project;

  beforeEach(async () => {
    repo = {
      create: jest.fn((d) => d),
      save: jest.fn(async (e) => e),
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      // R62：update 改列级写 —— 假仓储需要 update，且按真实语义把 patch 落到 findOne 返回的行上。
      update: jest.fn(async (where: any, patch: any) => {
        const row = await (repo as any).findOne({ where });
        if (!row) return { affected: 0 };
        Object.assign(row, patch);
        return { affected: 1 };
      }),
    };
    taskRepo = { count: jest.fn().mockResolvedValue(0) };
    memberRepo = { count: jest.fn().mockResolvedValue(0) };
    appRepo = { count: jest.fn().mockResolvedValue(0) };
    execQb = {
      innerJoin: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
      getMany: jest.fn().mockResolvedValue([]),
    };
    execRepo = { createQueryBuilder: jest.fn(() => execQb) };
    const module = await Test.createTestingModule({
      providers: [
        ProjectsService,
        { provide: getRepositoryToken(Project), useValue: repo },
        { provide: getRepositoryToken(Task), useValue: taskRepo },
        { provide: getRepositoryToken(ProjectMember), useValue: memberRepo },
        { provide: getRepositoryToken(Application), useValue: appRepo },
        { provide: getRepositoryToken(TaskExecution), useValue: execRepo },
      ],
    }).compile();
    service = module.get(ProjectsService);
  });

  describe("create", () => {
    it("落库 name + 可空 description", async () => {
      repo.create.mockImplementation((d) => ({ ...d }));
      const row = await service.create({ name: "P1", description: "d" });
      expect(repo.create).toHaveBeenCalledWith({
        name: "P1",
        description: "d",
      });
      expect(row.name).toBe("P1");
    });

    it("description 缺省归 null", async () => {
      repo.create.mockImplementation((d) => ({ ...d }));
      await service.create({ name: "P1" });
      expect(repo.create).toHaveBeenCalledWith({
        name: "P1",
        description: null,
      });
    });
  });

  describe("findAll / findOne", () => {
    it("findAll 按 createdAt ASC 返回", async () => {
      repo.find.mockResolvedValue([makeRow()]);
      const rows = await service.findAll();
      expect(repo.find).toHaveBeenCalledWith({
        order: { createdAt: "ASC" },
      });
      expect(rows).toHaveLength(1);
    });

    it("findOne 未命中抛 404", async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(
        service.findOne("22222222-2222-4222-8222-222222222222"),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("update", () => {
    it("正常更新字段", async () => {
      const row = makeRow();
      repo.findOne.mockResolvedValue(row);
      const saved = await service.update(row.id, { name: "Renamed" });
      expect(saved.name).toBe("Renamed");
      // R62：只写 dto 带来的列（不再整行 save —— 实体将来多出别的写者时，
      // 整行 save 会变成「顺手把旧值写回去」）
      expect(repo.update).toHaveBeenCalledWith(
        { id: row.id },
        { name: "Renamed" },
      );
      expect(repo.save).not.toHaveBeenCalled();
    });

    it("默认项目拒绝改名（404 拦截，与 remove 同文案）", async () => {
      const row = makeRow({ id: DEFAULT_PROJECT_ID, name: "Default" });
      repo.findOne.mockResolvedValue(row);
      await expect(
        service.update(DEFAULT_PROJECT_ID, { name: "Other" }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it("默认项目允许仅改 description（名字未出现）", async () => {
      const row = makeRow({ id: DEFAULT_PROJECT_ID, name: "Default" });
      repo.findOne.mockResolvedValue(row);
      const saved = await service.update(DEFAULT_PROJECT_ID, {
        description: "meta",
      });
      expect(saved.description).toBe("meta");
    });
  });

  describe("remove — 默认项目拦截", () => {
    it("删除默认项目抛 404（回填锚点不可删）", async () => {
      await expect(service.remove(DEFAULT_PROJECT_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(repo.delete).not.toHaveBeenCalled();
    });

    it("非默认项目正常删除", async () => {
      const row = makeRow();
      repo.findOne.mockResolvedValue(row);
      const res = await service.remove(row.id);
      expect(repo.delete).toHaveBeenCalledWith(row.id);
      expect(res).toEqual({ deleted: true });
    });

    it("删除不存在的项目抛 404", async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(
        service.remove("22222222-2222-4222-8222-222222222222"),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  /**
   * PROJECT-DUPNAME-01：撞 `UQ_projects_name` 时给「项目名已存在」而不是笼统的
   * 「资源已存在」。
   *
   * 为什么这条值得单测：它只在**落库那一刻**才暴露（预检查与 INSERT 之间仍有
   * 竞态窗口，且预检查本来就没做），而错误文案是用户唯一能看到的线索。
   */
  describe("重名（PROJECT-DUPNAME-01）", () => {
    const uniqueViolation = (constraint: string) =>
      Object.assign(new Error("duplicate key value"), {
        code: "23505",
        constraint,
      });

    it("create 撞 UQ_projects_name → 409 且文案带项目名", async () => {
      repo.save.mockRejectedValue(uniqueViolation("UQ_projects_name"));
      await expect(service.create({ name: "重复名" })).rejects.toMatchObject({
        // AppError 按状态码挂到内置异常原型上（见 app-error.ts），故按类断言
        status: 409,
      });
      await expect(service.create({ name: "重复名" })).rejects.toThrow(
        "重复名",
      );
    });

    it("create 撞**其它**唯一约束 → 原样抛（不误报成项目重名）", async () => {
      const err = uniqueViolation("uq_project_members_project_user");
      repo.save.mockRejectedValue(err);
      await expect(service.create({ name: "X" })).rejects.toBe(err);
    });

    it("约束名缺失（驱动差异）→ 原样抛，不猜", async () => {
      const err = Object.assign(new Error("dup"), { code: "23505" });
      repo.save.mockRejectedValue(err);
      await expect(service.create({ name: "X" })).rejects.toBe(err);
    });

    it("非唯一冲突（23503 等）→ 原样抛", async () => {
      const err = Object.assign(new Error("fk"), { code: "23503" });
      repo.save.mockRejectedValue(err);
      await expect(service.create({ name: "X" })).rejects.toBe(err);
    });

    it("update 改名撞同一索引 → 同样给可读文案", async () => {
      const row = makeRow();
      repo.findOne.mockResolvedValue(row);
      // R62：update 走列级 update，唯一索引冲突由它抛出（不再是 save）
      repo.update.mockRejectedValue(uniqueViolation("UQ_projects_name"));
      await expect(
        service.update(row.id, { name: "已被占用的名字" }),
      ).rejects.toThrow("已被占用的名字");
    });

    it("对照：ConflictException 是本码落到的异常类型（前端按 409 分支处置）", async () => {
      repo.save.mockRejectedValue(uniqueViolation("UQ_projects_name"));
      await expect(service.create({ name: "Dup" })).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  /**
   * PROJECT-IMPACT-01：删除影响面预览。
   *
   * 这是本轮为「项目已关联很多任务时执行删除」补的安全网：删除本身走
   * FK ON DELETE SET NULL（任务不消失、cron 照跑，但会退回默认项目判定，
   * 对非 ADMIN 变成「看得见改不动」）。确认框要能如实报数，前提是这里的
   * 计数口径正确——故逐条钉住「软删行不计入」「active 单独统计」「默认项目
   * 不可删」。
   */
  describe("describeRemovalImpact（PROJECT-IMPACT-01）", () => {
    it("返回项目名 / 任务数 / active 任务数 / 成员数 / 可删性", async () => {
      repo.findOne.mockResolvedValue(makeRow({ name: "数据平台组" }));
      taskRepo.count
        .mockResolvedValueOnce(12) // 非软删任务
        .mockResolvedValueOnce(7); // 其中 active
      memberRepo.count.mockResolvedValue(3);

      await expect(service.describeRemovalImpact("p1")).resolves.toEqual({
        projectName: "数据平台组",
        taskCount: 12,
        activeTaskCount: 7,
        memberCount: 3,
        deletable: true,
      });
    });

    it("任务计数排除软删行（status = deleted），active 口径只看 active", async () => {
      repo.findOne.mockResolvedValue(makeRow());
      await service.describeRemovalImpact("p1");

      // 第一次 = 总任务（Not(DELETED)），第二次 = active
      const [allWhere, activeWhere] = taskRepo.count.mock.calls.map(
        (c) => c[0].where,
      );
      expect(allWhere).toEqual({
        projectId: "p1",
        status: expect.objectContaining({ _type: "not" }),
      });
      expect(activeWhere).toEqual({ projectId: "p1", status: "active" });
    });

    it("默认项目：deletable=false（但仍返回真实计数，不提前 404）", async () => {
      repo.findOne.mockResolvedValue(
        makeRow({ id: DEFAULT_PROJECT_ID, name: "Default" }),
      );
      const impact = await service.describeRemovalImpact(DEFAULT_PROJECT_ID);
      expect(impact.deletable).toBe(false);
      expect(impact.projectName).toBe("Default");
    });

    it("项目不存在 → 404（与 remove 同一失败面，不返回一堆 0 冒充成功）", async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(
        service.describeRemovalImpact("nope"),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("计数查询失败 → 按 0 返回并 warn，不阻断预览", async () => {
      repo.findOne.mockResolvedValue(makeRow());
      taskRepo.count.mockRejectedValue(new Error("boom"));
      memberRepo.count.mockRejectedValue(new Error("boom"));
      const warnSpy = jest
        .spyOn(
          (service as unknown as { logger: { warn: jest.Mock } }).logger,
          "warn",
        )
        .mockImplementation(() => {});

      const impact = await service.describeRemovalImpact("p1");
      expect(impact.taskCount).toBe(0);
      expect(impact.memberCount).toBe(0);
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  // ── P1-2：列表 q 关键字搜索 ──────────────────────────────────────────
  describe("findAll 关键字搜索（P1-2 q）", () => {
    it("无 q → 原单对象路径（行为逐字节不变）", async () => {
      repo.find.mockResolvedValue([makeRow()]);
      await service.findAll();
      expect(repo.find).toHaveBeenCalledWith({ order: { createdAt: "ASC" } });
    });

    it("空白 q 视为无关键字", async () => {
      repo.find.mockResolvedValue([]);
      await service.findAll("   ");
      expect(repo.find).toHaveBeenCalledWith({ order: { createdAt: "ASC" } });
    });

    it("带 q → name OR description 的 ILike，元字符转义按字面量匹配", async () => {
      repo.find.mockResolvedValue([]);
      await service.findAll("daily_report");
      const { where } = repo.find.mock.calls[0][0];
      expect(Array.isArray(where)).toBe(true);
      expect(where).toHaveLength(2);
      expect(where[0].name).toEqual(
        expect.objectContaining({ _value: "%daily\\_report%" }),
      );
      expect(where[1].description).toEqual(
        expect.objectContaining({ _value: "%daily\\_report%" }),
      );
    });
  });

  // ── P1-2：项目详情统计 GET /projects/:id/summary ─────────────────────
  describe("getSummary（P1-2 项目详情统计）", () => {
    it("汇总任务/应用/成员/近 7 天执行与失败率，透出最近失败与活动", async () => {
      repo.findOne.mockResolvedValue(makeRow({ name: "数据平台组" }));
      taskRepo.count.mockResolvedValue(12);
      appRepo.count.mockResolvedValue(0);
      memberRepo.count.mockResolvedValue(3);
      execQb.getRawMany.mockResolvedValue([
        { status: "success", count: "6" },
        { status: "failed", count: "2" },
        { status: "timeout", count: "1" },
      ]);
      execQb.getMany
        .mockResolvedValueOnce([
          {
            id: "e1",
            taskId: "t1",
            taskName: "任务甲",
            status: "failed",
            failureReason: "script_error",
            errorMessage: "boom",
            createdAt: new Date("2026-11-15T01:00:00.000Z"),
            duration: 1200,
          },
        ])
        .mockResolvedValueOnce([
          {
            id: "e2",
            taskId: "t2",
            taskName: "任务乙",
            status: "success",
            failureReason: null,
            errorMessage: null,
            createdAt: new Date("2026-11-15T02:00:00.000Z"),
            duration: 900,
          },
        ]);

      const summary = await service.getSummary("p1");

      expect(summary.projectName).toBe("数据平台组");
      expect(summary.taskCount).toBe(12);
      expect(summary.applicationCount).toBe(0);
      expect(summary.memberCount).toBe(3);
      expect(summary.executionsLast7d).toBe(9);
      expect(summary.failedExecutionsLast7d).toBe(2);
      expect(summary.timeoutExecutionsLast7d).toBe(1);
      // R283：分子改为 FAILED+TIMEOUT（原 22.22 = 2/9 只含 failed），
      // 旧断言把错误口径钉成了期望。现 3/9 → 33.33%。
      expect(summary.failureRate).toBe(33.33);
      expect(summary.recentFailures[0].taskName).toBe("任务甲");
      expect(summary.recentExecutions[0].taskName).toBe("任务乙");
    });

    it("同一屏一致性：2 failed + 1 timeout / 9 条 ⇒ 明细分桶、失败率合并、最近失败 3 条", async () => {
      // 跨字段不变式（全仓此前零覆盖）：同一响应里三个数必须自洽——
      // failedExecutionsLast7d=2（FAILED 桶）、timeoutExecutionsLast7d=1（TIMEOUT 桶）、
      // failureRate=(2+1)/9=33.33（合并口径）、recentFailures 列出 3 条（IN(FAILED,TIMEOUT)）。
      // 修复前这四者互相矛盾：明细说 2+1，失败率却按 2/9=22.22 算。
      repo.findOne.mockResolvedValue(makeRow());
      taskRepo.count.mockResolvedValue(5);
      appRepo.count.mockResolvedValue(0);
      memberRepo.count.mockResolvedValue(1);
      execQb.getRawMany.mockResolvedValue([
        { status: "success", count: "6" },
        { status: "failed", count: "2" },
        { status: "timeout", count: "1" },
      ]);
      execQb.getMany
        .mockResolvedValueOnce([
          {
            id: "e1",
            taskId: "t1",
            taskName: "脚本挂了",
            status: "failed",
            failureReason: "script_error",
            errorMessage: "boom",
            createdAt: new Date("2026-11-15T01:00:00.000Z"),
            duration: 1200,
          },
          {
            id: "e3",
            taskId: "t3",
            taskName: "超时了",
            status: "timeout",
            failureReason: "timeout",
            errorMessage: null,
            createdAt: new Date("2026-11-15T00:30:00.000Z"),
            duration: 600000,
          },
          {
            id: "e4",
            taskId: "t1",
            taskName: "脚本挂了",
            status: "failed",
            failureReason: "script_error",
            errorMessage: "boom",
            createdAt: new Date("2026-11-15T00:00:00.000Z"),
            duration: 800,
          },
        ])
        .mockResolvedValueOnce([]);

      const summary = await service.getSummary("p1");

      // ① 两个明细字段保持分桶语义（不合并——合并会让 timeout 字段失去意义）
      expect(summary.failedExecutionsLast7d).toBe(2);
      expect(summary.timeoutExecutionsLast7d).toBe(1);
      // ② 失败率分子是两桶之和：3/9
      expect(summary.failureRate).toBe(33.33);
      // ③ 因此失败率**刻意不等于** failed / total —— 这条断言就是契约本身
      expect(summary.failureRate).not.toBe(
        Math.round(
          (summary.failedExecutionsLast7d / summary.executionsLast7d) * 10000,
        ) / 100,
      );
      // ④ 最近失败列表含 timeout 那条，共 3 条 → 与失败率分子同一集合
      expect(summary.recentFailures).toHaveLength(3);
      expect(summary.recentFailures.map((r) => r.status)).toEqual([
        "failed",
        "timeout",
        "failed",
      ]);
      // ⑤ 列表条数与失败率分子一致（不看窗口上限，本条只验证口径同源）
      expect(
        summary.failedExecutionsLast7d + summary.timeoutExecutionsLast7d,
      ).toBe(summary.recentFailures.length);
    });

    it("窗口内无执行 → failureRate 为 null（前端显示暂无数据，不渲染 0%）", async () => {
      repo.findOne.mockResolvedValue(makeRow());
      taskRepo.count.mockResolvedValue(0);
      appRepo.count.mockResolvedValue(0);
      memberRepo.count.mockResolvedValue(0);
      execQb.getRawMany.mockResolvedValue([]);

      const summary = await service.getSummary("p1");
      expect(summary.executionsLast7d).toBe(0);
      expect(summary.failedExecutionsLast7d).toBe(0);
      expect(summary.failureRate).toBeNull();
      expect(summary.recentFailures).toEqual([]);
      expect(summary.recentExecutions).toEqual([]);
    });

    it("只有 timeout（0 failed）→ failureRate 不为 0（修复前会是 0%）", async () => {
      // 缺陷的正面形态：回调上报的 timeout 落 TIMEOUT 桶，只数 FAILED 时
      // 失败率算出来是 0%——而同一屏的最近失败列表里全是超时。
      repo.findOne.mockResolvedValue(makeRow());
      taskRepo.count.mockResolvedValue(3);
      appRepo.count.mockResolvedValue(0);
      memberRepo.count.mockResolvedValue(0);
      execQb.getRawMany.mockResolvedValue([
        { status: "success", count: "3" },
        { status: "timeout", count: "1" },
      ]);
      execQb.getMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      const summary = await service.getSummary("p1");
      expect(summary.failedExecutionsLast7d).toBe(0);
      expect(summary.timeoutExecutionsLast7d).toBe(1);
      expect(summary.executionsLast7d).toBe(4);
      expect(summary.failureRate).not.toBe(0);
      expect(summary.failureRate).toBe(25);
    });

    it("口径一致性：失败 = 失败 + 超时（人工终止不计入）——产品文案已宣示，后端必须同源", async () => {
      // 这条用例把 admin-web `locales/zh.ts:1479` 的**产品文案**钉进后端测试：
      //   'taskDetail.stats.caliberHint': '统计口径：全部历史执行（非仅最近 20 次）。
      //    成功率 = 成功 / 全部；失败 = 失败 + 超时（人工终止不计入失败率）。…'
      // ⇒ 「失败 = 失败 + 超时」不是本模块的局部选择，而是**已对外宣示的口径**。
      // 若有人把 getSummary 的分子改回只算 failed，本用例会红，且红在这里能直接读到
      // 「这与产品文案相反」——项目概览与任务详情会对同一批执行报出两个失败率。
      // 「人工终止不计入」由 FAILED_EXECUTION_STATUSES 保证：KILLED/CANCELLED 不在其中。
      expect([...FAILED_EXECUTION_STATUSES]).toEqual(["failed", "timeout"]);
      expect(FAILED_EXECUTION_STATUSES).not.toContain("killed");
      expect(FAILED_EXECUTION_STATUSES).not.toContain("cancelled");

      repo.findOne.mockResolvedValue(makeRow());
      taskRepo.count.mockResolvedValue(0);
      appRepo.count.mockResolvedValue(0);
      memberRepo.count.mockResolvedValue(0);
      // 1 成功 + 2 failed + 1 timeout + 1 killed（人工终止不计入失败率）
      execQb.getRawMany.mockResolvedValue([
        { status: "success", count: "1" },
        { status: "failed", count: "2" },
        { status: "timeout", count: "1" },
        { status: "killed", count: "1" },
      ]);
      execQb.getMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      const summary = await service.getSummary("p1");
      expect(summary.executionsLast7d).toBe(5);
      // 分子 = 2 + 1 = 3（killed 不算），分母 = 5 —— 与产品文案逐字一致
      expect(summary.failureRate).toBe(60);
    });

    it("项目不存在 → 404（不返回一堆 0 冒充成功）", async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.getSummary("nope")).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("执行聚合查询失败 → 计数按 0 / 空列表降级，不阻断页面", async () => {
      repo.findOne.mockResolvedValue(makeRow());
      execQb.getRawMany.mockRejectedValue(new Error("boom"));
      const warnSpy = jest
        .spyOn(
          (service as unknown as { logger: { warn: jest.Mock } }).logger,
          "warn",
        )
        .mockImplementation(() => {});

      const summary = await service.getSummary("p1");
      expect(summary.executionsLast7d).toBe(0);
      expect(summary.failureRate).toBeNull();
      expect(summary.recentFailures).toEqual([]);
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });
});
