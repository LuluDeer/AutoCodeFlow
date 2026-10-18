import { faker } from '@faker-js/faker';
import { User, UserRole } from '../../src/modules/users/entities/user.entity';

/**
 * 测试数据工厂：User 实体
 * 
 * 提供可复用的用户测试数据生成函数，支持部分覆盖默认值。
 */

export interface UserFactoryOptions {
  id?: number;
  username?: string;
  email?: string;
  password?: string;
  role?: UserRole;
  isActive?: boolean;
  loginFailCount?: number;
  lockedUntil?: Date | null;
  totpSecret?: string | null;
  totpEnabled?: boolean;
  sessionVersion?: number;
  lastTotpCounter?: number | null;
  oidcSub?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * 构建单个 User 对象（未保存到数据库）
 * 
 * @param overrides - 部分覆盖默认生成值
 * @returns 完整的 User 对象
 * 
 * @example
 * const admin = buildUser({ role: UserRole.ADMIN });
 * const lockedUser = buildUser({ isActive: false, lockedUntil: new Date() });
 */
export function buildUser(overrides: UserFactoryOptions = {}): User {
  const user = new User();
  
  user.id = overrides.id ?? faker.number.int({ min: 1, max: 999999 });
  user.username = overrides.username ?? faker.internet.username().toLowerCase();
  user.email = overrides.email ?? faker.internet.email().toLowerCase();
  // 生成符合约束的密码（至少8位，包含字母和数字）
  user.password = overrides.password ?? faker.internet.password({ length: 12, memorable: false, pattern: /[a-zA-Z0-9]/ });
  user.role = overrides.role ?? UserRole.USER;
  user.isActive = overrides.isActive ?? true;
  user.loginFailCount = overrides.loginFailCount ?? 0;
  user.lockedUntil = overrides.lockedUntil !== undefined ? overrides.lockedUntil : null;
  user.totpSecret = overrides.totpSecret !== undefined ? overrides.totpSecret : null;
  user.totpEnabled = overrides.totpEnabled ?? false;
  user.sessionVersion = overrides.sessionVersion ?? 0;
  user.lastTotpCounter = overrides.lastTotpCounter !== undefined ? overrides.lastTotpCounter : null;
  user.oidcSub = overrides.oidcSub !== undefined ? overrides.oidcSub : null;
  user.createdAt = overrides.createdAt ?? faker.date.past({ years: 1 });
  user.updatedAt = overrides.updatedAt ?? faker.date.recent({ days: 30 });

  return user;
}

/**
 * 批量构建 User 对象
 * 
 * @param count - 生成数量
 * @param overrides - 应用到所有对象的覆盖值
 * @returns User 对象数组
 * 
 * @example
 * const users = buildUsers(5);
 * const admins = buildUsers(3, { role: UserRole.ADMIN });
 */
export function buildUsers(count: number, overrides: UserFactoryOptions = {}): User[] {
  return Array.from({ length: count }, () => buildUser(overrides));
}

/**
 * 快捷函数：构建管理员用户
 */
export function buildAdminUser(overrides: UserFactoryOptions = {}): User {
  return buildUser({ role: UserRole.ADMIN, ...overrides });
}

/**
 * 快捷函数：构建已锁定的用户
 */
export function buildLockedUser(overrides: UserFactoryOptions = {}): User {
  return buildUser({
    loginFailCount: 5,
    lockedUntil: faker.date.future({ years: 1 }),
    isActive: false,
    ...overrides,
  });
}

/**
 * 快捷函数：构建启用了 TOTP 的用户
 */
export function buildTotpUser(overrides: UserFactoryOptions = {}): User {
  return buildUser({
    totpSecret: faker.string.alphanumeric(32).toUpperCase(),
    totpEnabled: true,
    lastTotpCounter: faker.number.int({ min: 1, max: 1000 }),
    ...overrides,
  });
}
