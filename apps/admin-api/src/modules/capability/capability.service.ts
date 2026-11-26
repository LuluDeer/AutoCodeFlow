import { Injectable, Optional } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { AppError } from "../../common/errors/app-error";
import { ErrorCode } from "../../common/errors/error-codes";
import { AuditService } from "../audit/audit.service";
import { UserRole } from "../users/entities/user.entity";
import {
  DOMAIN_EVENTS,
  EVENT_SCHEMA_VERSION,
} from "../../common/events/domain-events";
import { DomainEventBus } from "../../common/services/domain-event-bus.service";
import {
  CAPABILITY_KINDS,
  CAPABILITY_VISIBILITIES,
  CreateCapabilityDto,
  UpdateCapabilityDto,
} from "./dto/create-capability.dto";
import {
  Capability,
  CapabilityScope,
  CapabilitySource,
} from "./entities/capability.entity";
import type { CapabilityAttestation } from "./entities/capability.entity";
import {
  canAutoUpdate,
  canToggleMarketplace,
  isSupportedSourceType,
  SUPPORTED_SOURCE_TYPES,
} from "./source-policy";
import {
  POLICY_SEMANTIC_VALUES,
  type PolicySemanticValue,
  type ResolveCapabilityDto,
} from "./dto/resolve-capability.dto";
import {
  DEFAULT_POLICY_FIELD,
  MANAGED_LAYER,
  dumpConfig,
  evaluateAll,
  evaluatePolicy,
  mergeConfig,
  type ConfigLayer,
  type Decision,
  type DumpField,
  type FieldRule,
  type FieldRules,
  type SemanticPolicyLayer,
} from "./scope/scope-engine";
import { ReachabilityProbeService } from "./reachability-probe.service";
import type { DegradePath, ReachabilityCapability } from "./reachability";

/** key 形态：小写字母/数字起头，1-128 位 [a-z0-9._-]。 */
const KEY_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;

const SCOPE_MODES = new Set(["managed", "supervised", "self_service"]);
const GUIDANCE_RANK: Record<string, number> = { L1: 1, L2: 2, L3: 3 };

/**
 * manifest 封闭键集合（借鉴 scripts/check-template-manifest.mjs 的
 * ALLOWED_MANIFEST_KEYS）：清单是机器契约，自由字段会让「机器能读懂」与
 * 「人以为机器能读懂」分叉。未知键 = 400，不落库。
 */
const MANIFEST_ALLOWED_KEYS = new Set([
  "name",
  "version",
  "description",
  "capabilities",
  "params",
  "entrypoints",
  "resources",
]);

/** 禁止的可执行字段：命中即 400（含 onXxx 形态的 hook）。 */
const FORBIDDEN_KEY_RE =
  /(?:^|_)(?:command|hook|script)(?:$|_)|^(?:on|pre|post)(?:command|hook|script)/i;

/**
 * N16 versionPin：语义化版本（可带 prerelease/build）或 40/64 位 hex hash。
 * 与 dto/create-capability.dto.ts 的 VERSION_PIN_PATTERN 同口径（service 侧
 * 独立持有，内存单测绕过 DTO 装饰器时仍要守住落库判据）。
 */
