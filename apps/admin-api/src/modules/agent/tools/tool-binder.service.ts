import {
  Injectable,
  Logger,
  OnModuleInit,
  Inject,
  forwardRef,
} from "@nestjs/common";
import { AgentApiClient } from "./agent-api.client";
import { TaskService } from "../../task/task.service";
import { ExecutorService } from "../../executor/executor.service";
import { ApplicationService } from "../../application/application.service";
import { SopService } from "../../sop/sop.service";

/**
 * P3：把工具绑定到 admin-api 的内部 Service。
 *
 * ## 为什么单独成 service 而不是写在 module 的 onModuleInit
 * 绑定逻辑会随工具数量增长（P4/P5 还要加写工具与 SOP 工具）。放在模块里
 * 会让 agent.module.ts 变成数百行的装配清单，且难以单独测试。
 *
 * ## 范围
 * P3 绑只读工具（排障主力）；P5/P6 补 SOP 工具（sop_* → SopService）。
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
    // forwardRef：sop.module ↔ agent.module 装配期环（见 sop.module.ts 头注）
    @Inject(forwardRef(() => SopService))
    private readonly sops: SopService,
  ) {}

  onModuleInit(): void {
    this.bindTaskTools();
    this.bindApplicationTools();
    this.bindExecutorTools();
    this.bindSopTools();
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

  // ── SOP 组（P5/P6，设计文档 03 §4）──────────────────────────────

  private bindSopTools(): void {
    this.api.register("sop_list", async (args) =>
      this.sops.list({
        status: args.status as string | undefined,
        page: this.num(args.page, 1),
        pageSize: this.num(args.pageSize, 20),
      }),
    );

    // sop_get：sopId / slug 二选一（slug 是唯一索引，直查）
    this.api.register("sop_get", async (args) => {
      if (args.sopId) return this.sops.getSop(this.str(args.sopId));
      return this.sops.getBySlug(this.str(args.slug));
    });

    this.api.register("sop_draft", async (args) =>
      this.sops.draft({
        slug: this.str(args.slug),
        title: this.str(args.title),
        frontMatterYaml: args.frontMatterYaml as string | undefined,
        bodyMarkdown: args.bodyMarkdown as string | undefined,
        createdBy: "agent:tool-call",
      }),
    );

    this.api.register("sop_publish", async (args) =>
      this.sops.publish({
        sopId: this.str(args.sopId),
        bump: args.bump as "patch" | "minor" | "major" | undefined,
        changelog: args.changelog as string | undefined,
        publishedBy: "agent:tool-call",
      }),
    );

    this.api.register("sop_assign", async (args) => {
      let executorId = args.executorId as string | undefined;
      if (!executorId && args.executorAddress) {
        const exec = await this.executors.findByAddress(
          this.str(args.executorAddress),
        );
        if (!exec) throw new Error(`执行器 ${args.executorAddress} 不存在`);
        executorId = exec.id;
      }
      if (!executorId)
        throw new Error("executorId 与 executorAddress 必须提供其一");
      return this.sops.assign({
        sopId: this.str(args.sopId),
        version: args.version as string | undefined,
        executorId,
        assignedBy: "agent:tool-call",
      });
    });

    this.api.register("sop_reply_clarification", async (args) =>
      this.sops.replyClarification({
        clarificationId: this.str(args.clarificationId),
        resolution: this.str(args.resolution),
        answer: this.str(args.answer),
        amendedFrontMatterYaml: args.amendedFrontMatterYaml as
          string | undefined,
        amendedBodyMarkdown: args.amendedBodyMarkdown as string | undefined,
        changelog: args.changelog as string | undefined,
        replyBy: "agent:tool-call",
      }),
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
