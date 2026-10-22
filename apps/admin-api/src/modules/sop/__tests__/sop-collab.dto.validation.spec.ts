/**
 * 回归：agent-collab 的 DTO 必须真的参与全局 ValidationPipe。
 *
 * 真机 headless-agent 联调抓到的缺陷：这些 DTO 只有 @ApiProperty（OpenAPI
 * 装饰器），没有 class-validator 装饰器；而 main.ts 的 ValidationPipe 开了
 * `whitelist + forbidNonWhitelisted`，于是 capability/poll/complete 的每个
 * 字段都被判成「未声明」→ 400，执行器永远报不上 agent:sop，SOP 指派永远
 * 403。控制器单测直接调方法、绕过了 pipe，所以一直没红。
 *
 * 这里按生产 pipe 配置逐 DTO 验证：合法体通过、未知字段被拒、关键字段的
 * 类型/格式被校验。
 */
import { ValidationPipe } from "@nestjs/common";
import {
  AgentCollabAckReplyDto,
  AgentCollabCapabilityDto,
  AgentCollabClarificationDto,
  AgentCollabCompleteDto,
  AgentCollabPollDto,
  AgentCollabProgressDto,
} from "../sop-collab.controller";

const pipe = new ValidationPipe({
  whitelist: true,
  transform: true,
  forbidNonWhitelisted: true,
});

const validateBody = (metatype: new () => unknown, value: Record<string, unknown>) =>
  pipe.transform(value, { type: "body", metatype });

const UUID = "550e8400-e29b-41d4-a716-446655440000";

describe("agent-collab DTO validation (production pipe)", () => {
  it("capability：合法体通过（agent:sop 能真正上报）", async () => {
    const out = await validateBody(AgentCollabCapabilityDto, {
      address: "office-pc-07:8002",
      capabilities: ["agent:sop", "filesystem"],
      report: { gui: false },
    });
    expect(out).toMatchObject({
      address: "office-pc-07:8002",
      capabilities: ["agent:sop", "filesystem"],
    });
  });

  it("capability：未知字段被拒（forbidNonWhitelisted 仍生效）", async () => {
    await expect(
      validateBody(AgentCollabCapabilityDto, {
        address: "office-pc-07:8002",
        capabilities: ["agent:sop"],
        unexpected: true,
      }),
    ).rejects.toBeTruthy();
  });

  it("poll：合法体（含 resendAssignments 的 boolean / 数组两形态）通过", async () => {
    await expect(
      validateBody(AgentCollabPollDto, { address: "a:1", waitMs: 0 }),
    ).resolves.toMatchObject({ address: "a:1", waitMs: 0 });
    await expect(
      validateBody(AgentCollabPollDto, {
        address: "a:1",
        resendAssignments: true,
        inflight: ["id-1"],
      }),
    ).resolves.toMatchObject({ resendAssignments: true });
    await expect(
      validateBody(AgentCollabPollDto, {
        address: "a:1",
        resendAssignments: ["id-1"],
      }),
    ).resolves.toMatchObject({ resendAssignments: ["id-1"] });
  });

  it("clarification：UUID 格式被校验", async () => {
    await expect(
      validateBody(AgentCollabClarificationDto, {
        address: "a:1",
        assignmentId: UUID,
        clientClarificationId: UUID,
        question: "which env?",
      }),
    ).resolves.toMatchObject({ assignmentId: UUID });
    await expect(
      validateBody(AgentCollabClarificationDto, {
        address: "a:1",
        assignmentId: "not-a-uuid",
        question: "which env?",
      }),
    ).rejects.toBeTruthy();
  });

  it("progress / complete / ack：合法体通过，非法 status 被拒", async () => {
    await expect(
      validateBody(AgentCollabProgressDto, {
        address: "a:1",
        progressJson: { step: 1 },
      }),
    ).resolves.toMatchObject({ address: "a:1" });
    await expect(
      validateBody(AgentCollabCompleteDto, {
        address: "a:1",
        status: "completed",
        result: { outcome: "delivered" },
        attempt: 1,
      }),
    ).resolves.toMatchObject({ status: "completed" });
    await expect(
      validateBody(AgentCollabCompleteDto, { address: "a:1", status: "weird" }),
    ).rejects.toBeTruthy();
    await expect(
      validateBody(AgentCollabAckReplyDto, {
        address: "a:1",
        clarificationId: UUID,
      }),
    ).resolves.toMatchObject({ clarificationId: UUID });
  });
});
