import {
  Injectable,
  Logger,
  OnModuleInit,
  Inject,
  Optional,
  forwardRef,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { ConfigService } from "@nestjs/config";
import { LessThan, Repository } from "typeorm";
// LANG-ERR-01（后端错误码化）：用户面抛出统一走 AppError（带稳定码，前端按
// 用户语言渲染）。AppError 按状态码挂到对应内置异常原型上。
import { AppError } from "../../../common/errors/app-error";
import { AgentApiClient } from "./agent-api.client";
import { TaskService } from "../../task/task.service";
import { TaskTemplateService } from "../../task-template/task-template.service";
import { ExecutorService } from "../../executor/executor.service";
import { ApplicationService } from "../../application/application.service";
import { AppDeploymentService } from "../../application/app-deployment.service";
import { MutexGroupService } from "../../application/mutex-group.service";
import { SopService } from "../../sop/sop.service";
import { AgentToolCall } from "../entities/agent-tool-call.entity";
import { AgentStep } from "../entities/agent-step.entity";

/**
 * 逃生门：Agent 侧部署是否强制要求人工审批。
 *
 * 默认**开**（要审批）——DEP-04 的 `approvalRequired` 是按应用开关且默认
 * false，若这里也默认放开，Agent 部署就是默认零门。
 * 置 `false` 即回退到方案 C 的旧行为（门只看应用开关）。
 *
 * 扁平 env 键（非 `agent.policy.*` dotted 形态）：`ConfigService` 只在键
 * **已注册进 configuration.ts** 时才解析 dotted 路径（实测未注册的 dotted
 * 键恒 undefined），扁平键则由 Nest 按同名环境变量兜底，运维置 env 即可
 * 生效、无需改代码。
 */
export const AGENT_DEPLOY_APPROVAL_REQUIRED_KEY =
  "AGENT_DEPLOY_APPROVAL_REQUIRED";

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
    // MUTEX-01：互斥组四工具的执行体（list/create/update/delete_mutex_group）。
    private readonly mutexGroups: MutexGroupService,
    // forwardRef：sop.module ↔ agent.module 装配期环（见 sop.module.ts 头注）
    @Inject(forwardRef(() => SopService))
    private readonly sops: SopService,
    // P4 get_tool_call_result：回读本会话已存的工具结果（按 sessionId 隔离）
    @InjectRepository(AgentToolCall)
    private readonly toolCalls: Repository<AgentToolCall>,
    // G5 只读切片：本会话步骤时间线（get_session_steps）
    @InjectRepository(AgentStep)
    private readonly steps: Repository<AgentStep>,
    // Agent 侧部署的 fail-closed 前置读逃生门（`AGENT_DEPLOY_APPROVAL_REQUIRED`）。
    // @Optional：既有单测装配未提供时降级为「要审批」（安全侧）——用 `this.config?.`
    // 兜底，与本仓其它可选依赖同款姿态。
    @Optional()
    private readonly config?: ConfigService,
  ) {}

  onModuleInit(): void {
    this.bindTaskTools();
    this.bindApplicationTools();
    this.bindExecutorTools();
    this.bindSopTools();
    // P6 补齐：写工具执行体（白名单早已包含它们，P3 只绑了只读——
    // 不绑则模型调用一律「尚未实现」，事件处置/SOP 编排两大场景残废）
    this.bindWriteTools();
    this.bindAgentTools();
    this.logger.log(
      `Agent read-tool handlers bound: ${this.api.implementedTools().join(", ")}`,
    );
  }

  // ── Agent 自省组（P4）──────────────────────────────────────────

  /**
   * `get_tool_call_result`：回读**本会话**内某次工具调用的已存结果。
   *
   * 存在理由：工具结果进模型上下文时会被截断（首尾保留），而有副作用的工具
   * （trigger_task / approve_deployment / update_task）**不能**为了「再看一眼
   * 完整输出」而重跑。会话隔离靠执行器注入的 `ctx.sessionId`（工具参数里没有
   * sessionId——模型可控参数若含会话 id 就是跨会话读取漏洞）。
   */
  private bindAgentTools(): void {
    this.api.register("get_session_steps", async (args, ctx) => {
      const sessionId = ctx?.sessionId;
      if (!sessionId) {
        return {
          found: false,
          error: "missing session context (internal wiring error)",
        };
      }
      const limitRaw = Number(args.limit);
      const limit = Number.isFinite(limitRaw)
        ? Math.min(50, Math.max(1, Math.floor(limitRaw)))
        : 10;
      const beforeRaw = Number(args.beforeSeq);
      const beforeSeq = Number.isFinite(beforeRaw)
        ? Math.max(1, Math.floor(beforeRaw))
        : null;
      const rows = await this.steps.find({
        where: {
          sessionId,
          ...(beforeSeq !== null ? { seq: LessThan(beforeSeq) } : {}),
        },
        order: { seq: "DESC" },
        take: limit,
        select: {
          seq: true,
          role: true,
          content: true,
          toolCallId: true,
          toolCallsJson: true,
          createdAt: true,
        },
      });
      // 时间线按 seq 升序回给模型（分页方向是倒序，语义顺序是正序）。
      return {
        count: rows.length,
        steps: rows
          .slice()
          .reverse()
          .map((r) => ({
            seq: r.seq,
            role: r.role,
            content:
              typeof r.content === "string" ? r.content.slice(0, 300) : null,
            toolCalls: Array.isArray(r.toolCallsJson)
              ? r.toolCallsJson
                  .slice(0, 10)
                  .map(
                    (c) =>
                      (c as { function?: { name?: string }; id?: string })
                        ?.function?.name ?? "unknown",
                  )
              : null,
            createdAt: r.createdAt,
          })),
      };
    });

    this.api.register("get_tool_call_result", async (args, ctx) => {
      const toolCallId =
        typeof args.toolCallId === "string" ? args.toolCallId : "";
      const sessionId = ctx?.sessionId;
      if (!sessionId) {
        return {
          found: false,
          error: "missing session context (internal wiring error)",
        };
      }
      if (!toolCallId) {
        return { found: false, error: "toolCallId is required" };
      }
      const row = await this.toolCalls.findOne({
        where: { sessionId, toolCallId },
        select: {
          toolName: true,
          status: true,
          resultJson: true,
          resultTruncated: true,
        },
      });
      if (!row) {
        return {
          found: false,
          error:
            "no tool call with that id in THIS session (ids are session-scoped)",
        };
      }
      const stored = (row.resultJson ?? null) as Record<string, unknown> | null;
      const full = typeof stored?.full === "string" ? stored.full : null;
      if (full) {
        return {
          found: true,
          toolName: row.toolName,
          status: row.status,
          resultTruncated: row.resultTruncated,
          full,
        };
      }
      return {
        found: true,
        toolName: row.toolName,
        status: row.status,
        resultTruncated: row.resultTruncated,
        preview: stored,
        note:
          "only a truncated preview (<=500 chars) + sha256 were stored for this " +
          "result (sanitized full text exceeded the 32KB storage cap). Re-query the underlying " +
          "resource if you need more detail.",
      };
    });
  }

  // ── 任务组 ──────────────────────────────────────────────────────

  private bindTaskTools(): void {
    this.api.register("list_tasks", async (args) => {
      const res = await this.tasks.findAll({
        page: this.num(args.page, 1),
        pageSize: this.num(args.pageSize, 20),
        status: args.status as string | undefined,
        name: args.name as string | undefined,
      } as never);
      // 紧凑投影：findAll 返回完整 Task 实体（glueSource/params/secrets 等
      // 大字段），而 Agent 只需要 id/name/status/调度/最近执行。此前原样
      // 回传会让单条记录 ~2KB，TOOL_RESULT_MAX_CHARS=2000 直接截断，模型
      // 看不到完整列表 → 反复换分页重试（真模型实测 list_tasks 调了 7 次）。
      // 这里只保留决策所需字段，既避免截断，也避免把脚本/凭据塞进 LLM 上下文。
      return compactTaskList(res);
    });

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
      const res = taskId
        ? await this.tasks.getExecutions(taskId, paging as never)
        : await this.tasks.getAllExecutions(paging as never);
      // 同 list_tasks：完整执行行含 logs/aiAnalysis 等大字段，原样回传会被
      // 2000 字符闸截断，模型只能看到前几条并反复翻页。
      return compactExecutionList(res);
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
    this.api.register("list_executors", async () => {
      const rows = await this.executors.findAll();
      // 完整 Executor 实体含 interpreters / runningExecutionIds 等大数组；
      // Agent 只需要地址、状态、负载与能力，投影后再回传。
      return compactExecutorList(rows);
    });

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
        if (!exec)
          throw new AppError("AGENT_TOOL_EXECUTOR_NOT_FOUND", {
            address: this.str(args.executorAddress),
          });
        executorId = exec.id;
      }
      if (!executorId)
        throw new AppError("AGENT_TOOL_EXECUTOR_TARGET_REQUIRED");
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
        const prev = (await this.tasks.getExecution(
          this.str(args.executionId),
        )) as {
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
    // TOOLS-03：schema 的必填是 {name, version, runtime}，执行体此前只传
    // name/description/gitRepo —— 插入必然违反 NOT NULL（23502）。schema 是
    // 模型唯一能看到的契约，执行体读的键必须与它逐字对齐。
    this.api.register("create_application", async (args) =>
      this.applications.create(
        {
          name: this.str(args.name),
          version: this.str(args.version),
          runtime: this.str(args.runtime),
          ...(args.description
            ? { description: this.str(args.description) }
            : {}),
          ...(args.gitRepo ? { gitRepo: this.str(args.gitRepo) } : {}),
        } as never,
        null,
      ),
    );

    // ── update_application / cancel_deployment（2026-11-02：从「看得见但永远
    //    失败」修成「真的能执行，但必须先有人点头」）────────────────────
    //
    // ## 为什么「没绑定」是缺陷，不是设计
    // 两条 spec 都在注册表里（`tool-registry.ts:606` / `:909`）⇒ 模型看得见
    // （chat 会话不限工具）。但 `AgentApiClient.invoke` 对没有登记执行体的
    // 工具如实返回「尚未实现」（`agent-api.client.ts:115-122`）。模型拿到的
    // 不是「没这个能力」，而是「这次调用失败了」——它会怀疑是工具/参数坏了
    // 并**反复重试**，白烧轮次与预算；而这两条都是**写**工具（改生产应用 /
    // 撤部署审批），本该受审批闸管控。看得见 + 永远失败 + 没有门，三件事同时
    // 成立才是缺陷本身，`gate-inventory.ts` 的 `kind: "unbound"` 当时就是
    // 把这件事登记成「已知、待裁定」，而不是宣布它安全。
    //
    // ## 审批闸怎么保证（两条都是硬要求，不是为了跑通而放宽）
    // 两条在注册表都声明了 `approvalRequired: true`（`tool-registry.ts:622`
    // 与 `:918`）⇒ 闸门在**执行之前**就返回 NEED_APPROVAL
    // （`boundary/agent-boundary.service.ts:281`），`ToolExecutorService` 落
    // `agent_approvals` 行并挂起会话；**没有批准单就永远走不到本文件的执行体**
    // （批准后重放才带 approvedApprovalKey，且一张单只放行一次）。这是逐工具
    // 闸：不随 `agent.policy.writeRequiresApproval` 放宽而放宽——与
    // update_task / sop_publish 同档。
    this.api.register("update_application", async (args) =>
      this.applications.update(
        this.str(args.applicationId),
        normaliseApplicationPatch(args.patch) as never,
        // Agent 没有具名用户。user=null 时 ApplicationService 的属主守卫
        // （assertCanWriteProjectAware：无主行 → APPLICATION_HAS_NO_OWNER，
        // 有主行 → APPLICATION_NOT_OWNER）对**每一行**都拒——传 null 等于
        // 「绑定了但永远 403」，和「尚未实现」是同一种不可用缺陷。
        null,
        // 因此走既有的机器面语义 systemBypass（CI 发版 webhook 走同一条，
        // application.controller.ts:741）。这**不是**新开的口子：
        //   · 授权依据从「HMAC 已鉴权」换成「人逐次批准」（approvalRequired）；
        //   · 动作留有 agent_tool_calls.argsJson + agent_approvals 两处台账；
        //   · 人工路径（控制台 PUT /applications/:id）不传 systemBypass，
        //     属主判定与 200/403 语义逐字节不变。
        // 代价如实写明：systemBypass 会跳过 service 内的 application.update
        // 审计行（该分支既有语义，见 application.service.ts:745-752），故
        // Agent 侧的可追溯性由上面两处台账承担，而不是假装它没被跳过。
        { systemBypass: true },
      ),
    );

    // cancel_deployment：撤回一条**待审批**的部署请求（DEP-04 的出口之一）。
    // actor 与 deployApp 同形：id=null = 无具名主体（approvalMeta.requestedBy
    // 为 null 的机器提交者），name 让审批待办与事件流里显示「agent」。
    // 注意这正是它必须带审批的原因：`cancelDeployment` 的「仅发起人」校验
    // 在 actor.id=null 时被跳过（app-deployment.service.ts:1776-1783），绑定
    // 后 Agent 能撤掉**任何人**的待审批请求——高影响且改写双人审批的事实。
    this.api.register("cancel_deployment", async (args) =>
      this.deployments.cancelDeployment(this.str(args.deploymentId), {
        id: null,
        name: "agent",
      }),
    );

    // create_task_from_template：沙箱校验后允许（新建不破坏既有）
    //
    // TOOLS-03：schema 声明的是 `{template, name, description, overrides}`，
    // 执行体此前读 args.templateId（undefined → findOne("") → NOT_FOUND），
    // 并把 schema 必填的 name 静默丢弃。这里按 schema 读 template，并把
    // name/description 归一进 instantiate 的 body（overrides 可覆盖）。
    this.api.register("create_task_from_template", async (args) =>
      this.templates.instantiate(this.str(args.template), {
        ...(args.name ? { name: this.str(args.name) } : {}),
        ...(args.description
          ? { description: this.str(args.description) }
          : {}),
        ...((args.overrides && typeof args.overrides === "object"
          ? args.overrides
          : {}) as Record<string, unknown>),
      }),
    );

    // deploy_application / deploy_app：**方案 C**（03 §3）+ **Agent 侧
    // fail-closed 前置**（2026-11-01 实施轮，DEP-04 默认关 ⇒ 默认零门）。
    //
    // ── 为什么这里需要一道门 ──────────────────────────────────────
    // 方案 C 把「门」全交给 DEP-04，而 DEP-04 是**按应用**的开关且**默认
    // false**（`application.entity.ts:60`）⇒ 从未开过审批的应用，Agent 部署
    // 是**零门**的：模型一声令下，生产应用直接派发到执行器，无人点头。
    // 人工路径不需要这道门——人点的那一下，人自己就是决策者；但 Agent 不是
    // 人，机器替人部署生产应用必须有人点头。
    //
    // ── 判据（可复核）────────────────────────────────────────────
    // Agent 触发的部署**一律**要求人工审批：即使目标应用没开
    // `approvalRequired`，也走 DEP-04 的冻结路径（落 pending_approval 行、
    // 零派发），由另一位管理员在审批待办里处置。
    // 应用**已开**开关时走的是**同一条** DEP-04 路径（既有 pending_approval
    // 语义逐字节不变）——只是门不再依赖「应用恰好开了开关」这个前提。
    //
    // ── 逃生门（默认安全）────────────────────────────────────────
    // `AGENT_DEPLOY_APPROVAL_REQUIRED=false` ⇒ 回到方案 C 的旧行为
    // （门只看应用开关）。默认**开**（=要审批）——「没配」绝不能等于
    // 「放开」：安全默认不可由「没配」变成「放开」（同
    // `agent.policy.executableSourceGate` 的 G3.6 纪律）。
    // 读取走 `ConfigService` 的**扁平 env 键**兜底（本仓 `EXECUTOR_ARTIFACT_ALLOW_SHARED_TOKEN`
    // / `LOG_PARTITION_ENABLED` 同款用法）：该键未在 configuration.ts 注册，
    // Nest 按同名环境变量兜底，运维置 env 即可生效，无需改代码。
    //
    // ── 为什么落在执行器（binder）侧而不是 service 侧 ────────────
    // 部署是中台侧动作，但这道门是**Agent 侧**的：判据是「谁触发的」，不是
    // 「部署什么」。放在 binder 执行体里，判据与「Agent 触发了部署」这件事
    // 同处一地，读代码即可复核；service 层只接受一个显式的
    // `intent.forceApproval` 参数（见 `DeploymentApprovalIntent` 头注），
    // 人工路径永远不传它 ⇒ 人工行为逐字节不变。
    //
    // 注意：**不**把它塞进 `agent_approvals`（工具调用审批）——那是「Agent
    // 要调这个工具吗」的面，与「这个部署要不要派发」的面是两回事；这里走
    // DEP-04 的部署审批链（第二人规则、审批待办、审计都是既有的）。
    const deployApp = async (args: Record<string, unknown>) => {
      const forceApproval = this.agentDeployApprovalRequired();
      return this.deployments.deploy(
        this.str(args.applicationId),
        {
          ...(args.executorId ? { executorId: this.str(args.executorId) } : {}),
          ...(args.runMode ? { runMode: args.runMode } : {}),
          ...(args.env ? { env: args.env } : {}),
        } as never,
        // 审批痕迹里的「提交者」：Agent 不是具名用户，但审批待办要能显示
        // 「谁发起的」。`id: null` = 无具名主体（`DeploymentApprovalActor`
        // 的既有语义）⇒ DEP-04 的第二人规则按「不可判定」放行并 warn
        // （审批人本就必然是位人，与机器提交者不构成同一人）；
        // `name: "agent"` ⇒ 待办里显示「提交者：agent」，人一眼能看出
        // 这行是机器发起的。
        { id: null, name: "agent" },
        // trigger 刻意不传：`DeploymentTriggerType` 只有 manual/upgrade/
        // rollback/approval 四个取值，没有「agent」——为它加一个枚举值会牵动
        // admin-web 的手工枚举清单（不在本轮足迹内），且把机器动作标成
        // 「手动」是**误导**。不传 ⇒ triggerType/operator 两列留 null
        // （与修复前逐字节一致）；Agent 的身份由上面 actor.name 承担。
        undefined,
        // fail-closed 前置：Agent 触发的部署要求人工审批。
        { forceApproval },
      );
    };
    this.api.register("deploy_application", deployApp);
    this.api.register("deploy_app", deployApp);

    // ── MUTEX-01 互斥组四工具（MUTEX-CLI/MCP 同步轮补齐）──────────────
    //
    // 为什么要绑：这四个端点在 MCP 面与中台都存在，agent 若只声明不绑定，
    // 模型调用一律得「尚未实现」——白名单形同虚设（与上方 P6 注释同一教训）。
    // delete_mutex_group 声明为 dangerous（默认禁用 + 强制审批），此处仍绑定
    // 执行体：tier 决定**是否放行**，绑定决定**放行后能不能跑**，两者正交。
    this.api.register("list_mutex_groups", async () =>
      this.mutexGroups.findAll(),
    );

    this.api.register("create_mutex_group", async (args) =>
      this.mutexGroups.create({
        name: this.str(args.name),
        ...(args.maxConcurrentPerDevice !== undefined
          ? { maxConcurrentPerDevice: this.num(args.maxConcurrentPerDevice, 1) }
          : {}),
        ...(args.scope ? { scope: args.scope } : {}),
        ...(args.description
          ? { description: this.str(args.description) }
          : {}),
      } as never),
    );

    this.api.register("update_mutex_group", async (args) => {
      // 与 CLI 同口径：空 patch（一个字段都没给）在服务端是「成功但什么都没改」，
      // 容易被模型误读为已生效——此处如实报错而不是静默返回成功。
      const patch: Record<string, unknown> = {};
      if (args.name !== undefined) patch.name = this.str(args.name);
      if (args.maxConcurrentPerDevice !== undefined) {
        patch.maxConcurrentPerDevice = this.num(args.maxConcurrentPerDevice, 1);
      }
      if (args.scope !== undefined) patch.scope = args.scope;
      if (args.description !== undefined) {
        patch.description = this.str(args.description);
      }
      if (Object.keys(patch).length === 0) {
        throw new AppError("AGENT_TOOL_MUTEX_GROUP_PATCH_EMPTY");
      }
      return this.mutexGroups.update(this.str(args.groupId), patch as never);
    });

    this.api.register("delete_mutex_group", async (args) =>
      this.mutexGroups.remove(
        this.str(args.groupId),
        args.force === true || args.force === "true",
      ),
    );
  }

  // ── 参数取值辅助（闸门已保证类型，这里只做缺省）─────────────────

  /**
   * Agent 侧部署是否**强制**要求人工审批（fail-closed 前置的逃生门）。
   *
   * ## 判据
   * 读 `AGENT_DEPLOY_APPROVAL_REQUIRED`（扁平 env 键，运维置 env 即生效）：
   *   · 缺省 / `true` / `1` ⇒ **要审批**（安全侧）：Agent 触发的部署一律
   *     走 DEP-04 的冻结路径，即使目标应用没开 `approvalRequired`。
   *   · `false` / `0` ⇒ 回退到方案 C 的旧行为（门只看应用开关）。
   *
   * ## 为什么默认是「要审批」
   * 「没配」不等于「放开」——安全默认不可由「没配」变成「放开」（同
   * `agent.policy.executableSourceGate` 的 G3.6 纪律）。DEP-04 的开关默认
   * 关（`application.entity.ts:60`），若这里也默认放开，Agent 部署就是
   * **默认零门**——那正是本轮要修的缺口。
   *
   * ## 为什么用扁平 env 键而不是 `agent.policy.*`
   * `ConfigService.get("agent.policy.x")` 只在**该键已注册进
   * `configuration.ts`** 时才解析得到值（实测：未注册的 dotted 键恒
   * `undefined`）；扁平键则由 Nest 按同名环境变量兜底（`ConfigService` 的
   * process.env 分支），运维置 env 即生效、无需改代码——与本仓
   * `EXECUTOR_ARTIFACT_ALLOW_SHARED_TOKEN` / `LOG_PARTITION_ENABLED`
   * 同款用法。注册进 `configuration.ts` 需要动本轮足迹外的文件，故用扁平键。
   */
  private agentDeployApprovalRequired(): boolean {
    const raw = this.config?.get<unknown>(AGENT_DEPLOY_APPROVAL_REQUIRED_KEY);
    if (raw === undefined || raw === null || raw === "") return true;
    if (typeof raw === "boolean") return raw;
    const s = String(raw).trim().toLowerCase();
    // 只有显式的 false / 0 才放行；任何看不懂的值都按安全侧（要审批）处理。
    if (s === "false" || s === "0") return false;
    return true;
  }

  private str(v: unknown): string {
    return typeof v === "string" ? v : String(v ?? "");
  }

  private num(v: unknown, fallback: number): number {
    const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
    return Number.isFinite(n) ? n : fallback;
  }
}