const VERSION_PIN_RE =
  /^(?:\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?|[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;

/** N16 背书声明封闭键集合：未知键即 400。 */
const ATTESTATION_ALLOWED_KEYS = new Set(["signer", "at", "scope"]);

/** 校验失败统一抛此码，detail 点名字段与原因。 */
const invalid: (detail: string) => never = (detail: string): never => {
  throw new AppError("VALIDATION_FAILED", { detail });
};

/**
 * ADR-040 默认字段族规则表（service 落点；resolve 与 dump 共用同一份）。
 * 未列出的字段族按 scope-engine 的 default-replace（标量整值覆盖）处理。
 */
export const DEFAULT_FIELD_RULES: FieldRules = Object.freeze({
  // 标量 replace（显式列出常见标量，便于审计阅读）
  timeout: "replace",
  model: "replace",
  version: "replace",
  enabled: "replace",
  // map keyMerge：只改一个 key 不影响其他 key
  providers: "keyMerge",
  models: "keyMerge",
  // permission / skill / plugin：追加 + 稳定去重
  permissions: "append",
  skills: "append",
  plugins: "append",
  // command / mcpServers：同名整对象替换，不同名追加
  command: "replaceIfSameKey",
  commands: "replaceIfSameKey",
  mcpServers: "replaceIfSameKey",
  // policy：单调收紧，managed deny 不可被下层放行
  policy: "policyTighten",
});

const VALID_FIELD_RULES: ReadonlySet<FieldRule> = new Set<FieldRule>([
  "replace",
  "keyMerge",
  "append",
  "replaceIfSameKey",
  "policyTighten",
]);

/** 四语义白名单：取值与 DTO / scope-engine 的 PolicySemantic 共用单一来源。 */
const VALID_POLICY_SEMANTICS: ReadonlySet<PolicySemanticValue> =
  new Set<PolicySemanticValue>(POLICY_SEMANTIC_VALUES);

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * N16：发布背书声明的纯校验（无副作用，失败抛稳定 400）。
 * 封闭键 + signer 非空；at/scope 为可选上下文，不在这里推断语义。
 */
export function assertAttestationShape(raw: unknown): void {
  if (!isPlainRecord(raw)) invalid("attestation must be a plain object");
  for (const key of Object.keys(raw)) {
    if (!ATTESTATION_ALLOWED_KEYS.has(key)) {
      invalid(`attestation.${key} is not an allowed key`);
    }
  }
  const signer = raw.signer;
  if (typeof signer !== "string" || signer.trim().length === 0) {
    invalid("attestation.signer must be a non-empty string");
  }
}

function assertOptionalText(
  value: unknown,
  field: string,
  maxLength: number,
): void {
  if (value === undefined || value === null) return;
  if (typeof value !== "string" || value.length > maxLength) {
    invalid(`${field} must be a string of at most ${maxLength} chars`);
  }
}

/** 递归检查纯对象是否为合法 manifest（封闭键 + 无可执行字段）。 */
function assertManifestShape(manifest: unknown): void {
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    Array.isArray(manifest)
  ) {
    invalid("manifest must be a plain object");
  }
  const walk = (obj: Record<string, unknown>, path: string): void => {
    for (const [key, value] of Object.entries(obj)) {
      if (FORBIDDEN_KEY_RE.test(key)) {
        invalid(`manifest.${path}${key} is a forbidden executable field`);
      }
      if (path === "" && !MANIFEST_ALLOWED_KEYS.has(key)) {
        invalid(`manifest.${key} is not an allowed key`);
      }
      if (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value)
      ) {
        walk(value as Record<string, unknown>, `${path}${key}.`);
      }
    }
  };
  walk(manifest as Record<string, unknown>, "");
}

function assertScopeShape(scope: unknown): void {
  if (scope === null || typeof scope !== "object" || Array.isArray(scope)) {
    invalid("scope must be a plain object");
  }
  const s = scope as Partial<CapabilityScope>;
  if (typeof s.mode !== "string" || !SCOPE_MODES.has(s.mode)) {
    invalid("scope.mode must be managed|supervised|self_service");
  }
  if (typeof s.guidance !== "string" || !(s.guidance in GUIDANCE_RANK)) {
    invalid("scope.guidance must be L1|L2|L3");
  }
  // ADR-040：强监管模式（managed）不允许最高自治档 L3。
  if (s.mode === "managed" && (GUIDANCE_RANK[s.guidance] ?? 0) > 2) {
    invalid("scope.mode=managed forbids guidance=L3");
  }
}

function assertSourceShape(source: unknown): void {
  if (source === null || typeof source !== "object" || Array.isArray(source)) {
    invalid("source must be a plain object");
  }
  const t = (source as Partial<CapabilitySource>).type;
  if (!isSupportedSourceType(t)) {
    invalid(`source.type must be one of ${SUPPORTED_SOURCE_TYPES.join("|")}`);
  }
}

