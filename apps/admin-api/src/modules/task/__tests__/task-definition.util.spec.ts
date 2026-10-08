import { BadRequestException, ConflictException } from "@nestjs/common";
import {
  assertNoSecretMaterial,
  buildExportFilename,
  buildTaskExportPayload,
  buildTaskExportResult,
  importNameCandidate,
  mapExportToCreateDto,
  TASK_DEFINITION_EXPORT_KEYS,
  TASK_EXPORT_SCHEMA_VERSION,
  TASK_IMPORT_SECRETS_IGNORED_WARNING,
  TASK_IMPORT_SECRETS_WARNING,
} from "../task-definition.util";
import { Task, TaskTriggerType, TaskRuntime } from "../entities/task.entity";

/**
 * E-1（任务定义导入/导出）：纯函数层单测。
 *
 * 核心红线（SEC-02）：secrets 值与键名 alike 绝不出现在导出物中——
 * 这里用「携带 secrets 的任务 → 导出 → 全文检索 secret 痕迹」钉死。
 */
describe("task-definition.util（E-1 导出/导入纯函数）", () => {
  const makeTask = (overrides: Partial<Task> = {}): Task =>
    ({
      id: "11111111-1111-4111-8111-111111111111",
      name: "Nightly sync",
      description: "sync db",
      triggerType: TaskTriggerType.CRON,
      cronExpression: "0 2 * * *",
      timezone: "Asia/Shanghai",
      runtime: TaskRuntime.PYTHON,
      runtimeVersion: "3.12",
      requirements: ["requests>=2.31"],
      dependencies: { "upstream name": "22222222-2222-4222-8222-222222222222" },
      entrypoint: "main.py",
      gitRepo: null,
      gitBranch: null,
      gitCommit: null,
      currentVersion: null,
      timeout: 600,
      timeoutAction: "kill_retry",
      timeoutWarnRatio: 80,
      estimatedDurationSec: 300,
      maxRetry: 3,
      retryDelay: 30,
      retryableErrors: ["TIMEOUT"],
      priority: "normal",
      executeMode: "single",
      blockStrategy: "serial",
      misfireStrategy: "fire_once",
      alarmEmail: "ops@example.com",
      alarmChannels: ["email"],
      params: { db: "primary" },
      deploymentPolicy: "strict",
      executorId: null,
      executorAppName: "edge-1",
      executorGroup: "edge",
      executorTags: ["gpu"],
      executorAffinityTags: ["gpu", "edge"],
      executorAntiAffinityTags: null,
      glueSource: "print('hello')",
      glueLanguage: "python",
      applicationId: "33333333-3333-4333-8333-333333333333",
      codeSource: "glue",
      maintenanceWindows: [{ start: "30 2 * * *", end: "0 4 * * *" }],
      runbook: "# runbook",
      projectId: "44444444-4444-4444-8444-444444444444",
      status: "active",
      lastTriggerTime: new Date("2026-01-01T00:00:00Z"),
      ownerUserId: 7,
      secrets: { API_TOKEN: "sk-live-abc123", DB_PASSWORD: "hunter2" },
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-02T00:00:00Z"),
      deletedAt: null,
      ...overrides,
    }) as unknown as Task;

  describe("buildTaskExportPayload — 结构与 schemaVersion", () => {
    it("导出 schemaVersion=1、ISO exportedAt 与全量定义键（值逐字携带）", () => {
      const payload = buildTaskExportPayload(makeTask());

      expect(payload.schemaVersion).toBe("1");
      expect(TASK_EXPORT_SCHEMA_VERSION).toBe("1");
      expect(Number.isNaN(Date.parse(payload.exportedAt))).toBe(false);

      // 快照全键（= saveVersion 快照键 − id）值逐字一致
      expect(payload.task.name).toBe("Nightly sync");
      expect(payload.task.description).toBe("sync db");
      expect(payload.task.triggerType).toBe("cron");
      expect(payload.task.cronExpression).toBe("0 2 * * *");
      expect(payload.task.timezone).toBe("Asia/Shanghai");
      expect(payload.task.runtime).toBe("python");
      expect(payload.task.runtimeVersion).toBe("3.12");
      expect(payload.task.glueSource).toBe("print('hello')");
      expect(payload.task.glueLanguage).toBe("python");
      expect(payload.task.params).toEqual({ db: "primary" });
      expect(payload.task.dependencies).toEqual({
        "upstream name": "22222222-2222-4222-8222-222222222222",
      });
      expect(payload.task.maintenanceWindows).toEqual([
        { start: "30 2 * * *", end: "0 4 * * *" },
      ]);
      expect(payload.task.deploymentPolicy).toBe("strict");
      expect(payload.task.executorAffinityTags).toEqual(["gpu", "edge"]);
      expect(payload.task.applicationId).toBe(
        "33333333-3333-4333-8333-333333333333",
      );
      expect(payload.task.projectId).toBe(
        "44444444-4444-4444-8444-444444444444",
      );
      expect(payload.task.codeSource).toBe("glue");
      expect(payload.task.runbook).toBe("# runbook");
      expect(payload.task.timeout).toBe(600);
      expect(payload.task.timeoutAction).toBe("kill_retry");
      expect(payload.task.timeoutWarnRatio).toBe(80);
      expect(payload.task.estimatedDurationSec).toBe(300);
      expect(payload.task.maxRetry).toBe(3);
      expect(payload.task.retryDelay).toBe(30);
      expect(payload.task.retryableErrors).toEqual(["TIMEOUT"]);
      expect(payload.task.requirements).toEqual(["requests>=2.31"]);
      expect(payload.task.executorAppName).toBe("edge-1");
    });

    it("导出键集合恰好是白名单（无 id/status/ownerUserId/审计列等多余键）", () => {
      const payload = buildTaskExportPayload(makeTask());
      expect(Object.keys(payload.task).sort()).toEqual(
        [...TASK_DEFINITION_EXPORT_KEYS].sort(),
      );
      // 运行态/身份/审计列绝不出现
      for (const forbidden of [
        "id",
        "status",
        "ownerUserId",
        "lastTriggerTime",
        "createdAt",
        "updatedAt",
        "deletedAt",
        "secrets",
        "webhookSecret",
      ]) {
        expect(Object.keys(payload.task)).not.toContain(forbidden);
      }
    });

    it("SEC-02 红线：含 secrets 任务的导出物全文无 secret 键名与值", () => {
      const task = makeTask();
      (task as unknown as Record<string, unknown>)["webhookSecret"] =
        "whsec_raw_9f8e7d6c";
      const json = JSON.stringify(buildTaskExportPayload(task));

      // 值（明文与掩码 alike）不得出现
      expect(json).not.toContain("sk-live-abc123");
      expect(json).not.toContain("hunter2");
      expect(json).not.toContain("whsec_raw_9f8e7d6c");
      // 键名 alike：整个导出物任何位置（含 task 与 envelope）无 secret 形态键
      expect(json).not.toContain("secrets");
      expect(json).not.toContain("API_TOKEN");
      expect(json).not.toContain("DB_PASSWORD");
      expect(json).not.toContain("webhookSecret");
    });

    it("null 值键照常导出（导入端 IsOptional 放行 null）", () => {
      const payload = buildTaskExportPayload(makeTask());
      expect(payload.task.gitRepo).toBeNull();
      expect(payload.task.executorId).toBeNull();
      expect(payload.task.executorAntiAffinityTags).toBeNull();
    });

    it("buildTaskExportResult 产出 slug 化文件名 + payload", () => {
      const result = buildTaskExportResult(makeTask());
      expect(result.filename).toBe("task-Nightly-sync.json");
      expect(result.payload.schemaVersion).toBe("1");
    });

    it("buildExportFilename 折叠非法字符、限制长度、空名回退 task", () => {
      expect(buildExportFilename("a/b\\c:d*? -- 调度")).toBe(
        "task-a-b-c-d.json",
      );
      expect(buildExportFilename("x".repeat(200)).length).toBeLessThanOrEqual(
        "task-".length + 60 + ".json".length,
      );
      expect(buildExportFilename("///")).toBe("task-task.json");
    });
  });

  describe("assertNoSecretMaterial — 导出不变量 fail-closed", () => {
    it("任何层级的 /secret/i 键名都会抛错（宁可炸导出也不泄密）", () => {
      expect(() =>
        assertNoSecretMaterial({ task: { name: "x", secrets: {} } }),
      ).toThrow(ConflictException);
      expect(() =>
        assertNoSecretMaterial({ task: { nested: [{ webhookSecret: "v" }] } }),
      ).toThrow(/SEC-02/);
    });

    it("无 secret 形态键的正常对象放行（数组/嵌套递归）", () => {
      expect(() =>
        assertNoSecretMaterial({
          task: { name: "x", tags: ["a"], win: [{ start: "0 2 * * *" }] },
        }),
      ).not.toThrow();
    });
  });

  describe("mapExportToCreateDto — 导入映射", () => {
    const payload = buildTaskExportPayload(makeTask());

    it("定义键映射回 CreateTaskDto 形状（值逐字往返）", () => {
      const { dto } = mapExportToCreateDto(payload);
      expect(dto.name).toBe("Nightly sync");
      expect(dto.triggerType).toBe(TaskTriggerType.CRON);
      expect(dto.cronExpression).toBe("0 2 * * *");
      expect(dto.params).toEqual({ db: "primary" });
      expect(dto.glueSource).toBe("print('hello')");
      expect(dto.maintenanceWindows).toEqual([
        { start: "30 2 * * *", end: "0 4 * * *" },
      ]);
      expect(dto.dependencies).toEqual({
        "upstream name": "22222222-2222-4222-8222-222222222222",
      });
    });

    it("secrets 红线：导入物携带 secrets/id/status 也绝不进入 create DTO", () => {
      const { dto, warnings } = mapExportToCreateDto({
        schemaVersion: "1",
        exportedAt: "2026-10-05T00:00:00.000Z",
        task: {
          name: "X",
          triggerType: "manual",
          secrets: { API_TOKEN: "sk-live-abc123" },
          id: "99999999-9999-4999-8999-999999999999",
          status: "active",
          ownerUserId: 7,
          webhookSecret: "whsec_raw",
        } as Record<string, unknown>,
      });

      // 整键剔除：create 链路拿到的 DTO 上根本没有这些键
      expect(dto).not.toHaveProperty("secrets");
      expect(dto).not.toHaveProperty("id");
      expect(dto).not.toHaveProperty("status");
      expect(dto).not.toHaveProperty("ownerUserId");
      expect(dto).not.toHaveProperty("webhookSecret");
      expect(JSON.stringify(dto)).not.toContain("sk-live-abc123");
      expect(JSON.stringify(dto)).not.toContain("whsec_raw");

      expect(warnings).toContain(TASK_IMPORT_SECRETS_WARNING);
      expect(warnings).toContain(TASK_IMPORT_SECRETS_IGNORED_WARNING);
    });

    it("未携带 secrets 的导入物 warnings 常驻重配提示", () => {
      const { warnings } = mapExportToCreateDto({
        schemaVersion: "1",
        exportedAt: "2026-10-05T00:00:00.000Z",
        task: { name: "X", triggerType: "manual" },
      });
      expect(warnings).toEqual([TASK_IMPORT_SECRETS_WARNING]);
    });

    it("name 缺失/空白 → fail-closed 400（覆盖编程式调用方）", () => {
      expect(() =>
        mapExportToCreateDto({ task: { triggerType: "manual" } }),
      ).toThrow(BadRequestException);
      expect(() => mapExportToCreateDto({ task: { name: "   " } })).toThrow(
        BadRequestException,
      );
    });
  });

  describe("importNameCandidate — 重名后缀策略", () => {
    it("ordinal 0 = 原名；1 = 首次冲突加 (imported)；n≥2 追加序号", () => {
      expect(importNameCandidate("X", 0)).toBe("X");
      expect(importNameCandidate("X", 1)).toBe("X (imported)");
      expect(importNameCandidate("X", 2)).toBe("X (imported) 2");
      expect(importNameCandidate("X", 20)).toBe("X (imported) 20");
    });

    // FEAT-RENAME：importDefinition 是**服务层直调 create()**（不经 HTTP
    // DTO 管道），create 也不校验名称长度——越界值直达 PG 报 22001（笼统
    // 500）。后缀拼接必须自己裁剪到上限内。
    //
    // 长度口径 = **码点**，与 PG varchar(255) 实测一致（255 emoji 接受、
    // 256 拒绝；128 emoji 虽是 256 个 UTF-16 码元却只有 128 码点，同样接受）。
    describe("长度上限（255 码点）", () => {
      it("长名 + 后缀不越界，且后缀完整保留", () => {
        const long = "备".repeat(255);
        for (const ordinal of [1, 2, 20]) {
          const out = importNameCandidate(long, ordinal);
          expect(Array.from(out).length).toBeLessThanOrEqual(255);
          // 后缀是"这是导入副本"的语义载体，必须完整
          expect(
            out.endsWith(
              ordinal === 1 ? " (imported)" : ` (imported) ${ordinal}`,
            ),
          ).toBe(true);
        }
      });

      it("恰好 255 的原名 + 后缀 → 裁剪原名而非丢后缀", () => {
        const out = importNameCandidate("a".repeat(255), 1);
        expect(Array.from(out).length).toBe(255);
        expect(out).toBe(
          `${"a".repeat(255 - " (imported)".length)} (imported)`,
        );
      });

      it("短名不受影响（零行为变化）", () => {
        expect(importNameCandidate("nightly", 1)).toBe("nightly (imported)");
      });

      it("按码点裁剪：emoji 名字不产生孤立代理项且不越界", () => {
        // 300 个 emoji：若按 UTF-16 码元 slice 会切出半个代理对，PG 以
        // "invalid byte sequence for encoding UTF8" 拒绝整条请求。
        const emoji = "🚀".repeat(300);
        const out = importNameCandidate(emoji, 1);
        // 码点口径：255 - 11 = 244 个 emoji + 后缀
        expect(Array.from(out).length).toBe(255);
        expect(() => Buffer.from(out, "utf8")).not.toThrow();
        expect(out).not.toContain("\uFFFD");
        // 头部每个码点都是完整 emoji（没有被劈开）
        const head = out.slice(0, -" (imported)".length);
        expect(Array.from(head).every((c) => c === "🚀")).toBe(true);
      });

      it("emoji 名在 DB 上限内不被误裁（128 个 emoji = 256 码元但仅 128 码点）", () => {
        // 反证：若上限按 UTF-16 码元算（value.length），这里 128+11=139 码元
        // 仍不越界；但 200 个 emoji（400 码元 / 200 码点）会被误判越界而遭
        // 无谓裁剪——DB 明明接受。
        const out = importNameCandidate("🚀".repeat(200), 1);
        expect(Array.from(out).length).toBe(200 + " (imported)".length);
        expect(out.startsWith("🚀".repeat(200))).toBe(true);
      });
    });
  });
});