/**
 * `update_application` 的 `patch` 可写字段（= `UpdateApplicationDto` 的列）。
 *
 * ## 为什么执行体要自己白名单（而不是把 patch 原样交给 service）
 * Agent 走的是**直调 Service**（不经 HTTP 的 `ValidationPipe`）：
 *   · 未知键会被 TypeORM 当成列名拼进 UPDATE（500，而且模型只会看到一条
 *     含糊的 DB 报错）；
 *   · 空 patch 在 service 里是「成功但什么都没改」——模型会把它误读成
 *     「已生效」并继续往下推理（MCP 侧同一教训：`NO_UPDATABLE_FIELDS`）。
 * 执行体是模型与 DB 之间唯一能做形状校验的一层，所以在这里收口，非法 patch
 * 当场给 400 稳定码（`VALIDATION_FAILED`）。
 *
 * ## 刻意**不含**的两个字段
 *   · `name` ——注册表描述逐字写着「renaming is not supported」；
 *   · `webhookSecret` ——纯凭据字段，而审批预览对凭据值一律打码
 *     （`ToolExecutorService.sanitizeArgs`），放进来等于让人「看不见内容就
 *     点头」。要轮换请在控制台由人操作。
 */
const UPDATE_APPLICATION_PATCH_FIELDS: ReadonlySet<string> = new Set([
  "description",
  "version",
  "runtime",
  "status",
  "gitRepo",
  "gitBranch",
  "gitCommit",
  "manifest",
  "env",
  "entrypoint",
  "packageUrl",
  "approvalRequired",
  "mutexGroupId",
]);

