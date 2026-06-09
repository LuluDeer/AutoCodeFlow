import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ApplicationService } from './application.service';
import { Application, ApplicationStatus } from './entities/application.entity';
import { ModuleRef } from '@nestjs/core';

const makeRepo = (overrides: Partial<Record<string, jest.Mock>> = {}) => ({
  findOne: jest.fn(),
  find: jest.fn(),
  create: jest.fn((d: any) => d),
  save: jest.fn((e: any) => Promise.resolve(e)),
  remove: jest.fn(),
  delete: jest.fn().mockResolvedValue({ affected: 0 }),
  ...overrides,
});

describe('ApplicationService', () => {
  let service: ApplicationService;
  let appRepo: ReturnType<typeof makeRepo>;

  beforeEach(async () => {
    appRepo = makeRepo({ findOne: jest.fn() });
    const module = await Test.createTestingModule({
      providers: [
        ApplicationService,
        { provide: getRepositoryToken(Application), useValue: appRepo },
        { provide: ModuleRef, useValue: { get: jest.fn() } },
      ],
    }).compile();
    service = module.get(ApplicationService);
  });

  describe('findAll', () => {
    it('should return applications ordered by createdAt DESC', async () => {
      const apps = [{ id: '1', name: 'app1' }];
      appRepo.find.mockResolvedValue(apps);
      const result = await service.findAll();
      expect(result).toEqual(apps);
      expect(appRepo.find).toHaveBeenCalledWith({ order: { createdAt: 'DESC' } });
    });
  });

  describe('findById', () => {
    it('should return an application when found', async () => {
      const app = { id: '1', name: 'app1' };
      appRepo.findOne.mockResolvedValue(app);
      const result = await service.findById('1');
      expect(result).toEqual(app);
    });

    it('should throw NotFoundException when not found', async () => {
      appRepo.findOne.mockResolvedValue(null);
      await expect(service.findById('nonexistent')).rejects.toThrow('not found');
    });
  });

  describe('create', () => {
    it('should create an application successfully', async () => {
      appRepo.findOne.mockResolvedValue(null);
      appRepo.save.mockResolvedValue({ id: '1', name: 'test-app', status: ApplicationStatus.ACTIVE });

      const result = await service.create({
        name: 'test-app',
        version: '1.0.0',
        runtime: 'node',
      });

      expect(result.name).toBe('test-app');
      expect(result.status).toBe(ApplicationStatus.ACTIVE);
    });

    it('should throw ConflictException when name already exists', async () => {
      appRepo.findOne.mockResolvedValue({ id: '1', name: 'test-app' });
      await expect(
        service.create({ name: 'test-app', version: '1.0.0', runtime: 'node' }),
      ).rejects.toThrow('already exists');
    });
  });

  describe('update', () => {
    it('should update an application', async () => {
      const app = { id: '1', name: 'app1', description: '' };
      appRepo.findOne.mockResolvedValue(app);
      appRepo.save.mockResolvedValue({ ...app, description: 'updated' });

      const result = await service.update('1', { description: 'updated' });
      expect(result.description).toBe('updated');
    });
  });

  describe('remove', () => {
    it('should remove an application', async () => {
      const app = { id: '1', name: 'app1' };
      appRepo.findOne.mockResolvedValue(app);
      appRepo.remove.mockResolvedValue(undefined);

      await service.remove('1');
      expect(appRepo.remove).toHaveBeenCalledWith(app);
    });
  });
});