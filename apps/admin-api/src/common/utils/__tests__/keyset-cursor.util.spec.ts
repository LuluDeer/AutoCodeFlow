import { BadRequestException } from "@nestjs/common";
import {
  decodeExecutionCursor,
  decodeKeysetCursor,
  decodeNumericKeysetCursor,
  encodeExecutionCursor,
  encodeKeysetCursor,
  encodeNumericKeysetCursor,
  nextExecutionCursor,
  nextKeysetCursor,
  nextNumericKeysetCursor,
} from "../keyset-cursor.util";

/**
 * §2.1 游标分页 · **编解码纯函数**单测。
 *
 * 为什么这个 spec 值得写这么细：游标是唯一跨请求携带的**排序状态**，编解码一旦
 * 不自洽，翻页会静默漏行/重行（UI 上的症状是"偶发少了几条执行记录"，几乎无法
 * 被用户准确描述）。故把 round-trip、非法输入、边界、以及"同一 createdAt 靠 id
 * 决胜"全部钉死在这里，服务层只负责把结果拼进 SQL。
 */

const ISO = "2026-01-02T03:04:05.123Z";
const UUID = "6f1c2a9e-1111-4222-8333-444455556666";
/** 默认项目 id：版本位是 0，`@IsUUID()` 会拒、uuid 形状校验必须接受。 */
const DEFAULT_PROJECT_UUID = "00000000-0000-0000-0000-000000000001";

/** 以指定 payload 手工编一个 base64url（模拟"客户端伪造/损坏"的游标）。 */
const b64url = (text: string): string =>
  Buffer.from(text, "utf8").toString("base64url").replace(/=+$/, "");

