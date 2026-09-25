import {
  Injectable,
  Logger,
  OnModuleInit,
  Inject,
  forwardRef,
} from "@nestjs/common";
import { AgentApiClient } from "./agent-api.client";
import { TaskService } from "../../task/task.service";
import { TaskTemplateService } from "../../task-template/task-template.service";
import { ExecutorService } from "../../executor/executor.service";
import { ApplicationService } from "../../application/application.service";
import { AppDeploymentService } from "../../application/app-deployment.service";
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
    private readonly deployments: AppDeploymentService,
    private readonly templates: TaskTemplateService,
    // forwardRef：sop.module ↔ agent.module 装配期环（见 sop.module.ts 头注）
    @Inject(forwardRef(() => SopService))
    private readonly sops: SopService,
  ) {}

  onModuleInit(): void {
    this.bindTaskTools();
    this.bindApplicationTools();
    this.bindExecutorTools();
    this.bindSopTools();
    // P6 补齐：写工具执行体（白名单早已包含它们，P3 只绑了只读——
    // 不绑则模型调用一律「尚未实现」，事件处置/SOP 编排两大场景残废）
    this.bindWriteTools();
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

  // ── 写工具组（P6 补齐：binder 头注承诺的「写工具随触发器与 SOP 一起接」）──
  //
  // 为什么要绑：incident / sop_authoring 会话的工具白名单里早就包含
  // trigger_task / retry_execution / kill_execution / pause_task /
  // resume_task / create_application / create_task_from_template /
  // deploy_application——但 P3 只绑了只读工具，模型一调这些就得到
  // 「尚未实现」，白名单形同虚设、事件处置与 SOP 编排两大场景全部残废。
  //
  // 身份纪律：user 参数传 undefined——与 analyze_execution 同款既有语义
  // （无 user 主体 = 系统内部调用，ALS 守卫放行）。trigger 显式传
  // triggerTypeOverride="agent"（迁移 1790000000040 的缺口 6：Agent 触发
  // 的执行行带 triggerType='agent'，执行详情页可辨）。

  private bindWriteTools(): void {
    // trigger_task：排障主力（收敛性、幂等意图、可终止）
    this.api.register("trigger_task", async (args) =>
      this.tasks.trigger(
        this.str(args.taskId),
        {
          ...(args.params ? { params: args.params } : {}),
        } as never,
        undefined,
        "agent",
      ),
    );

    // retry_execution：admin API 无原生 retry 端点（NF-06）——与 mcp-server
    // 同语义：回放原执行的 params 走 manual-trigger 路径，产生**新**执行行
    this.api.register("retry_execution", async (args) => {
      let params = args.params as Record<string, unknown> | undefined;
      if (!params) {
        const prev = (await this.tasks.getExecution(this.str(args.executionId))) as {
          params?: Record<string, unknown> | null;
        };
        if (prev?.params) params = prev.params;
      }
      return this.tasks.trigger(
        this.str(args.taskId),
        { ...(params ? { params } : {}) } as never,
        undefined,
        "agent",
      );
    });

    this.api.register("kill_execution", async (args) =>
      this.tasks.killExecution(this.str(args.executionId)),
    );

    this.api.register("pause_task", async (args) =>
      this.tasks.pause(this.str(args.taskId)),
    );

    this.api.register("resume_task", async (args) =>
      this.tasks.resume(this.str(args.taskId)),
    );

    // create_application：新建无破坏（03 §2 Tier 2 允许项）
    this.api.register("create_application", async (args) =>
      this.applications.create(
        {
          name: this.str(args.name),
          ...(args.description ? { description: this.str(args.description) } : {}),
          ...(args.gitRepo ? { gitRepo: this.str(args.gitRepo) } : {}),
        } as never,
        null,
      ),
    );

    // create_task_from_template：沙箱校验后允许（新建不破坏既有）
    this.api.register("create_task_from_template", async (args) =>
      this.templates.instantiate(this.str(args.templateId), (args.overrides ?? {}) as Record<string, unknown>),
    );

    // deploy_application / deploy_app：**方案 C**（03 §3）——不新增审批机制，
    // 直接调 deploy；DEP-04 开启时返回 pending_approval 且不派发，Agent 把
    // 「需要人批」转述给人。审批是唯一事实源（DEP-04），审计链干净。
    const deployApp = async (args: Record<string, unknown>) =>
      this.deployments.deploy(
        this.str(args.applicationId),
        {
          ...(args.executorId ? { executorId: this.str(args.executorId) } : {}),
          ...(args.runMode ? { runMode: args.runMode } : {}),
          ...(args.env ? { env: args.env } : {}),
        } as never,
      );
    this.api.register("deploy_application", deployApp);
    this.api.register("deploy_app", deployApp);
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
