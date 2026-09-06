import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as request from "supertest";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../../common/guards/roles.guard";
import { ConfigController } from "../config.controller";
import { SystemConfigService } from "../config.service";

describe("ConfigController rollback id validation (S15)", () => {
  let app: INestApplication;
  const rollback = jest.fn();

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ConfigController],
      providers: [
        {
          provide: SystemConfigService,
          useValue: {
            rollback,
            findAll: jest.fn().mockResolvedValue([]),
            findOne: jest.fn(),
            getByPrefix: jest.fn().mockResolvedValue([]),
            getByTag: jest.fn().mockResolvedValue([]),
            getHistory: jest.fn().mockResolvedValue({ data: [], total: 0 }),
            getSecretKeys: jest.fn().mockResolvedValue(new Set()),
          },
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = module.createNestApplication();
    app.setGlobalPrefix("api");
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    rollback.mockReset();
  });

  it("S15: a non-numeric id is rejected with 400 (ParseIntPipe), not a 500", async () => {
    const res = await request(app.getHttpServer()).post(
      "/api/config/history/abc/rollback",
    );
    expect(res.status).toBe(400);
    expect(rollback).not.toHaveBeenCalled();
  });

  it("S15: a numeric id is parsed and passed through to the service", async () => {
    rollback.mockResolvedValueOnce({ key: "k1", value: "v1" });
    const res = await request(app.getHttpServer()).post(
      "/api/config/history/42/rollback",
    );
    expect(res.status).toBe(201);
    expect(rollback).toHaveBeenCalledWith(42, expect.anything());
  });
});
