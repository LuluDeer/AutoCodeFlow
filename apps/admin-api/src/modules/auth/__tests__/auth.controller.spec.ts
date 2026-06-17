import { Test, TestingModule } from '@nestjs/testing';
import { AuthController } from '../auth.controller';
import { AuthService } from '../auth.service';
import { AuditService } from '../../audit/audit.service';
import { AuthUser } from '../../../common/interfaces/auth-user.interface';
import { UserRole } from '../../users/entities/user.entity';

const mockAuthService = () => ({
  login: jest.fn(),
  refreshToken: jest.fn(),
  revokeAllForUser: jest.fn(),
});

const mockAuditService = () => ({
  log: jest.fn().mockResolvedValue(undefined),
});

const mockReq = { ip: '192.168.1.1' } as any;
const adminUser: AuthUser = { id: 1, username: 'admin', role: UserRole.ADMIN } as AuthUser;

describe('AuthController', () => {
  let controller: AuthController;
  let authSvc: ReturnType<typeof mockAuthService>;
  let auditSvc: ReturnType<typeof mockAuditService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useFactory: mockAuthService },
        { provide: AuditService, useFactory: mockAuditService },
      ],
    }).compile();

    controller = module.get(AuthController);
    authSvc = module.get(AuthService);
    auditSvc = module.get(AuditService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('login', () => {
    it('delegates to authService.login and logs audit', async () => {
      const dto = { username: 'admin', password: 'secret' } as any;
      const tokens = { accessToken: 'at', refreshToken: 'rt' };
      authSvc.login.mockResolvedValue(tokens);

      const result = await controller.login(dto, mockReq);

      expect(authSvc.login).toHaveBeenCalledWith(dto);
      expect(auditSvc.log).toHaveBeenCalledWith(
        expect.objectContaining({
          username: 'admin',
          action: 'auth.login',
          resource: 'auth',
          ip: '192.168.1.1',
        }),
      );
      expect(result).toEqual(tokens);
    });

    it('still returns tokens even when audit log throws', async () => {
      const dto = { username: 'admin', password: 'secret' } as any;
      const tokens = { accessToken: 'at', refreshToken: 'rt' };
      authSvc.login.mockResolvedValue(tokens);
      auditSvc.log.mockRejectedValue(new Error('DB down'));

      const result = await controller.login(dto, mockReq);

      expect(result).toEqual(tokens);
    });

    it('propagates auth service errors', async () => {
      authSvc.login.mockRejectedValue(new Error('invalid credentials'));
      await expect(
        controller.login({ username: 'bad', password: 'bad' } as any, mockReq),
      ).rejects.toThrow('invalid credentials');
    });
  });

  describe('refreshToken', () => {
    it('delegates to authService.refreshToken', () => {
      const newTokens = { accessToken: 'new-at', refreshToken: 'new-rt' };
      authSvc.refreshToken.mockResolvedValue(newTokens);

      const dto = { refreshToken: 'old-rt' } as any;
      controller.refreshToken(dto);

      expect(authSvc.refreshToken).toHaveBeenCalledWith('old-rt');
    });
  });

  describe('logout', () => {
    it('revokes all tokens for user and logs audit', async () => {
      authSvc.revokeAllForUser.mockResolvedValue(undefined);

      const result = await controller.logout(adminUser, mockReq);

      expect(authSvc.revokeAllForUser).toHaveBeenCalledWith(1);
      expect(auditSvc.log).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 1,
          username: 'admin',
          action: 'auth.logout',
          resource: 'auth',
        }),
      );
      expect(result).toEqual({ success: true });
    });

    it('returns success even when audit log throws', async () => {
      authSvc.revokeAllForUser.mockResolvedValue(undefined);
      auditSvc.log.mockRejectedValue(new Error('DB timeout'));

      const result = await controller.logout(adminUser, mockReq);

      expect(result).toEqual({ success: true });
    });

    it('propagates revoke errors (does not swallow them)', async () => {
      authSvc.revokeAllForUser.mockRejectedValue(new Error('token store failure'));
      await expect(controller.logout(adminUser, mockReq)).rejects.toThrow('token store failure');
    });
  });

  describe('getProfile', () => {
    it('returns the current user directly', () => {
      const result = controller.getProfile(adminUser);
      expect(result).toBe(adminUser);
    });
  });
});
