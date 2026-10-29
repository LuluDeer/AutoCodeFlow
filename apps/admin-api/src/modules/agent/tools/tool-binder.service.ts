import {
  Injectable,
  Logger,
  OnModuleInit,
  Inject,
  forwardRef,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
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

    // deploy_application / deploy_app：**方案 C**（03 §3）——不新增审批机制，
    // 直接调 deploy；DEP-04 开启时返回 pending_approval 且不派发，Agent 把
    // 「需要人批」转述给人。审批是唯一事实源（DEP-04），审计链干净。
    const deployApp = async (args: Record<string, unknown>) =>
      this.deployments.deploy(this.str(args.applicationId), {
        ...(args.executorId ? { executorId: this.str(args.executorId) } : {}),
        ...(args.runMode ? { runMode: args.runMode } : {}),
        ...(args.env ? { env: args.env } : {}),
      } as never);
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

  private str(v: unknown): string {
    return typeof v === "string" ? v : String(v ?? "");
  }

  private num(v: unknown, fallback: number): number {
    const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
    return Number.isFinite(n) ? n : fallback;
  }
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
