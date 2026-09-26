import { BadRequestException, ForbiddenException, NotFoundException, UnauthorizedException } from "@nestjs/common";

import { SopCollabController } from "../sop-collab.controller";

/** 手工 fake 六个依赖（对照 sop.service.capabilities.spec 的 harness 风格）。 */
function harness(opts?: {
  agentCaps?: string[];
  tokenOk?: boolean;
  configValues?: Record<string, unknown>;
}) {
  const executor = { id: "exec-1", address: "office-pc-07:8002" };
  const executors = {
    findByAddress: jest.fn(async (address: string) =>
      address === "unknown" ? null : executor,
    ),
    validateTokenByAddress: jest.fn(async (..._a: unknown[]) => opts?.tokenOk ?? true),
    getAgentCapabilities: jest.fn(async () => opts?.agentCaps ?? ["agent:sop"]),
    updateCapabilities: jest.fn(async () => undefined),
  };
  const sops = {
    pollPending: jest.fn(async () => [] as unknown[]),
    ingestClarification: jest.fn(async () => ({
      clarification: { id: "c-1", clientClarificationId: "cc-1", round: 1 },
      escalated: false,
    })),
    recordProgress: jest.fn(async () => undefined),
    completeAssignment: jest.fn(async () => ({ accepted: true })),
    ackClarificationReply: jest.fn(async () => undefined),
    getAssignment: jest.fn(async (): Promise<Record<string, any>> => ({
      assignment: { targetExecutorId: "exec-1", sopVersion: "1.0.0" },
      sop: { id: "sop-1" },
    })),
  };
  const media = { save: jest.fn(async (v: unknown) => ({ saved: true, ...(v as object) })) };
  const packages = {
    create: jest.fn(async (..._args: unknown[]) => ({
      id: "pkg-1",
      name: "sop-candidate",
      version: "1.0.0+agent.x",
    })),
  };
  const config = {
    get: jest.fn((key: string) => opts?.configValues?.[key]),
  };
  const ai = {
    chatMultimodal: jest.fn(async (v: { messages: unknown[] }) => ({
      content: "ok",
      toolCalls: undefined,
      usage: { totalTokens: 1 },
      model: "qwen",
      messages: v.messages,
    })),
  };
  const ctl = new SopCollabController(
    executors as never,
    sops as never,
    media as never,
    packages as never,
    config as never,
    ai as never,
  );
  const auth = "Bearer tok-1";
  return { ctl, executors, sops, media, packages, config, ai, executor, auth };
}

