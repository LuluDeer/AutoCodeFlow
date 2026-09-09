/**
 * CORE-03：TaskTemplateService CRUD + 从模板实例化。
 * 用桩 repo（getRepositoryToken）与桩 TaskService 隔离 DB / 队列依赖。
 */
import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { TaskTemplateService } from "../task-template.service";
import { TaskTemplate } from "../entities/task-template.entity";
import { TaskService } from "../../task/task.service";
import { OFFICIAL_TASK_TEMPLATES } from "../task-template.constants";

const makeRepo = () => ({
  find: jest.fn().mockResolvedValue([]),
  findOne: jest.fn().mockResolvedValue(null),
  create: jest.fn((d) => ({ id: "tpl-1", ...d })),
  save: jest.fn((e) => Promise.resolve(e)),
  delete: jest.fn().mockResolvedValue({ affected: 1 }),
});

const official = (over: Partial<TaskTemplate> = {}): TaskTemplate => {
  const seed = OFFICIAL_TASK_TEMPLATES[0];
  return {
    id: "official-1",
    key: seed.key,
    name: seed.name,
    description: seed.description,
    category: seed.category,
    config: seed.config,
    isOfficial: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as TaskTemplate;
};

describe("TaskTemplateService (CORE-03)", () => {
  let svc: TaskTemplateService;
  let repo: ReturnType<typeof makeRepo>;
  let taskService: { create: jest.Mock };

  beforeEach(async () => {
    repo = makeRepo();
    taskService = {
      create: jest.fn((dto) => Promise.resolve({ id: "task-1", ...dto })),
    };
    const module = await Test.createTestingModule({
      providers: [
        TaskTemplateService,
        { provide: getRepositoryToken(TaskTemplate), useValue: repo },
        { provide: TaskService, useValue: taskService },
      ],
    }).compile();
    svc = module.get(TaskTemplateService);
  });

  it("findAll 透传 repo.find（官方在前由 order 决定）", async () => {
    const list = [official()];
    repo.find.mockResolvedValue(list);
    await expect(svc.findAll()).resolves.toBe(list);
    expect(repo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        order: { isOfficial: "DESC", createdAt: "DESC" },
      }),
    );
  });

  it("create 合法自定义模板：isOfficial 恒 false、落库", async () => {
    repo.findOne.mockResolvedValue(null); // key 未占用
    const created = await svc.create({
      name: "My Sync",
      description: "custom",
      category: "同步",
      config: {
        triggerType: "fixed_rate",
        fixedRate: 120,
        runtime: "python",
        entrypoint: "s.py",
      },
    });
    expect(repo.save).toHaveBeenCalled();
    expect(
      (repo.create.mock.calls[0][0] as { isOfficial: boolean }).isOfficial,
    ).toBe(false);
    expect(created.config.triggerType).toBe("fixed_rate");
  });

  it("create 缺省 key 时由 name 规整生成", async () => {
    repo.findOne.mockResolvedValue(null);
    await svc.create({
      name: "Nightly Rebuild",
      config: { triggerType: "manual", runtime: "node", entrypoint: "b.js" },
    });
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ key: "nightly-rebuild" }),
    );
  });

  it("create 脏 config（白名单外字段）被拒且不落库", async () => {
    await expect(
      svc.create({
        name: "bad",
        config: {
          triggerType: "manual",
          runtime: "node",
          entrypoint: "x.js",
          bogus: 1,
        },
      }),
    ).rejects.toThrow(BadRequestException);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it("create key 冲突返回 409", async () => {
    repo.findOne.mockResolvedValue(official());
    await expect(
      svc.create({
        key: "scheduled_backup",
        name: "dup",
        config: { triggerType: "manual", runtime: "node", entrypoint: "x.js" },
      }),
    ).rejects.toThrow(ConflictException);
  });

  it("findOne 不存在 → 404", async () => {
    repo.findOne.mockResolvedValue(null);
    await expect(svc.findOne("nope")).rejects.toThrow(NotFoundException);
  });

  it("remove 官方模板被拒 403", async () => {
    repo.findOne.mockResolvedValue(official());
    await expect(svc.remove("official-1")).rejects.toThrow(ForbiddenException);
    expect(repo.delete).not.toHaveBeenCalled();
  });

  it("remove 自定义模板删除", async () => {
    repo.findOne.mockResolvedValue(
      official({ id: "c-1", key: "mine", isOfficial: false }),
    );
    await svc.remove("c-1");
    expect(repo.delete).toHaveBeenCalledWith({ id: "c-1" });
  });

  it("instantiate：模板 config 作默认、显式覆盖胜出、复用 TaskService.create", async () => {
    repo.findOne.mockResolvedValue(official());
    const task = await svc.instantiate("official-1", {
      name: "prod-backup",
      timeoutSeconds: 120, // 覆盖模板 3600
    });
    expect(taskService.create).toHaveBeenCalledTimes(1);
    const passed = taskService.create.mock.calls[0][0];
    expect(passed.name).toBe("prod-backup");
    expect(passed.timeoutSeconds).toBe(120); // 显式覆盖
    expect(passed.cronExpression).toBe("0 2 * * *"); // 模板默认
    expect(passed.triggerType).toBe("cron");
    expect(task.id).toBe("task-1");
  });

  it("instantiate 缺 name → 400（不建任务）", async () => {
    repo.findOne.mockResolvedValue(official());
    await expect(
      svc.instantiate("official-1", { timeoutSeconds: 60 }),
    ).rejects.toThrow(BadRequestException);
    expect(taskService.create).not.toHaveBeenCalled();
  });

  it("instantiate 剥离 body 内 templateId 防越权", async () => {
    repo.findOne.mockResolvedValue(official());
    await svc.instantiate("official-1", {
      name: "ok",
      templateId: "someone-else-template",
    });
    const passed = taskService.create.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(passed.templateId).toBeUndefined();
  });

  it("instantiate 模板不存在 → 404（不建任务）", async () => {
    repo.findOne.mockResolvedValue(null);
    await expect(svc.instantiate("ghost", { name: "x" })).rejects.toThrow(
      NotFoundException,
    );
    expect(taskService.create).not.toHaveBeenCalled();
  });
});
