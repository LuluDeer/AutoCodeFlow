/**
 * G-1（admin-web 深度审查）：`GET /config/runtime-version` —— Python 版本契约
 * 的权威下发端点。
 *
 * 端点存在的唯一理由：前端 apps/admin-web/src/pages/executor-mode.ts 此前硬编码
 * min/max/onlineMin/legacyDefault，而后端 min/max 支持
 * PYTHON_RUNTIME_VERSION_MIN/MAX env 覆盖——运维一改，前端的区间提示与舰队能力
 * 咨询就静默漂移。本 spec 钉死「端点返回的是后端当前生效值」这一契约。
 *
 * 另有一条**路由顺序**反证：本控制器底部有动态 `@Get(":key")`，静态路由必须声明
 * 在其之前，否则 `runtime-version` 会被当成配置键落到 findOne()。
 */
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as request from "supertest";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../../common/guards/roles.guard";
import { ConfigController } from "../config.controller";
import { SystemConfigService } from "../config.service";
import {
  RUNTIME_VERSION_MIN_ENV,
  RUNTIME_VERSION_MAX_ENV,
} from "../../task/runtime-version.util";

describe("ConfigController GET /config/runtime-version (G-1)", () => {
  let app: INestApplication;
  const findOne = jest.fn();

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ConfigController],
      providers: [
        {
          provide: SystemConfigService,
          useValue: {
            findOne,
            findAll: jest.fn().mockResolvedValue([]),
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

  // resolveBound 在**调用期**读 env（runtime-version.util 的求值期豁免路径），
  // 故用例可直接操纵 process.env；跑完必须复原，避免污染同进程其它 spec。
  const savedMin = process.env[RUNTIME_VERSION_MIN_ENV];
  const savedMax = process.env[RUNTIME_VERSION_MAX_ENV];
  const restore = () => {
    if (savedMin === undefined) delete process.env[RUNTIME_VERSION_MIN_ENV];
    else process.env[RUNTIME_VERSION_MIN_ENV] = savedMin;
    if (savedMax === undefined) delete process.env[RUNTIME_VERSION_MAX_ENV];
    else process.env[RUNTIME_VERSION_MAX_ENV] = savedMax;
  };

  beforeEach(() => {
    findOne.mockReset();
    restore();
  });
  afterAll(restore);

  it("returns contract defaults, and is not shadowed by the dynamic :key route", async () => {
    const res = await request(app.getHttpServer()).get(
      "/api/config/runtime-version",
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      min: "3.7",
      max: "3.14",
      onlineMin: "3.8",
      legacyDefaultInterpreter: "3.12",
    });
    // 路由顺序反证：若静态路由被 ':key' 抢先匹配，这里会走 findOne()
    expect(findOne).not.toHaveBeenCalled();
  });

  it("follows PYTHON_RUNTIME_VERSION_MIN/MAX overrides — the drift this endpoint exists to kill", async () => {
    process.env[RUNTIME_VERSION_MIN_ENV] = "3.9";
    process.env[RUNTIME_VERSION_MAX_ENV] = "3.13";
    const res = await request(app.getHttpServer()).get(
      "/api/config/runtime-version",
    );
    expect(res.status).toBe(200);
    expect(res.body.min).toBe("3.9");
    expect(res.body.max).toBe("3.13");
    // onlineMin 是 uv 能力边界（契约常量，不可配置），不随 env 变动
    expect(res.body.onlineMin).toBe("3.8");
  });

  it("silently falls back to contract defaults on malformed / inverted env (no 500)", async () => {
    process.env[RUNTIME_VERSION_MIN_ENV] = "3.20";
    process.env[RUNTIME_VERSION_MAX_ENV] = "not-a-version";
    const res = await request(app.getHttpServer()).get(
      "/api/config/runtime-version",
    );
    expect(res.status).toBe(200);
    expect(res.body.min).toBe("3.7");
    expect(res.body.max).toBe("3.14");
  });
});
