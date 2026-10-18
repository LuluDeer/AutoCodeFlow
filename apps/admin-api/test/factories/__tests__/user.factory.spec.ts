import {
  buildUser,
  buildUsers,
  buildAdminUser,
  buildLockedUser,
  buildTotpUser,
} from '../user.factory';
import { UserRole } from '../../../src/modules/users/entities/user.entity';

describe('User Factory', () => {
  describe('buildUser', () => {
    it('应该生成具有默认值的 User 对象', () => {
      const user = buildUser();

      expect(user).toBeDefined();
      expect(user.id).toBeGreaterThan(0);
      expect(user.username).toBeTruthy();
      expect(user.email).toContain('@');
      expect(user.password).toBeTruthy();
      expect(user.role).toBe(UserRole.USER);
      expect(user.isActive).toBe(true);
      expect(user.loginFailCount).toBe(0);
      expect(user.totpEnabled).toBe(false);
      expect(user.sessionVersion).toBe(0);
      expect(user.createdAt).toBeInstanceOf(Date);
      expect(user.updatedAt).toBeInstanceOf(Date);
    });

    it('应该支持覆盖默认值', () => {
      const user = buildUser({
        username: 'testuser',
        email: 'test@example.com',
        role: UserRole.ADMIN,
        isActive: false,
      });

      expect(user.username).toBe('testuser');
      expect(user.email).toBe('test@example.com');
      expect(user.role).toBe(UserRole.ADMIN);
      expect(user.isActive).toBe(false);
    });

    it('应该正确处理 null 值', () => {
      const user = buildUser({
        lockedUntil: null,
        totpSecret: null,
        oidcSub: null,
      });

      expect(user.lockedUntil).toBeNull();
      expect(user.totpSecret).toBeNull();
      expect(user.oidcSub).toBeNull();
    });

    it('生成的密码应该有足够的复杂度', () => {
      const user = buildUser();

      expect(user.password.length).toBeGreaterThanOrEqual(8);
      // 密码应包含字母和数字
      expect(user.password).toMatch(/[a-zA-Z]/);
      expect(user.password).toMatch(/[0-9]/);
    });
  });

  describe('buildUsers', () => {
    it('应该生成指定数量的用户', () => {
      const users = buildUsers(5);

      expect(users).toHaveLength(5);
      users.forEach(user => {
        expect(user.id).toBeGreaterThan(0);
        expect(user.username).toBeTruthy();
      });
    });

    it('应该为所有用户应用覆盖值', () => {
      const users = buildUsers(3, { role: UserRole.ADMIN });

      expect(users).toHaveLength(3);
      users.forEach(user => {
        expect(user.role).toBe(UserRole.ADMIN);
      });
    });

    it('每个用户应该有唯一的生成值', () => {
      const users = buildUsers(3);

      const usernames = users.map(u => u.username);
      const uniqueUsernames = new Set(usernames);
      expect(uniqueUsernames.size).toBe(3);
    });
  });

  describe('buildAdminUser', () => {
    it('应该生成管理员用户', () => {
      const admin = buildAdminUser();

      expect(admin.role).toBe(UserRole.ADMIN);
    });

    it('应该支持覆盖其他属性', () => {
      const admin = buildAdminUser({ username: 'superadmin' });

      expect(admin.role).toBe(UserRole.ADMIN);
      expect(admin.username).toBe('superadmin');
    });
  });

  describe('buildLockedUser', () => {
    it('应该生成已锁定的用户', () => {
      const lockedUser = buildLockedUser();

      expect(lockedUser.loginFailCount).toBeGreaterThan(0);
      expect(lockedUser.lockedUntil).toBeInstanceOf(Date);
      expect(lockedUser.isActive).toBe(false);
    });

    it('lockedUntil 应该是未来时间', () => {
      const lockedUser = buildLockedUser();

      expect(lockedUser.lockedUntil).not.toBeNull();
      expect(lockedUser.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('buildTotpUser', () => {
    it('应该生成启用了 TOTP 的用户', () => {
      const totpUser = buildTotpUser();

      expect(totpUser.totpEnabled).toBe(true);
      expect(totpUser.totpSecret).toBeTruthy();
      expect(totpUser.lastTotpCounter).toBeGreaterThan(0);
    });

    it('TOTP secret 应该有合适的格式', () => {
      const totpUser = buildTotpUser();

      expect(totpUser.totpSecret).toBeTruthy();
      expect(totpUser.totpSecret!.length).toBe(32);
      // Base32 格式应该只包含大写字母和数字
      expect(totpUser.totpSecret).toMatch(/^[A-Z0-9]+$/);
    });
  });
});
