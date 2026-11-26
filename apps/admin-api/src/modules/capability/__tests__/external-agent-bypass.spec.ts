import {
  applySingleKeyRewrite,
  buildBypassPointer,
  type BypassPointer,
} from "../external-agent-bypass";

const KEY_REF = "{env:ACF_MCP_KEY}";
const pointer: BypassPointer = {
  baseUrl: "https://cp.example.test/v1",
  keyRef: KEY_REF,
};

const config = (keyRef: unknown, baseUrl: unknown = pointer.baseUrl) => ({
  baseUrl,
  keyRef,
});

describe("buildBypassPointer（N1 指针生成，纯函数零 I/O）", () => {
  it("合法下发 → 冻结指针，baseUrl 与 keyRef 逐字原样", () => {
    const result = buildBypassPointer(config(KEY_REF));
    expect(result).toEqual(pointer);
    expect(Object.isFrozen(result)).toBe(true);
    expect(result?.baseUrl).toBe("https://cp.example.test/v1");
    expect(result?.keyRef).toBe(KEY_REF);
  });

  it("空 / 畸形 config → null（fail-closed）", () => {
    expect(buildBypassPointer(null)).toBeNull();
    expect(buildBypassPointer(undefined)).toBeNull();
    expect(buildBypassPointer({} as any)).toBeNull();
    expect(buildBypassPointer("nope" as any)).toBeNull();
  });

  it("baseUrl 畸形 → null：空串、前后空白、非 http(s)、带用户信息", () => {
    expect(buildBypassPointer(config(KEY_REF, ""))).toBeNull();
    expect(
      buildBypassPointer(config(KEY_REF, " https://cp.example.test ")),
    ).toBeNull();
    expect(
      buildBypassPointer(config(KEY_REF, "ftp://cp.example.test")),
    ).toBeNull();
    expect(
      buildBypassPointer(config(KEY_REF, "https://u:p@cp.example.test")),
    ).toBeNull();
    expect(buildBypassPointer(config(KEY_REF, 42))).toBeNull();
  });

  it("keyRef 空值 / 非字符串 → null", () => {
    expect(buildBypassPointer(config(""))).toBeNull();
    expect(buildBypassPointer(config("   "))).toBeNull();
    expect(buildBypassPointer(config(undefined))).toBeNull();
    expect(buildBypassPointer(config(123))).toBeNull();
    expect(buildBypassPointer(config("{env:}"))).toBeNull();
  });

  it("占位形态必须严格 {env:[A-Z0-9_]+}，与 N13续 同口径", () => {
    expect(buildBypassPointer(config("{env:ACF_MCP_KEY_2}"))).not.toBeNull();
    expect(buildBypassPointer(config("{env:lower}"))).toBeNull();
    expect(buildBypassPointer(config("{env:A-B}"))).toBeNull();
    expect(buildBypassPointer(config("{env:A.B}"))).toBeNull();
    expect(buildBypassPointer(config("${env:FOO}"))).toBeNull();
    expect(buildBypassPointer(config("{secret:FOO}"))).toBeNull();
    // JS 的 `$` 会在结尾换行前命中：必须由长度校验挡下。
    expect(buildBypassPointer(config(`${KEY_REF}\n`))).toBeNull();
  });

  it("反证锚点：明文凭证（sk- / PEM / 长 hex）一律 null", () => {
    expect(
      buildBypassPointer(config("sk-ant-abcdefghijklmnopqrstuvwxyz")),
    ).toBeNull();
    expect(
      buildBypassPointer(
        config(
          "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----",
        ),
      ),
    ).toBeNull();
    expect(buildBypassPointer(config("a".repeat(40)))).toBeNull();
    expect(
      buildBypassPointer(config("0123456789abcdef0123456789abcdef")),
    ).toBeNull();
  });
});