/** 对「合并后的完整字段」做确定性校验；create 与 update 共用同一判据。 */
function assertValidFields(fields: {
  key: string;
  kind: string;
  visibility: string;
  scope: unknown;
  source: unknown;
  manifest: unknown;
  owner?: unknown;
  backer?: unknown;
  versionPin?: unknown;
  attestation?: unknown;
}): void {
  if (typeof fields.key !== "string" || !KEY_RE.test(fields.key)) {
    invalid("key must match /^[a-z0-9][a-z0-9._-]{0,127}$/");
  }
  if (
    typeof fields.kind !== "string" ||
    !(CAPABILITY_KINDS as readonly string[]).includes(fields.kind)
  ) {
    invalid(`kind must be one of ${CAPABILITY_KINDS.join("|")}`);
  }
  if (
    typeof fields.visibility !== "string" ||
    !(CAPABILITY_VISIBILITIES as readonly string[]).includes(fields.visibility)
  ) {
    invalid(`visibility must be one of ${CAPABILITY_VISIBILITIES.join("|")}`);
  }
  assertScopeShape(fields.scope);
  assertSourceShape(fields.source);
  assertManifestShape(fields.manifest);
  assertOptionalText(fields.owner, "owner", 128);
  assertOptionalText(fields.backer, "backer", 128);
  assertOptionalText(fields.versionPin, "versionPin", 64);
  if (
    fields.versionPin !== undefined &&
    fields.versionPin !== null &&
    !VERSION_PIN_RE.test(fields.versionPin as string)
  ) {
    invalid("versionPin must be a semver or a 40/64-hex hash");
  }
  if (fields.attestation !== undefined && fields.attestation !== null) {
    assertAttestationShape(fields.attestation);
  }
}

/** 审计落证的请求方身份（缺 id/username 时降级为 null 字段）。 */
export interface CapabilityActor {
  id?: number;
  username?: string;
  role?: UserRole;
}

/** POST /resolve 响应：生效配置 + 以 capability key 为资源的策略结论。 */
export interface CapabilityResolution {
  key: string;
  effective: Record<string, unknown>;
  decision: Decision;
  /** N9：可达性降级编排标记；探测口缺席时不写该字段（旧响应逐字不变）。 */
  degradePath?: DegradePath;
  /** N9：降级原因提示，格式「可达性分级:降级编排标记」。 */
  degradationHint?: string;
}

/** GET /:key/dump 响应：scope-engine 产出的三栏审计行。 */
export interface CapabilityDump {
  key: string;
  dump: DumpField[];
  /** N9：与 resolve 同口径的降级编排标记（可选）。 */
  degradePath?: DegradePath;
  /** N9：降级原因提示（可选）。 */
  degradationHint?: string;
}

/**
 * ADR-040 / P1：Capability 注册表 CRUD。
 *
 * 写端点（POST/PATCH/DELETE）由 controller 的 @Roles(ADMIN) 门控；service 只负责
 * 确定性校验 + 落库 + best-effort 审计。审计故障 fail-open（不阻断主链），
 * 与 event-subscription.service 等既有写面同款取舍。
 */
@Injectable()
export class CapabilityService {
  constructor(
    @InjectRepository(Capability)
    private readonly repo: Repository<Capability>,
    @Optional()
    private readonly audit: AuditService | null = null,
    // N14: DomainEventModule 是 @Global，生产自动注入；内存单测缺席不崩（fail-open）。
    @Optional()
    private readonly bus: DomainEventBus | null = null,
    // N9：探测口 @Optional，内存单测缺席不崩（既有 resolve/dump 响应不变）。
    @Optional()
    private readonly probe: ReachabilityProbeService | null = null,
  ) {}

  async findAll(): Promise<Capability[]> {
    return this.repo.find({ order: { createdAt: "DESC" } });
  }

  async findOne(id: string): Promise<Capability> {
    const cap = await this.repo.findOne({ where: { id } });
    if (!cap) throw new AppError(ErrorCode.CAPABILITY_NOT_FOUND);
    return cap;
  }

  /**
   * POST /api/capabilities/resolve —— 只读查询：这条能力在给定层叠下的最终生效配置。
   * 层由调用方按高→低提供；key 必须已注册（findAll 对账），防止任意 JSON 被当配置探针。
   * decision 以 capability key 为 resource、'*' 为 action 求值：未传 semanticLayers
   * 走旧 evaluatePolicy（managed deny 不被下层放行）；传入则交 scope-engine 四语义求值。
   */
  async resolveFor(dto: ResolveCapabilityDto): Promise<CapabilityResolution> {
    const key = dto?.key;
    if (typeof key !== "string" || key.length === 0) {
      invalid("key must be a non-empty string");
    }
    const caps = await this.findAll();
    if (!caps.some((cap) => cap.key === key)) {
      invalid(`key not registered: ${key}`);
    }
    const layers = this.assertLayers(dto.layers);
    const rules = this.assertFieldRules(dto.fieldRules);
    const semanticLayers = this.assertSemanticLayers(dto.semanticLayers);
    const effective = mergeConfig(layers, rules);
    const policyField =
      Object.keys(rules).find((field) => rules[field] === "policyTighten") ??
      DEFAULT_POLICY_FIELD;
    // 四语义只判定 decision，不改配置合并规则（effective 仍出自 mergeConfig）。
    const decision = semanticLayers
      ? evaluateAll(semanticLayers, [{ resource: key, action: "*" }])
      : evaluatePolicy(layers, key, "*", policyField);
    const resolution: CapabilityResolution = { key, effective, decision };
    await this.attachDegradation(
      resolution,
      caps.find((c) => c.key === key),
    );
    return resolution;
  }

