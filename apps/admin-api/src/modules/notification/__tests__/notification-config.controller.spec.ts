import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { NotificationConfigController } from '../notification-config.controller';
import { NotificationConfigService } from '../notification-config.service';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { ROLES_KEY } from '../../../common/decorators/roles.decorator';
import { UserRole } from '../../users/entities/user.entity';

const mockConfigService = () => ({
  getAllChannels: jest.fn(),
  updateChannel: jest.fn(),
  testChannel: jest.fn(),
  sendTest: jest.fn(),
});

describe('NotificationConfigController', () => {
  let controller: NotificationConfigController;
  let svc: ReturnType<typeof mockConfigService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [NotificationConfigController],
      providers: [
        { provide: NotificationConfigService, useFactory: mockConfigService },
      ],
    }).compile();

    controller = module.get(NotificationConfigController);
    svc = module.get(NotificationConfigService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('getChannels', () => {
    it('returns all channels from service', () => {
      const channels = [{ key: 'slack', enabled: true }];
      svc.getAllChannels.mockReturnValue(channels);
      expect(controller.getChannels()).toEqual(channels);
      expect(svc.getAllChannels).toHaveBeenCalled();
    });
  });

  describe('updateChannel', () => {
    it('delegates update to service with key and body', () => {
      const updated = { key: 'slack', enabled: true, config: { webhookUrl: 'https://x' } };
      svc.updateChannel.mockReturnValue(updated);
      const body = { enabled: true, config: { webhookUrl: 'https://x' } };

      const result = controller.updateChannel('slack', body);

      expect(svc.updateChannel).toHaveBeenCalledWith('slack', body);
      expect(result).toEqual(updated);
    });

    it('throws when service throws for unknown channel', () => {
      svc.updateChannel.mockImplementation(() => { throw new Error('Unknown notification channel: bad'); });
      expect(() => controller.updateChannel('bad', {})).toThrow('Unknown notification channel: bad');
    });
  });

  describe('testChannel', () => {
    it('delegates to configService.testChannel', async () => {
      const response = { success: true, message: 'Test message sent successfully' };
      svc.testChannel.mockResolvedValue(response);
      const body = { webhookUrl: 'https://hooks.example.com' };

      const result = await controller.testChannel(body);

      expect(svc.testChannel).toHaveBeenCalledWith(body);
      expect(result).toEqual(response);
    });

    it('returns failure response when service returns failure', async () => {
      svc.testChannel.mockResolvedValue({ success: false, message: 'SMTP error' });
      const result = await controller.testChannel({});
      expect(result.success).toBe(false);
    });
  });

  describe('sendTest', () => {
    it('delegates to configService.sendTest', async () => {
      const response = { success: true, message: 'Test notification sent' };
      svc.sendTest.mockResolvedValue(response);
      const body = { channels: ['slack'], title: 'Test', content: 'Hello' };

      const result = await controller.sendTest(body);

      expect(svc.sendTest).toHaveBeenCalledWith(body);
      expect(result).toEqual(response);
    });

    it('passes multiple channels through', async () => {
      svc.sendTest.mockResolvedValue({ success: true, message: 'done' });
      await controller.sendTest({ channels: ['slack', 'email', 'wecom'], title: 'T', content: 'C' });
      expect(svc.sendTest).toHaveBeenCalledWith(
        expect.objectContaining({ channels: ['slack', 'email', 'wecom'] }),
      );
    });
  });

  // N11: channel configs carry SMTP credentials — the global RolesGuard must
  // reject plain users (403) on the channels read/write surface.
  describe('RBAC — channels endpoints are ADMIN-only (N11)', () => {
    const guard = new RolesGuard(new Reflector());
    const ctxWith = (handler: Function, role: UserRole): ExecutionContext =>
      ({
        getHandler: () => handler,
        getClass: () => NotificationConfigController,
        switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
      }) as unknown as ExecutionContext;

    it('getChannels/updateChannel declare @Roles(ADMIN) metadata', () => {
      expect(
        Reflect.getMetadata(ROLES_KEY, NotificationConfigController.prototype.getChannels),
      ).toEqual([UserRole.ADMIN]);
      expect(
        Reflect.getMetadata(ROLES_KEY, NotificationConfigController.prototype.updateChannel),
      ).toEqual([UserRole.ADMIN]);
    });

    it('plain user is denied (RolesGuard → 403)', () => {
      expect(
        guard.canActivate(ctxWith(NotificationConfigController.prototype.getChannels, UserRole.USER)),
      ).toBe(false);
      expect(
        guard.canActivate(ctxWith(NotificationConfigController.prototype.updateChannel, UserRole.USER)),
      ).toBe(false);
    });

    it('admin passes (200 path)', () => {
      expect(
        guard.canActivate(ctxWith(NotificationConfigController.prototype.getChannels, UserRole.ADMIN)),
      ).toBe(true);
      expect(
        guard.canActivate(ctxWith(NotificationConfigController.prototype.updateChannel, UserRole.ADMIN)),
      ).toBe(true);
    });
  });
});
