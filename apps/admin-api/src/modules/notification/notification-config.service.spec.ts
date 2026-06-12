import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { NotificationConfigService } from './notification-config.service';
import { NotificationService } from './notification.service';

describe('NotificationConfigService', () => {
  let service: NotificationConfigService;
  let notificationService: jest.Mocked<Partial<NotificationService>>;
  let configService: jest.Mocked<ConfigService>;

  beforeEach(async () => {
    notificationService = {
      sendAll: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationConfigService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue(undefined),
          },
        },
        {
          provide: NotificationService,
          useValue: notificationService,
        },
      ],
    }).compile();

    service = module.get<NotificationConfigService>(NotificationConfigService);
    configService = module.get(ConfigService);
  });

  describe('getAllChannels', () => {
    it('should return all 4 default channels', () => {
      const channels = service.getAllChannels();
      expect(channels).toHaveLength(4);
      const keys = channels.map((c) => c.key);
      expect(keys).toContain('email');
      expect(keys).toContain('slack');
      expect(keys).toContain('dingtalk');
      expect(keys).toContain('wecom');
    });

    it('should have all channels disabled by default', () => {
      const channels = service.getAllChannels();
      channels.forEach((c) => expect(c.enabled).toBe(false));
    });
  });

  describe('getChannel', () => {
    it('should return the channel for a known key', () => {
      const ch = service.getChannel('email');
      expect(ch).toBeDefined();
      expect(ch!.key).toBe('email');
    });

    it('should return undefined for unknown key', () => {
      expect(service.getChannel('unknown')).toBeUndefined();
    });
  });

  describe('updateChannel', () => {
    it('should enable a channel', () => {
      service.updateChannel('slack', { enabled: true });
      expect(service.getChannel('slack')!.enabled).toBe(true);
    });

    it('should merge config fields', () => {
      service.updateChannel('dingtalk', {
        config: { webhookUrl: 'https://oapi.dingtalk.com/robot/xxx' },
      });
      expect(service.getChannel('dingtalk')!.config.webhookUrl).toBe(
        'https://oapi.dingtalk.com/robot/xxx',
      );
    });

    it('should throw for unknown channel key', () => {
      expect(() =>
        service.updateChannel('telegram', { enabled: true }),
      ).toThrow('Unknown notification channel: telegram');
    });
  });

  describe('testChannel', () => {
    it('should return success when sendAll resolves', async () => {
      (notificationService.sendAll as jest.Mock).mockResolvedValue(undefined);
      const result = await service.testChannel({});
      expect(result.success).toBe(true);
      expect(result.message).toBe('测试消息发送成功');
    });

    it('should return failure when sendAll rejects', async () => {
      (notificationService.sendAll as jest.Mock).mockRejectedValue(
        new Error('SMTP connection failed'),
      );
      const result = await service.testChannel({});
      expect(result.success).toBe(false);
      expect(result.message).toContain('SMTP connection failed');
    });
  });

  describe('sendTest', () => {
    it('should skip disabled channels and succeed', async () => {
      // all channels disabled by default
      const result = await service.sendTest({
        channels: ['email', 'slack'],
        title: 'Test',
        content: 'hello',
      });
      expect(result.success).toBe(true);
      // notificationService methods not called since channels disabled
    });

    it('should call the correct channel method when enabled', async () => {
      service.updateChannel('slack', { enabled: true });
      const mockSlackSend = jest.fn().mockResolvedValue(undefined);
      (notificationService as any)['slack'] = { send: mockSlackSend };

      const result = await service.sendTest({
        channels: ['slack'],
        title: 'Alert',
        content: 'Task failed',
      });
      expect(result.success).toBe(true);
      expect(mockSlackSend).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Alert', content: 'Task failed' }),
      );
    });

    it('should return failure when channel send throws', async () => {
      service.updateChannel('wecom', { enabled: true });
      const mockWecomSend = jest.fn().mockRejectedValue(new Error('webhook error'));
      (notificationService as any)['wecom'] = { send: mockWecomSend };

      const result = await service.sendTest({
        channels: ['wecom'],
        title: 'Test',
        content: 'content',
      });
      expect(result.success).toBe(false);
      expect(result.message).toContain('webhook error');
    });
  });
});
