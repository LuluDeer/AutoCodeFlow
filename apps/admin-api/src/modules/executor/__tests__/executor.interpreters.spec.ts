/**
 * python_task_multiversion（WS2 · CONTRACT §2.2/§2.3/§2.4/§3.1）：解释器缓存池
 * 在 admin 侧的四处落点集成断言：
 * ① 注册 / 心跳的**采纳规则**（缺省保留 / 非法拒绝 / 合法覆盖，含 `[]`）；
 * ② 三处调度站点（selectLeastLoaded / dispatch / dispatchBroadcast）的过滤；
 * ③ pinning 分支的守卫（**占坑前**失败：runningTaskCount 不被 +1）；
 * ④ zip 渠道的 `packageUrl` 解析与下发附加（push + pull 双分支）。
 *
 * 装配沿用 executor.dispatch-estimated.spec 的 mock repo 形态；本文件额外提供
 * `Application` repository（packageUrl 解析面）。
 */
import { Test } from "@nestjs/testing";
import { getQueueToken } from "@nestjs/bullmq";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ConfigService } from "@nestjs/config";
import { ExecutorService } from "../executor.service";
import { Executor, ExecutorStatus } from "../entities/executor.entity";
import { ExecutorMetricsHistory } from "../entities/executor-metrics-history.entity";
import { Task, TaskCodeSource } from "../../task/entities/task.entity";
import { TaskExecution } from "../../task/entities/task-execution.entity";
import { Application } from "../../application/entities/application.entity";
import { NotificationService } from "../../notification/notification.service";
import { SystemConfigService } from "../../config/config.service";
import { SecretsCryptoService } from "../../../common/utils/secret-crypto.util.service";
import { INTERPRETER_UNAVAILABLE_TOKEN } from "../interpreter-match.util";
import axios from "axios";

jest.mock("axios");
jest.mock("../../../common/utils/safe-http.util", () => ({
  ...jest.requireActual("../../../common/utils/safe-http.util"),
  assertSafeExecutorUrl: jest
    .fn()
    .mockResolvedValue(new URL("http://fixture:3002/")),
}));
const mockedAxios = axios as jest.Mocked<typeof axios>;

const mkExecutor = (over: Partial<Executor> = {}): Executor =>
  ({
    id: "e-" + Math.random().toString(36).slice(2, 8),
    appName: "ex",
    address: "127.0.0.1:3105",
    status: ExecutorStatus.ONLINE,
    runningTaskCount: 0,
    version: 1,
    ...over,
  }) as Executor;