describe("§2.1 keyset 游标编解码", () => {
  describe("round-trip", () => {
    it("encode → decode 还原出同一对 (createdAt, id)", () => {
      const cursor = encodeExecutionCursor(ISO, UUID);
      expect(decodeExecutionCursor(cursor)).toEqual({
        createdAt: ISO,
        id: UUID,
      });
    });

    it("接受 Date 形态的 createdAt（服务层从实体取到的就是 Date）", () => {
      const asDate = new Date(ISO);
      expect(encodeExecutionCursor(asDate, UUID)).toBe(
        encodeExecutionCursor(ISO, UUID),
      );
      expect(
        decodeExecutionCursor(encodeExecutionCursor(asDate, UUID)),
      ).toEqual({ createdAt: ISO, id: UUID });
    });

    it("编码产物是 URL 安全的（只含 [A-Za-z0-9_-]，无 padding/+/）", () => {
      // 反复取值以覆盖不同填充长度（base64 的 padding 是 0/1/2 个 =）
      const samples = [
        encodeExecutionCursor(ISO, UUID),
        encodeExecutionCursor("2026-01-02T03:04:05.000Z", DEFAULT_PROJECT_UUID),
        encodeExecutionCursor("2026-12-31T23:59:59.999999Z", UUID),
      ];
      for (const s of samples) {
        expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(s).not.toContain("=");
        expect(s).not.toContain("+");
        expect(s).not.toContain("/");
      }
    });

    it("保留微秒（TIMESTAMP 列的真实精度，截断会导致翻页重行）", () => {
      // 这不是吹毛求疵：task_executions.createdAt 是 PG TIMESTAMP（微秒），
      // 写入时取 now()。若编解码把微秒丢掉，元组比较的第一分量会变小，
      // 同一毫秒内的行会被重复返回。游标必须原样往返。
      const micro = "2026-01-02T03:04:05.123456Z";
      expect(
        decodeExecutionCursor(encodeExecutionCursor(micro, UUID)).createdAt,
      ).toBe(micro);
    });

    it("接受带 0 位小数的 ISO（无毫秒形态）", () => {
      const noMs = "2026-01-02T03:04:05Z";
      expect(decodeExecutionCursor(encodeExecutionCursor(noMs, UUID))).toEqual({
        createdAt: noMs,
        id: UUID,
      });
    });
  });

  describe("非法输入一律 400 —— 绝不静默降级成「从头开始」", () => {
    /**
     * 断言抛的是**可识别的业务码 400**。
     *
     * 只断言 `toThrow(BadRequestException)` 是不够的：那会让"任何别的原因导致的
     * 400"也算通过。这里同时钉住 errorCode 与 detail（前端/CLI 靠它们区分"游标
     * 坏了"与其它参数错误），因为错误码是本仓的稳定契约。
     *
     * 码用既有的 `VALIDATION_FAILED` 而非新增专用码：新增码会让
     * `check:error-i18n-drift` 变红，而重新生成前端产物需要改 `apps/admin-web`
     * （本轮明确禁止）。详见 keyset-cursor.util.ts 中 decodeExecutionCursor 的注释。
     *
     * ⚠️ 刻意**不**断言 `instanceof AppError`：`AppError` 的构造函数会把原型换成
     * 对应的 Nest 内置异常类（app-error.ts 的 `Object.setPrototypeOf`，为的是
     * 保住 178 处按类断言的既有 spec），换完之后 `instanceof AppError` **恒为
     * false**。真正的契约是"状态码 400 + 稳定业务码"，见下。
     */
    const expectInvalid = (input: unknown) => {
      let caught: unknown;
      try {
        decodeExecutionCursor(input);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BadRequestException);
      const err = caught as BadRequestException & { errorCode?: string };
      expect(err.getStatus()).toBe(400);
      const body = err.getResponse() as {
        errorCode?: string;
        params?: { detail?: string };
      };
      // 码必须同时出现在实例与响应载荷里（前端 axios 拦截器读的是 body.errorCode）
      expect(err.errorCode).toBe("VALIDATION_FAILED");
      expect(body.errorCode).toBe("VALIDATION_FAILED");
      // detail 里必须点名是**游标**坏了——否则调用方分不清是哪来的 400
      expect(body.params?.detail).toContain("游标");
    };

    it("非字符串 / null / undefined / 数字 / 对象", () => {
      expectInvalid(undefined);
      expectInvalid(null);
      expectInvalid(123);
      expectInvalid({ createdAt: ISO, id: UUID });
      expectInvalid([ISO, UUID]);
    });

    it("空串与纯空白（不能当成「没有游标」）", () => {
      expectInvalid("");
      expectInvalid("   ");
      expectInvalid("\t\n");
    });

    it("非 base64url 字符（含 URL 里会出现的 %、空格、+、/、=）", () => {
      // 注意 `+` / `/` / `=` 是**标准 base64** 的字符集，本实现刻意不接受：
      // 它们在 query string 里会被不同中间件做不一致的解码，收进来等于让
      // 同一串游标在不同代理后表现不同。
      for (const bad of [
        "abc def",
        "abc%2F",
        "****",
        "ab+cd",
        "ab/cd",
        "abcd==",
      ]) {
        expectInvalid(bad);
      }
    });

    it("长度余数为 1（base64 里不可能出现，说明尾部被截断）", () => {
      expectInvalid("A");
      expectInvalid("ABCDE");
    });

    it("base64 能解但内容不是「时间|uuid」两段", () => {
      expectInvalid(b64url("only-one-segment"));
      expectInvalid(b64url(`${ISO}|${UUID}|extra`));
      expectInvalid(b64url(""));
    });

    it("时间字段不是 ISO 8601", () => {
      expectInvalid(b64url(`2026-01-02|${UUID}`));
      expectInvalid(b64url(`not-a-date|${UUID}`));
      expectInvalid(b64url(`01/02/2026|${UUID}`));
      expectInvalid(b64url(`2026-01-02T03:04:05+08:00|${UUID}`));
    });

    it("时间字段是 Date 会「静默归一化」的非法日期（必须拒绝而非接受偏移值）", () => {
      // `new Date("2026-02-30T00:00:00Z")` 不抛错，它归一化成 3 月 2 日。
      // 若只判 NaN，一个数据库里根本不存在的时刻会被接受成游标。
      expectInvalid(b64url(`2026-02-30T00:00:00.000Z|${UUID}`));
      expectInvalid(b64url(`2026-13-01T00:00:00.000Z|${UUID}`));
    });

    it("id 不是 uuid 形状", () => {
      expectInvalid(b64url(`${ISO}|not-a-uuid`));
      expectInvalid(b64url(`${ISO}|`));
      expectInvalid(b64url(`${ISO}|6f1c2a9e111142228333444455556666`));
      // 注入类载荷：uuid 形状校验把它们全部拒掉
      expectInvalid(b64url(`${ISO}|'; DROP TABLE task_executions; --`));
    });

    it("被截断的真实游标（尾部少几个字符）", () => {
      const good = encodeExecutionCursor(ISO, UUID);
      // 逐字符截断，任何一种截断都不得被"宽容"接受
      for (let cut = 1; cut <= 6; cut++) {
        const broken = good.slice(0, good.length - cut);
        if (broken.length % 4 === 1) continue; // 该形态由上面的余数用例覆盖
        expectInvalid(broken);
      }
    });
  });

  describe("边界：同一 createdAt 多条靠 id 决胜", () => {
    it("同一时刻、不同 id 编出的游标互不相同（否则决胜键失效）", () => {
      const a = encodeExecutionCursor(
        ISO,
        "11111111-1111-4111-8111-111111111111",
      );
      const b = encodeExecutionCursor(
        ISO,
        "22222222-2222-4222-8222-222222222222",
      );
      expect(a).not.toBe(b);
      expect(decodeExecutionCursor(a).id).not.toBe(decodeExecutionCursor(b).id);
    });

    it("默认项目 id（版本位 0）可通过 uuid 形状校验", () => {
      expect(
        decodeExecutionCursor(encodeExecutionCursor(ISO, DEFAULT_PROJECT_UUID))
          .id,
      ).toBe(DEFAULT_PROJECT_UUID);
    });

    it("两侧空白被容忍（代理/客户端可能带空格），但内部结构不变", () => {
      const cursor = encodeExecutionCursor(ISO, UUID);
      expect(decodeExecutionCursor(`  ${cursor}  `)).toEqual({
        createdAt: ISO,
        id: UUID,
      });
    });
  });

  describe("nextExecutionCursor：由一页的行算出下一页游标", () => {
    const rows = [
      {
        createdAt: new Date("2026-01-03T00:00:00.000Z"),
        id: "33333333-3333-4333-8333-333333333333",
      },
      {
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
        id: "22222222-2222-4222-8222-222222222222",
      },
      {
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        id: "11111111-1111-4111-8111-111111111111",
      },
    ];

    it("取最后一行（本页最靠后的位置），不是第一行", () => {
      expect(decodeExecutionCursor(nextExecutionCursor(rows)!)).toEqual({
        createdAt: "2026-01-01T00:00:00.000Z",
        id: "11111111-1111-4111-8111-111111111111",
      });
    });

    it("空页 → null（没有最后一行，硬造游标是错的）", () => {
      expect(nextExecutionCursor([])).toBeNull();
    });

    it("行缺 createdAt / id → null 而不是抛「客户端 400」（这是服务端数据问题）", () => {
      expect(nextExecutionCursor([{ createdAt: null, id: UUID }])).toBeNull();
      expect(nextExecutionCursor([{ createdAt: ISO, id: null }])).toBeNull();
      expect(nextExecutionCursor([{}])).toBeNull();
    });

    it("支持 raw 查询返回的字符串形态 createdAt", () => {
      expect(
        decodeExecutionCursor(
          nextExecutionCursor([{ createdAt: ISO, id: UUID }])!,
        ),
      ).toEqual({ createdAt: ISO, id: UUID });
    });
  });

  /**
   * 整型主键表（当前唯一使用方：`GET /audit`，`audit_logs.id` 是 `integer`）。
   *
   * 真库实测（information_schema）：
   *   audit_logs.id                 integer   nextval('audit_logs_id_seq')
   *   audit_logs."createdAt"        timestamp without time zone, precision 6
   *
   * 时间列与 task_executions **逐字段相同** ⇒ 时间段判据必须共用同一份实现；
   * id 段判据不同（十进制正整数 vs uuid 形状）⇒ 必须分开，不能放宽成一个。
   */
  describe("整型主键游标（audit_logs.id 是 integer）", () => {
    it("encode → decode 还原出同一对 (createdAt, id)", () => {
      const cursor = encodeNumericKeysetCursor(ISO, 42);
      expect(decodeNumericKeysetCursor(cursor)).toEqual({
        createdAt: ISO,
        id: "42",
      });
    });

    it("编码字节布局与 uuid 版**完全相同**（游标格式与表无关）", () => {
      // 同一对值经两个编码器必须产出同一个串——否则"一个 base64 串在哪个
      // 端点都合法"这条直觉会被打破。
      expect(encodeNumericKeysetCursor(ISO, "42")).toBe(
        encodeKeysetCursor(ISO, "42"),
      );
      expect(encodeNumericKeysetCursor(new Date(ISO), 42)).toBe(
        encodeKeysetCursor(ISO, "42"),
      );
    });

    it("接受 sequence 的值域两端（1 与超过 2^53 的值都不丢精度）", () => {
      // 载荷是**字符串**，不做 JS 数值转换 ⇒ bigint 范围的值也能原样往返。
      expect(
        decodeNumericKeysetCursor(encodeNumericKeysetCursor(ISO, 1)).id,
      ).toBe("1");
      const big = "9007199254740993"; // 2^53 + 1，JS Number 会截成 …992
      expect(String(Number(big))).not.toBe(big); // 先证明前提成立
      expect(
        decodeNumericKeysetCursor(encodeNumericKeysetCursor(ISO, big)).id,
      ).toBe(big);
    });

    it("保留微秒（与 uuid 版同一理由，同一份时间段实现）", () => {
      const micro = "2026-01-02T03:04:05.123456Z";
      expect(
        decodeNumericKeysetCursor(encodeNumericKeysetCursor(micro, 7))
          .createdAt,
      ).toBe(micro);
    });

    /** 与 uuid 版同一条断言口径：400 + VALIDATION_FAILED + detail 点名游标。 */
    const expectInvalidNumeric = (input: unknown) => {
      let caught: unknown;
      try {
        decodeNumericKeysetCursor(input);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BadRequestException);
      const err = caught as BadRequestException & { errorCode?: string };
      expect(err.getStatus()).toBe(400);
      const body = err.getResponse() as {
        errorCode?: string;
        params?: { detail?: string };
      };
      expect(err.errorCode).toBe("VALIDATION_FAILED");
      expect(body.errorCode).toBe("VALIDATION_FAILED");
      expect(body.params?.detail).toContain("游标");
    };

    /**
     * id 段判据刻意**比 Number.isInteger(Number(s)) 严得多**：放宽一丝就会放进
     * "同一行有多个游标串"（`01` vs `1`）或"PG 能解析但语义歧义"（`1e3`、`+1`、
     * ` 1`）的输入。
     */
    it.each([
      ["uuid 形状（错表主键）", `${ISO}|${UUID}`],
      ["前导零", `${ISO}|01`],
      ["零", `${ISO}|0`],
      ["负数", `${ISO}|-1`],
      ["正号", `${ISO}|+1`],
      ["科学计数", `${ISO}|1e3`],
      ["小数", `${ISO}|1.0`],
      ["前导空白", `${ISO}| 1`],
      ["尾随空白", `${ISO}|1 `],
      ["十六进制", `${ISO}|0x10`],
      ["注入串", `${ISO}|1; DROP TABLE audit_logs; --`],
      ["空 id 段", `${ISO}|`],
    ])("id 段非法（%s）→ 400", (_label: string, payload: string) => {
      expectInvalidNumeric(b64url(payload));
    });

    it("时间段判据与 uuid 版共用一份实现（非法时间同样被拒）", () => {
      // 「Date 会静默归一化」的日期、非 ISO 形态、NaN —— 两个解码器必须给出
      // 完全相同的接受/拒绝结论，否则两条端点对同一串时间自相矛盾。
      for (const iso of [
        "2026-02-30T00:00:00.000Z",
        "2026-13-01T00:00:00.000Z",
        "2026-01-02|03:04:05",
        "not-a-date",
        "2026-01-02T03:04:05+08:00",
      ]) {
        expectInvalidNumeric(b64url(`${iso}|42`));
        // 对照：uuid 版对同一个时间分量同样拒绝
        let uuidCaught: unknown;
        try {
          decodeKeysetCursor(b64url(`${iso}|${UUID}`));
        } catch (err) {
          uuidCaught = err;
        }
        expect(uuidCaught).toBeInstanceOf(BadRequestException);
      }
    });

    it("nextNumericKeysetCursor：取最后一行，接受 number 与 string 两种 id", () => {
      const rows = [
        { createdAt: new Date("2026-01-03T00:00:00.000Z"), id: 9 },
        { createdAt: new Date("2026-01-02T00:00:00.000Z"), id: 5 },
        { createdAt: new Date("2026-01-01T00:00:00.000Z"), id: 2 },
      ];
      expect(decodeNumericKeysetCursor(nextNumericKeysetCursor(rows)!)).toEqual(
        {
          createdAt: "2026-01-01T00:00:00.000Z",
          id: "2",
        },
      );
      // raw 查询把 id 读成字符串的形态也支持
      expect(
        decodeNumericKeysetCursor(
          nextNumericKeysetCursor([{ createdAt: ISO, id: "77" }])!,
        ).id,
      ).toBe("77");
    });

    it("nextNumericKeysetCursor：空页 / 缺列 → null（不抛客户端 400）", () => {
      expect(nextNumericKeysetCursor([])).toBeNull();
      expect(nextNumericKeysetCursor([{ createdAt: null, id: 1 }])).toBeNull();
      expect(
        nextNumericKeysetCursor([{ createdAt: ISO, id: null }]),
      ).toBeNull();
      expect(nextNumericKeysetCursor([{}])).toBeNull();
    });

    it("uuid 版**不会**接受整型 id（两张表判据不能混用）", () => {
      // 反过来同样成立：uuid 表若误用了整型解码器会拒绝 uuid，audit 表若误用
      // uuid 解码器会拒绝整型 id。这条钉住"混用即失败"而不是"混用即静默"。
      let caught: unknown;
      try {
        decodeKeysetCursor(encodeNumericKeysetCursor(ISO, 42));
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BadRequestException);
    });

    it("nextKeysetCursor 与 nextNumericKeysetCursor 对同一行编出同一串", () => {
      const row = { createdAt: ISO, id: "42" };
      expect(nextNumericKeysetCursor([row])).toBe(
        nextKeysetCursor([{ createdAt: ISO, id: "42" }]),
      );
    });
  });
});
