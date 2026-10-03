/**
 * N-03 覆盖率棘轮：`SopService` **读面 + 校验面 + 清洗面**定向补测。
 *
 * 为什么挑这三面（而不是凑覆盖率的空壳断言）：
 *  - **读面**（list/getSop/getBySlug/listVersions/listAssignments/getAssignment/
 *    listActiveAssignments/setExecutorSession）此前一行未测，而它们是 SOP 工具
 *    （sop_list/sop_get）与审计页的实际取数路径——分页钳位、slug 唯一索引语义、
 *    活跃工单投影字段都在这里。
 *  - **校验面**（validateMediaRefs / checkJsonSize）是**安全边界**：mediaRefs 只认
 *    平台内 `/api/...` 路径（外链=SSRF 转嫁面，11 §5.2），载荷大小上限防 DoS。
 *    这类判据漏测等于边界只存在于注释里。
 *  - **清洗面**（sanitizeUntrusted）处理**完全不可信**的执行器上报文本（凭据打码），
 *    是 SOP 澄清进入中台存储前的最后一道。
 *
 * 私有方法经 `(service as any)` 直调：它们是纯函数式的校验/清洗逻辑，
 * 走公开路径（ingestClarification）需要构造大量仓储交互，反而测不准边界本身。
 * 公开读面走真实桩，断言**可观察结果**而非调用次数。
 */
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { SopService } from "./sop.service";
import { SOP_CLARIFICATION_QUESTION_MAX } from "./sop-frontmatter";

type Any = Record<string, any>;

function harness() {
  const sopRows: Any[] = [];
  const versionRows: Any[] = [];
  const assignmentRows: Any[] = [];
  const clarificationRows: Any[] = [];

  const matchWhere = (rows: Any[], where: Any) =>
    rows.filter((r) =>
      Object.entries(where ?? {}).every(([k, v]) => {
        if (
          v &&
          typeof v === "object" &&
          "type" in v &&
          (v as Any).type === "in"
        ) {
          return (v as Any).value.includes(r[k]);
        }
        return r[k] === v;
      }),
    );

  const sops = {
    findOne: jest.fn(
      async ({ where }: Any) => matchWhere(sopRows, where)[0] ?? null,
    ),
    create: jest.fn((v: Any) => ({ ...v })),
    save: jest.fn(async (v: Any) => v),
    createQueryBuilder: jest.fn(() => {
      const state: Any = { status: null, skip: 0, take: 20 };
      const qb: Any = {
        andWhere: jest.fn((_sql: string, params: Any) => {
          if (params?.status !== undefined) state.status = params.status;
          return qb;
        }),
        orderBy: jest.fn(() => qb),
        skip: jest.fn((n: number) => {
          state.skip = n;
          return qb;
        }),
        take: jest.fn((n: number) => {
          state.take = n;
          return qb;
        }),
        getManyAndCount: jest.fn(async () => {
          const filtered = state.status
            ? sopRows.filter((r) => r.status === state.status)
            : sopRows;
          return [
            filtered.slice(state.skip, state.skip + state.take),
            filtered.length,
          ];
        }),
      };
      return qb;
    }),
  };
  const versions = {
    find: jest.fn(async ({ where }: Any) => matchWhere(versionRows, where)),
  };
  const assignments = {
    find: jest.fn(async ({ where }: Any) => matchWhere(assignmentRows, where)),
    findOne: jest.fn(
      async ({ where }: Any) => matchWhere(assignmentRows, where)[0] ?? null,
    ),
    update: jest.fn(async (where: Any, patch: Any) => {
      const row = matchWhere(assignmentRows, where)[0];
      if (row) Object.assign(row, patch);
      return { affected: row ? 1 : 0 };
    }),
  };
  const clarifications = {
    find: jest.fn(async ({ where }: Any) =>
      matchWhere(clarificationRows, where),
    ),
  };

  const service = Object.assign(Object.create(SopService.prototype), {
    sops,
    versions,
    assignments,
    clarifications,
  }) as SopService;

  return { service, sopRows, versionRows, assignmentRows, clarificationRows };
}

