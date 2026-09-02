import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { NotificationConfigService } from '../notification-config.service';
import { NotificationService } from '../notification.service';

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
      expect(result.message).toBe('Test message sent successfully');
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

  // N11: the read surface must never leak SMTP credentials — password-type
  // config fields are masked to '***', and the sentinel must not overwrite
  // the stored secret when admin-web echoes it back through PATCH.
  describe('secret masking (N11)', () => {
    const buildService = async () => {
      const env: Record<string, unknown> = {
        'notification.email.enabled': true,
        'notification.email.host': 'smtp.example.com',
        'notification.email.user': 'bot@example.com',
        'notification.email.password': 's3cret-smtp',
        'notification.slack.enabled': true,
        'notification.slack.webhookUrl': 'https://hooks.slack.com/services/T/B/X',
      };
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          NotificationConfigService,
          {
            provide: ConfigService,
            useValue: { get: jest.fn((key: string) => env[key]) },
          },
          { provide: NotificationService, useValue: { sendAll: jest.fn() } },
        ],
      }).compile();
      return module.get(NotificationConfigService);
    };

    it('getAllChannels masks email password but keeps non-secret fields', async () => {
      const svc = await buildService();
      const email = svc.getAllChannels().find((c) => c.key === 'email')!;
      expect(email.config.password).toBe('***');
      expect(email.config.host).toBe('smtp.example.com');
      // slack webhookUrl is not a password-class field — left intact
      const slack = svc.getAllChannels().find((c) => c.key === 'slack')!;
      expect(slack.config.webhookUrl).toBe('https://hooks.slack.com/services/T/B/X');
    });

    it('getChannel and updateChannel responses are masked too', async () => {
      const svc = await buildService();
      expect(svc.getChannel('email')!.config.password).toBe('***');
      const updated = svc.updateChannel('email', {
        config: { password: 'new-secret', host: 'smtp2.example.com' },
      });
      expect(updated.config.password).toBe('***');
      expect(updated.config.host).toBe('smtp2.example.com');
    });

    it('a "***" round-trip from the client does not overwrite the stored secret', async () => {
      const svc = await buildService();
      svc.updateChannel('email', {
        config: { password: '***', host: 'smtp.example.com' },
      });
      const stored = (svc as any).channelConfigs.get('email').config;
      expect(stored.password).toBe('s3cret-smtp');
    });

    it('a real new password is persisted', async () => {
      const svc = await buildService();
      svc.updateChannel('email', { config: { password: 'rotated' } });
      const stored = (svc as any).channelConfigs.get('email').config;
      expect(stored.password).toBe('rotated');
    });
  });
});
