/**
 * N-03 覆盖率棘轮：`SopController`（ADMIN 管理面）定向补测。
 *
 * 此前该文件 **0% 覆盖**（15 个函数全未执行）。挑它不是因为它薄，而是因为
 * 管理面的**发布权 = 间接的指令注入权**（04 §4.3）——SOP 会成为执行器 Agent 的
 * 执行依据，所以这里的每条分支都值得钉住：
 *
 *  ① **跨工单答复防线**：`humanReply` 必须先确认澄清属于该指派，否则
 *     一个 ADMIN 拿着 A 工单的 id 就能答复 B 工单的澄清（跨工单串答复）。
 *  ② **指派目标解析**：`executorId` 与 `executorAddress` 二选一——地址查不到
 *     必须**如实拒绝**（Forbidden），不能退化成"没有目标也照派"；
 *     两者都缺也必须拒绝（此前这类"默认随便挑一台"是派发面最常见的错误来源）。
 *  ③ **编辑走工作副本语义**：`PATCH` 不得直接改 SOP 实体，而要经 `draft()`
 *     把标题/正文重写进工作副本——真身在不可变版本快照里；
 *     且 `title` 缺省时必须沿用原值（不能写成 undefined 清空标题）。
 *  ④ **媒体下载的响应头**：Content-Length 必须来自真实对象大小、文件名必须
 *     经 encodeURIComponent（未编码的中文/引号文件名会破坏 Content-Disposition
 *     头，甚至注入额外头）。
 *  ⑤ 查询参数是**字符串**（HTTP 层），必须转成数字后才交给 service——直接把
 *     字符串喂进分页会让 `(page-1)*pageSize` 变成字符串拼接。
 */
import { ForbiddenException, ValidationPipe, BadRequestException } from "@nestjs/common";

import { SopController, DraftSopDto } from "../sop.controller";

type Any = Record<string, any>;

function harness() {
  const calls: Any = {};
  const sops = {
    list: jest.fn(async (o: Any) => {
      calls.list = o;
      return { items: [], total: 0 };
    }),
    getAssignment: jest.fn(async (id: string) => {
      calls.getAssignment = id;
      return {
        assignment: { id, targetExecutorId: "exec-1" },
        clarifications: [{ id: "c-1" }, { id: "c-2" }],
      };
    }),
    replyClarification: jest.fn(async (o: Any) => {
      calls.reply = o;
      return { ok: true };
    }),
    getSop: jest.fn(async (id: string) => ({
      id,
      slug: "daily-report",
      title: "日报",
      createdBy: "user:owner-9",
    })),
    draft: jest.fn(async (o: Any) => {
      calls.draft = o;
      return o;
    }),
    publish: jest.fn(async (o: Any) => {
      calls.publish = o;
      return o;
    }),
    assign: jest.fn(async (o: Any) => {
      calls.assign = o;
      return o;
    }),
    listVersions: jest.fn(async (id: string) => [
      { sopId: id, version: "1.0.0" },
    ]),
    listAssignments: jest.fn(async (id: string) => [{ id: "a-1", sopId: id }]),
  };
  const media = {
    requireById: jest.fn(async (id: string) => ({
      id,
      storagePath: `/tmp/${id}`,
    })),
    openStream: jest.fn(() => ({
      stream: { pipe: jest.fn((res: Any) => res.end()) },
      size: 12345,
      mime: "video/mp4",
      name: '澄清 录屏 "final".mp4',
    })),
    listByAssignment: jest.fn(async (id: string) => [
      { id: "m-1", assignmentId: id },
    ]),
  };
  const executors = {
    listSopCapableExecutors: jest.fn(async () => [{ id: "exec-1" }]),
    findByAddress: jest.fn(async (address: string) =>
      address === "office-pc-07:8002" ? { id: "exec-by-addr" } : null,
    ),
  };

  const controller = new SopController(
    sops as never,
    media as never,
    executors as never,
  );
  return { controller, sops, media, executors, calls };
}

/** 造一个够用的 express Response 假体（只记头与 end）。 */
function fakeRes() {
  const headers: Record<string, string> = {};
  return {
    headers,
    ended: false,
    setHeader: jest.fn((k: string, v: string) => {
      headers[k] = v;
    }),
    end: jest.fn(function (this: Any) {
      this.ended = true;
    }),
  };
}