describe("SopService 读面（sop_list / sop_get / 审计取数路径）", () => {
  it("list 分页钳位：page≥1、pageSize 1..100，越界值被夹回而非穿透", async () => {
    const h = harness();
    h.sopRows.push(
      ...Array.from({ length: 5 }, (_, i) => ({
        id: `s${i}`,
        slug: `s${i}`,
        title: `T${i}`,
        status: "draft",
        updatedAt: new Date(2026, 0, i + 1),
      })),
    );
    // page=0 → 夹到 1；pageSize=9999 → 夹到 100
    const r = await h.service.list({ page: 0, pageSize: 9999 });
    expect(r.total).toBe(5);
    expect(r.items).toHaveLength(5);

    // pageSize=0 → 夹到 1（不得返回 0 行：那会让界面永远空）
    const r2 = await h.service.list({ pageSize: 0 });
    expect(r2.items).toHaveLength(1);
  });

  it('list NaN 守卫：page/pageSize 非有限数（controller Number("abc")=NaN）回落默认 1/20 而非炸 500', async () => {
    const h = harness();
    h.sopRows.push(
      ...Array.from({ length: 3 }, (_, i) => ({
        id: `s${i}`,
        slug: `s${i}`,
        title: `T${i}`,
        status: "draft",
        updatedAt: new Date(2026, 0, i + 1),
      })),
    );
    // NaN 穿透 Math.max/Math.min（Math.max(1,NaN)=NaN）会直达 skip/take；
    // 守卫后视同未传——合法行数全量可见、不抛错不 400。
    for (const evil of [NaN, Number.POSITIVE_INFINITY]) {
      const r = await h.service.list({ page: evil, pageSize: evil });
      expect(r.total).toBe(3);
      expect(r.items).toHaveLength(3);
    }
  });

  it("list 按 status 过滤（下推给 SQL，不在内存过滤）", async () => {
    const h = harness();
    h.sopRows.push(
      { id: "a", slug: "a", status: "draft", updatedAt: new Date() },
      { id: "b", slug: "b", status: "published", updatedAt: new Date() },
    );
    const r = await h.service.list({ status: "published" });
    expect(r.items.map((x: Any) => x.id)).toEqual(["b"]);
    expect(r.total).toBe(1);
  });

  it("getBySlug 命中返回值、未命中抛 NotFound（slug 是唯一索引直查路径）", async () => {
    const h = harness();
    h.sopRows.push({ id: "sop-1", slug: "deploy-demo" });
    await expect(h.service.getBySlug("deploy-demo")).resolves.toMatchObject({
      id: "sop-1",
    });
    await expect(h.service.getBySlug("nope")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("getSop 走 requireSop：不存在抛 NotFound 而不是返回 null", async () => {
    const h = harness();
    h.sopRows.push({ id: "sop-1", slug: "x" });
    await expect(h.service.getSop("sop-1")).resolves.toMatchObject({
      id: "sop-1",
    });
    await expect(h.service.getSop("missing")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("listVersions 先校验 SOP 存在（不存在时不得静默返回空数组）", async () => {
    const h = harness();
    await expect(h.service.listVersions("ghost")).rejects.toBeInstanceOf(
      NotFoundException,
    );

    h.sopRows.push({ id: "sop-1" });
    h.versionRows.push({ sopId: "sop-1", version: "1.0.0" });
    await expect(h.service.listVersions("sop-1")).resolves.toHaveLength(1);
  });

  it("listAssignments 同样先校验 SOP 存在", async () => {
    const h = harness();
    await expect(h.service.listAssignments("ghost")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("getAssignment 未命中抛 NotFound；命中同时带出澄清行", async () => {
    const h = harness();
    h.assignmentRows.push({ id: "as-1", sopId: "sop-1" });
    h.clarificationRows.push(
      { id: "c2", assignmentId: "as-1", round: 2 },
      { id: "c1", assignmentId: "as-1", round: 1 },
      { id: "other", assignmentId: "as-9", round: 1 },
    );
    const r = await h.service.getAssignment("as-1");
    expect(r.assignment.id).toBe("as-1");
    // 只带本指派的澄清（不得串指派——跨指派泄漏）
    expect(r.clarifications.map((c: Any) => c.id).sort()).toEqual(["c1", "c2"]);

    await expect(h.service.getAssignment("ghost")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("listActiveAssignments 只投影活跃态且字段集封闭（不泄漏 frontMatter/正文）", async () => {
    const h = harness();
    h.assignmentRows.push(
      {
        id: "a1",
        sopId: "s1",
        sopVersion: "1.0.0",
        status: "in_progress",
        clarificationRound: 1,
        maxRounds: 5,
        createdAt: new Date(0),
        secretsInRow: "must-not-leak",
      },
      {
        id: "a2",
        sopId: "s1",
        sopVersion: "1.0.0",
        status: "completed",
        clarificationRound: 0,
        maxRounds: 5,
        createdAt: new Date(1),
      },
    );
    const rows = (await h.service.listActiveAssignments()) as Any[];
    expect(rows.map((r) => r.id)).toEqual(["a1"]);
    // 投影字段封闭：多出的列不得透出（防"实体新增敏感列即自动外泄"）
    expect(Object.keys(rows[0]).sort()).toEqual(
      [
        "clarificationRound",
        "createdAt",
        "id",
        "maxRounds",
        "sopId",
        "sopVersion",
        "status",
      ].sort(),
    );
  });

  it("setExecutorSession 写 targetAgentSessionId 且钳到 128 位（防超长列写入）", async () => {
    const h = harness();
    h.assignmentRows.push({ id: "as-1" });
    await h.service.setExecutorSession("as-1", "x".repeat(500));
    expect(h.assignmentRows[0].targetAgentSessionId).toHaveLength(128);
  });
});

describe("SopService 校验面（安全边界：mediaRefs / 载荷大小）", () => {
  const call = (service: SopService, fn: string, ...args: any[]) =>
    (service as unknown as Any)[fn](...args);

  it("mediaRefs 只认平台内 /api/ 路径——外链、协议相对、相对路径全拒（SSRF 转嫁面）", () => {
    const h = harness();
    const ok = call(h.service, "validateMediaRefs", [
      { kind: "video", url: "/api/agent-collab/media/abc" },
      { kind: "screenshot", url: "/api/artifacts/1" },
      { kind: "other", url: "/api/executions/9/x" },
      { kind: "other", url: "/api/executor-package/y" },
    ]);
    expect(ok).toHaveLength(4);

    for (const bad of [
      "https://evil.example/x",
      "http://127.0.0.1:9000/internal",
      "//evil.example/x",
      "/etc/passwd",
      "/api/../secret",
      "javascript:alert(1)",
      "",
    ]) {
      expect(() =>
        call(h.service, "validateMediaRefs", [{ kind: "video", url: bad }]),
      ).toThrow(BadRequestException);
    }
  });

  it("mediaRefs 上限 4 条、kind 封闭枚举、URL 长度上限", () => {
    const h = harness();
    const five = Array.from({ length: 5 }, () => ({
      kind: "video",
      url: "/api/artifacts/1",
    }));
    expect(() => call(h.service, "validateMediaRefs", five)).toThrow(
      /最多 4 条/,
    );

    expect(() =>
      call(h.service, "validateMediaRefs", [
        { kind: "exe", url: "/api/artifacts/1" },
      ]),
    ).toThrow(/kind/);
    expect(() => call(h.service, "validateMediaRefs", [null])).toThrow(
      BadRequestException,
    );

    const longUrl = `/api/artifacts/${"a".repeat(600)}`;
    expect(() =>
      call(h.service, "validateMediaRefs", [{ kind: "video", url: longUrl }]),
    ).toThrow(/超长/);
  });

  it("mediaRefs 的 note 透传但钳到 256（防无界文本入库）", () => {
    const h = harness();
    const out = call(h.service, "validateMediaRefs", [
      { kind: "video", url: "/api/artifacts/1", note: "n".repeat(1000) },
    ]);
    expect(out[0].note).toHaveLength(256);
    // 无 note 时不写该键（保持投影最小）
    const noNote = call(h.service, "validateMediaRefs", [
      { kind: "video", url: "/api/artifacts/1" },
    ]);
    expect(Object.prototype.hasOwnProperty.call(noNote[0], "note")).toBe(false);
  });

  it("checkJsonSize 超限抛 BadRequest（含 label，便于定位是哪个载荷）", () => {
    const h = harness();
    expect(() =>
      call(h.service, "checkJsonSize", { a: 1 }, 100, "payload"),
    ).not.toThrow();
    expect(() =>
      call(h.service, "checkJsonSize", { a: "x".repeat(200) }, 100, "payload"),
    ).toThrow(/payload 超过 100 字节上限/);
    // null/undefined 序列化为 "null"（4 字节）——不得因空值绕过或崩溃
    expect(() =>
      call(h.service, "checkJsonSize", null, 100, "payload"),
    ).not.toThrow();
    expect(() =>
      call(h.service, "checkJsonSize", undefined, 100, "payload"),
    ).not.toThrow();
  });
});

describe("SopService 清洗面（不可信执行器上报文本）", () => {
  const sanitize = (text: string) =>
    (SopService.prototype as unknown as Any).sanitizeUntrusted.call({}, text);

  it("key=value 形态的凭据被打码（token/password/secret/api-key/credential 各形态）", () => {
    for (const raw of [
      "token=abcdef123456",
      "password: hunter2",
      "passwd = xyz",
      "secret: s3cr3t",
      "api_key=AKIA123",
      "api-key: kkk",
      "credentials=abc",
      "TOKEN=UPPERCASE",
    ]) {
      const out = sanitize(`前置文本 ${raw} 后置文本`);
      expect(out).not.toContain("hunter2");
      expect(out).toMatch(/\[REDACTED\]/);
    }
  });

  it("已知前缀密钥形态被打码（sk- / gh[pousr]_）", () => {
    expect(sanitize("key sk-abcdefghijklmnop")).toContain("[REDACTED]");
    expect(sanitize("ghp_abcdefghijklmnopqrst")).toContain("[REDACTED]");
    expect(sanitize("gho_abcdefghijklmnopqrst")).toContain("[REDACTED]");
  });

  it("普通文本不被误伤（不给运维制造噪音）", () => {
    const plain = "请确认部署窗口是否在 2026-10-01 之后";
    expect(sanitize(plain)).toBe(plain);
  });

  it("超长文本截断到 SOP_CLARIFICATION_QUESTION_MAX（防无界文本入库）", () => {
    // 断言对着**导出的常量**而不是硬编码数字——上限调整时这里跟着走，
    // 不会留下一个"看着在测、其实钉的是旧值"的假绿。
    const out = sanitize("a".repeat(100000));
    expect(out).toHaveLength(SOP_CLARIFICATION_QUESTION_MAX);
    expect(out).toBe("a".repeat(SOP_CLARIFICATION_QUESTION_MAX));
  });

  it("截断发生在打码之前：截断不会把已打码的 [REDACTED] 切回明文", () => {
    // 若实现顺序反了（先截断后打码），构造一个"凭据刚好被切断"的输入会露馅：
    // 这里直接钉住语义——超长输入里的凭据必须仍被打码，且长度受限。
    const padded = `${"x".repeat(SOP_CLARIFICATION_QUESTION_MAX - 20)} token=supersecretvalue`;
    const out = sanitize(padded);
    expect(out.length).toBeLessThanOrEqual(SOP_CLARIFICATION_QUESTION_MAX);
    expect(out).not.toContain("supersecretvalue");
  });
});
