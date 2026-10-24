import {
  buildTask,
  buildTasks,
  buildCronTask,
  buildFixedRateTask,
  buildPausedTask,
  buildPythonTask,
  buildNodeTask,
  buildGitTask,
  buildGlueTask,
} from "../task.factory";
import {
  TaskStatus,
  TaskTriggerType,
  TaskRuntime,
  BlockStrategy,
  TaskPriority,
} from "../../../src/modules/task/entities/task.entity";

describe("Task Factory", () => {
  describe("buildTask", () => {
    it("应该生成具有默认值的 Task 对象", () => {
      const task = buildTask();

      expect(task).toBeDefined();
      expect(task.id).toBeTruthy();
      expect(task.name).toBeTruthy();
      expect(task.status).toBe(TaskStatus.ACTIVE);
      expect(task.triggerType).toBe(TaskTriggerType.MANUAL);
      expect(task.runtime).toBe(TaskRuntime.PYTHON);
      expect(task.entrypoint).toBe("main.py");
      expect(task.timeout).toBe(300);
      expect(task.maxRetry).toBe(3);
      expect(task.blockStrategy).toBe(BlockStrategy.SERIAL);
      expect(task.priority).toBe(TaskPriority.NORMAL);
      expect(task.createdAt).toBeInstanceOf(Date);
      expect(task.updatedAt).toBeInstanceOf(Date);
    });

    it("应该支持覆盖默认值", () => {
      const task = buildTask({
        name: "custom-task",
        status: TaskStatus.PAUSED,
        runtime: TaskRuntime.NODE,
        timeout: 600,
      });

      expect(task.name).toBe("custom-task");
      expect(task.status).toBe(TaskStatus.PAUSED);
      expect(task.runtime).toBe(TaskRuntime.NODE);
      expect(task.timeout).toBe(600);
    });

    it("应该正确处理 null 值", () => {
      const task = buildTask({
        cronExpression: null,
        gitRepo: null,
        requirements: null,
        projectId: null,
      });

      expect(task.cronExpression).toBeNull();
      expect(task.gitRepo).toBeNull();
      expect(task.requirements).toBeNull();
      expect(task.projectId).toBeNull();
    });

    it("生成的任务名应该符合格式", () => {
      const task = buildTask();

      // 任务名格式：task-{adjective}-{noun}，可能包含连字符
      expect(task.name).toMatch(/^task-[a-z-]+$/);
      expect(task.name).toContain("task-");
    });
  });

  describe("buildTasks", () => {
    it("应该生成指定数量的任务", () => {
      const tasks = buildTasks(5);

      expect(tasks).toHaveLength(5);
      tasks.forEach((task) => {
        expect(task.id).toBeTruthy();
        expect(task.name).toBeTruthy();
      });
    });

    it("应该为所有任务应用覆盖值", () => {
      const tasks = buildTasks(3, { runtime: TaskRuntime.NODE });

      expect(tasks).toHaveLength(3);
      tasks.forEach((task) => {
        expect(task.runtime).toBe(TaskRuntime.NODE);
      });
    });

    it("每个任务应该有唯一的 ID", () => {
      const tasks = buildTasks(3);

      const ids = tasks.map((t) => t.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(3);
    });
  });

  describe("buildCronTask", () => {
    it("应该生成 CRON 调度任务", () => {
      const task = buildCronTask();

      expect(task.triggerType).toBe(TaskTriggerType.CRON);
      expect(task.cronExpression).toBe("0 0 * * *");
    });

    it("应该支持自定义 CRON 表达式", () => {
      const task = buildCronTask({ cronExpression: "*/5 * * * *" });

      expect(task.triggerType).toBe(TaskTriggerType.CRON);
      expect(task.cronExpression).toBe("*/5 * * * *");
    });
  });

  describe("buildFixedRateTask", () => {
    it("应该生成固定频率任务", () => {
      const task = buildFixedRateTask();

      expect(task.triggerType).toBe(TaskTriggerType.FIXED_RATE);
      expect(task.fixedRate).toBe(60000);
    });

    it("应该支持自定义频率", () => {
      const task = buildFixedRateTask({ fixedRate: 30000 });

      expect(task.fixedRate).toBe(30000);
    });
  });

  describe("buildPausedTask", () => {
    it("应该生成已暂停的任务", () => {
      const task = buildPausedTask();

      expect(task.status).toBe(TaskStatus.PAUSED);
    });
  });

  describe("buildPythonTask", () => {
    it("应该生成 Python 任务", () => {
      const task = buildPythonTask();

      expect(task.runtime).toBe(TaskRuntime.PYTHON);
      expect(task.runtimeVersion).toBe("3.11");
      expect(task.entrypoint).toBe("main.py");
      expect(task.requirements).toBeTruthy();
      expect(task.requirements).toContain("requests>=2.31.0");
    });
  });

  describe("buildNodeTask", () => {
    it("应该生成 Node 任务", () => {
      const task = buildNodeTask();

      expect(task.runtime).toBe(TaskRuntime.NODE);
      expect(task.runtimeVersion).toBe("20");
      expect(task.entrypoint).toBe("index.js");
    });
  });

  describe("buildGitTask", () => {
    it("应该生成 Git 源任务", () => {
      const task = buildGitTask();

      expect(task.gitRepo).toBeTruthy();
      expect(task.gitRepo).toContain(".git");
      expect(task.gitBranch).toBe("main");
      expect(task.gitCommit).toBeTruthy();
      expect(task.gitCommit).toMatch(/^[a-f0-9]{40}$/);
    });
  });

  describe("buildGlueTask", () => {
    it("应该生成 Glue 脚本任务", () => {
      const task = buildGlueTask();

      expect(task.glueSource).toBeTruthy();
      expect(task.glueSource).toContain("print");
      expect(task.entrypoint).toBeNull();
    });
  });
});