describe("SopController —— 列表与查询参数转换", () => {
  it("page/pageSize 从 query 字符串转数字（不转会让分页算成字符串拼接）", async () => {
    const h = harness();
    await h.controller.list("published", "3", "50");
    expect(h.calls.list).toEqual({
      status: "published",
      page: 3,
      pageSize: 50,
    });
    expect(typeof h.calls.list.page).toBe("number");
  });

  it("缺省 query 传 undefined（而非 NaN/空串）——分页钳位由 service 兜底", async () => {
    const h = harness();
    await h.controller.list();
    expect(h.calls.list).toEqual({
      status: undefined,
      page: undefined,
      pageSize: undefined,
    });
  });
});

describe("SopController —— 人工答复的跨工单防线", () => {
  const user = { id: "admin-1" };

  it("澄清属于该指派 → 放行，且 replyBy 记 user:<id>（可审计到人）", async () => {
    const h = harness();
    await h.controller.humanReply(
      "a-1",
      "c-1",
      { resolution: "answered", answer: "ok" } as never,
      user,
    );
    expect(h.calls.reply).toMatchObject({
      clarificationId: "c-1",
      resolution: "answered",
      answer: "ok",
      replyBy: "user:admin-1",
    });
  });

  it("澄清**不属于**该指派 → Forbidden（不得跨工单串答复）", async () => {
    const h = harness();
    await expect(
      h.controller.humanReply(
        "a-1",
        "c-from-other-assignment",
        { resolution: "answered", answer: "x" } as never,
        user,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    // 关键：拒绝必须发生在写之前——未命中就绝不能调 replyClarification
    expect(h.sops.replyClarification).not.toHaveBeenCalled();
  });

  it("修订载荷（sop_amended）原样透传给 service（校验在服务层，控制器不预判）", async () => {
    const h = harness();
    await h.controller.humanReply(
      "a-1",
      "c-2",
      {
        resolution: "sop_amended",
        answer: "已修订",
        amendedFrontMatterYaml: "capabilities: [filesystem]",
        amendedBodyMarkdown: "新正文",
        changelog: "补一步",
      } as never,
      user,
    );
    expect(h.calls.reply).toMatchObject({
      resolution: "sop_amended",
      amendedFrontMatterYaml: "capabilities: [filesystem]",
      amendedBodyMarkdown: "新正文",
      changelog: "补一步",
    });
  });
});

describe("SopController —— 指派目标解析", () => {
  const user = { id: "admin-1" };

  it("给 executorId → 直接使用（不走地址查询）", async () => {
    const h = harness();
    await h.controller.assign("sop-1", { executorId: "exec-x" } as never, user);
    expect(h.calls.assign).toMatchObject({
      sopId: "sop-1",
      executorId: "exec-x",
    });
    expect(h.executors.findByAddress).not.toHaveBeenCalled();
  });

  it("只给 executorAddress → 解析成 id", async () => {
    const h = harness();
    await h.controller.assign(
      "sop-1",
      { executorAddress: "office-pc-07:8002" } as never,
      user,
    );
    expect(h.calls.assign).toMatchObject({ executorId: "exec-by-addr" });
  });

  it("地址查不到 → Forbidden，且**不落指派**（不得退化成随便派一台）", async () => {
    const h = harness();
    await expect(
      h.controller.assign(
        "sop-1",
        { executorAddress: "ghost:9999" } as never,
        user,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.sops.assign).not.toHaveBeenCalled();
  });

  it("两者都缺 → Forbidden，且不落指派", async () => {
    const h = harness();
    await expect(
      h.controller.assign("sop-1", {} as never, user),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.sops.assign).not.toHaveBeenCalled();
  });

  it("executorId 优先于 executorAddress（同时给时按 id 走）", async () => {
    const h = harness();
    await h.controller.assign(
      "sop-1",
      {
        executorId: "exec-primary",
        executorAddress: "office-pc-07:8002",
      } as never,
      user,
    );
    expect(h.calls.assign.executorId).toBe("exec-primary");
    expect(h.executors.findByAddress).not.toHaveBeenCalled();
  });
});

describe("SopController —— 编辑走工作副本语义", () => {
  it("PATCH 经 draft() 重写工作副本，title 缺省时沿用原值（不清空）", async () => {
    const h = harness();
    await h.controller.update("sop-1", { bodyMarkdown: "新正文" } as never);
    expect(h.calls.draft).toMatchObject({
      slug: "daily-report",
      title: "日报", // 沿用，不是 undefined
      bodyMarkdown: "新正文",
      createdBy: "user:user:owner-9", // 既有实现形态：createdBy 前缀 + 原 createdBy
    });
  });

  it("PATCH 显式给 title → 采用新值", async () => {
    const h = harness();
    await h.controller.update("sop-1", { title: "新标题" } as never);
    expect(h.calls.draft.title).toBe("新标题");
  });

  it("PATCH 不直接改实体（先 getSop 取工作副本再 draft）", async () => {
    const h = harness();
    await h.controller.update("sop-1", { title: "t" } as never);
    expect(h.sops.getSop).toHaveBeenCalledWith("sop-1");
    expect(h.sops.draft).toHaveBeenCalled();
  });
});

describe("SopController —— 起草/发布/只读面透传", () => {
  it("draft 落 createdBy=user:<id>，applicationId 缺省补 null", async () => {
    const h = harness();
    await h.controller.draft({ slug: "s", title: "t" } as never, {
      id: "admin-7",
    });
    expect(h.calls.draft).toMatchObject({
      slug: "s",
      title: "t",
      applicationId: null,
      createdBy: "user:admin-7",
    });
  });

  it("publish 落 publishedBy=user:<id>（发布权=指令注入权，必须可追溯）", async () => {
    const h = harness();
    await h.controller.publish(
      "sop-1",
      { bump: "minor", changelog: "c" } as never,
      { id: "admin-7" },
    );
    expect(h.calls.publish).toEqual({
      sopId: "sop-1",
      bump: "minor",
      changelog: "c",
      publishedBy: "user:admin-7",
    });
  });

  it("只读端点直通 service（detail/versions/assignments/assignment/mediaList/assignable）", async () => {
    const h = harness();
    await expect(h.controller.detail("sop-1")).resolves.toMatchObject({
      id: "sop-1",
    });
    await expect(h.controller.versions("sop-1")).resolves.toHaveLength(1);
    await expect(h.controller.assignments("sop-1")).resolves.toHaveLength(1);
    await expect(h.controller.assignment("a-1")).resolves.toMatchObject({
      assignment: { id: "a-1" },
    });
    await expect(h.controller.mediaList("a-1")).resolves.toHaveLength(1);
    await expect(h.controller.assignableExecutors()).resolves.toHaveLength(1);
  });
});

describe("SopController —— 媒体下载响应头", () => {
  it("Content-Type/Length 来自真实对象，文件名经 encodeURIComponent（防头注入）", async () => {
    const h = harness();
    const res = fakeRes();
    await h.controller.downloadMedia("m-1", res as never);

    expect(res.headers["Content-Type"]).toBe("video/mp4");
    expect(res.headers["Content-Length"]).toBe("12345");
    // 未编码的引号会截断 filename 参数并可能注入额外头
    expect(res.headers["Content-Disposition"]).toBe(
      `attachment; filename="${encodeURIComponent('澄清 录屏 "final".mp4')}"`,
    );
    expect(res.headers["Content-Disposition"]).not.toContain('"final"');
    expect(h.media.openStream).toHaveBeenCalled();
  });

  it("mime 缺失时回落 application/octet-stream（不得发出空 Content-Type）", async () => {
    const h = harness();
    h.media.openStream.mockReturnValueOnce({
      stream: { pipe: jest.fn((r: Any) => r.end()) },
      size: 1,
      mime: null,
      name: "x.bin",
    });
    const res = fakeRes();
    await h.controller.downloadMedia("m-2", res as never);
    expect(res.headers["Content-Type"]).toBe("application/octet-stream");
  });
});

describe("DraftSopDto —— title 空串/纯空白防线（对齐前端 c5c46a58）", () => {
  // 与 main.ts 全局管道同参：whitelist + transform + forbidNonWhitelisted
  const pipe = new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
  });

  function validate(value: object): Promise<DraftSopDto> {
    return pipe.transform(value, {
      type: "body",
      metatype: DraftSopDto,
    }) as Promise<DraftSopDto>;
  }

  const validDraft = { slug: "daily-report", title: "日报" };

  it("合法 title → 放行", async () => {
    const dto = await validate(validDraft);
    expect(dto.title).toBe("日报");
  });

  it("空串 title → 400（API 直调不得绕过前端拦截）", async () => {
    await expect(validate({ ...validDraft, title: "" })).rejects.toThrow(
      BadRequestException,
    );
  });

  it("纯空白 title → 400（IsNotEmpty 只挡空串，\S 补住纯空白）", async () => {
    for (const t of ["   ", "\t\n"]) {
      await expect(validate({ ...validDraft, title: t })).rejects.toThrow(
        BadRequestException,
      );
    }
  });

  it("title 缺失 → 400（IsString 失败，不得静默成 undefined）", async () => {
    await expect(validate({ slug: "daily-report" })).rejects.toThrow(
      BadRequestException,
    );
  });
});