/** 应用状态的合法取值（与 `ApplicationStatus` 逐字一致，避免为一处校验引依赖）。 */
const APPLICATION_STATUS_VALUES: ReadonlySet<string> = new Set([
  "active",
  "deploying",
  "failed",
]);

/**
 * 归一 + 校验 `update_application.patch`（非法即 400，不是「尚未实现」）。
 *
 * 校验只做「形状」：字段是否可写、值类型是否与 DTO 列一致。**不做业务判断**
 * （组是否存在、版本号语义等留给 service）——执行体越权做业务校验就会与
 * 人工路径（REST）产生两套真相。
 */
export function normaliseApplicationPatch(
  raw: unknown,
): Record<string, unknown> {
  const allowed = [...UPDATE_APPLICATION_PATCH_FIELDS].join(", ");
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AppError("VALIDATION_FAILED", {
      detail:
        "update_application.patch 必须是「字段名 → 新值」的对象" +
        `（可写字段：${allowed}）`,
    });
  }
  const patch = raw as Record<string, unknown>;
  const keys = Object.keys(patch);
  if (keys.length === 0) {
    throw new AppError("VALIDATION_FAILED", {
      detail:
        "update_application.patch 为空——没有任何字段会被改动" +
        `（可写字段：${allowed}）`,
    });
  }
  const unknownKeys = keys.filter(
    (k) => !UPDATE_APPLICATION_PATCH_FIELDS.has(k),
  );
  if (unknownKeys.length > 0) {
    throw new AppError("VALIDATION_FAILED", {
      detail:
        `update_application.patch 含不可更新字段：${unknownKeys.join(", ")}` +
        `（可写字段：${allowed}）`,
    });
  }
  for (const key of keys) {
    const value = patch[key];
    if (key === "manifest" || key === "env") {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new AppError("VALIDATION_FAILED", {
          detail: `update_application.patch.${key} 必须是对象`,
        });
      }
      continue;
    }
    if (key === "approvalRequired") {
      if (typeof value !== "boolean") {
        throw new AppError("VALIDATION_FAILED", {
          detail: "update_application.patch.approvalRequired 必须是布尔值",
        });
      }
      continue;
    }
    if (key === "mutexGroupId") {
      // null = 摘组（service 的既有语义），其余必须是字符串 id。
      if (value !== null && typeof value !== "string") {
        throw new AppError("VALIDATION_FAILED", {
          detail: "update_application.patch.mutexGroupId 必须是字符串或 null",
        });
      }
      continue;
    }
    if (typeof value !== "string") {
      throw new AppError("VALIDATION_FAILED", {
        detail: `update_application.patch.${key} 必须是字符串`,
      });
    }
    if (key === "status" && !APPLICATION_STATUS_VALUES.has(value)) {
      throw new AppError("VALIDATION_FAILED", {
        detail:
          `update_application.patch.status 取值非法（${value}）——` +
          "只接受 active | deploying | failed",
      });
    }
  }
  return patch;
}

