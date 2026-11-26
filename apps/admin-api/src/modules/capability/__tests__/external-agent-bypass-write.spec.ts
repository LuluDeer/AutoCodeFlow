import { Test } from "@nestjs/testing";
import {
  ExternalAgentBypassWriteService,
  type BypassFs,
  type BypassPath,
} from "../external-agent-bypass.service";

const CONFIG_PATH = "/home/agent/.claude/settings.json";
const BASE_URL = "https://cp.example.test/v1";
const KEY_REF = "{env:ACF_MCP_KEY}";

const ORIGINAL = [
  "{",
  '  "baseUrl": "https://old.example.test",',
  '  "apiKey": "old-secret",',
  '  "timeout": 30',
  "}",
  "",
].join("\n");
const EXPECTED = ORIGINAL.replace('"old-secret"', `"${KEY_REF}"`);

/** 内存 fs：记录每一次写 / rename / unlink 及顺序，并能注入写失败。 */
class MemoryFs implements BypassFs {
  readonly files = new Map<string, string>();
  readonly writes: Array<{ path: string; data: string }> = [];
  readonly actions: string[] = [];
  failWrite = false;
  failRename = false;

  readFileSync(file: string, _encoding: BufferEncoding): string {
    const content = this.files.get(file);
    if (content === undefined) {
      throw Object.assign(new Error(`ENOENT: ${file}`), { code: "ENOENT" });
    }
    return content;
  }

  writeFileSync(
    file: string,
    data: string,
    _options?: { encoding?: BufferEncoding },
  ): void {
    this.actions.push(`write:${file}`);
    this.writes.push({ path: file, data });
    if (this.failWrite) throw new Error("simulated write failure");
    this.files.set(file, data);
  }

  renameSync(from: string, to: string): void {
    this.actions.push(`rename:${from}->${to}`);
    if (this.failRename) throw new Error("simulated rename failure");
    const content = this.files.get(from);
    if (content === undefined) throw new Error(`ENOENT tmp: ${from}`);
    this.files.delete(from);
    this.files.set(to, content);
  }

  unlinkSync(file: string): void {
    this.actions.push(`unlink:${file}`);
    this.files.delete(file);
  }
}

const fakePath: BypassPath = {
  dirname: (file) => file.slice(0, file.lastIndexOf("/")),
  basename: (file) => file.slice(file.lastIndexOf("/") + 1),
  join: (...parts) => parts.join("/"),
};

const serviceWith = (fs: MemoryFs) =>
  new ExternalAgentBypassWriteService(fs, fakePath);

