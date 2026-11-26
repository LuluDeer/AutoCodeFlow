import {
  aggregateDecisions,
  dumpConfig,
  evaluatePolicy,
  isCredentialKey,
  mergeConfig,
  REDACTED,
  type ConfigLayer,
} from "../scope-engine";
import { mergeReplaceIfSameKey, stableKey } from "../merge-rules";

describe("ADR-040 逐字段族合并引擎", () => {
  describe("replace / default-replace", () => {
    const layers: ConfigLayer[] = [
      { name: "managed", config: { timeout: 100, mode: "managed-only" } },
      { name: "project", config: { timeout: 150 } },
      { name: "private", config: { timeout: 200 } },
    ];

    it("标量下层覆盖上层；未声明字段族不丢失", () => {
      const merged = mergeConfig(layers, {});
      expect(merged.timeout).toBe(200);
      expect(merged.mode).toBe("managed-only");
    });

    it("无规则字段在 dump 标 default-replace，source 指向最后落地层", () => {
      const dump = dumpConfig(layers, {});
      expect(dump.find((row) => row.field === "timeout")).toMatchObject({
        effective: 200,
        source: "private",
        rule: "default-replace",
      });
      expect(dump.find((row) => row.field === "mode")!.source).toBe("managed");
    });
  });

  describe("keyMerge", () => {
    it("按 key 合并：改一个 key 不影响其他 key（反证：整替换会丢键）", () => {
      const layers: ConfigLayer[] = [
        {
          name: "managed",
          config: {
            providers: {
              openai: { model: "gpt" },
              anthropic: { model: "claude" },
            },
          },
        },
        {
          name: "project",
          config: { providers: { openai: { model: "gpt-2" } } },
        },
      ];
      const merged = mergeConfig(layers, { providers: "keyMerge" });
      expect(merged.providers).toEqual({
        openai: { model: "gpt-2" },
        anthropic: { model: "claude" },
      });
      expect(dumpConfig(layers, { providers: "keyMerge" })[0].source).toBe(
        "project",
      );
    });
  });

  describe("append", () => {
    it("permission 列表追加且去重（上层在前）", () => {
      const layers: ConfigLayer[] = [
        { name: "managed", config: { permissions: ["read", "write"] } },
        { name: "project", config: { permissions: ["write", "exec"] } },
      ];
      expect(
        mergeConfig(layers, { permissions: "append" }).permissions,
      ).toEqual(["read", "write", "exec"]);
    });

    it("skill/plugin 对象项按稳定 key 去重（键序无关）", () => {
      const layers: ConfigLayer[] = [
        { name: "managed", config: { skills: [{ name: "a", v: 1 }] } },
        {
          name: "private",
          config: {
            skills: [
              { v: 1, name: "a" },
              { name: "b", v: 2 },
            ],
          },
        },
      ];
      expect(mergeConfig(layers, { skills: "append" }).skills).toEqual([
        { name: "a", v: 1 },
        { name: "b", v: 2 },
      ]);
      expect(stableKey({ a: 1, b: 2 })).toBe(stableKey({ b: 2, a: 1 }));
    });
  });

  describe("replaceIfSameKey", () => {
    it("同名 MCP / command 整对象替换，旧字段零残留；不同名追加", () => {
      const layers: ConfigLayer[] = [
        {
          name: "managed",
          config: {
            mcpServers: [
              {
                name: "fs",
                command: "old-cmd",
                args: ["--old"],
                apiKey: "LEAK-OLD",
              },
            ],
            commands: [{ name: "deploy", script: "old.sh", legacy: true }],
          },
        },
        {
          name: "project",
          config: {
            mcpServers: [
              { name: "fs", url: "http://new" },
              { name: "db", command: "x" },
            ],
            commands: [{ name: "deploy", script: "new.sh" }],
          },
        },
      ];
      const merged = mergeConfig(layers, {
        mcpServers: "replaceIfSameKey",
        commands: "replaceIfSameKey",
      }) as any;
      expect(merged.mcpServers).toHaveLength(2);
      expect(merged.mcpServers[0]).toEqual({ name: "fs", url: "http://new" });
      for (const stale of ["command", "args", "apiKey"]) {
        expect(
          Object.prototype.hasOwnProperty.call(merged.mcpServers[0], stale),
        ).toBe(false);
      }
      expect(merged.mcpServers[1]).toEqual({ name: "db", command: "x" });
      expect(merged.commands[0]).toEqual({ name: "deploy", script: "new.sh" });
      expect(
        Object.prototype.hasOwnProperty.call(merged.commands[0], "legacy"),
      ).toBe(false);
    });

    it("map 形态同名 key 也整值替换", () => {
      expect(
        mergeReplaceIfSameKey({ srv: { x: 1, y: 2 } }, { srv: { x: 9 } }),
      ).toEqual({ srv: { x: 9 } });
    });
  });

  describe("policyTighten / managed 硬策略", () => {
    const layers: ConfigLayer[] = [
      {
        name: "managed",
        config: { policy: { rules: { shell: "deny", net: { write: "ask" } } } },
      },
      {
        name: "project",
        config: { policy: { rules: { shell: "allow", "net:write": "allow" } } },
      },
      {
        name: "private",
        config: { policy: { deny: ["db"] }, scope: { locked: false } },
      },
    ];

    it("managed deny 不可被下层 allow 覆盖（scope.locked:false 也无效）", () => {
      expect(evaluatePolicy(layers, "shell", "write")).toBe("deny");
      expect(evaluatePolicy(layers, "db", "read")).toBe("deny");
    });

    it("无匹配默认 ask；下层不得放宽上层 ask", () => {
      expect(evaluatePolicy(layers, "unknown", "x")).toBe("ask");
      expect(evaluatePolicy(layers, "net", "write")).toBe("ask");
    });

    it("下层 deny 可收紧上层 allow", () => {
      const tightened: ConfigLayer[] = [
        { name: "managed", config: { policy: { rules: { shell: "allow" } } } },
        { name: "project", config: { policy: { rules: { shell: "deny" } } } },
      ];
      expect(evaluatePolicy(tightened, "shell", "read")).toBe("deny");
    });

    it("dump 的 policyTighten effective 与 source 反映收紧结果", () => {
      const row = dumpConfig(layers, { policy: "policyTighten" }).find(
        (item) => item.field === "policy",
      )!;
      expect(row.source).toBe("managed");
      expect((row.effective as any).rules["shell:*"]).toBe("deny");
      expect((row.effective as any).rules["net:write"]).toBe("ask");
    });
  });

  describe("dump 三栏与凭据脱敏", () => {
    const TOKEN = "sk-VERY-SECRET-TOKEN-42";
    const NESTED_KEY = "nested-apikey-SECRET-99";
    const layers: ConfigLayer[] = [
      {
        name: "managed",
        config: {
          token: TOKEN,
          providers: { openai: { apiKey: NESTED_KEY, model: "gpt" } },
          timeout: 30,
        },
      },
      {
        name: "private",
        config: {
          token: "another-secret-value",
          providers: {
            openai: { apiKey: "other-secret-value", model: "gpt-4" },
          },
          timeout: 60,
        },
      },
    ];
    const dump = dumpConfig(layers, { providers: "keyMerge" });
    const rendered = JSON.stringify(dump);

    it("三栏齐全：分层来源 / 生效值 / source", () => {
      expect(
        dump.every(
          (row) =>
            Array.isArray(row.layers) &&
            "effective" in row &&
            typeof row.source === "string",
        ),
      ).toBe(true);
      expect(dump.find((row) => row.field === "timeout")).toMatchObject({
        layers: [
          { name: "managed", value: 30 },
          { name: "private", value: 60 },
        ],
        effective: 60,
        source: "private",
      });
    });

    it("凭据明文绝不出现在 dump 输出（含嵌套 apiKey）", () => {
      for (const secret of [
        TOKEN,
        NESTED_KEY,
        "another-secret-value",
        "other-secret-value",
      ]) {
        expect(rendered).not.toContain(secret);
      }
      const tokenRow = dump.find((row) => row.field === "token")!;
      expect(tokenRow.layers).toEqual([
        { name: "managed", value: REDACTED },
        { name: "private", value: REDACTED },
      ]);
      expect(tokenRow.effective).toBe(REDACTED);

      const providerRow = dump.find((row) => row.field === "providers")!;
      expect(providerRow.layers[0].value).toEqual({
        openai: { apiKey: REDACTED, model: "gpt" },
      });
      expect(providerRow.effective).toEqual({
        openai: { apiKey: REDACTED, model: "gpt-4" },
      });
    });
  });

  describe("aggregateDecisions any-deny 与凭据键识别", () => {
    it("any-deny 聚合：deny > ask > allow，空集 ask", () => {
      expect(aggregateDecisions([])).toBe("ask");
      expect(aggregateDecisions(["allow", "allow", "deny"])).toBe("deny");
      expect(aggregateDecisions(["allow", "ask", "allow"])).toBe("ask");
      expect(aggregateDecisions(["allow", "allow"])).toBe("allow");
      expect(aggregateDecisions([undefined, null, "deny"])).toBe("deny");
    });

    it("大小写与下划线变体都命中凭据键", () => {
      for (const key of [
        "apiKey",
        "API_KEY",
        "clientSecret",
        "password",
        "credentialFile",
        "TOKEN",
      ]) {
        expect(isCredentialKey(key)).toBe(true);
      }
      expect(isCredentialKey("timeout")).toBe(false);
    });
  });
});