describe("SopCollabController · 鉴权链（11 §2 + 能力闸 11 §5.1）", () => {
  it("缺 address / 未知机器 / 坏 token 分别 400/404/401", async () => {
    const h = harness();
    await expect(
      h.ctl.capability({ address: "", capabilities: [] } as never, h.auth),
    ).rejects.toThrow(BadRequestException);
    await expect(
      h.ctl.capability({ address: "unknown", capabilities: [] } as never, h.auth),
    ).rejects.toThrow(NotFoundException);
    const bad = harness({ tokenOk: false });
    await expect(
      bad.ctl.capability({ address: "x", capabilities: [] } as never, bad.auth),
    ).rejects.toThrow(UnauthorizedException);
  });

  it("协作面未声明 agent:sop → 403（空能力 ≠ 通用）", async () => {
    const h = harness({ agentCaps: [] });
    await expect(
      h.ctl.clarify(
        { address: "x", assignmentId: "a-1", question: "?" } as never,
        h.auth,
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it("Bearer 前缀剥离：带与不带前缀、无 header 等价", async () => {
    const h = harness();
    await h.ctl.capability({ address: "x", capabilities: ["agent:sop"] } as never, h.auth);
    await h.ctl.capability({ address: "x", capabilities: ["agent:sop"] } as never, "raw-tok");
    await h.ctl.capability({ address: "x", capabilities: ["agent:sop"] } as never, undefined);
    expect(h.executors.validateTokenByAddress).toHaveBeenCalledTimes(3);
    expect(h.executors.validateTokenByAddress.mock.calls[0][1]).toBe("tok-1");
    expect(h.executors.validateTokenByAddress.mock.calls[1][1]).toBe("raw-tok");
    expect(h.executors.validateTokenByAddress.mock.calls[2][1]).toBe("");
  });
});

describe("SopCollabController · poll（拉模式 + sopPolicy 下发）", () => {
  it("无等待（waitMs 缺省/非法）时立即返回 items + sopPolicy 回退值", async () => {
    const h = harness();
    const items = [{ id: "asg-1" }];
    h.sops.pollPending.mockResolvedValueOnce(items);
    const out = await h.ctl.poll({ address: "x" } as never, h.auth);
    expect(out.items).toEqual(items);
    expect(out.sopPolicy).toEqual({
      permissionPolicy: "standard",
      allowedProfiles: ["minimal", "standard"],
    });
    expect(h.sops.pollPending).toHaveBeenCalledWith(
      expect.objectContaining({ resendAssignments: false }),
    );
  });

  it("waitMs 钳位 ≤25s；resendAssignments=true 透传；config 有值时下发配置值", async () => {
    const h = harness({
      configValues: {
        "agent.collab.sopPolicy.permissionPolicy": "developer",
        "agent.collab.sopPolicy.allowedProfiles": ["minimal", "standard", "developer"],
      },
    });
    h.sops.pollPending
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "asg-2" }]);
    const out = await h.ctl.poll(
      { address: "x", waitMs: 999_999, resendAssignments: true } as never,
      h.auth,
    );
    expect(out.items).toEqual([{ id: "asg-2" }]);
    expect(out.sopPolicy.permissionPolicy).toBe("developer");
    expect(h.sops.pollPending).toHaveBeenLastCalledWith(
      expect.objectContaining({ resendAssignments: true }),
    );
  });

  it("sopPolicy 配置键为 null 时回退默认（形状校验在装配层 Joi，控制器 fail-open）", async () => {
    const h = harness({
      configValues: {
        "agent.collab.sopPolicy.permissionPolicy": null,
        "agent.collab.sopPolicy.allowedProfiles": null,
      },
    });
    h.sops.pollPending.mockResolvedValueOnce([{ id: "asg-1" }]);
    const out = await h.ctl.poll({ address: "x" } as never, h.auth);
    expect(out.sopPolicy.allowedProfiles).toEqual(["minimal", "standard"]);
    expect(out.sopPolicy.permissionPolicy).toBe("standard");
  });
});

describe("SopCollabController · capability（覆盖式上报入口）", () => {
  it("合法清单写回；非数组按空清单处理", async () => {
    const h = harness();
    await h.ctl.capability({ address: "x", capabilities: ["agent:sop", "browser"] } as never, h.auth);
    expect(h.executors.updateCapabilities).toHaveBeenCalledWith("exec-1", ["agent:sop", "browser"]);
    await h.ctl.capability({ address: "x", capabilities: "agent:sop" } as never, h.auth);
    expect(h.executors.updateCapabilities).toHaveBeenLastCalledWith("exec-1", []);
  });

  it(">32 个或含非字符串/超长项 → 400", async () => {
    const h = harness();
    await expect(
      h.ctl.capability(
        { address: "x", capabilities: Array.from({ length: 33 }, () => "c") } as never,
        h.auth,
      ),
    ).rejects.toThrow(BadRequestException);
    await expect(
      h.ctl.capability({ address: "x", capabilities: [42] } as never, h.auth),
    ).rejects.toThrow(BadRequestException);
    await expect(
      h.ctl.capability({ address: "x", capabilities: ["x".repeat(65)] } as never, h.auth),
    ).rejects.toThrow(BadRequestException);
  });
});

describe("SopCollabController · clarify / progress / complete / ack", () => {
  it("clarify：缺 assignmentId 或 question → 400；escalated 透传；幂等键优先回显", async () => {
    const h = harness();
    const out = await h.ctl.clarify(
      { address: "x", assignmentId: "a-1", question: "?" } as never,
      h.auth,
    );
    expect(out).toEqual({ clarificationId: "cc-1", round: 1, escalated: false });
    await expect(
      h.ctl.clarify({ address: "x", question: "?" } as never, h.auth),
    ).rejects.toThrow(BadRequestException);
    await expect(
      h.ctl.clarify({ address: "x", assignmentId: "a-1" } as never, h.auth),
    ).rejects.toThrow(BadRequestException);
    h.sops.ingestClarification.mockResolvedValueOnce({
      clarification: { id: "c-2", clientClarificationId: null, round: 2 },
      escalated: true,
    });
    const escalated = await h.ctl.clarify(
      { address: "x", assignmentId: "a-1", question: "?" } as never,
      h.auth,
    );
    expect(escalated).toEqual({ clarificationId: "c-2", round: 2, escalated: true });
  });

  it("progress：缺省 progressJson/targetAgentSessionId 归 null", async () => {
    const h = harness();
    await expect(
      h.ctl.progress("asg-1", { address: "x" } as never, h.auth),
    ).resolves.toEqual({ ok: true });
    expect(h.sops.recordProgress).toHaveBeenCalledWith({
      assignmentId: "asg-1",
      executorId: "exec-1",
      progressJson: null,
      targetAgentSessionId: null,
    });
  });

  it("complete：非法 status → 400；result/attempt 透传", async () => {
    const h = harness();
    await expect(
      h.ctl.complete("asg-1", { address: "x", status: "nope" } as never, h.auth),
    ).rejects.toThrow(BadRequestException);
    await h.ctl.complete(
      "asg-1",
      { address: "x", status: "failed", result: { why: "x" }, attempt: 2 } as never,
      h.auth,
    );
    expect(h.sops.completeAssignment).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", result: { why: "x" }, attempt: 2 }),
    );
  });

  it("ack：缺 clarificationId → 400；其余透传", async () => {
    const h = harness();
    await expect(
      h.ctl.ackClarificationReply("asg-1", { address: "x" } as never, h.auth),
    ).rejects.toThrow(BadRequestException);
    await h.ctl.ackClarificationReply(
      "asg-1",
      { address: "x", clarificationId: "c-1" } as never,
      h.auth,
    );
    expect(h.sops.ackClarificationReply).toHaveBeenCalledWith({
      assignmentId: "asg-1",
      executorId: "exec-1",
      clarificationId: "c-1",
    });
  });
});

