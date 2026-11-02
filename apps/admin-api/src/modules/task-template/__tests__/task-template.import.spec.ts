/**
 * 清单导入端点（`POST /task-templates/import`）的行为锁。
 *
 * 四条断言（任务书要求）：
 *   ① 正常导入 ⇒ 落库一行 + 审计有一条（task_template.import）；
 *   ② key 冲突 ⇒ 409（TASK_TEMPLATE_KEY_EXISTS）且**不落库**；
 *   ③ 清单结构不合法 ⇒ 400 且**不落库**；
 *   ④ 生成物同步（由 CI 的 diff 闸兜底，本文件锁「契约面」）。
 *
 * 外加一条**对账**用例：本端点算出的 contentHash 必须与
 * `docs/skills/registry.json` 里同一条的 contentHash 逐字相等——
 * 「registry 可与 DB 行对账」这句话要有机械判据，否则只是文档里的一句漂亮话。
 */
import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ConflictException, BadRequestException } from "@nestjs/common";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TaskTemplateService } from "../task-template.service";
import { TaskTemplate } from "../entities/task-template.entity";
import { TaskService } from "../../task/task.service";
import { Task } from "../../task/entities/task.entity";
import { UserRole } from "../../users/entities/user.entity";
import {
  parseTemplateImportRequest,
  templateManifestContentHash,
} from "../task-template.manifest";
import { TaskTemplateController } from "../task-template.controller";

// 仓库根 = __tests__ → task-template → modules → src → admin-api → apps → root
const REPO_ROOT = join(__dirname, "../../../../../..");

/** 一份合法的清单（非官方 key ⇒ 导入时必须自带 config）。 */
const VALID_MANIFEST = {
  name: "acme_report",
  version: "1.0.0",
  description: "示例清单：导入后落成一行自定义模板",
  capabilities: ["filesystem"],
  params: {
    outDir: {
      type: "string",
      title: "输出目录",
      description: "报表输出目录",
      required: false,
      default: "",
    },
  },
  entrypoints: [],
};

const VALID_CONFIG = {
  triggerType: "fixed_rate",
  fixedRate: 600,
  runtime: "node",
  glueLanguage: "javascript",
  glueSource: "console.log('acme');",
};

const makeRepo = () => ({
  find: jest.fn().mockResolvedValue([]),
  findOne: jest.fn().mockResolvedValue(null),
  create: jest.fn((d) => ({ id: "tpl-imported", ...d })),
  save: jest.fn((e) => Promise.resolve(e)),
  delete: jest.fn().mockResolvedValue({ affected: 1 }),
});

const makeTaskRepo = () => ({ findOne: jest.fn().mockResolvedValue(null) });