  /**
   * GET /api/capabilities/:key/dump —— 三栏审计。
   * managed 层取该记录的 manifest + scope（中台下发层）；project/private 由 query JSON 模拟。
   * 脱敏由 dumpConfig 统一完成（凭据键递归替换为 <redacted>）。
   */
  async dumpFor(
    key: string,
    projectLayer?: string | Record<string, unknown>,
    privateLayer?: string | Record<string, unknown>,
  ): Promise<CapabilityDump> {
    if (typeof key !== "string" || key.length === 0) {
      invalid("key must be a non-empty string");
    }
    const caps = await this.findAll();
    const cap = caps.find((c) => c.key === key);
    if (!cap) invalid(`key not registered: ${key}`);

    const layers: ConfigLayer[] = [
      {
        name: MANAGED_LAYER,
        config: {
          ...(isPlainRecord(cap.manifest) ? cap.manifest : {}),
          ...(isPlainRecord(cap.scope) ? cap.scope : {}),
        },
      },
    ];
    const project = this.parseQueryLayer(projectLayer, "projectLayer");
    if (project !== null) layers.push({ name: "project", config: project });
    const priv = this.parseQueryLayer(privateLayer, "privateLayer");
    if (priv !== null) layers.push({ name: "private", config: priv });

    const result: CapabilityDump = {
      key,
      dump: dumpConfig(layers, { ...DEFAULT_FIELD_RULES }),
    };
    await this.attachDegradation(result, cap);
    return result;
  }

  /**
   * N9：把一次探测的分级/降级标记增量挂到响应上。
   * 探测口缺席或探测链异常时静默跳过——resolve/dump 主链与既有响应形状不变。
   */
  private async attachDegradation(
    target: CapabilityResolution | CapabilityDump,
    capability: ReachabilityCapability | null | undefined,
  ): Promise<void> {
    if (!this.probe) return;
    try {
      const assessment = await this.probe.assess(capability);
      target.degradePath = assessment.degradePath;
      target.degradationHint = assessment.degradationHint;
    } catch {
      // fail-open：探测失败只让降级字段缺席，不把 resolve/dump 变成 500。
    }
  }

  async create(
    dto: CreateCapabilityDto,
    actor?: CapabilityActor,
  ): Promise<Capability> {
    const fields = {
      key: dto.key,
      kind: dto.kind,
      visibility: dto.visibility,
      scope: dto.scope ?? { mode: "supervised", guidance: "L2" },
      source: dto.source ?? { type: "builtin" },
      manifest: dto.manifest,
      owner: dto.owner ?? null,
      backer: dto.backer ?? null,
      versionPin: dto.versionPin ?? null,
      attestation: dto.attestation ?? null,
    };
    assertValidFields(fields);

    const existing = await this.repo.findOne({ where: { key: fields.key } });
    if (existing) {
      throw new AppError("VALIDATION_FAILED", {
        detail: `key already exists: ${fields.key}`,
      });
    }

    const entity = this.repo.create({
      key: fields.key,
      kind: fields.kind,
      label: dto.label,
      description: dto.description ?? null,
      version: dto.version ?? "1.0.0",
      source: fields.source as unknown as CapabilitySource,
      visibility: fields.visibility,
      scope: fields.scope as unknown as CapabilityScope,
      manifest: fields.manifest as Record<string, unknown>,
      enabled: dto.enabled ?? true,
      createdBy: this.actorKey(actor),
      owner: fields.owner as string | null,
      backer: fields.backer as string | null,
      versionPin: fields.versionPin as string | null,
      attestation:
        fields.attestation as unknown as CapabilityAttestation | null,
    });
    // adr-026-exempt: 创建路径 INSERT —— entity 来自 repo.create，无前置状态可断言。
    const saved = await this.repo.save(entity);
    await this.writeAudit("capability.create", saved, actor);
    // ARCH-21 时序：DB INSERT 成功之后才 emit（事件即既成事实）。
    this.emitCapabilityChanged(saved.key, "create");
    return saved;
  }

