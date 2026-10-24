import { faker } from "@faker-js/faker";
import {
  ApiKey,
  ApiKeyScope,
} from "../../src/modules/api-keys/entities/api-key.entity";
import { generateApiKey } from "../../src/modules/api-keys/api-key.util";

/**
 * 测试数据工厂：ApiKey 实体
 *
 * 提供可复用的 API Key 测试数据生成函数，支持部分覆盖默认值。
 */

export interface ApiKeyFactoryOptions {
  id?: number;
  userId?: number;
  name?: string;
  keyPrefix?: string;
  keyHash?: string;
  scope?: ApiKeyScope;
  scopes?: string | null;
  expiresAt?: Date | null;
  revokedAt?: Date | null;
  lastUsedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * 构建单个 ApiKey 对象（未保存到数据库）
 *
 * 注意：默认情况下会生成真实的 key hash，如果需要测试特定的明文 key，
 * 请使用 buildApiKeyWithPlaintext 函数。
 *
 * @param overrides - 部分覆盖默认生成值
 * @returns 完整的 ApiKey 对象
 *
 * @example
 * const readonlyKey = buildApiKey({ scope: 'readonly' });
 * const expiredKey = buildApiKey({ expiresAt: new Date('2020-01-01') });
 */
export function buildApiKey(overrides: ApiKeyFactoryOptions = {}): ApiKey {
  const apiKey = new ApiKey();

  // 如果没有提供 keyPrefix 和 keyHash，生成一对新的
  let keyPrefix = overrides.keyPrefix;
  let keyHash = overrides.keyHash;

  if (!keyPrefix || !keyHash) {
    const generated = generateApiKey();
    keyPrefix = keyPrefix ?? generated.keyPrefix;
    keyHash = keyHash ?? generated.keyHash;
  }

  apiKey.id = overrides.id ?? faker.number.int({ min: 1, max: 999999 });
  apiKey.userId = overrides.userId ?? faker.number.int({ min: 1, max: 999999 });
  apiKey.name = overrides.name ?? `${faker.word.adjective()}-key`;
  apiKey.keyPrefix = keyPrefix;
  apiKey.keyHash = keyHash;
  apiKey.scope = overrides.scope ?? "readonly";
  apiKey.scopes = overrides.scopes !== undefined ? overrides.scopes : null;
  apiKey.expiresAt =
    overrides.expiresAt !== undefined ? overrides.expiresAt : null;
  apiKey.revokedAt =
    overrides.revokedAt !== undefined ? overrides.revokedAt : null;
  apiKey.lastUsedAt =
    overrides.lastUsedAt !== undefined ? overrides.lastUsedAt : null;
  apiKey.createdAt = overrides.createdAt ?? faker.date.past({ years: 1 });
  apiKey.updatedAt = overrides.updatedAt ?? faker.date.recent({ days: 30 });

  return apiKey;
}

/**
 * 构建 ApiKey 对象并返回对应的明文 key
 *
 * 用于需要测试完整认证流程的场景。
 *
 * @param overrides - 部分覆盖默认生成值
 * @returns { apiKey: ApiKey, plaintext: string }
 *
 * @example
 * const { apiKey, plaintext } = buildApiKeyWithPlaintext({ scope: 'manage' });
 * // 使用 plaintext 进行认证测试
 */
export function buildApiKeyWithPlaintext(
  overrides: ApiKeyFactoryOptions = {},
): { apiKey: ApiKey; plaintext: string } {
  const { plaintext, keyPrefix, keyHash } = generateApiKey();

  const apiKey = buildApiKey({
    keyPrefix,
    keyHash,
    ...overrides,
  });

  return { apiKey, plaintext };
}

/**
 * 批量构建 ApiKey 对象
 *
 * @param count - 生成数量
 * @param overrides - 应用到所有对象的覆盖值
 * @returns ApiKey 对象数组
 *
 * @example
 * const keys = buildApiKeys(5);
 * const triggerKeys = buildApiKeys(3, { scope: 'trigger' });
 */
export function buildApiKeys(
  count: number,
  overrides: ApiKeyFactoryOptions = {},
): ApiKey[] {
  return Array.from({ length: count }, () => buildApiKey(overrides));
}

/**
 * 快捷函数：构建只读权限 API Key
 */
export function buildReadonlyApiKey(
  overrides: ApiKeyFactoryOptions = {},
): ApiKey {
  return buildApiKey({
    scope: "readonly",
    ...overrides,
  });
}

/**
 * 快捷函数：构建触发权限 API Key
 */
export function buildTriggerApiKey(
  overrides: ApiKeyFactoryOptions = {},
): ApiKey {
  return buildApiKey({
    scope: "trigger",
    ...overrides,
  });
}

/**
 * 快捷函数：构建管理权限 API Key
 */
export function buildManageApiKey(
  overrides: ApiKeyFactoryOptions = {},
): ApiKey {
  return buildApiKey({
    scope: "manage",
    ...overrides,
  });
}

/**
 * 快捷函数：构建已过期的 API Key
 */
export function buildExpiredApiKey(
  overrides: ApiKeyFactoryOptions = {},
): ApiKey {
  return buildApiKey({
    expiresAt: faker.date.past({ years: 1 }),
    ...overrides,
  });
}

/**
 * 快捷函数：构建已吊销的 API Key
 */
export function buildRevokedApiKey(
  overrides: ApiKeyFactoryOptions = {},
): ApiKey {
  return buildApiKey({
    revokedAt: faker.date.recent({ days: 7 }),
    ...overrides,
  });
}

/**
 * 快捷函数：构建带额外 scope 的 API Key
 */
export function buildApiKeyWithScopes(
  scopes: string[],
  overrides: ApiKeyFactoryOptions = {},
): ApiKey {
  return buildApiKey({
    scopes: scopes.join(" "),
    ...overrides,
  });
}

/**
 * 快捷函数：构建最近使用过的 API Key
 */
export function buildRecentlyUsedApiKey(
  overrides: ApiKeyFactoryOptions = {},
): ApiKey {
  return buildApiKey({
    lastUsedAt: faker.date.recent({ days: 1 }),
    ...overrides,
  });
}
