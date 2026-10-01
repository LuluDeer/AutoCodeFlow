import {
  DISPATCH_TASK_FIELD_WHITELIST,
  DispatchTaskPayload,
  applyPinnedVersionSnapshot,
  buildDispatchTaskPayload,
} from "../dispatch-task-payload.util";
import { Task, TaskCodeSource } from "../../task/entities/task.entity";

/**
 * A4（第三轮审计·高）：派发体 task 字段白名单的纯函数单测。
 * 集成面（dispatch 载荷键集断言）见 executor.service.spec.ts 的
 * "A4: dispatch payload task contains only whitelisted fields"。
 */
describe("buildDispatchTaskPayload（A4：派发体白名单）", () => {
  const mkTask = (overrides: Partial<Task> = {}) =>
    ({
      id: "task-1",
      name: "demo",
      runtime: "python",
      runtimeVersion: "3.12",
      entrypoint: "main.py",
      timeout: 60,
      requirements: ["requests"],
      gitRepo: null,
      gitBranch: null,
      gitCommit: null,
      glueSource: null,
      glueLanguage: null,
      codeSource: null,
      applicationId: null,
      // 白名单之外的内部面字段——绝不应进派发体：
      secrets: { API_KEY: "enc:v1:..." },
      webhookSecret: "whsec_raw",
      ownerUserId: 1,
      maxRetry: 3,
      priority: "critical",
      ...overrides,
    }) as unknown as Task;

  it("白名单字段值逐字段透传，值恒存在（null 保留键位）", () => {
    const task = mkTask({ gitRepo: null, requirements: null });
    const payload: DispatchTaskPayload = buildDispatchTaskPayload(task);
    // requirements 的字面 null 是协议 TaskConfig 明文要求执行器接受的形态。
    expect(payload.requirements).toBeNull();
    expect(payload.runtimeVersion).toBe("3.12");
    expect(payload.timeout).toBe(60);
    expect(payload.gitRepo).toBeNull();
  });

  it("非白名单字段（含凭据/内部面）一律不出现", () => {
    const payload = buildDispatchTaskPayload(mkTask()) as Record<
      string,
      unknown
    >;
    expect(payload).not.toHaveProperty("secrets");
    expect(payload).not.toHaveProperty("webhookSecret");
    expect(payload).not.toHaveProperty("ownerUserId");
    expect(payload).not.toHaveProperty("maxRetry");
    expect(payload).not.toHaveProperty("priority");
    expect(payload).not.toHaveProperty("params");
  });

  it("键集恰为白名单（未传 packageUrl 时无该键）", () => {
    const payload = buildDispatchTaskPayload(mkTask());
    expect(Object.keys(payload).sort()).toEqual(
      [...DISPATCH_TASK_FIELD_WHITELIST].sort(),
    );
  });

  it("显式传入 packageUrl 时注入该键（zip 渠道），空值不注入", () => {
    const withUrl = buildDispatchTaskPayload(
      mkTask(),
      "https://registry/pkg.zip",
    );
    expect(withUrl.packageUrl).toBe("https://registry/pkg.zip");
    expect(Object.keys(withUrl)).toContain("packageUrl");

    const withoutUrl = buildDispatchTaskPayload(mkTask(), null);
    expect(Object.keys(withoutUrl)).not.toContain("packageUrl");
    const emptyUrl = buildDispatchTaskPayload(mkTask(), "");
    expect(Object.keys(emptyUrl)).not.toContain("packageUrl");
  });

  it("绝不改写入参实体（纯挑选、零副作用）", () => {
    const task = mkTask();
    const snapshot = { ...task };
    buildDispatchTaskPayload(task, "https://registry/pkg.zip");
    expect(task).toEqual(snapshot);
    expect(
      (task as unknown as Record<string, unknown>).packageUrl,
    ).toBeUndefined();
  });

  it("白名单覆盖三渠道判别字段（git/glue/zip）与通用面", () => {
    // 渠道判别与通用面必须齐备——缺任一字段对应渠道在执行器侧失效。
    expect(DISPATCH_TASK_FIELD_WHITELIST).toEqual(
      expect.arrayContaining([
        "gitRepo",
        "gitBranch",
        "gitCommit", // git 渠道
        "glueSource",
        "glueLanguage", // glue 渠道
        "codeSource",
        "applicationId", // zip 渠道判别
        "runtime",
        "runtimeVersion",
        "entrypoint",
        "timeout",
        "requirements",
        "id",
        "name", // 通用面
      ]),
    );
    // 白名单本身是封闭集（14 个实体字段），防止后来者随手扩列。
    expect(new Set(DISPATCH_TASK_FIELD_WHITELIST).size).toBe(
      DISPATCH_TASK_FIELD_WHITELIST.length,
    );
    expect(
      DISPATCH_TASK_FIELD_WHITELIST.some((f) =>
        ["secrets", "webhookSecret", "params", "priority"].includes(f),
      ),
    ).toBe(false);
    expect(TaskCodeSource.APPLICATION_ZIP).toBe("application_zip");
  });
});