  async update(
    id: string,
    dto: UpdateCapabilityDto,
    actor?: CapabilityActor,
  ): Promise<Capability> {
    const cap = await this.findOne(id);
    // 合并后校验：PATCH 只改 visibility 也不能绕过 scope/manifest 的既有合法性。
    const merged = {
      key: dto.key ?? cap.key,
      kind: dto.kind ?? cap.kind,
      visibility: dto.visibility ?? cap.visibility,
      scope: dto.scope ?? cap.scope,
      source: dto.source ?? cap.source,
      manifest: dto.manifest ?? cap.manifest,
      owner: dto.owner !== undefined ? dto.owner : cap.owner,
      backer: dto.backer !== undefined ? dto.backer : cap.backer,
      versionPin:
        dto.versionPin !== undefined ? dto.versionPin : cap.versionPin,
      attestation:
        dto.attestation !== undefined ? dto.attestation : cap.attestation,
    };
    assertValidFields(merged);

    if (dto.key !== undefined && dto.key !== cap.key) {
      const existing = await this.repo.findOne({ where: { key: dto.key } });
      if (existing && existing.id !== cap.id) {
        throw new AppError("VALIDATION_FAILED", {
          detail: `key already exists: ${dto.key}`,
        });
      }
    }

    // ADR-026 规则 2/4：把「读时刻的版本」下沉到写谓词，判据归数据库。
    // 旧实现 `Object.assign(cap, dto…) + repo.save(cap)` 是整行回写：并发
    // PATCH 只改 visibility，却把别人刚写的 scope/manifest/policy 按旧快照
    // 盖回去（last-write-wins）。不可解析的时间戳 fail-closed——绝不退化成
    // 无条件写。与 task.service 的乐观锁同构：PG timestamptz 是微秒而 JS
    // Date 毫秒，用 [ms, ms+1) 毫秒桶等值，避免「差 1μs 永不命中」。
    const expectedVersionMs = new Date(cap.updatedAt).getTime();
    if (!Number.isFinite(expectedVersionMs)) {
      throw new AppError(ErrorCode.RESOURCE_EXISTS, { id });
    }

    const patch = this.capabilityPatchFromDto(
      dto as unknown as Record<string, unknown>,
    );
    const applied = await this.patchCapabilityColumns(
      id,
      patch,
      expectedVersionMs,
    );

    // 返回体必须是库里的当前行，不是本次方法的早期快照（并发赢家的列如实回给）。
    const saved = await this.findOne(id);
    if (!applied) {
      // 谓词未命中：行已被并发 remove ⇒ findOne 已抛 404；仍在 ⇒ 版本被
      // 别人推进 ⇒ 409。两条路径都绝不按旧快照回写（ADR-026 规则 3）。
      throw new AppError(ErrorCode.RESOURCE_EXISTS, { id });
    }
    await this.writeAudit("capability.update", saved, actor);
    // 含 enable-disable（DTO 的 enabled 列走同一条 update 路径）。
    this.emitCapabilityChanged(saved.key, "update");
    return saved;
  }

  /**
   * N25 marketplace 启停写口：资格判定唯一委托 source-policy 的
   * canToggleMarketplace（源闭包 + marketplace 身份 + ref 形态 + 布尔 enabled），
   * service 不复制任何字面量判据。非法组合零写入 + 失败审计，沿用 update 的
   * 条件写与既有审计通道，不新开旁路 save。
   */
  async toggleMarketplace(
    id: string,
    enabled: unknown,
    actor?: CapabilityActor,
  ): Promise<Capability> {
    const cap = await this.findOne(id);
    if (!canToggleMarketplace(cap.source, enabled)) {
      await this.writeAudit(
        "capability.marketplace.toggle_failed",
        cap,
        actor,
        {
          source: cap.source,
          enabled,
          result: "failure",
          reason:
            "marketplace toggle requires an eligible source, a <package>@marketplace ref, and a boolean enabled",
        },
        "failure",
      );
      invalid("marketplace toggle is not eligible for this source/ref/enabled");
    }
    return this.update(id, { enabled } as never, actor);
  }

