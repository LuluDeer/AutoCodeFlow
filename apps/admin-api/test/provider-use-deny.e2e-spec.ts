import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { DataSource } from "typeorm";
import { createTestApp } from "./helpers/app.helper";
import { AiService } from "../src/modules/ai/ai.service";
import { selectableProviders } from "../src/modules/ai/ai-providers";
import type { AiProviderEntry } from "../src/modules/ai/ai-providers";

/**
 * AGENTS §4.4 第 3 级：真 PG + 真 Nest（无 HTTP mock）。
 * ADR-044 步 2 / provider.use 出域硬开关的端到端副作用：
 *   managed deny 写 system_configs → selectableProviders 目录里该 provider 消失、
 *   routeFor 命中 deny（零出域请求）、项目 allow 不可推翻、audit_logs 落一行。
 *
 * 用真 DataSource 写/清 system_configs 与查 audit_logs，随机 key 前缀隔离。
 * 不 mock AiService / SystemConfigService / AuditService；routeFor 不发包（deny 在选路阶段拒）。
 */
describe("Provider use deny (real PG e2e)", () => {
  let app: INestApplication;
  let db: DataSource;
  let ai: AiService;

  const runId = randomUUID().slice(0, 8);
  const deniedId = `egress-denied-${runId}`;
  const configKey = "ai.provider.use.denied";
  const providersKey = "ai.providers";
  let before: { key: string; value: string | null; valueType: string } | null =
    null;
  let providersBefore: {
    key: string;
    value: string | null;
    valueType: string;
  } | null = null;

  const entry = (id: string): AiProviderEntry =>
    ({
      id,
      label: id,
      baseUrl: "https://example.invalid/v1",
      transport: "openai",
      model: "test-model",
      enabled: true,
    }) as AiProviderEntry;

  beforeAll(async () => {
    const dbName = process.env.DB_DATABASE ?? "";
    if (!/(^|_)(test|e2e)(_|$)/i.test(dbName)) {
      throw new Error(
        `provider use deny e2e 需要显式 test/e2e 库（收到 DB_DATABASE=${dbName || "<empty>"}）`,
      );
    }
    app = await createTestApp();
    db = app.get(DataSource);
    ai = app.get(AiService);
    const rows = await db.query(
      'SELECT key, value, "valueType" FROM system_configs WHERE key = $1',
      [configKey],
    );
    before = rows[0] ?? null;
    const pRows = await db.query(
      'SELECT key, value, "valueType" FROM system_configs WHERE key = $1',
      [providersKey],
    );
    providersBefore = pRows[0] ?? null;
  });

  afterAll(async () => {
    // audit_logs 是 append-only（触发器拒 DELETE），不做清理；本用例的审计行带
    // runId 前缀，按 (action, resourceId) 精确查询不污染其它用例。
    if (providersBefore) {
      await db.query(
        'UPDATE system_configs SET value = $1, "valueType" = $2 WHERE key = $3',
        [providersBefore.value, providersBefore.valueType, providersKey],
      );
    } else {
      await db.query("DELETE FROM system_configs WHERE key = $1", [
        providersKey,
      ]);
    }
    if (before) {
      await db.query(
        'UPDATE system_configs SET value = $1, "valueType" = $2 WHERE key = $3',
        [before.value, before.valueType, configKey],
      );
    } else {
      await db.query("DELETE FROM system_configs WHERE key = $1", [configKey]);
    }
    await app?.close();
  });

  it("managed deny → 目录消失 + 路由拒绝零出域 + 项目 allow 不可推翻 + 审计落行", async () => {
    // 1) 写 managed deny 名单到 system_configs（真库）
    await db.query(
      `INSERT INTO system_configs (key, value, "valueType", description)
       VALUES ($1, $2, 'json', 'e2e provider use deny')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "valueType" = EXCLUDED."valueType"`,
      [configKey, JSON.stringify([deniedId])],
    );

    // 1b) 注册该 provider 到 ai.providers（无密钥，注册表合法形态）
    await db.query(
      `INSERT INTO system_configs (key, value, "valueType", description)
       VALUES ($1, $2, 'json', 'e2e providers')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "valueType" = EXCLUDED."valueType"`,
      [
        providersKey,
        JSON.stringify([entry(deniedId), entry(`allowed-${runId}`)]),
      ],
    );

    // 2) 目录：被 deny 的 provider 消失（不是 disabled 置灰）
    const entries = [entry(deniedId), entry(`allowed-${runId}`)];
    const denied = await loadDenied(db, configKey);
    const visible = selectableProviders(entries, "agent", denied);
    expect(visible.map((e) => e.id)).not.toContain(deniedId);
    expect(visible.map((e) => e.id)).toContain(`allowed-${runId}`);

    // 3) routeFor：请求级 override 指到被 deny 的 provider → provider_denied；
    //    这里只验证判据（routeFor 不发包），chatMultimodal 层 emptyResponse 另有语义。
    const route = await (
      ai as unknown as {
        routeFor: (
          p: string,
          o?: string,
        ) => Promise<{ status: string; reason?: string }>;
      }
    ).routeFor("agent", `${deniedId}/some-model`);
    expect(route.status).toBe("error");
    if (route.status === "error") {
      expect(route.reason).toBe("provider_denied");
    }

    // 4) 项目层 allow 不可推翻：policyLayers 由纯函数单测覆盖 restrict 单调；
    //    这里断言 system_configs 仍只有 denied 名单、没有被 routeFor 改写。
    const after = await loadDenied(db, configKey);
    expect(after).toEqual([deniedId]);

    // 5) 审计落行（审计是 void async，短轮询等待）
    let auditRows: Array<{ action: string; detail: unknown }> = [];
    for (let i = 0; i < 20; i += 1) {
      auditRows = await db.query(
        'SELECT action, detail FROM audit_logs WHERE action = $1 AND "resourceId" = $2',
        ["capability.provider_denied", deniedId],
      );
      if (auditRows.length > 0) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
    const detail = JSON.stringify(auditRows[0]?.detail ?? {});
    expect(detail).not.toMatch(/apiKey|baseUrl|example\.invalid/);
  });
});

async function loadDenied(
  db: DataSource,
  key: string,
): Promise<readonly string[]> {
  const rows = await db.query(
    'SELECT value, "valueType" FROM system_configs WHERE key = $1',
    [key],
  );
  const raw = rows[0]?.value;
  if (typeof raw !== "string" || raw.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((s: unknown) => typeof s === "string")
      : [];
  } catch {
    return [];
  }
}