/**
 * 技术债 A 组（2026-10-01）·按原版本重放：钉定快照 → 派发体覆盖的纯函数
 * 单测。集成面（processor 取快照后以覆盖副本派发）见 task.processor.spec.ts
 * 的 "REPLAY-PINNED" 组。
 */
describe("applyPinnedVersionSnapshot（REPLAY-PINNED）", () => {
  const mkTask = (overrides: Partial<Task> = {}) =>
    ({
      id: "task-1",
      name: "demo",
      runtime: "python",
      runtimeVersion: "3.12",
      entrypoint: "main.py",
      timeout: 60,
      requirements: ["requests"],
      gitRepo: "https://git.example/new-repo",
      gitBranch: "main",
      gitCommit: "newcommit",
      glueSource: null,
      glueLanguage: null,
      codeSource: "git",
      applicationId: null,
      // 调度面字段：夹具必须带现值，"快照调度面键不覆盖"断言才有意义
      //（否则 out.maxRetry 为 undefined，「未被 99 覆盖」退化成「不存在」）。
      maxRetry: 3,
      executorId: "exec-current",
      secrets: { API_KEY: "enc:v1:..." },
      ...overrides,
    }) as unknown as Task;

  it("快照有的执行相关键覆盖现值（git 渠道三件套 + runtimeVersion）", () => {
    const task = mkTask();
    const out = applyPinnedVersionSnapshot(task, {
      gitRepo: "https://git.example/old-repo",
      gitBranch: "release/1.0",
      gitCommit: "oldcommit",
      runtimeVersion: "3.7",
    });
    expect(out.gitRepo).toBe("https://git.example/old-repo");
    expect(out.gitBranch).toBe("release/1.0");
    expect(out.gitCommit).toBe("oldcommit");
    expect(out.runtimeVersion).toBe("3.7");
  });

  it("快照缺键保留现值（与 rollbackToVersion 的 Object.assign 缺键语义一致）", () => {
    const out = applyPinnedVersionSnapshot(mkTask(), {
      gitCommit: "oldcommit",
      // gitRepo/gitBranch/codeSource 不在快照里（旧快照缺键形态）
    });
    expect(out.gitRepo).toBe("https://git.example/new-repo");
    expect(out.gitBranch).toBe("main");
    expect(out.codeSource).toBe("git");
  });

  it("只覆盖派发体白名单字段——快照里的调度面/凭据键不进派发副本", () => {
    const out = applyPinnedVersionSnapshot(mkTask(), {
      executorId: "exec-pinned",
      secrets: { API_KEY: "leak" },
      maxRetry: 99,
    }) as unknown as Record<string, unknown>;
    expect(out.executorId).toBe("exec-current");
    expect(out.secrets).toEqual({ API_KEY: "enc:v1:..." });
    expect((out as { maxRetry?: number }).maxRetry).toBe(3);
  });

  it("绝不改写入参实体（返回副本，库内任务行零影响）", () => {
    const task = mkTask();
    const before = { ...task };
    applyPinnedVersionSnapshot(task, { gitCommit: "oldcommit" });
    expect(task).toEqual(before);
    expect(applyPinnedVersionSnapshot(task, {})).not.toBe(task);
  });
});