describe("SopCollabController · llmRelay（P7a relay 载荷边界）", () => {
  const msg = { role: "user", content: "hi" };

  it("合法调用透传 chatMultimodal 并映射出参（toolCalls 缺省归 null）", async () => {
    const h = harness();
    const out = await h.ctl.llmRelay(
      { address: "x", messages: [msg] } as never,
      h.auth,
    );
    expect(out).toEqual({
      content: "ok",
      toolCalls: null,
      usage: { totalTokens: 1 },
      model: "qwen",
    });
    expect(h.ai.chatMultimodal).toHaveBeenCalledWith({ messages: [msg] });
  });

  it("messages 空 / >64 → 400", async () => {
    const h = harness();
    await expect(
      h.ctl.llmRelay({ address: "x" } as never, h.auth),
    ).rejects.toThrow(BadRequestException);
    await expect(
      h.ctl.llmRelay(
        { address: "x", messages: Array.from({ length: 65 }, () => msg) } as never,
        h.auth,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it("role 白名单 / content 非空串 / 100KB 上限逐条拒绝", async () => {
    const h = harness();
    await expect(
      h.ctl.llmRelay(
        { address: "x", messages: [{ role: "tool", content: "x" }] } as never,
        h.auth,
      ),
    ).rejects.toThrow(/role 必须是/);
    await expect(
      h.ctl.llmRelay(
        { address: "x", messages: [{ role: "user", content: "" }] } as never,
        h.auth,
      ),
    ).rejects.toThrow(/content 必须是非空字符串/);
    await expect(
      h.ctl.llmRelay(
        { address: "x", messages: [{ role: "user", content: 42 }] } as never,
        h.auth,
      ),
    ).rejects.toThrow(/content 必须是非空字符串/);
    await expect(
      h.ctl.llmRelay(
        { address: "x", messages: [{ role: "user", content: "x".repeat(100_001) }] } as never,
        h.auth,
      ),
    ).rejects.toThrow(/超过 100KB 上限/);
  });

  it("tools：非数组忽略、>32 拒绝、合法透传", async () => {
    const h = harness();
    await h.ctl.llmRelay({ address: "x", messages: [msg], tools: "x" } as never, h.auth);
    expect(h.ai.chatMultimodal).toHaveBeenLastCalledWith({ messages: [msg] });
    await expect(
      h.ctl.llmRelay(
        { address: "x", messages: [msg], tools: Array.from({ length: 33 }, () => ({})) } as never,
        h.auth,
      ),
    ).rejects.toThrow(BadRequestException);
    const tools = [{ name: "t" }];
    await h.ctl.llmRelay({ address: "x", messages: [msg], tools } as never, h.auth);
    expect(h.ai.chatMultimodal).toHaveBeenLastCalledWith({ messages: [msg], tools });
  });
});

describe("SopCollabController · uploadMedia / uploadCandidatePackage（归属校验）", () => {
  const file = (patch?: Partial<Express.Multer.File>): Express.Multer.File =>
    ({
      buffer: Buffer.from("png"),
      originalname: "shot.png",
      mimetype: "image/png",
      path: "/tmp/pkg.zip",
      size: 3,
      fieldname: "file",
      encoding: "7bit",
      stream: undefined as never,
      destination: "",
      filename: "",
    }) as Express.Multer.File;

  it("媒体：非归属机器 → 403；缺 file → 400；name/mime 缺省回退", async () => {
    const h = harness();
    h.sops.getAssignment.mockResolvedValueOnce({
      assignment: { targetExecutorId: "exec-OTHER" },
    });
    await expect(
      h.ctl.uploadMedia("asg-1", { address: "x" } as never, file(), h.auth),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      h.ctl.uploadMedia("asg-1", { address: "x" } as never, undefined, h.auth),
    ).rejects.toThrow(BadRequestException);
    await expect(
      h.ctl.uploadMedia("asg-1", { address: "x" } as never, { ...file(), buffer: Buffer.alloc(0) }, h.auth),
    ).rejects.toThrow(BadRequestException);
    await h.ctl.uploadMedia(
      "asg-1",
      { address: "x" } as never,
      { ...file(), originalname: undefined as never, mimetype: undefined as never },
      h.auth,
    );
    expect(h.media.save).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: "media.bin", mime: null, uploadedBy: "executor:exec-1" }),
    );
  });

  it("候选包：runtime 归一 node/python、sopSlug/contentHash 截断、来源标记 agent:sop", async () => {
    const h = harness();
    const out = await h.ctl.uploadCandidatePackage(
      "asg-1",
      { address: "x", sopSlug: "x".repeat(100), contentHash: "h".repeat(100), runtime: "node" } as never,
      file(),
      h.auth,
    );
    expect(out).toEqual({ packageId: "pkg-1", name: "sop-candidate", version: "1.0.0+agent.x" });
    const meta = h.packages.create.mock.calls[0][0] as Record<string, unknown>;
    expect(meta.name).toBe(`sop-${"x".repeat(64)}`);
    expect((meta.description as string).length).toBeLessThanOrEqual(
      "agent candidate assignment=asg-1 contentHash=".length + 64,
    );
    expect(h.packages.create.mock.calls[0][2]).toBe("agent:sop:exec-1");
    await h.ctl.uploadCandidatePackage("asg-1", { address: "x" } as never, file(), h.auth);
    expect((h.packages.create.mock.calls[1][0] as Record<string, unknown>).type).toBe("python");
  });

  it("候选包：非归属 → 403；缺 file.path → 400", async () => {
    const h = harness();
    h.sops.getAssignment.mockResolvedValueOnce({
      assignment: { targetExecutorId: "exec-OTHER" },
    });
    await expect(
      h.ctl.uploadCandidatePackage("asg-1", { address: "x" } as never, file(), h.auth),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      h.ctl.uploadCandidatePackage("asg-1", { address: "x" } as never, undefined, h.auth),
    ).rejects.toThrow(BadRequestException);
  });
});