  /** N25 autoUpdate 只接纯判定；拉取/落库属 external，本切片不实现。 */
  canAutoUpdateFor(
    source: unknown,
    currentVersion: unknown,
    latestVersion: unknown,
  ): boolean {
    return canAutoUpdate(source, currentVersion, latestVersion);
  }

  /**
   * N16 所有权移交：治理动作审计（capability.transfer）与字段变更审计
   * （capability.update）分层——update 记「哪些列被改」，transfer 记
   * 「谁把 owner/backer 交给谁、谁背书」并带前后值；语义不同，不是重复记录。
   * 字段写入完全复用 update 的合并校验、乐观锁与通用审计，不引入旁路写库。
   */
  async transfer(
    id: string,
    dto: { owner: string; backer: string },
    actor?: CapabilityActor,
  ): Promise<Capability> {
    const before = await this.findOne(id);
    const saved = await this.update(
      id,
      { owner: dto.owner, backer: dto.backer },
      actor,
    );
    await this.writeAudit("capability.transfer", saved, actor, {
      before: { owner: before.owner, backer: before.backer },
      after: { owner: saved.owner, backer: saved.backer },
    });
    return saved;
  }

  /**
   * ADR-026 规则 1/2/4（与 task.service.patchTaskColumns 同构）：列级条件写。
   * 只写本次 DTO 显式带来的列 + 库时钟 updatedAt；行谓词恒带 updatedAt 版本
   * 桶。QueryBuilder 的 UPDATE 不像 save() 自动刷新 @UpdateDateColumn，漏了它
   * 会让并发判据退化成恒定值。
   *
   * @returns true = 行谓词成立且写落库（affected > 0）
   */
  private async patchCapabilityColumns(
    id: string,
    patch: Record<string, unknown>,
    expectedVersionMs: number,
  ): Promise<boolean> {
    const result = await this.repo
      .createQueryBuilder()
      .update(Capability)
      .set({ ...patch, updatedAt: () => "CURRENT_TIMESTAMP" })
      .where('"id" = :id', { id })
      .andWhere('"updatedAt" >= :tsFrom AND "updatedAt" < :tsTo', {
        tsFrom: new Date(expectedVersionMs),
        tsTo: new Date(expectedVersionMs + 1),
      })
      .execute();
    return (result?.affected ?? 0) > 0;
  }

  /** PATCH 投影：只取本次请求真的带来的可写列（undefined = 保留旧值，不写）。 */
  private capabilityPatchFromDto(
    dto: Record<string, unknown>,
  ): Record<string, unknown> {
    const patch: Record<string, unknown> = {};
    for (const key of [
      "key",
      "kind",
      "label",
      "description",
      "version",
      "source",
      "visibility",
      "scope",
      "manifest",
      "enabled",
      "owner",
      "backer",
      "versionPin",
      "attestation",
    ] as const) {
      if (dto[key] !== undefined) patch[key] = dto[key];
    }
    return patch;
  }

  async remove(id: string, actor?: CapabilityActor): Promise<void> {
    const cap = await this.findOne(id);
    await this.repo.remove(cap);
    await this.writeAudit("capability.delete", cap, actor);
    this.emitCapabilityChanged(cap.key, "remove");
  }

  /** 层的形态与层数守卫（上限 8 防滥用）；返回 scope 引擎可直接消费的 ConfigLayer[]。 */
  private assertLayers(layers: unknown): ConfigLayer[] {
    if (!Array.isArray(layers) || layers.length < 1) {
      invalid("layers must be a non-empty array");
    }
    if (layers.length > 8) {
      invalid("layers must not exceed 8");
    }
    return layers.map((layer, index) => {
      if (
        !isPlainRecord(layer) ||
        typeof layer.name !== "string" ||
        layer.name.length === 0
      ) {
        invalid(`layers[${index}].name must be a non-empty string`);
      }
      if (!isPlainRecord(layer.config)) {
        invalid(`layers[${index}].config must be a plain object`);
      }
      return { name: layer.name, config: layer.config };
    });
  }

