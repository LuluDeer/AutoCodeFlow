import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ModuleRef } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { IsNull, Or, In } from "typeorm";
import { ApplicationService } from "../application.service";
import { Application } from "../entities/application.entity";
import { ApplicationController } from "../application.controller";
import { AiService } from "../../ai/ai.service";
// ARCH-30：AiAnalysisService 在 ApplicationService 的 DI 面上（findAll 路径
// 不触达，仅补齐 provider 解析）。
import { AiAnalysisService } from "../../ai/ai-analysis.service";
import { AppDeploymentService } from "../app-deployment.service";
import { DEFAULT_PROJECT_ID } from "../../project/project.entity";

/**
 * AUTH-01: application.service.findAll 的可选 projectId 过滤——
 * 语义："default" → Or(IsNull(), In([默认项目 uuid]))；具体 uuid → 精确；
 * 不传 → where 缺省（既有行为零变化）。controller 把 @Query("projectId")
 * 透传给 service 的接线也一并断言。
 */
describe("ApplicationService.findAll — projectId 过滤（AUTH-01）", () => {
  let service: ApplicationService;
  let controller: ApplicationController;
  let repo: Record<string, jest.Mock>;

  beforeEach(async () => {
    repo = {
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      save: jest.fn(),
      findOne: jest.fn(),
    };
    const module = await Test.createTestingModule({
      controllers: [ApplicationController],
      providers: [
        ApplicationService,
        { provide: getRepositoryToken(Application), useValue: repo },
        // ApplicationService 构造器依赖（findAll 路径不触达，给空桩）
        { provide: ModuleRef, useValue: { get: jest.fn() } },
        { provide: AiService, useValue: {} },
        {
          provide: AiAnalysisService,
          useValue: { analyzeFailure: jest.fn().mockResolvedValue("") },
        },
        // ApplicationController 构造器依赖（接线断言仅透传 projectId）
        { provide: AppDeploymentService, useValue: {} },
        { provide: ConfigService, useValue: {} },
      ],
    }).compile();
    service = module.get(ApplicationService);
    controller = module.get(ApplicationController);
  });

  it("projectId='default' → Or(IsNull, In([默认项目])) 的 where", async () => {
    await service.findAll("default");
    const opts = repo.find.mock.calls[0][0];
    expect(opts.order).toEqual({ createdAt: "DESC" });
    expect(opts.where.projectId).toEqual(
      Or(IsNull(), In([DEFAULT_PROJECT_ID])),
    );
  });

  it("具体 uuid → 精确等值过滤", async () => {
    const pid = "33333333-3333-4333-8333-333333333333";
    await service.findAll(pid);
    const opts = repo.find.mock.calls[0][0];
    expect(opts.where).toEqual({ projectId: pid });
  });

  it("不传 projectId → 无 where（既有行为零变化）", async () => {
    await service.findAll();
    const opts = repo.find.mock.calls[0][0];
    expect(opts.where).toBeUndefined();
  });

  it("controller 把 @Query projectId 透传给 service.findAll", async () => {
    const spy = jest.spyOn(service, "findAll").mockResolvedValue([]);
    await controller.findAll("default");
    expect(spy).toHaveBeenCalledWith("default");
  });

  it("controller 不带 query → service 收到 undefined", async () => {
    const spy = jest.spyOn(service, "findAll").mockResolvedValue([]);
    await controller.findAll();
    expect(spy).toHaveBeenCalledWith(undefined);
  });

  it("常量默认项目 uuid 与迁移回填值一致（契约锚定）", () => {
    expect(DEFAULT_PROJECT_ID).toBe("00000000-0000-0000-0000-000000000001");
  });
});
