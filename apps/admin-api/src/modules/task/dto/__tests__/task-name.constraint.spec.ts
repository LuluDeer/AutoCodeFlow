import {
  describeTaskNameProblem,
  taskNameLength,
} from "../task-name.constraint";

/**
 * FEAT-RENAME / 名称国际化：任务名允许任意语言。
 *
 * 背景（生产反馈）：「创建任务时任务名称只能英文」。根因是**前端**一条
 * `/^[a-zA-Z0-9_-]+$/` 白名单，后端一直只要求非空字符串。把限制放开后必须
 * 自己补上原来由白名单**顺带**提供的保护——本 spec 钉死这些边界。
 */
describe("describeTaskNameProblem — 任务名校验（任意语言）", () => {
  describe("接受（任意语言）", () => {
    it.each([
      ["中文", "每日备份"],
      ["中文+标点", "每日备份（生产环境）"],
      ["日文", "日次バックアップ"],
      ["韩文", "일일 백업"],
      ["emoji", "备份 🚀"],
      ["英文", "daily-report"],
      ["数字+下划线", "job_2026_01"],
      ["内部空格", "daily report"],
      ["混合", "生产 daily-备份 2026"],
      ["单字符", "备"],
      ["255 字符（上限边界）", "备".repeat(255)],
    ])("%s", (_label, value) => {
      expect(describeTaskNameProblem(value)).toBeNull();
    });
  });

  describe("拒绝", () => {
    it("空串", () => {
      expect(describeTaskNameProblem("")).toMatch(/不能为空/);
    });

    it("纯空白（视觉上像空名）", () => {
      expect(describeTaskNameProblem("   ")).toMatch(/空白字符/);
    });

    it("前导空格（与 '备份' 在库里是两行、界面上看起来一样）", () => {
      expect(describeTaskNameProblem(" 备份")).toMatch(/开头或结尾/);
    });

    it("尾随空格", () => {
      expect(describeTaskNameProblem("备份 ")).toMatch(/开头或结尾/);
    });

    it("换行（会伪造一条日志记录）", () => {
      expect(describeTaskNameProblem("备份\n注入")).toMatch(/控制字符/);
    });

    it("制表符", () => {
      expect(describeTaskNameProblem("备份\tA")).toMatch(/控制字符/);
    });

    it("NUL", () => {
      expect(describeTaskNameProblem("备份\u0000")).toMatch(/控制字符/);
    });

    it("DEL (0x7F)", () => {
      expect(describeTaskNameProblem("备份\u007f")).toMatch(/控制字符/);
    });

    it("零宽字符（Cf 类：不可见，会造出视觉上相同的两个名字）", () => {
      expect(describeTaskNameProblem("备份\u200b")).toMatch(/控制字符/);
    });

    it("超长（256 字符）——PG 侧会报 22001 而非 23505，必须在写面拦住", () => {
      expect(describeTaskNameProblem("备".repeat(256))).toMatch(/255/);
    });

    it("非字符串", () => {
      expect(describeTaskNameProblem(123)).toMatch(/字符串/);
    });
  });

  it("上限边界：255 接受 / 256 拒绝（逐字符，非字节）", () => {
    expect(describeTaskNameProblem("备".repeat(255))).toBeNull();
    expect(describeTaskNameProblem("备".repeat(256))).not.toBeNull();
    // 长度按**字符**计：255 个中文是 765 字节，仍合法
    expect(Buffer.byteLength("备".repeat(255), "utf8")).toBeGreaterThan(255);
  });

  // 长度口径必须与 PG 的 varchar(255) 一致 = **码点**，不是 UTF-16 码元。
  // 实测（真库 INSERT）：255 个 emoji 接受、256 个拒绝；128 个 emoji 虽是
  // 256 个码元却只有 128 码点，同样接受。用 `value.length` 做上限会对 emoji
  // 多算一倍，把 DB 完全接受的名字 400 拒掉，且报错数字与用户所见对不上。
  describe("长度按码点计（与 PG varchar(255) 同口径）", () => {
    it("255 个 emoji 接受 / 256 个拒绝", () => {
      expect(describeTaskNameProblem("🚀".repeat(255))).toBeNull();
      expect(describeTaskNameProblem("🚀".repeat(256))).not.toBeNull();
    });

    it("128 个 emoji（=256 个 UTF-16 码元）不被误拒", () => {
      const name = "🚀".repeat(128);
      // 反证：若判据用 value.length，这里会得到 256 > 255 而被拒
      expect(name.length).toBe(256);
      expect(describeTaskNameProblem(name)).toBeNull();
    });

    it("超限文案里的数字是码点数（用户看到的字符数），不是码元数", () => {
      const problem = describeTaskNameProblem("🚀".repeat(256));
      // 256 个 emoji → 文案应说 256，而非 512
      expect(problem).toContain("256");
      expect(problem).not.toContain("512");
    });

    it("taskNameLength 与 PG length() 同口径", () => {
      expect(taskNameLength("abc")).toBe(3);
      expect(taskNameLength("每日备份")).toBe(4);
      expect(taskNameLength("🚀")).toBe(1);
      expect(taskNameLength("a🚀备")).toBe(3);
    });
  });
});