  /**
   * 可选四语义策略层守卫：省略返回 undefined（旧 decision 路径逐字不变），
   * 传入则逐层校验 name / semantic / config，非法即 400，供 evaluateAll 直接消费。
   */
  private assertSemanticLayers(
    layers: unknown,
  ): SemanticPolicyLayer[] | undefined {
    if (layers === undefined || layers === null) return undefined;
    if (!Array.isArray(layers) || layers.length < 1) {
      invalid("semanticLayers must be a non-empty array");
    }
    if (layers.length > 8) {
      invalid("semanticLayers must not exceed 8");
    }
    return layers.map((layer, index) => {
      if (!isPlainRecord(layer)) {
        invalid(`semanticLayers[${index}] must be a plain object`);
      }
      if (typeof layer.name !== "string" || layer.name.length === 0) {
        invalid(`semanticLayers[${index}].name must be a non-empty string`);
      }
      if (!VALID_POLICY_SEMANTICS.has(layer.semantic as PolicySemanticValue)) {
        invalid(
          `semanticLayers[${index}].semantic must be one of ${POLICY_SEMANTIC_VALUES.join("|")}`,
        );
      }
      if (!isPlainRecord(layer.config)) {
        invalid(`semanticLayers[${index}].config must be a plain object`);
      }
      return {
        name: layer.name,
        semantic: layer.semantic as SemanticPolicyLayer["semantic"],
        config: layer.config,
      };
    });
  }

  /** 显式 fieldRules 逐项校验；缺省回落到默认规则表（Object.freeze 需复制）。 */
  private assertFieldRules(fieldRules: unknown): FieldRules {
    if (fieldRules === undefined || fieldRules === null) {
      return { ...DEFAULT_FIELD_RULES };
    }
    if (!isPlainRecord(fieldRules))
      invalid("fieldRules must be a plain object");
    for (const [field, rule] of Object.entries(fieldRules)) {
      if (!VALID_FIELD_RULES.has(rule as FieldRule)) {
        invalid(
          `fieldRules.${field} must be one of ${[...VALID_FIELD_RULES].join("|")}`,
        );
      }
    }
    return fieldRules as FieldRules;
  }

  /** query 的 JSON 字符串 → 纯对象；空串视为未提供，非法 JSON/非对象拒绝。 */
  private parseQueryLayer(
    raw: string | Record<string, unknown> | undefined,
    label: string,
  ): Record<string, unknown> | null {
    if (raw === undefined || raw === "") return null;
    let parsed: unknown = raw;
    if (typeof raw === "string") {
      try {
        parsed = JSON.parse(raw);
      } catch {
        invalid(`${label} must be valid JSON`);
      }
    }
    if (!isPlainRecord(parsed)) invalid(`${label} must be a JSON object`);
    return parsed;
  }

  private actorKey(actor?: CapabilityActor): string | null {
    if (!actor || actor.id === undefined) return null;
    return `user:${actor.id}|${actor.username ?? ""}`.slice(0, 64);
  }

  /**
   * N14: 能力写操作落库后发布 capability.changed，供 workbench 运行时代际
   * registry bump（在途旧方案卡即时失效）。fail-open：bus 缺席或 emit 抛错
   * 都不阻断 capability 主链——写已经提交，事件只是旁路通知。
   */
  private emitCapabilityChanged(
    key: string,
    operation: "create" | "update" | "remove",
  ): void {
    if (!this.bus) return;
    try {
      this.bus.emit(DOMAIN_EVENTS.CAPABILITY_CHANGED, {
        key,
        operation,
        occurredAt: new Date().toISOString(),
        schemaVersion: EVENT_SCHEMA_VERSION,
      });
    } catch {
      // fail-open：事件发布失败不改变已落库的写操作结果。
    }
  }

  /** best-effort 审计落证；失败只 warn，绝不外抛（审计不是主链的失败条件）。 */
  private async writeAudit(
    action: string,
    cap: Capability,
    actor?: CapabilityActor,
    detail?: Record<string, unknown>,
    result?: "success" | "failure",
  ): Promise<void> {
    if (!this.audit) return;
    try {
      await this.audit.log({
        userId: actor?.id,
        username: actor?.username,
        action,
        resource: "capability",
        resourceId: cap.id,
        ...(result ? { result } : {}),
        detail: {
          key: cap.key,
          kind: cap.kind,
          visibility: cap.visibility,
          ...(detail ?? {}),
        },
      });
    } catch (err: unknown) {
      // fail-open：审计写失败只 warn，不改变已落库的 capability 主链结果。
      console.warn(
        `[CapabilityService] audit write failed for ${action}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }
}
