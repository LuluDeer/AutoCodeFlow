import { Test, TestingModule } from '@nestjs/testing';
import { AuditController } from '../audit.controller';
import { AuditService } from '../audit.service';

const mockAuditService = () => ({
  findAll: jest.fn(),
  exportCsv: jest.fn(),
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

      const result = await controller.findAll({
        page: 1,
        pageSize: 20,
      } as any);

      expect(svc.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ page: 1, pageSize: 20 }),
      );
      expect(result).toEqual(expected);
    });

    it('passes action filter to service', async () => {
      svc.findAll.mockResolvedValue({ data: [], total: 0 });
      await controller.findAll({ page: 1, pageSize: 10, action: 'auth.login' } as any);
      expect(svc.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'auth.login' }),
      );
    });

    it('passes resource filter to service', async () => {
      svc.findAll.mockResolvedValue({ data: [], total: 0 });
      await controller.findAll({ page: 1, pageSize: 10, resource: 'task' } as any);
      expect(svc.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ resource: 'task' }),
      );
    });

    it('passes userId filter to service', async () => {
      svc.findAll.mockResolvedValue({ data: [], total: 0 });
      await controller.findAll({ page: 1, pageSize: 10, userId: 42 } as any);
      expect(svc.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 42 }),
      );
    });

    it('passes username and time-range filters to service', async () => {
      svc.findAll.mockResolvedValue({ data: [], total: 0 });
      await controller.findAll({
        page: 1,
        pageSize: 10,
        username: 'admin',
        startTime: '2026-01-01T00:00:00.000Z',
        endTime: '2026-01-31T23:59:59.000Z',
      } as any);
      expect(svc.findAll).toHaveBeenCalledWith(
        expect.objectContaining({
          username: 'admin',
          startTime: '2026-01-01T00:00:00.000Z',
          endTime: '2026-01-31T23:59:59.000Z',
        }),
      );
    });

    it('returns empty result when no logs match', async () => {
      svc.findAll.mockResolvedValue({ data: [], total: 0 });
      const result = await controller.findAll({
        page: 5,
        pageSize: 20,
        action: 'nonexistent',
      } as any);
      expect(result).toEqual({ data: [], total: 0 });
    });
  });

  describe('exportCsv', () => {
    it('sends CSV with the same filter set as the list endpoint', async () => {
      svc.exportCsv.mockResolvedValue('id,action\n1,auth.login');
      const res = {
        setHeader: jest.fn(),
        send: jest.fn(),
      } as any;

      await controller.exportCsv(
        {
          action: 'auth.login',
          username: 'admin',
          startTime: '2026-01-01T00:00:00.000Z',
          endTime: '2026-01-31T23:59:59.000Z',
        } as any,
        res,
      );

      expect(svc.exportCsv).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'auth.login',
          username: 'admin',
          startTime: '2026-01-01T00:00:00.000Z',
          endTime: '2026-01-31T23:59:59.000Z',
        }),
      );
      expect(res.setHeader).toHaveBeenCalledWith(
        'Content-Type',
        'text/csv; charset=utf-8',
      );
      expect(res.send).toHaveBeenCalledWith('id,action\n1,auth.login');
    });
  });
});
