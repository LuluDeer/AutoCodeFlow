import { Test } from '@nestjs/testing';
import { NotificationService } from './notification.service';
import { WecomChannel } from './channels/wecom.channel';
import { DingtalkChannel } from './channels/dingtalk.channel';
import { EmailChannel } from './channels/email.channel';
import { SlackChannel } from './channels/slack.channel';

const mockChannel = () => ({ send: jest.fn() });

describe('NotificationService', () => {
  let service: NotificationService;
  let email: { send: jest.Mock };
  let slack: { send: jest.Mock };
  let wecom: { send: jest.Mock };
  let dingtalk: { send: jest.Mock };

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        NotificationService,
        { provide: WecomChannel, useFactory: mockChannel },
        { provide: DingtalkChannel, useFactory: mockChannel },
        { provide: EmailChannel, useFactory: mockChannel },
        { provide: SlackChannel, useFactory: mockChannel },
      ],
    }).compile();

    service = module.get(NotificationService);
    email = module.get(EmailChannel);
    slack = module.get(SlackChannel);
    wecom = module.get(WecomChannel);
    dingtalk = module.get(DingtalkChannel);
  });

  describe('notifyFailureWithConfig', () => {
    it('should only call configured channels', async () => {
      email.send.mockResolvedValue(undefined);
      slack.send.mockResolvedValue(undefined);

      await service.notifyFailureWithConfig('task', 'exec-1', 'err', '', undefined, ['email', 'slack']);
      expect(email.send).toHaveBeenCalledTimes(1);
      expect(slack.send).toHaveBeenCalledTimes(1);
      expect(wecom.send).not.toHaveBeenCalled();
      expect(dingtalk.send).not.toHaveBeenCalled();
    });

    it('should throw when a channel fails', async () => {
      email.send.mockRejectedValue(new Error('smtp error'));

      await expect(
        service.notifyFailureWithConfig('task', 'exec-1', 'err', '', undefined, ['email'])
      ).rejects.toThrow('smtp error');
    });

    it('should fall back to sendAll when no channels configured', async () => {
      wecom.send.mockResolvedValue(undefined);
      dingtalk.send.mockResolvedValue(undefined);
      email.send.mockResolvedValue(undefined);
      slack.send.mockResolvedValue(undefined);

      await expect(
        service.notifyFailureWithConfig('task', 'exec-1', 'err', '', undefined, [])
      ).resolves.toBeUndefined();
      expect(wecom.send).toHaveBeenCalledTimes(1);
    });
  });
});