describe("applySingleKeyRewrite（单 key 原子改写）", () => {
  const jsonConfig = [
    "{",
    '  "baseUrl": "https://old.example.test",',
    '  "apiKey": "old-secret",',
    '  "timeout": 30',
    "}",
  ].join("\n");

  it("只改一个 key：其它内容逐字节保持", () => {
    const result = applySingleKeyRewrite(jsonConfig, pointer, "apiKey");
    expect(result.changed).toBe(true);
    expect(result.content).toBe(
      jsonConfig.replace('"old-secret"', `"${KEY_REF}"`),
    );
    expect(result.content).toContain('"baseUrl": "https://old.example.test"');
    expect(result.content).toContain('"timeout": 30');
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("回滚等价性：把新值换回旧值即原文", () => {
    const result = applySingleKeyRewrite(jsonConfig, pointer, "apiKey");
    expect(result.content.replace(KEY_REF, "old-secret")).toBe(jsonConfig);
  });

  it("幂等：值已是指针 → changed=false，原文返回", () => {
    const rewritten = applySingleKeyRewrite(
      jsonConfig,
      pointer,
      "apiKey",
    ).content;
    const again = applySingleKeyRewrite(rewritten, pointer, "apiKey");
    expect(again.changed).toBe(false);
    expect(again.content).toBe(rewritten);
  });

  it("反证锚点：同名 key 出现两次 → changed=false，绝不改第一个", () => {
    const ambiguous = [
      "{",
      '  "apiKey": "first-secret",',
      '  "nested": { "apiKey": "second-secret" }',
      "}",
    ].join("\n");
    const result = applySingleKeyRewrite(ambiguous, pointer, "apiKey");
    expect(result.changed).toBe(false);
    expect(result.content).toBe(ambiguous);
  });

  it("注释里的同名 key 不参与命中", () => {
    const withComment = [
      "{",
      '  // "apiKey": "comment-only"',
      '  "apiKey": "real-secret"',
      "}",
    ].join("\n");
    const result = applySingleKeyRewrite(withComment, pointer, "apiKey");
    expect(result.changed).toBe(true);
    expect(result.content).toContain(`"apiKey": "${KEY_REF}"`);
    expect(result.content).toContain('"apiKey": "comment-only"');
  });

  it("控制组：目标 key 不存在 → changed=false，原文返回", () => {
    const result = applySingleKeyRewrite(jsonConfig, pointer, "missingKey");
    expect(result.changed).toBe(false);
    expect(result.content).toBe(jsonConfig);
  });

  it("非法 keyName / 非法 pointer → changed=false 且不抛", () => {
    expect(applySingleKeyRewrite(jsonConfig, pointer, "a)b(").changed).toBe(
      false,
    );
    expect(applySingleKeyRewrite(jsonConfig, null, "apiKey").changed).toBe(
      false,
    );
    expect(applySingleKeyRewrite(jsonConfig, undefined, "apiKey").changed).toBe(
      false,
    );
    expect(applySingleKeyRewrite(jsonConfig, pointer, null).changed).toBe(
      false,
    );
    expect(applySingleKeyRewrite(jsonConfig, pointer, " apiKey ").changed).toBe(
      false,
    );
  });

  it("反证锚点：调用方绕过 build 传入明文 pointer 也被拒绝", () => {
    const forged: BypassPointer = {
      baseUrl: "https://cp.example.test",
      keyRef: "sk-ant-abcdefghijklmnopqrstuvwxyz",
    };
    const result = applySingleKeyRewrite(jsonConfig, forged, "apiKey");
    expect(result.changed).toBe(false);
    expect(result.content).toBe(jsonConfig);
  });

  it("YAML 单引号值同样只改一处", () => {
    const yaml = "apiKey: 'old-secret'\nbaseUrl: 'https://old.example.test'\n";
    const result = applySingleKeyRewrite(yaml, pointer, "apiKey");
    expect(result.changed).toBe(true);
    expect(result.content).toBe(
      `apiKey: '${KEY_REF}'\nbaseUrl: 'https://old.example.test'\n`,
    );
  });

  it("env 风格带引号值同样只改一处", () => {
    const envFile =
      'API_KEY = "old-secret"\nBASE_URL = "https://old.example.test"\n';
    const result = applySingleKeyRewrite(envFile, pointer, "API_KEY");
    expect(result.changed).toBe(true);
    expect(result.content).toBe(
      `API_KEY = "${KEY_REF}"\nBASE_URL = "https://old.example.test"\n`,
    );
  });

  it("无引号裸值不猜改：changed=false，原文返回", () => {
    const bare = "API_KEY=old-secret\n";
    const result = applySingleKeyRewrite(bare, pointer, "API_KEY");
    expect(result.changed).toBe(false);
    expect(result.content).toBe(bare);
  });
});