describe("ExecutorService python_task_multiversion（解释器缓存池 / packageUrl）", () => {
  let service: ExecutorService;
  let executorRepo: Record<string, jest.Mock>;
  let execRepo: Record<string, jest.Mock>;
  let taskRepo: Record<string, jest.Mock>;
  let appRepo: Record<string, jest.Mock>;
  let metricsRepo: Record<string, jest.Mock>;
  let pullService: { enqueue: jest.Mock };
  let updateExecute: jest.Mock;
  let postedPayloads: any[];

  const execution = () =>
    ({ id: "exec-1", params: {} }) as unknown as TaskExecution;

  beforeEach(async () => {
    updateExecute = jest.fn().mockResolvedValue({ affected: 1 });
    executorRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((x: unknown) => x),
      save: jest.fn(async (x: unknown) => x),
      createQueryBuilder: jest.fn(() => ({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
        execute: updateExecute,
      })),
    };
    execRepo = { find: jest.fn().mockResolvedValue([]) };
    taskRepo = { find: jest.fn().mockResolvedValue([]) };
    appRepo = { findOne: jest.fn().mockResolvedValue(null) };
    metricsRepo = {
      create: jest.fn((x: unknown) => x),
      save: jest.fn(async (x: unknown) => x),
    };
    pullService = { enqueue: jest.fn().mockResolvedValue(undefined) };
    postedPayloads = [];

    const moduleRef = await Test.createTestingModule({
      providers: [
        ExecutorService,
        { provide: getRepositoryToken(Executor), useValue: executorRepo },
        { provide: getRepositoryToken(TaskExecution), useValue: execRepo },
        { provide: getRepositoryToken(Task), useValue: taskRepo },
        {
          provide: getRepositoryToken(ExecutorMetricsHistory),
          useValue: metricsRepo,
        },
        { provide: getRepositoryToken(Application), useValue: appRepo },
        { provide: getQueueToken("task-queue"), useValue: {} },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        {
          provide: NotificationService,
          useValue: {
            // register 首注册会 `notifyExecutorOnline(...).catch(...)`，mock 必须
            // 返回 Promise（否则同步 TypeError 冒泡成"注册失败"）。
            notifyExecutorOnline: jest.fn().mockResolvedValue(undefined),
            notifyExecutorOffline: jest.fn().mockResolvedValue(undefined),
            notifyExecutorKill: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: SystemConfigService, useValue: {} },
        {
          provide: SecretsCryptoService,
          useValue: { decryptForDispatch: jest.fn(() => null) },
        },
      ],
    }).compile();
    service = moduleRef.get(ExecutorService);
    // pull 分支经 @Optional 位置参数注入（既有 spec 同款：直接赋属性）。
    (service as unknown as { pullService: unknown }).pullService = pullService;
    jest.spyOn(service["logger"], "error").mockImplementation(() => undefined);
    jest.spyOn(service["logger"], "log").mockImplementation(() => undefined);
    jest.spyOn(service["logger"], "warn").mockImplementation(() => undefined);

    mockedAxios.post.mockReset();
    mockedAxios.post.mockImplementation(async (_url: string, payload: any) => {
      postedPayloads.push(payload);
      return { data: { ok: true }, status: 200 };
    });
  });

  // ───────────────────────── ① 注册 / 心跳采纳 ─────────────────────────
  describe("register —— interpreters 采纳（CONTRACT §2.2/§2.3）", () => {
    it("首注册上报合法清单 → 落列", async () => {
      executorRepo.findOne.mockResolvedValue(null);
      const saved = await service.register({
        appName: "py-1",
        address: "10.0.0.1:3002",
        interpreters: [{ version: "3.7.9", available: true }],
      });
      expect(saved.interpreters).toEqual([
        { version: "3.7.9", available: true },
      ]);
    });

    it("首注册未上报 → 列保持 undefined（= NULL，调度按 3.12 兜底）", async () => {
      executorRepo.findOne.mockResolvedValue(null);
      const saved = await service.register({
        appName: "py-1",
        address: "10.0.0.1:3002",
      });
      expect(saved.interpreters).toBeUndefined();
    });

    it("首注册上报非法结构 → 不落列 + warn", async () => {
      executorRepo.findOne.mockResolvedValue(null);
      const saved = await service.register({
        appName: "py-1",
        address: "10.0.0.1:3002",
        interpreters: [{ version: "3" }] as never,
      });
      expect(saved.interpreters).toBeUndefined();
      expect(service["logger"].warn).toHaveBeenCalledWith(
        expect.stringContaining("invalid interpreters payload"),
      );
    });

    it("重注册合法上报 → 覆盖；上报 [] → 覆盖为空池（不回退）", async () => {
      const existing = mkExecutor({
        interpreters: [{ version: "3.12.3" }],
      });
      executorRepo.findOne.mockResolvedValue(existing);
      const saved = await service.register({
        appName: "py-1",
        address: existing.address,
        interpreters: [],
      });
      expect(saved.interpreters).toEqual([]);
    });

    it("重注册缺省该字段 → DB 旧值不被清空（兼容性红线 3 的注册面）", async () => {
      const existing = mkExecutor({
        interpreters: [{ version: "3.12.3" }],
      });
      executorRepo.findOne.mockResolvedValue(existing);
      const saved = await service.register({
        appName: "py-1",
        address: existing.address,
      });
      expect(saved.interpreters).toEqual([{ version: "3.12.3" }]);
    });

    it("重注册上报非法结构 → 保留旧值 + warn（脏上报不污染调度判据）", async () => {
      const existing = mkExecutor({
        interpreters: [{ version: "3.12.3" }],
      });
      executorRepo.findOne.mockResolvedValue(existing);
      const saved = await service.register({
        appName: "py-1",
        address: existing.address,
        interpreters: "3.7.9" as never,
      });
      expect(saved.interpreters).toEqual([{ version: "3.12.3" }]);
      expect(service["logger"].warn).toHaveBeenCalledWith(
        expect.stringContaining("invalid interpreters payload"),
      );
    });
  });

  describe("heartbeat —— interpreters 采纳（CONTRACT §2.3 / 红线 3）", () => {
    it("缺省 → DB 旧值保留（旧执行器心跳不得擦除已上报清单）", async () => {
      const e = mkExecutor({ interpreters: [{ version: "3.7.9" }] });
      executorRepo.findOne.mockResolvedValue(e);
      const saved = await service.heartbeat(e.address, { cpuUsage: 10 });
      expect(saved.interpreters).toEqual([{ version: "3.7.9" }]);
    });

    it("合法上报（含 []）→ 覆盖", async () => {
      const e = mkExecutor({ interpreters: [{ version: "3.7.9" }] });
      executorRepo.findOne.mockResolvedValue(e);
      const saved = await service.heartbeat(e.address, { interpreters: [] });
      expect(saved.interpreters).toEqual([]);
    });

    it("非法结构 → 整字段拒绝采纳 + warn，DB 保留旧值", async () => {
      const e = mkExecutor({ interpreters: [{ version: "3.7.9" }] });
      executorRepo.findOne.mockResolvedValue(e);
      const saved = await service.heartbeat(e.address, {
        interpreters: [{ path: "/x" }] as never,
      });
      expect(saved.interpreters).toEqual([{ version: "3.7.9" }]);
      expect(service["logger"].warn).toHaveBeenCalledWith(
        expect.stringContaining("invalid interpreters payload"),
      );
    });

    it("interpreters 不落入数值指标白名单（不透传脏键到实体）", async () => {
      const e = mkExecutor({ interpreters: null });
      executorRepo.findOne.mockResolvedValue(e);
      const saved = await service.heartbeat(e.address, {
        interpreters: [{ version: "3.13.0", evil: 1 } as never],
      });
      // 白名单字段被剥除，只剩 version（其余键不得写进 jsonb）。
      expect(saved.interpreters).toEqual([{ version: "3.13.0" }]);
      expect(saved).not.toHaveProperty("evil");
    });
  });

  // ───────────────────────── ② 三处调度站点过滤 ─────────────────────────
  describe("调度过滤（CONTRACT §3.1，三处共享）", () => {
    it("selectLeastLoaded：不满足声明版本的候选被剔除，可满足者被选中", async () => {
      executorRepo.find.mockResolvedValue([
        mkExecutor({
          id: "e-a",
          appName: "a",
          address: "a:1",
          interpreters: [{ version: "3.12.3" }],
        }),
        mkExecutor({
          id: "e-b",
          appName: "b",
          address: "b:1",
          interpreters: [{ version: "3.9.18" }],
        }),
      ]);
      const picked = await service.selectLeastLoaded({ runtimeVersion: "3.9" });
      expect(picked.id).toBe("e-b");
    });

    it("selectLeastLoaded：全不满足 → ServiceUnavailableException，消息含每个候选快照（AC-09b）", async () => {
      executorRepo.find.mockResolvedValue([
        mkExecutor({
          id: "e-a",
          appName: "exec-a",
          interpreters: [{ version: "3.12.3" }],
        }),
        mkExecutor({ id: "e-b", appName: "exec-b", interpreters: [] }),
        mkExecutor({ id: "e-c", appName: "exec-c", interpreters: null }),
      ]);
      await expect(
        service.selectLeastLoaded({ runtimeVersion: "3.13" }),
      ).rejects.toThrow(/exec-a\[已缓存: 3\.12\.3\]/);
      await expect(
        service.selectLeastLoaded({ runtimeVersion: "3.13" }),
      ).rejects.toThrow(/exec-b\[已缓存: 无\]/);
      await expect(
        service.selectLeastLoaded({ runtimeVersion: "3.13" }),
      ).rejects.toThrow(/exec-c\[未上报，按 3\.12 兜底\]/);
    });

    it("selectLeastLoaded：未传 runtimeVersion → 零过滤（存量调用方行为不变）", async () => {
      executorRepo.find.mockResolvedValue([
        mkExecutor({ id: "e-a", interpreters: [] }),
      ]);
      const picked = await service.selectLeastLoaded();
      expect(picked.id).toBe("e-a");
    });

    it("dispatch：未上报（null）的执行器仍被选中（红线 2：旧执行器不因缺字段被剔除）", async () => {
      executorRepo.find.mockResolvedValue([
        mkExecutor({ id: "e-legacy", interpreters: null }),
      ]);
      const task = {
        id: "t1",
        name: "legacy",
        runtime: "python",
        timeout: 10,
        runtimeVersion: "3.12",
      } as unknown as Task;
      await service.dispatch(task, execution());
      expect(postedPayloads[0].executionId).toBe("exec-1");
    });

    it("dispatch：无候选满足 → 抛错含分因 token 与候选快照", async () => {
      executorRepo.find.mockResolvedValue([
        mkExecutor({ id: "e-a", appName: "exec-a", interpreters: [] }),
      ]);
      const task = {
        id: "t1",
        name: "py",
        runtime: "python",
        timeout: 10,
        runtimeVersion: "3.9",
      } as unknown as Task;
      await expect(service.dispatch(task, execution())).rejects.toThrow(
        INTERPRETER_UNAVAILABLE_TOKEN,
      );
      // 过滤失败发生在占坑之前：不得有任何 runningTaskCount +1。
      expect(updateExecute).not.toHaveBeenCalled();
    });

    it("dispatch：appName 精确点名 + 版本不满足 → 明确失败（不静默换机器）", async () => {
      executorRepo.find.mockResolvedValue([
        mkExecutor({
          id: "e-a",
          appName: "exec-a",
          interpreters: [{ version: "3.12.3" }],
        }),
      ]);
      const task = {
        id: "t1",
        name: "py",
        runtime: "python",
        timeout: 10,
        executorAppName: "exec-a",
        runtimeVersion: "3.9",
      } as unknown as Task;
      await expect(service.dispatch(task, execution())).rejects.toThrow(
        INTERPRETER_UNAVAILABLE_TOKEN,
      );
    });

    it("dispatchBroadcast：广播扇出面被版本声明收窄", async () => {
      executorRepo.find.mockResolvedValue([
        mkExecutor({
          id: "e-a",
          appName: "a",
          address: "a:1",
          interpreters: [{ version: "3.9.18" }],
        }),
        mkExecutor({
          id: "e-b",
          appName: "b",
          address: "b:1",
          interpreters: [{ version: "3.12.3" }],
        }),
      ]);
      const task = {
        id: "t1",
        name: "py",
        runtime: "python",
        timeout: 10,
        runtimeVersion: "3.9",
      } as unknown as Task;
      const results = await service.dispatchBroadcast(task, execution());
      expect(results).toHaveLength(1);
      expect(postedPayloads).toHaveLength(1);
    });

    it("dispatchBroadcast：全不满足 → 抛错（分因 token + 快照）", async () => {
      executorRepo.find.mockResolvedValue([
        mkExecutor({ id: "e-a", appName: "exec-a", interpreters: [] }),
      ]);
      const task = {
        id: "t1",
        name: "py",
        runtime: "python",
        timeout: 10,
        runtimeVersion: "3.9",
      } as unknown as Task;
      await expect(
        service.dispatchBroadcast(task, execution()),
      ).rejects.toThrow(INTERPRETER_UNAVAILABLE_TOKEN);
    });
  });

  // ───────────────────────── ③ pinning 守卫 ─────────────────────────
  describe("pinning 守卫（CONTRACT §3.1 / AC-08b / D2③）", () => {
    const pinnedTask = (runtimeVersion: string) =>
      ({
        id: "t1",
        name: "pinned",
        runtime: "python",
        timeout: 10,
        executorId: "e-pinned",
        runtimeVersion,
      }) as unknown as Task;

    it("pinned 执行器不满足声明版本 → **占坑前**失败（runningTaskCount 未 +1）", async () => {
      executorRepo.findOne.mockResolvedValue(
        mkExecutor({
          id: "e-pinned",
          appName: "exec-pinned",
          interpreters: [{ version: "3.12.3" }],
        }),
      );
      await expect(
        service.dispatch(pinnedTask("3.9"), execution()),
      ).rejects.toThrow(INTERPRETER_UNAVAILABLE_TOKEN);
      // 关键：占坑 UPDATE 一次都没发生（失败在槽位预订之前）。
      expect(updateExecute).not.toHaveBeenCalled();
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it("pinned 失败消息含声明版本与 pinned 执行器已缓存清单", async () => {
      executorRepo.findOne.mockResolvedValue(
        mkExecutor({
          id: "e-pinned",
          appName: "exec-pinned",
          interpreters: [
            { version: "3.12.3" },
            { version: "3.8.3", available: false },
          ],
        }),
      );
      await expect(
        service.dispatch(pinnedTask("3.9"), execution()),
      ).rejects.toThrow(/3\.12\.3；3\.8\.3\(不可用\)/);
    });

    it("pinned 执行器满足声明版本 → 正常派发", async () => {
      executorRepo.findOne.mockResolvedValue(
        mkExecutor({
          id: "e-pinned",
          appName: "exec-pinned",
          address: "p:1",
          interpreters: [{ version: "3.9.18" }],
        }),
      );
      await service.dispatch(pinnedTask("3.9"), execution());
      expect(postedPayloads[0].executionId).toBe("exec-1");
    });

    it("pinned 未上报（旧执行器）+ 声明 3.12 → 兜底放行（红线 2）", async () => {
      executorRepo.findOne.mockResolvedValue(
        mkExecutor({ id: "e-pinned", address: "p:1", interpreters: null }),
      );
      await service.dispatch(pinnedTask("3.12"), execution());
      expect(postedPayloads[0].executionId).toBe("exec-1");
    });

    it("pinned 未上报（旧执行器）+ 声明 3.7 → 失败（兜底只覆盖 3.12）", async () => {
      executorRepo.findOne.mockResolvedValue(
        mkExecutor({ id: "e-pinned", interpreters: null }),
      );
      await expect(
        service.dispatch(pinnedTask("3.7"), execution()),
      ).rejects.toThrow(INTERPRETER_UNAVAILABLE_TOKEN);
      expect(updateExecute).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────── ④ packageUrl 注入 ─────────────────────────
  describe("packageUrl 注入（CONTRACT §2.4/§3.1）", () => {
    const zipTask = (over: Partial<Task> = {}) =>
      ({
        id: "t-zip",
        name: "zip-task",
        runtime: "python",
        timeout: 10,
        applicationId: "app-1",
        codeSource: TaskCodeSource.APPLICATION_ZIP,
        ...over,
      }) as unknown as Task;

    it("push 分支：解析并附加 packageUrl（不污染持久化实体）", async () => {
      executorRepo.find.mockResolvedValue([
        mkExecutor({ id: "e-a", address: "a:1", interpreters: null }),
      ]);
      appRepo.findOne.mockResolvedValue({
        id: "app-1",
        name: "demo",
        packageUrl: "https://cdn.example.com/demo.zip",
      });
      const task = zipTask();
      await service.dispatch(task, execution());
      expect(postedPayloads[0].task.packageUrl).toBe(
        "https://cdn.example.com/demo.zip",
      );
      // 实体本体未被写入非列字段（task 是托管行）。
      expect(
        (task as unknown as { packageUrl?: string }).packageUrl,
      ).toBeUndefined();
    });

    it("pull 分支：同一份附加 task 入队", async () => {
      executorRepo.find.mockResolvedValue([
        mkExecutor({
          id: "e-a",
          address: "a:1",
          dispatchMode: "pull",
          interpreters: null,
        }),
      ]);
      appRepo.findOne.mockResolvedValue({
        id: "app-1",
        name: "demo",
        packageUrl: "https://cdn.example.com/demo.zip",
      });
      await service.dispatch(zipTask(), execution());
      expect(pullService.enqueue).toHaveBeenCalledTimes(1);
      const payload = pullService.enqueue.mock.calls[0][1];
      expect(payload.task.packageUrl).toBe("https://cdn.example.com/demo.zip");
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it("codeSource=git + applicationId 拘留 → 不进 zip 路径（git 渠道优先，不误伤）", async () => {
      executorRepo.find.mockResolvedValue([
        mkExecutor({ id: "e-a", address: "a:1", interpreters: null }),
      ]);
      appRepo.findOne.mockResolvedValue(null);
      await service.dispatch(
        zipTask({ codeSource: TaskCodeSource.GIT }),
        execution(),
      );
      expect(appRepo.findOne).not.toHaveBeenCalled();
      expect(postedPayloads[0].task.packageUrl).toBeUndefined();
    });

    it("codeSource=null + applicationId 非空 → zip 兜底（存量行 NFR-05）", async () => {
      executorRepo.find.mockResolvedValue([
        mkExecutor({ id: "e-a", address: "a:1", interpreters: null }),
      ]);
      appRepo.findOne.mockResolvedValue({
        id: "app-1",
        name: "demo",
        packageUrl: "https://cdn.example.com/legacy.zip",
      });
      await service.dispatch(
        zipTask({ codeSource: null as never }),
        execution(),
      );
      expect(postedPayloads[0].task.packageUrl).toBe(
        "https://cdn.example.com/legacy.zip",
      );
    });

    it("非 zip 渠道（无 applicationId / codeSource=git）→ 不查库、载荷不含 packageUrl", async () => {
      executorRepo.find.mockResolvedValue([
        mkExecutor({ id: "e-a", address: "a:1", interpreters: null }),
      ]);
      const task = {
        id: "t-git",
        name: "git-task",
        runtime: "python",
        timeout: 10,
        codeSource: TaskCodeSource.GIT,
      } as unknown as Task;
      await service.dispatch(task, execution());
      expect(appRepo.findOne).not.toHaveBeenCalled();
      expect(postedPayloads[0].task.packageUrl).toBeUndefined();
    });

    it("应用不存在 → 派发失败，消息明确", async () => {
      executorRepo.find.mockResolvedValue([
        mkExecutor({ id: "e-a", address: "a:1", interpreters: null }),
      ]);
      appRepo.findOne.mockResolvedValue(null);
      await expect(service.dispatch(zipTask(), execution())).rejects.toThrow(
        /application app-1 not found/,
      );
      expect(postedPayloads).toHaveLength(0);
    });

    it("应用存在但 packageUrl 为空 → 派发失败（不静默下发无包任务）", async () => {
      executorRepo.find.mockResolvedValue([
        mkExecutor({ id: "e-a", address: "a:1", interpreters: null }),
      ]);
      appRepo.findOne.mockResolvedValue({
        id: "app-1",
        name: "demo",
        packageUrl: null,
      });
      await expect(service.dispatch(zipTask(), execution())).rejects.toThrow(
        /has no packageUrl configured/,
      );
    });

    it("codeSource=application_zip 但无 applicationId → 派发失败（存量脏行）", async () => {
      executorRepo.find.mockResolvedValue([
        mkExecutor({ id: "e-a", address: "a:1", interpreters: null }),
      ]);
      await expect(
        service.dispatch(
          zipTask({ applicationId: null as never }),
          execution(),
        ),
      ).rejects.toThrow(/has no applicationId/);
    });

    it("解析失败时占坑被回滚（catch 路径 -1）", async () => {
      executorRepo.find.mockResolvedValue([
        mkExecutor({ id: "e-a", address: "a:1", interpreters: null }),
      ]);
      appRepo.findOne.mockResolvedValue(null);
      await expect(service.dispatch(zipTask(), execution())).rejects.toThrow();
      // 两次 UPDATE：占坑 +1（affected 1）与回滚 -1。
      expect(updateExecute).toHaveBeenCalledTimes(2);
    });

    it("Application repository 未装配 → 明确失败而非静默降级", async () => {
      (service as unknown as { applicationRepo: unknown }).applicationRepo =
        null;
      executorRepo.find.mockResolvedValue([
        mkExecutor({ id: "e-a", address: "a:1", interpreters: null }),
      ]);
      await expect(service.dispatch(zipTask(), execution())).rejects.toThrow(
        /Application repository is not wired/,
      );
    });

    it("广播路径：一次解析服务全部目标", async () => {
      executorRepo.find.mockResolvedValue([
        mkExecutor({ id: "e-a", address: "a:1", interpreters: null }),
        mkExecutor({ id: "e-b", address: "b:1", interpreters: null }),
      ]);
      appRepo.findOne.mockResolvedValue({
        id: "app-1",
        name: "demo",
        packageUrl: "https://cdn.example.com/demo.zip",
      });
      await service.dispatchBroadcast(zipTask(), execution());
      expect(appRepo.findOne).toHaveBeenCalledTimes(1);
      expect(postedPayloads).toHaveLength(2);
      for (const p of postedPayloads) {
        expect(p.task.packageUrl).toBe("https://cdn.example.com/demo.zip");
      }
    });
  });
});
