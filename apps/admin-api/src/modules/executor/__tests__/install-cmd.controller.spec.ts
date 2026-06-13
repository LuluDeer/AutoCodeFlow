import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { InstallCmdController } from '../install-cmd.controller';

const mockConfig: Record<string, any> = {
  'executor.sharedToken': 'test-secret',
  'app.corsOrigins': 'http://admin.example.com',
  'app.port': 3105,
};

const makeModule = async (overrides: Record<string, any> = {}) => {
  const cfg = { ...mockConfig, ...overrides };
  const module: TestingModule = await Test.createTestingModule({
    controllers: [InstallCmdController],
    providers: [{
      provide: ConfigService,
      useValue: { get: (key: string) => cfg[key] },
    }],
  }).compile();
  return module.get(InstallCmdController);
};

describe('InstallCmdController', () => {
  let controller: InstallCmdController;

  beforeEach(async () => {
    controller = await makeModule();
  });

  describe('getInstallCmd', () => {
    it('returns cmd and curlCmd with required flags', () => {
      const result = controller.getInstallCmd();
      expect(result.cmd).toContain('--api-url');
      expect(result.cmd).toContain('--secret');
      expect(result.curlCmd).toContain('curl -fsSL');
      expect(result.curlCmd).toContain('--api-url');
    });

    it('includes optional name and port when provided', () => {
      const result = controller.getInstallCmd('my-executor', '9000');
      expect(result.cmd).toContain("--name 'my-executor'");
      expect(result.cmd).toContain("--port '9000'");
    });

    it('includes runtime when provided', () => {
      const result = controller.getInstallCmd(undefined, undefined, 'python');
      expect(result.cmd).toContain("--runtime 'python'");
    });

    it('uses admin URL derived from corsOrigins', () => {
      const result = controller.getInstallCmd();
      expect(result.cmd).toContain('http://admin.example.com');
    });

    it('falls back to localhost when corsOrigins is empty', async () => {
      const ctrl = await makeModule({ 'app.corsOrigins': '', 'executor.sharedToken': 'tok' });
      const result = ctrl.getInstallCmd();
      expect(result.cmd).toContain('http://localhost:3105');
    });

    it('uses executor.secret as fallback when sharedToken is absent', async () => {
      const ctrl = await makeModule({
        'executor.sharedToken': undefined,
        'executor.secret': 'fallback-secret',
      });
      const result = ctrl.getInstallCmd();
      expect(result.cmd).toContain("--secret 'fallback-secret'");
    });

    it('shell-quotes values containing single quotes to prevent injection', () => {
      const result = controller.getInstallCmd("it's-mine");
      // Single quote inside the name must be escaped as '\'' in the output
      expect(result.cmd).toContain("'it'\\''s-mine'");
    });

    it('curlCmd references the scriptUrl from adminUrl', () => {
      const result = controller.getInstallCmd();
      expect(result.curlCmd).toContain('http://admin.example.com/static/install.sh');
    });
  });
});