describe("ExternalAgentBypassWriteService（N1 配置落盘接线，实际副作用）", () => {
  it("真实落盘：仅目标 key 的带引号值由明文变指针，其余字节逐字不变", () => {
    const fs = new MemoryFs();
    fs.files.set(CONFIG_PATH, ORIGINAL);

    const result = serviceWith(fs).applyBypass(
      CONFIG_PATH,
      "apiKey",
      BASE_URL,
      KEY_REF,
    );

    // 返回纯函数原样结果，不新造形状（只有 content + changed）。
    expect(result).toEqual({ content: EXPECTED, changed: true });
    expect(Object.isFrozen(result)).toBe(true);
    // 读回内存 fs：只有 apiKey 的值被改，baseUrl / timeout / 换行全部保持。
    expect(fs.files.get(CONFIG_PATH)).toBe(EXPECTED);
    expect(fs.files.get(CONFIG_PATH)).not.toContain("old-secret");
    expect(fs.files.get(CONFIG_PATH)).toContain(
      '"baseUrl": "https://old.example.test"',
    );
    expect(fs.files.get(CONFIG_PATH)).toContain('"timeout": 30');
    // tmp 已 rename，磁盘上只剩目标文件。
    expect(fs.files.size).toBe(1);
  });

  const noWriteCases: Array<{
    name: string;
    content: string;
    keyName: string;
    baseUrl: unknown;
    keyRef: unknown;
  }> = [
    {
      name: "同名 key 命中两次（命中数≠1）",
      content:
        '{\n  "apiKey": "first",\n  "nested": { "apiKey": "second" }\n}\n',
      keyName: "apiKey",
      baseUrl: BASE_URL,
      keyRef: KEY_REF,
    },
    {
      name: "目标 key 不存在（命中数=0）",
      content: ORIGINAL,
      keyName: "missingKey",
      baseUrl: BASE_URL,
      keyRef: KEY_REF,
    },
    {
      name: "明文凭证 keyRef",
      content: ORIGINAL,
      keyName: "apiKey",
      baseUrl: BASE_URL,
      keyRef: "sk-ant-abcdefghijklmnopqrstuvwxyz",
    },
    {
      name: "畸形 keyRef（小写名）",
      content: ORIGINAL,
      keyName: "apiKey",
      baseUrl: BASE_URL,
      keyRef: "{env:lower}",
    },
    {
      name: "畸形 keyRef（尾随换行，JS $ 陷阱）",
      content: ORIGINAL,
      keyName: "apiKey",
      baseUrl: BASE_URL,
      keyRef: `${KEY_REF}\n`,
    },
    {
      name: "畸形 baseUrl（非 http(s)）",
      content: ORIGINAL,
      keyName: "apiKey",
      baseUrl: "ftp://cp.example.test",
      keyRef: KEY_REF,
    },
    {
      name: "非法 keyName",
      content: ORIGINAL,
      keyName: "a)b(",
      baseUrl: BASE_URL,
      keyRef: KEY_REF,
    },
  ];

  it.each(noWriteCases)(
    "$name → changed=false，内存 fs 写调用数=0，原文一个字节不动",
    ({ content, keyName, baseUrl, keyRef }) => {
      const fs = new MemoryFs();
      fs.files.set(CONFIG_PATH, content);

      const result = serviceWith(fs).applyBypass(
        CONFIG_PATH,
        keyName,
        baseUrl,
        keyRef,
      );

      expect(result.changed).toBe(false);
      expect(result.content).toBe(content);
      expect(fs.writes).toHaveLength(0);
      expect(fs.actions).toHaveLength(0);
      expect(fs.files.get(CONFIG_PATH)).toBe(content);
    },
  );

  it("幂等：第二次调用 changed=false，写调用仍只有 1 次", () => {
    const fs = new MemoryFs();
    fs.files.set(CONFIG_PATH, ORIGINAL);
    const service = serviceWith(fs);

    const first = service.applyBypass(CONFIG_PATH, "apiKey", BASE_URL, KEY_REF);
    const second = service.applyBypass(
      CONFIG_PATH,
      "apiKey",
      BASE_URL,
      KEY_REF,
    );

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.content).toBe(EXPECTED);
    expect(fs.writes).toHaveLength(1);
    expect(fs.actions.filter((a) => a.startsWith("write:"))).toHaveLength(1);
    expect(fs.actions.filter((a) => a.startsWith("rename:"))).toHaveLength(1);
    expect(fs.files.get(CONFIG_PATH)).toBe(EXPECTED);
  });

  it("原子写真发生：先写同目录 tmp，再 rename 覆盖目标，顺序正确", () => {
    const fs = new MemoryFs();
    fs.files.set(CONFIG_PATH, ORIGINAL);

    serviceWith(fs).applyBypass(CONFIG_PATH, "apiKey", BASE_URL, KEY_REF);

    const tmp = fs.writes[0].path;
    expect(fs.writes).toHaveLength(1);
    expect(fs.writes[0].data).toBe(EXPECTED);
    expect(tmp).not.toBe(CONFIG_PATH);
    expect(fakePath.dirname(tmp)).toBe(fakePath.dirname(CONFIG_PATH));
    expect(tmp.endsWith(".tmp")).toBe(true);
    expect(fs.actions).toEqual([
      `write:${tmp}`,
      `rename:${tmp}->${CONFIG_PATH}`,
    ]);
  });

  it("写失败：tmp 被清理、无 rename、目标文件保持原文，原异常照抛", () => {
    const fs = new MemoryFs();
    fs.files.set(CONFIG_PATH, ORIGINAL);
    fs.failWrite = true;

    expect(() =>
      serviceWith(fs).applyBypass(CONFIG_PATH, "apiKey", BASE_URL, KEY_REF),
    ).toThrow("simulated write failure");

    const tmp = fs.writes[0].path;
    expect(fs.actions).toEqual([`write:${tmp}`, `unlink:${tmp}`]);
    expect(fs.actions.some((a) => a.startsWith("rename:"))).toBe(false);
    expect(fs.files.get(CONFIG_PATH)).toBe(ORIGINAL);
    expect(fs.files.size).toBe(1);
  });

  it("rename 失败：同样清理 tmp 并重抛，绝不半写", () => {
    const fs = new MemoryFs();
    fs.files.set(CONFIG_PATH, ORIGINAL);
    fs.failRename = true;

    expect(() =>
      serviceWith(fs).applyBypass(CONFIG_PATH, "apiKey", BASE_URL, KEY_REF),
    ).toThrow("simulated rename failure");

    const tmp = fs.writes[0].path;
    expect(fs.actions).toEqual([
      `write:${tmp}`,
      `rename:${tmp}->${CONFIG_PATH}`,
      `unlink:${tmp}`,
    ]);
    expect(fs.files.get(CONFIG_PATH)).toBe(ORIGINAL);
    expect(fs.files.has(tmp)).toBe(false);
  });

  it("读文件失败如实抛，不吞异常假装成功", () => {
    const fs = new MemoryFs(); // 目标不存在

    expect(() =>
      serviceWith(fs).applyBypass(CONFIG_PATH, "apiKey", BASE_URL, KEY_REF),
    ).toThrow(/ENOENT/);
    expect(fs.writes).toHaveLength(0);
    expect(fs.actions).toHaveLength(0);
  });

  it("Nest 零配置注册：未注入 token 时构造仍成功（主控接线缝）", async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [ExternalAgentBypassWriteService],
    }).compile();

    expect(moduleRef.get(ExternalAgentBypassWriteService)).toBeInstanceOf(
      ExternalAgentBypassWriteService,
    );
  });
});
