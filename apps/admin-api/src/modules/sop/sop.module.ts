import { Module, forwardRef } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { BullModule } from "@nestjs/bullmq";

import { Sop } from "./entities/sop.entity";
import { SopVersion } from "./entities/sop-version.entity";
import { SopAssignment } from "./entities/sop-assignment.entity";
import { SopClarification } from "./entities/sop-clarification.entity";
import { AgentMedia } from "./entities/agent-media.entity";
import { SopService } from "./sop.service";
import { SopMediaService } from "./sop-media.service";
import { SopController } from "./sop.controller";
import { SopCollabController } from "./sop-collab.controller";
import { AgentModule } from "../agent/agent.module";
import { ExecutorModule } from "../executor/executor.module";
import { NotificationModule } from "../notification/notification.module";
import { AiModule } from "../ai/ai.module";
import { ExecutorPackageModule } from "../executor-package/executor-package.module";
import { SchedulerModule } from "../scheduler/scheduler.module";
import { AGENT_QUEUE_NAME } from "../agent/runtime/agent.processor";

/**
 * P5/P6（agent-and-deployment）：SOP 协议模块。
 *
 * ## 与 agent 模块的双向 forwardRef
 * 本模块需要 `AgentSessionService`（澄清上报时起 sop_review 会话）与
 * agent-jobs 队列；agent 模块的 `ToolBinderService` 又需要 `SopService`
 * （绑定 6 个 SOP 工具的执行体）。这是**装配期**的环（与 task/application
 * 的既有 forwardRef 同款），不是运行期调用环——SOP 的读写由 controller /
 * 工具体触发，Agent 循环只消费工具。
 *
 * ## 队列
 * `BullModule.registerQueue(AGENT_QUEUE_NAME)` 与 agent.module 注册的是
 * **同一条** agent-jobs 队列（同名 provider 共享实例）——澄清触发的
 * sop_review 会话与其它会话排同一条队、共享并发上限 2。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Sop,
      SopVersion,
      SopAssignment,
      SopClarification,
      AgentMedia,
    ]),
    forwardRef(() => AgentModule),
    ExecutorModule,
    NotificationModule,
    // P6 超时治理：leader 门禁复用 SchedulerService（与 AgentTrigger 同款）
    SchedulerModule,
    // P7a 续批：LLM relay（执行器 Agent 的推理经中台代跑，key 不出服务端）
    AiModule,
    // P7d 前半：候选应用包交付——复用既有包校验链（SEC-05 zip bomb 等）
    ExecutorPackageModule,
    BullModule.registerQueue({ name: AGENT_QUEUE_NAME }),
  ],
  controllers: [SopController, SopCollabController],
  providers: [SopService, SopMediaService],
  exports: [SopService],
})
export class SopModule {}
