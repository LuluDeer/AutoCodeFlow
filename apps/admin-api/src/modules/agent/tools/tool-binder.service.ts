import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { AgentApiClient } from "./agent-api.client";
import { TaskService } from "../../task/task.service";
import { ExecutorService } from "../../executor/executor.service";
import { ApplicationService } from "../../application/application.service";

/**
 * P3：把只读工具绑定到 admin-api 的内部 Service。
 *
 * ## 为什么单独成 service 而不是写在 module 的 onModuleInit
 * 绑定逻辑会随工具数量增长（P4/P5 还要加写工具与 SOP 工具）。放在模块里
 * 会让 agent.module.ts 变成数百行的装配清单，且难以单独测试。
 *
 * ## P3 范围
 * 只绑**只读工具**（排障主力）。写工具的执行体在 P4/P5 随触发器与 SOP
 * 一起接——它们需要那些模块的能力（如事件聚合、SOP 校验）。
 * 未绑定的工具由 `AgentApiClient.invoke` 如实返回「尚未实现」，不静默成功。
 */
@Injectable()
export class ToolBinderService implements OnModuleInit {
  private readonly logger = new Logger(ToolBinderService.name);

  constructor(
    private readonly api: AgentApiClient,
    private readonly tasks: TaskService,
    private readonly executors: ExecutorService,
    private readonly applications: ApplicationService,
  ) {}

  onModuleInit(): void {
    this.bindTaskTools();
    this.bindApplicationTools();
    this.bindExecutorTools();
    this.logger.log(
      `Agent read-tool handlers bound: ${this.api.implementedTools().join(", ")}`,
    );
  }

  // ── 任务组 ──────────────────────────────────────────────────────

  private bindTaskTools(): void {
    this.api.register("list_tasks", async (args) =>
      this.tasks.findAll({
        page: this.num(args.page, 1),
        pageSize: this.num(args.pageSize, 20),
        status: args.status as string | undefined,
        name: args.name as string | undefined,
      } as never),
    );

    this.api.register("get_task", async (args) =>
      this.tasks.findOne(this.str(args.taskId)),
    );

    this.api.register("list_executions", async (args) => {
      const taskId = args.taskId as string | undefined;
      const paging = {
        page: this.num(args.page, 1),
        pageSize: this.num(args.pageSize, 20),
        status: args.status as string | undefined,
      };
      return taskId
        ? this.tasks.getExecutions(taskId, paging as never)
        : this.tasks.getAllExecutions(paging as never);
    });

    this.api.register("get_execution", async (args) =>
      this.tasks.getExecution(this.str(args.executionId)),
    );

    this.api.register("get_execution_logs", async (args) =>
      this.tasks.getExecutionLogs(this.str(args.executionId), {
        fromLine: this.num(args.fromLine, 0),
        limit: this.num(args.limit, 500),
      } as never),
    );

    this.api.register("get_execution_stats", async (args) =>
      this.tasks.getExecutionStats(this.str(args.taskId)),
    );

    this.api.register("list_task_versions", async (args) =>
      this.tasks.getVersions(this.str(args.taskId)),
    );

    this.api.register("compare_task_versions", async (args) =>
      this.tasks.compareVersions(
        this.str(args.taskId),
        this.str(args.fromVersionId),
        this.str(args.toVersionId),
      ),
    );

    this.api.register("get_execution_timeline", async (args) =>
      this.tasks.getExecutionReport(this.str(args.executionId)),
    );

    // 消耗 AI 配额的两个工具——它们透传 AiAnalysisService 的 fail-open 语义。
    // 注意：这两个 service 方法带 `user?` 参数（用于属主守卫 assertCanWrite*）。
    // Agent 以 `agent@system` 身份调用，但 P3 尚未引入该账号（见设计文档
    // 03 §7 的决策），故此处传 undefined —— 守卫对「无 user」的姿态是
    // **放行**（既有语义：无 user 主体 = 系统内部调用）。这一点在
    // agent-runtime-check 里有断言钉住，避免将来有人误改成「拒绝」而
    // 让 Agent 的只读分析全部失败。
    this.api.register("analyze_execution", async (args) =>
      this.tasks.analyzeExecution(this.str(args.executionId)),
    );

    // suggestSchedule 只收 taskId（它内部自己查任务），不需要先 findOne
    this.api.register("suggest_schedule", async (args) =>
      this.tasks.suggestSchedule(this.str(args.taskId)),
    );
  }

  // ── 应用组 ──────────────────────────────────────────────────────

  private bindApplicationTools(): void {
    this.api.register("list_applications", async (args) =>
      this.applications.findAll(args.projectId as string | undefined),
    );

    this.api.register("get_application", async (args) =>
      this.applications.findById(this.str(args.applicationId)),
    );

    this.api.register("analyze_application", async (args) =>
      this.applications.analyzeHealth(this.str(args.applicationId)),
    );
  }

  // ── 执行器组 ────────────────────────────────────────────────────

  private bindExecutorTools(): void {
    this.api.register("list_executors", async () => this.executors.findAll());

    this.api.register("get_executor", async (args) =>
      this.executors.findOne(this.str(args.executorId)),
    );

    this.api.register("get_executor_metrics", async (args) =>
      this.executors.getExecutorMetrics(this.str(args.executorId)),
    );
  }

  // ── 参数取值辅助（闸门已保证类型，这里只做缺省）─────────────────

  private str(v: unknown): string {
    return typeof v === "string" ? v : String(v ?? "");
  }

  private num(v: unknown, fallback: number): number {
    const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
    return Number.isFinite(n) ? n : fallback;
  }
}
