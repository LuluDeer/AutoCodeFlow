import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { ConfigService } from "@nestjs/config";
import { randomBytes } from "crypto";
import { Repository } from "typeorm";
import { Task, TaskStatus } from "./entities/task.entity";
import {
  ExecutionStatus,
  TaskExecution,
} from "./entities/task-execution.entity";
import { UserRole } from "../users/entities/user.entity";
import { TASK_PARAMS_MAX_BYTES, TaskService } from "./task.service";
import { SecretsCryptoService } from "../../common/utils/secret-crypto.util.service";
import { isEncryptedSecret } from "../../common/utils/secret-crypto.util";
import {
  verifyWebhookSignature,
  type WebhookSignatureFailure,
} from "../../common/utils/webhook-hmac.util";
import { AuditService } from "../audit/audit.service";

/** 任务 webhook 密钥前缀（acf 前缀族；w=webhook，泄漏扫描可识别）。 */
const WEBHOOK_SECRET_PREFIX = "acfw_";

/** 密钥熵：32 随机字节 hex（256-bit），与前缀合计 69 字符。 */
const WEBHOOK_SECRET_RANDOM_BYTES = 32;

/** 同步等待模式（?wait=1）的轮询间隔。 */
const WAIT_POLL_INTERVAL_MS = 500;

/** 同步等待模式允许的 timeout 上限（秒）——长任务必须走出站订阅回调，
 *  HTTP 连接与上游调用方（飞书自动化等）的超时都撑不住分钟级以上挂起。 */
export const WEBHOOK_WAIT_MAX_SECONDS = 300;

/** 同步等待模式缺省 timeout（秒）。 */
export const WEBHOOK_WAIT_DEFAULT_SECONDS = 60;

/** 终态集合：wait 模式与「执行结束」判定的单一事实源。 */
const TERMINAL_EXECUTION_STATUSES: ReadonlySet<string> = new Set([
  ExecutionStatus.SUCCESS,
  ExecutionStatus.FAILED,
  ExecutionStatus.TIMEOUT,
  ExecutionStatus.KILLED,
  ExecutionStatus.CANCELLED,
]);

/** wait 模式响应里的执行视图（显式白名单——logs/result 大对象按需，绝不带 secrets）。 */
export interface TaskWebhookExecutionView {
  id: string;
  taskId: string | null;
  taskName: string;
  status: string;
  result: Record<string, unknown> | null;
  errorMessage: string | null;
  failureReason: string | null;
  startTime: Date | null;
  endTime: Date | null;
  duration: number | null;
  executorAddress: string | null;
  exitCode: number | null;
}

export interface TaskWebhookStatus {
  enabled: boolean;
  url: string;
}

export interface TaskWebhookSecretIssued {
  url: string;
  /** 明文密钥——仅本响应返回一次，服务端只存加密信封。 */
  secret: string;
}

/**
 * FEAT-21: 任务级 webhook 入站触发。
 *
 * 复刻 applications 发版 webhook 的既有安全姿态（per-record secret +
 * HMAC-SHA256 over `${timestamp}.${rawBody}`，校验收敛在
 * common/utils/webhook-hmac.util），触发内核直接复用
 * TaskService.trigger(..., "webhook")——入队/补偿/互斥组快照/审计全继承。
 *
 * 反枚举：任务不存在 / 未启用 / 签名失败 → 同一条 401 消息，使
 * "taskId 是否存在" 不可探测（APP-001 先例）；具体原因只进日志。
 */
@Injectable()
export class TaskWebhookService {
  private readonly logger = new Logger(TaskWebhookService.name);