/** list_tasks 的紧凑投影：只保留 Agent 决策需要的字段。 */
const TASK_LIST_FIELDS = [
  "id",
  "name",
  "status",
  "triggerType",
  "cronExpression",
  "fixedRate",
  "timezone",
  "lastTriggerTime",
  "applicationId",
  "runtime",
  "enabled",
] as const;

function pickTask(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of TASK_LIST_FIELDS) {
    if (row[key] !== undefined) out[key] = row[key];
  }
  return out;
}

export function compactTaskList(res: unknown): unknown {
  if (Array.isArray(res)) {
    return {
      tasks: res.map((row) => pickTask(row as Record<string, unknown>)),
    };
  }
  if (!res || typeof res !== "object") return res;
  const rec = res as Record<string, unknown>;
  const rows = Array.isArray(rec.list)
    ? rec.list
    : Array.isArray(rec.items)
      ? rec.items
      : null;
  if (!rows) return res;
  return {
    total: rec.total,
    page: rec.page,
    pageSize: rec.pageSize,
    totalPages: rec.totalPages,
    tasks: rows.map((row) => pickTask(row as Record<string, unknown>)),
  };
}

/** list_executions 的紧凑投影：去掉 logs/aiAnalysis/artifacts 等大字段。 */
const EXECUTION_LIST_FIELDS = [
  "id",
  "taskId",
  "taskName",
  "status",
  "triggerType",
  "executorAddress",
  "createdAt",
  "startTime",
  "endTime",
  "duration",
  "exitCode",
  "failureReason",
  "errorMessage",
] as const;