describe("TaskTemplateService.importManifest —— 清单导入", () => {
  let svc: TaskTemplateService;
  let repo: ReturnType<typeof makeRepo>;

  beforeEach(async () => {
    repo = makeRepo();
    const moduleRef = await Test.createTestingModule({
      providers: [
        TaskTemplateService,
        { provide: getRepositoryToken(TaskTemplate), useValue: repo },
        { provide: getRepositoryToken(Task), useValue: makeTaskRepo() },
        {
          provide: TaskService,
          useValue: { create: jest.fn() },
        },
      ],
    }).compile();
    svc = moduleRef.get(TaskTemplateService);
  });

  // ── ① 正常导入：落库 + 内容锚 ────────────────────────────────────────
  it("① 合法清单 ⇒ 落库一行（key=name、config 落 config 列、isOfficial=false）", async () => {
    const res = await svc.importManifest(
      { ...VALID_MANIFEST, config: VALID_CONFIG },
      { id: 42, username: "alice" },
    );

    expect(repo.save).toHaveBeenCalledTimes(1);
    const saved = repo.save.mock.calls[0][0];
    expect(saved.key).toBe("acme_report");
    expect(saved.name).toBe("acme_report"); // 非官方 key：无别的名字来源
    expect(saved.description).toBe(VALID_MANIFEST.description);
    expect(saved.category).toBeNull();
    expect(saved.config).toEqual(VALID_CONFIG);
    expect(saved.isOfficial).toBe(false);
    // 属主键按 id 编码（R39-A1 同款）
    expect(saved.createdBy).toBe("user:42|alice");
    expect(res.configSource).toBe("request");
    expect(res.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("① 官方 key 且省略 config ⇒ 取官方常量（configSource=official）", async () => {
    const officialManifest = {
      name: "health_check",
      version: "1.0.0",
      description:
        "开箱即跑：Node 脚本 GET params.url（默认 https://example.com），5 秒超时，打印 HTTP 状态码与耗时；网络失败或非 2xx 会抛错让执行如实失败。可改参数：params.url。",
      capabilities: ["http"],
      params: {},
      entrypoints: [],
    };
    const res = await svc.importManifest(officialManifest, {
      id: 1,
      username: "admin",
    });
    expect(res.configSource).toBe("official");
    expect(res.template.name).toBe("健康巡检"); // 展示名取官方种子
    expect(res.template.category).toBe("巡检");
    expect(repo.save).toHaveBeenCalledTimes(1);
  });

  // ── ② key 冲突 ⇒ 409 且不落库 ────────────────────────────────────────
  it("② key 已存在 ⇒ 409（TASK_TEMPLATE_KEY_EXISTS）且不落库", async () => {
    repo.findOne.mockResolvedValue({
      id: "existing",
      key: "acme_report",
    } as TaskTemplate);

    await expect(
      svc.importManifest({ ...VALID_MANIFEST, config: VALID_CONFIG }),
    ).rejects.toThrow(ConflictException);
    expect(repo.save).not.toHaveBeenCalled();
  });

  // ── ③ 清单结构不合法 ⇒ 400 且不落库 ──────────────────────────────────
  it("③ 未知键（可执行片段）⇒ 400 且不落库", async () => {
    await expect(
      svc.importManifest({
        ...VALID_MANIFEST,
        config: VALID_CONFIG,
        glueSource: "console.log('x');",
      }),
    ).rejects.toThrow(BadRequestException);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it("③ name 形状非法 ⇒ 400 且不落库", async () => {
    await expect(
      svc.importManifest({
        ...VALID_MANIFEST,
        name: "Bad Name!",
        config: VALID_CONFIG,
      }),
    ).rejects.toThrow(BadRequestException);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it("③ config 非法（CreateTaskDto 语义）⇒ 400 且不落库", async () => {
    await expect(
      svc.importManifest({
        ...VALID_MANIFEST,
        config: { triggerType: "not_a_trigger" },
      }),
    ).rejects.toThrow(BadRequestException);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it("③ 非官方 key 且未提供 config ⇒ 400 且不落库（清单不携带可执行内容）", async () => {
    await expect(svc.importManifest({ ...VALID_MANIFEST })).rejects.toThrow(
      BadRequestException,
    );
    expect(repo.save).not.toHaveBeenCalled();
  });

  it("③ contentHash 与内容不自洽 ⇒ 400（清单改了而 registry 没重生成）", async () => {
    await expect(
      svc.importManifest({
        ...VALID_MANIFEST,
        config: VALID_CONFIG,
        contentHash: "0".repeat(64),
      }),
    ).rejects.toThrow(BadRequestException);
    expect(repo.save).not.toHaveBeenCalled();
  });

  // ── ④ 对账：本端点的 contentHash 必须等于 registry 里的 contentHash ──
  it("④ contentHash 与 docs/skills/registry.json 逐字相等（可对账）", () => {
    const registry = JSON.parse(
      readFileSync(join(REPO_ROOT, "docs/skills/registry.json"), "utf8"),
    ) as {
      templates: Array<{
        name: string;
        version: string;
        description: string;
        capabilities: string[];
        params: Record<string, unknown>;
        entrypoints: string[];
        contentHash: string;
      }>;
    };
    expect(registry.templates.length).toBeGreaterThan(0);
    for (const entry of registry.templates) {
      const { manifest } = parseTemplateImportRequest({ ...entry });
      expect(templateManifestContentHash(manifest)).toBe(entry.contentHash);
    }
  });
});

describe("TaskTemplateController.importTemplate —— 审计落证", () => {
  it("① 导入成功后落证 task_template.import（含操作人与内容锚）", async () => {
    const svc = {
      importManifest: jest.fn().mockResolvedValue({
        template: { id: "tpl-9", key: "acme_report" },
        manifest: { name: "acme_report", version: "1.0.0" },
        configSource: "request",
        contentHash: "a".repeat(64),
      }),
    };
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const controller = new TaskTemplateController(svc as never, audit as never);
    const user = {
      id: 7,
      username: "alice",
      role: UserRole.USER,
    } as never;

    const out = await controller.importTemplate({ name: "acme_report" }, user);

    expect(out).toEqual({ id: "tpl-9", key: "acme_report" });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "task_template.import",
        resource: "task_template",
        resourceId: "tpl-9",
        username: "alice",
        detail: expect.objectContaining({
          key: "acme_report",
          version: "1.0.0",
          contentHash: "a".repeat(64),
          configSource: "request",
        }),
      }),
    );
  });

  it("② 导入失败（409）⇒ 不写审计", async () => {
    const svc = {
      importManifest: jest.fn().mockRejectedValue(new ConflictException()),
    };
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const controller = new TaskTemplateController(svc as never, audit as never);

    await expect(
      controller.importTemplate({ name: "acme_report" }, { id: 1 } as never),
    ).rejects.toThrow(ConflictException);
    expect(audit.log).not.toHaveBeenCalled();
  });
});