  constructor(
    @InjectRepository(Task) private readonly taskRepo: Repository<Task>,
    @InjectRepository(TaskExecution)
    private readonly execRepo: Repository<TaskExecution>,
    private readonly taskService: TaskService,
    private readonly secretsCrypto: SecretsCryptoService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  /** 任务 webhook 的展示 URL（apiBaseUrl 未配置时退化为站内绝对路径）。 */
  webhookUrl(taskId: string): string {
    const base = (this.config.get<string>("app.apiBaseUrl") ?? "").replace(
      /\/+$/,
      "",
    );
    return `${base}/api/webhooks/tasks/${taskId}`;
  }

  /** 管理面取数：默认全列 + 显式带出 select:false 的 webhookSecret。 */
  private async loadTaskWithSecret(id: string): Promise<Task | null> {
    return this.taskRepo
      .createQueryBuilder("task")
      .addSelect("task.webhookSecret")
      .where("task.id = :id", { id })
      .andWhere("task.status != :deleted", { deleted: TaskStatus.DELETED })
      .getOne();
  }

  /** 降级模式兼容：enc:v1 信封 → 解密；明文（SEC_SECRETS_KEY 未配置期）原样。 */
  private resolveSecret(stored: string): string {
    return isEncryptedSecret(stored)
      ? this.secretsCrypto.decryptValue(stored)
      : stored;
  }

  /**
   * 写侧与 secrets 列同生命周期：key 未配置（encryptionEnabled=false）时存
   * 明文并沿用 SecretsCryptoService 的一次性降级告警——encryptValue 本体在
   * 降级态抛错，这里按 encryptionEnabled 显式分流。
   */
  private encryptSecret(plain: string): string {
    return this.secretsCrypto.encryptionEnabled
      ? this.secretsCrypto.encryptValue(plain)
      : plain;
  }

  /** best-effort 审计落证（fail-open——审计故障绝不吞掉已入队的执行结果）。 */
  private async safeAudit(payload: {
    user?: { id: number; username?: string | null } | null;
    action: string;
    resourceId?: string;
    detail?: Record<string, unknown>;
    ip?: string | null;
  }): Promise<void> {
    try {
      await this.audit.log({
        userId: payload.user?.id,
        username: payload.user?.username ?? undefined,
        action: payload.action,
        resource: "task",
        resourceId: payload.resourceId,
        detail: payload.detail,
        ip: payload.ip ?? undefined,
      });
    } catch (err: unknown) {
      this.logger.warn(
        `Task webhook audit write failed (${payload.action}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  async getStatus(
    id: string,
    user: { id: number; role: UserRole },
  ): Promise<TaskWebhookStatus> {
    const task = await this.loadTaskWithSecret(id);
    if (!task) throw new NotFoundException("Task not found");
    await this.taskService.assertCanOperate(task, user);
    return { enabled: !!task.webhookSecret, url: this.webhookUrl(task.id) };
  }

  async enable(
    id: string,
    user: { id: number; username?: string | null; role: UserRole } | null,
    ip?: string | null,
  ): Promise<TaskWebhookSecretIssued> {
    return this.issueSecret(id, user, ip, "task.webhook_enable");
  }

  async rotate(
    id: string,
    user: { id: number; username?: string | null; role: UserRole } | null,
    ip?: string | null,
  ): Promise<TaskWebhookSecretIssued> {
    return this.issueSecret(id, user, ip, "task.webhook_rotate");
  }

  /** enable 与 rotate 共用：生成新密钥并覆盖（对已启用任务 enable 等价 rotate）。 */
  private async issueSecret(
    id: string,
    user: { id: number; username?: string | null; role: UserRole } | null,
    ip: string | null | undefined,
    action: string,
  ): Promise<TaskWebhookSecretIssued> {
    const task = await this.loadTaskWithSecret(id);
    if (!task) throw new NotFoundException("Task not found");
    await this.taskService.assertCanOperate(task, user);
    const secret =
      WEBHOOK_SECRET_PREFIX +
      randomBytes(WEBHOOK_SECRET_RANDOM_BYTES).toString("hex");
    await this.taskRepo.update(task.id, {
      webhookSecret: this.encryptSecret(secret),
    });
    await this.safeAudit({
      user,
      action,
      resourceId: task.id,
      detail: { webhook: true, wasEnabled: !!task.webhookSecret },
      ip,
    });
    return { url: this.webhookUrl(task.id), secret };
  }

  async disable(
    id: string,
    user: { id: number; username?: string | null; role: UserRole } | null,
    ip?: string | null,
  ): Promise<{ enabled: false }> {
    const task = await this.loadTaskWithSecret(id);
    if (!task) throw new NotFoundException("Task not found");
    await this.taskService.assertCanOperate(task, user);
    await this.taskRepo.update(task.id, { webhookSecret: null });
    await this.safeAudit({
      user,
      action: "task.webhook_disable",
      resourceId: task.id,
      detail: { webhook: true },
      ip,
    });
    return { enabled: false };
  }

  /**
   * 入站触发：HMAC 校验 →（可选）params 体积门 → TaskService.trigger
   * （triggerType="webhook"）→（可选）同步等待终态。
   */
  async triggerFromWebhook(
    taskId: string,
    dto: { params?: Record<string, unknown> },
    opts: {
      rawBody?: Buffer;
      signature?: string;
      timestamp?: string;
      wait?: boolean;
      timeoutSeconds?: number;
      ip?: string | null;
      userAgent?: string | null;
    },
  ): Promise<
    | TaskExecution
    | { completed: boolean; execution: TaskWebhookExecutionView | null }
  > {
    const authFail = () =>
      new UnauthorizedException("Task webhook authentication failed");
    const task = await this.loadTaskWithSecret(taskId);
    if (!task || !task.webhookSecret) {
      // 与签名失败同消息：taskId 枚举探测与未启用任务不可区分。
      this.logger.warn(
        `Task webhook: reject taskId=${taskId} (${
          task ? "webhook not enabled" : "unknown task"
        })`,
      );
      throw authFail();
    }
    const failure: WebhookSignatureFailure | null = verifyWebhookSignature(
      {
        rawBody: opts.rawBody,
        signature: opts.signature,
        timestamp: opts.timestamp,
      },
      this.resolveSecret(task.webhookSecret),
    );
    if (failure) {
      this.logger.warn(
        `Task webhook: signature verification failed (${failure}) taskId=${taskId}`,
      );
      throw authFail();
    }

    // 参数体积门（auth 通过之后才校验，避免用 400 消息反推密钥有效性）
    if (dto.params !== undefined) {
      let size = 0;
      try {
        size = Buffer.byteLength(JSON.stringify(dto.params) ?? "", "utf8");
      } catch {
        throw new BadRequestException("params must be a JSON object");
      }
      if (size > TASK_PARAMS_MAX_BYTES) {
        throw new BadRequestException(
          `params exceeds ${TASK_PARAMS_MAX_BYTES} bytes`,
        );
      }
    }

    const exec = await this.taskService.trigger(
      task.id,
      dto.params !== undefined ? { params: dto.params } : {},
      null,
      "webhook",
    );

    await this.safeAudit({
      action: "task.trigger_webhook",
      resourceId: task.id,
      detail: {
        taskId: task.id,
        executionId: exec.id,
        webhook: true,
        withParams: dto.params !== undefined,
        userAgent: opts.userAgent ?? undefined,
      },
      ip: opts.ip,
    });

    if (!opts.wait) return exec;
    return this.waitForTerminal(
      exec.id,
      opts.timeoutSeconds ?? WEBHOOK_WAIT_DEFAULT_SECONDS,
    );
  }

  /**
   * 同步等待执行到终态（或超时）。超时**不视为错误**：completed=false +
   * 最新快照，调用方改走 GET /tasks/:id/executions 轮询或出站订阅。
   */
  async waitForTerminal(
    executionId: string,
    timeoutSeconds: number,
  ): Promise<{
    completed: boolean;
    execution: TaskWebhookExecutionView | null;
  }> {
    const deadline =
      Date.now() +
      Math.min(Math.max(timeoutSeconds, 1), WEBHOOK_WAIT_MAX_SECONDS) * 1000;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let exec: TaskExecution | null = await this.pollView(executionId);
    while (
      exec &&
      !TERMINAL_EXECUTION_STATUSES.has(exec.status) &&
      Date.now() < deadline
    ) {
      await sleep(WAIT_POLL_INTERVAL_MS);
      exec = await this.pollView(executionId);
    }
    const completed = !!exec && TERMINAL_EXECUTION_STATUSES.has(exec.status);
    return { completed, execution: exec ? this.toView(exec) : null };
  }

  /** 只取 wait 视图需要的列（logs 等大字段不进轮询路径）。 */
  private async pollView(id: string): Promise<TaskExecution | null> {
    return this.execRepo.findOne({
      where: { id },
      select: {
        id: true,
        taskId: true,
        taskName: true,
        status: true,
        result: true,
        errorMessage: true,
        failureReason: true,
        startTime: true,
        endTime: true,
        duration: true,
        executorAddress: true,
        exitCode: true,
      },
    });
  }

  private toView(exec: TaskExecution): TaskWebhookExecutionView {
    return {
      id: exec.id,
      taskId: exec.taskId,
      taskName: exec.taskName,
      status: exec.status,
      result: exec.result ?? null,
      errorMessage: exec.errorMessage ?? null,
      failureReason: exec.failureReason ?? null,
      startTime: exec.startTime ?? null,
      endTime: exec.endTime ?? null,
      duration: exec.duration ?? null,
      executorAddress: exec.executorAddress ?? null,
      exitCode: exec.exitCode ?? null,
    };
  }
}