function pickExecution(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of EXECUTION_LIST_FIELDS) {
    const value = row[key];
    if (value === undefined) continue;
    out[key] =
      key === "errorMessage" && typeof value === "string"
        ? value.slice(0, 500)
        : value;
  }
  return out;
}

export function compactExecutionList(res: unknown): unknown {
  const pickRows = (rows: unknown[]): Record<string, unknown>[] =>
    rows.map((row) => pickExecution(row as Record<string, unknown>));
  if (Array.isArray(res)) return { executions: pickRows(res) };
  if (!res || typeof res !== "object") return res;
  const rec = res as Record<string, unknown>;
  const rows = Array.isArray(rec.list)
    ? rec.list
    : Array.isArray(rec.items)
      ? rec.items
      : null;
  if (!rows) return res;
  return {
    total: rec.total,
    page: rec.page,
    pageSize: rec.pageSize,
    totalPages: rec.totalPages,
    executions: pickRows(rows),
  };
}

/** list_executors 的紧凑投影：去掉 interpreters/runningExecutionIds 等大数组。 */
const EXECUTOR_LIST_FIELDS = [
  "id",
  "address",
  "appName",
  "status",
  "lastHeartbeat",
  "groupName",
  "tags",
  "capabilities",
  "maxConcurrentTasks",
  "runningTaskCount",
  "executorVersion",
] as const;

function pickExecutor(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of EXECUTOR_LIST_FIELDS) {
    if (row[key] !== undefined) out[key] = row[key];
  }
  return out;
}

export function compactExecutorList(res: unknown): unknown {
  if (Array.isArray(res)) {
    return {
      executors: res.map((row) => pickExecutor(row as Record<string, unknown>)),
    };
  }
  return res;
}
