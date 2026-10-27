import { User, UserRole } from "../../src/modules/users/entities/user.entity";
import {
  futureDate,
  nextSeq,
  pastDate,
  uniqueSuffix,
} from "./deterministic";

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

  // 唯一后缀：用户名/邮箱/口令同源，保证"同一进程内唯一"这条用例成立。
  const suffix = uniqueSuffix();
  user.id = overrides.id ?? nextSeq();
  user.username = overrides.username ?? `user${suffix}`;
  user.email = overrides.email ?? `user${suffix}@example.com`;
  // 密码满足「至少 8 位、含字母与数字」——这是**构造出来的**，不再靠随机
  // 字符集"碰运气"（旧实现用 faker 的 pattern: /[a-zA-Z0-9]/，只约束字符集、
  // 不保证出现数字：12 位全字母概率约 12%，对应一条 ~12% 概率偶发失败的用例）。
  user.password = overrides.password ?? `Passw0rd${suffix}`;
  user.role = overrides.role ?? UserRole.USER;
  user.isActive = overrides.isActive ?? true;
  user.loginFailCount = overrides.loginFailCount ?? 0;
  user.lockedUntil =
    overrides.lockedUntil !== undefined ? overrides.lockedUntil : null;
  user.totpSecret =
    overrides.totpSecret !== undefined ? overrides.totpSecret : null;
  user.totpEnabled = overrides.totpEnabled ?? false;
  user.sessionVersion = overrides.sessionVersion ?? 0;
  user.lastTotpCounter =
    overrides.lastTotpCounter !== undefined ? overrides.lastTotpCounter : null;
  user.oidcSub = overrides.oidcSub !== undefined ? overrides.oidcSub : null;
  user.createdAt = overrides.createdAt ?? pastDate(60 * 24 * 30);
  user.updatedAt = overrides.updatedAt ?? pastDate(5);

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
export function buildUsers(
  count: number,
  overrides: UserFactoryOptions = {},
): User[] {
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
    lockedUntil: futureDate(30),
    isActive: false,
    ...overrides,
  });
}

/**
 * 快捷函数：构建启用了 TOTP 的用户
 */
export function buildTotpUser(overrides: UserFactoryOptions = {}): User {
  return buildUser({
    totpSecret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
    totpEnabled: true,
    lastTotpCounter: nextSeq(),
    ...overrides,
  });
}
