import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, BadRequestException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { UsersController } from '../users.controller';
import { UsersService } from '../users.service';
import { AuditService } from '../../audit/audit.service';
import { UserRole } from '../entities/user.entity';
import { AuthUser } from '../../../common/interfaces/auth-user.interface';

const mockUsersService = () => ({
  create: jest.fn(),
  findAll: jest.fn(),
  findById: jest.fn(),
  findByIdOrNull: jest.fn(),
  findByIdRaw: jest.fn(),
  update: jest.fn(),
  remove: jest.fn(),
  recordLoginFailure: jest.fn(),
  resetLoginFailure: jest.fn(),
});

const mockAuditService = () => ({
  log: jest.fn().mockResolvedValue(undefined),
});

const adminUser: AuthUser = { id: 1, username: 'admin', role: UserRole.ADMIN } as AuthUser;
const normalUser: AuthUser = { id: 2, username: 'bob', role: UserRole.USER } as AuthUser;
const mockReq = { ip: '127.0.0.1' } as any;

describe('UsersController', () => {
  let controller: UsersController;
  let usersSvc: ReturnType<typeof mockUsersService>;
  let auditSvc: ReturnType<typeof mockAuditService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        { provide: UsersService, useFactory: mockUsersService },
        { provide: AuditService, useFactory: mockAuditService },
      ],
    }).compile();

    controller = module.get(UsersController);
    usersSvc = module.get(UsersService);
    auditSvc = module.get(AuditService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('create', () => {
    it('should create user and log audit', async () => {
      const dto = { username: 'newuser', password: 'pass', role: UserRole.USER } as any;
      const created = { id: 10, username: 'newuser' };
      usersSvc.create.mockResolvedValue(created);

      const result = await controller.create(dto, adminUser, mockReq);

      expect(usersSvc.create).toHaveBeenCalledWith(dto);
      expect(auditSvc.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'user.create', resource: 'user', resourceId: '10' }),
      );
      expect(result).toEqual(created);
    });
  });

  describe('findAll', () => {
    it('should delegate to usersService.findAll', () => {
      const pagination = { page: 1, pageSize: 10 } as any;
      usersSvc.findAll.mockResolvedValue({ data: [], total: 0 });
      controller.findAll(pagination);
      expect(usersSvc.findAll).toHaveBeenCalledWith(pagination);
    });
  });

  describe('findOne', () => {
    it('admin can fetch any user by id', async () => {
      usersSvc.findByIdOrNull.mockResolvedValue({ id: 5 } as any);
      await controller.findOne(5, adminUser);
      expect(usersSvc.findByIdOrNull).toHaveBeenCalledWith(5);
    });
    it('non-admin can fetch their own profile', async () => {
      usersSvc.findByIdOrNull.mockResolvedValue({ id: 1 } as any);
      const self = { id: 1, role: 'viewer' };
      await controller.findOne(1, self as any);
      expect(usersSvc.findByIdOrNull).toHaveBeenCalledWith(1);
    });
    it('non-admin cannot fetch another user', async () => {
      const self = { id: 1, role: 'viewer' };
      await expect(
        controller.findOne(5, self as any),
      ).rejects.toThrow();
    });
    it('returns ForbiddenException when user is missing (H-3)', async () => {
      usersSvc.findByIdOrNull.mockResolvedValue(null);
      await expect(
        controller.findOne(5, adminUser),
      ).rejects.toThrow();
    });
  });

  describe('update', () => {
    it('admin can update any user', async () => {
      usersSvc.update.mockResolvedValue({ id: 99 });
      await controller.update(99, { username: 'x' } as any, adminUser, mockReq);
      expect(usersSvc.update).toHaveBeenCalledWith(99, expect.any(Object));
      expect(auditSvc.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'user.update', resourceId: '99' }),
      );
    });

    it('non-admin can update own account', async () => {
      usersSvc.update.mockResolvedValue({ id: 2 });
      await controller.update(2, { username: 'new' } as any, normalUser, mockReq);
      expect(usersSvc.update).toHaveBeenCalled();
    });

    it('non-admin cannot update another user', async () => {
      await expect(
        controller.update(99, { username: 'x' } as any, normalUser, mockReq),
      ).rejects.toThrow(ForbiddenException);
      expect(usersSvc.update).not.toHaveBeenCalled();
    });

    it('non-admin cannot change own role', async () => {
      await expect(
        controller.update(2, { role: UserRole.ADMIN } as any, normalUser, mockReq),
      ).rejects.toThrow(ForbiddenException);
    });

    it('non-admin must supply currentPassword when changing password', async () => {
      await expect(
        controller.update(2, { password: 'newpass' } as any, normalUser, mockReq),
      ).rejects.toThrow(BadRequestException);
    });

    it('non-admin rejected when currentPassword is wrong', async () => {
      const rawUser = { id: 2, password: await bcrypt.hash('correct', 10) };
      usersSvc.findByIdRaw.mockResolvedValue(rawUser);
      await expect(
        controller.update(2, { password: 'newpass', currentPassword: 'wrong' } as any, normalUser, mockReq),
      ).rejects.toThrow(BadRequestException);
    });

    it('non-admin succeeds when currentPassword matches', async () => {
      const rawUser = { id: 2, password: await bcrypt.hash('correct', 10) };
      usersSvc.findByIdRaw.mockResolvedValue(rawUser);
      usersSvc.update.mockResolvedValue({ id: 2 });
      await controller.update(
        2,
        { password: 'newpass', currentPassword: 'correct' } as any,
        normalUser,
        mockReq,
      );
      expect(usersSvc.update).toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('admin can delete user and log audit', async () => {
      usersSvc.remove.mockResolvedValue(undefined);
      await controller.remove(5, adminUser, mockReq);
      expect(usersSvc.remove).toHaveBeenCalledWith(5);
      expect(auditSvc.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'user.delete', resourceId: '5' }),
      );
    });
  });
});
