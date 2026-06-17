import { Test, TestingModule } from '@nestjs/testing';
import { AuditController } from '../audit.controller';
import { AuditService } from '../audit.service';

const mockAuditService = () => ({
  findAll: jest.fn(),
});

describe('AuditController', () => {
  let controller: AuditController;
  let svc: ReturnType<typeof mockAuditService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuditController],
      providers: [{ provide: AuditService, useFactory: mockAuditService }],
    }).compile();

    controller = module.get(AuditController);
    svc = module.get(AuditService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('findAll', () => {
    it('returns paginated audit logs', async () => {
      const expected = { data: [{ id: 1, action: 'auth.login' }], total: 1 };
      svc.findAll.mockResolvedValue(expected);

      const result = await controller.findAll(
        { page: 1, pageSize: 20 } as any,
        undefined,
        undefined,
      );

      expect(svc.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ page: 1, pageSize: 20 }),
      );
      expect(result).toEqual(expected);
    });

    it('passes action filter to service', async () => {
      svc.findAll.mockResolvedValue({ data: [], total: 0 });
      await controller.findAll({ page: 1, pageSize: 10 } as any, 'auth.login', undefined);
      expect(svc.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'auth.login' }),
      );
    });

    it('passes resource filter to service', async () => {
      svc.findAll.mockResolvedValue({ data: [], total: 0 });
      await controller.findAll({ page: 1, pageSize: 10 } as any, undefined, 'task');
      expect(svc.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ resource: 'task' }),
      );
    });

    it('passes userId filter to service', async () => {
      svc.findAll.mockResolvedValue({ data: [], total: 0 });
      await controller.findAll({ page: 1, pageSize: 10 } as any, undefined, undefined, 42);
      expect(svc.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 42 }),
      );
    });

    it('returns empty result when no logs match', async () => {
      svc.findAll.mockResolvedValue({ data: [], total: 0 });
      const result = await controller.findAll(
        { page: 5, pageSize: 20 } as any,
        'nonexistent',
        undefined,
      );
      expect(result).toEqual({ data: [], total: 0 });
    });
  });
});
