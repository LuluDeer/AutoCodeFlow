import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExecutorPackageService } from '../executor-package.service';
import {
  ExecutorPackage,
  ExecutorPackageStatus,
} from '../executor-package.entity';
import * as fs from 'fs';
import * as crypto from 'crypto';

jest.mock('fs');
const mockFs = fs as jest.Mocked<typeof fs>;

describe('ExecutorPackageService', () => {
  let service: ExecutorPackageService;
  let repo: jest.Mocked<Repository<ExecutorPackage>>;

  const mockFile: Express.Multer.File = {
    // P1: buffer must start with the zip magic bytes (PK\x03\x04) to pass
    // the upload content validation.
    buffer: Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from('fake-zip-content'),
    ]),
    originalname: 'executor-v1.0.0.zip',
    mimetype: 'application/zip',
    size: 1024,
    fieldname: 'file',
    encoding: '7bit',
    destination: '',
    filename: '',
    path: '',
    stream: null as any,
  };

  const mockPkg: ExecutorPackage = {
    id: 'pkg-001',
    name: 'my-executor',
    version: '1.0.0',
    type: 'node',
    platform: 'linux',
    description: 'test',
    filename: 'my-executor-1.0.0-abcd1234.zip',
    filePath: '/uploads/executor-packages/my-executor-1.0.0-abcd1234.zip',
    originalFilename: 'executor-v1.0.0.zip',
    mimeType: 'application/zip',
    fileSize: 1024,
    checksum: 'abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234',
    status: ExecutorPackageStatus.ACTIVE,
    uploadedBy: 'admin',
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
  } as any;

  beforeEach(async () => {
    mockFs.existsSync = jest.fn().mockReturnValue(true);
    mockFs.mkdirSync = jest.fn();
    mockFs.writeFileSync = jest.fn();
    mockFs.unlinkSync = jest.fn();
    mockFs.readFileSync = jest.fn().mockReturnValue(Buffer.from('content'));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExecutorPackageService,
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue('/uploads/executor-packages') } },
        {
          provide: getRepositoryToken(ExecutorPackage),
          useValue: {
            findOne: jest.fn(),
            findAndCount: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
            remove: jest.fn(),
            createQueryBuilder: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<ExecutorPackageService>(ExecutorPackageService);
    repo = module.get(getRepositoryToken(ExecutorPackage));
  });

  afterEach(() => jest.clearAllMocks());

  describe('create', () => {
    it('should throw BadRequestException when no file is provided', async () => {
      await expect(
        service.create({ name: 'x', version: '1.0', type: 'node' } as any, null as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw ConflictException when package already exists', async () => {
      repo.findOne.mockResolvedValue(mockPkg);
      await expect(
        service.create(
          { name: 'my-executor', version: '1.0.0', type: 'node' } as any,
          mockFile,
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('should create and save a new package', async () => {
      repo.findOne.mockResolvedValue(null);
      repo.create.mockReturnValue(mockPkg);
      repo.save.mockResolvedValue(mockPkg);

      const result = await service.create(
        { name: 'my-executor', version: '1.0.0', type: 'node' } as any,
        mockFile,
        'admin',
      );

      expect(result).toEqual(mockPkg);
      expect(mockFs.writeFileSync).toHaveBeenCalled();
      expect(repo.save).toHaveBeenCalled();
    });
  });

  describe('findAll', () => {
    it('should return items and total', async () => {
      repo.findAndCount.mockResolvedValue([[mockPkg], 1]);
      const result = await service.findAll({ page: 1, pageSize: 20 } as any);
      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(1);
    });
  });

  describe('findOne', () => {
    it('should return package when found', async () => {
      repo.findOne.mockResolvedValue(mockPkg);
      const result = await service.findOne('pkg-001');
      expect(result).toEqual(mockPkg);
    });

    it('should throw NotFoundException when not found', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.findOne('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('update', () => {
    it('should update and return the package', async () => {
      repo.findOne.mockResolvedValue(mockPkg);
      repo.save.mockResolvedValue({ ...mockPkg, description: 'updated' });
      const result = await service.update('pkg-001', { description: 'updated' } as any);
      expect(result.description).toBe('updated');
    });

    it('should throw ConflictException on duplicate name/version', async () => {
      const otherPkg = { ...mockPkg, id: 'pkg-002' };
      repo.findOne
        .mockResolvedValueOnce(mockPkg) // findOne for findOne(id)
        .mockResolvedValueOnce(otherPkg); // conflict check
      await expect(
        service.update('pkg-001', { name: 'my-executor', version: '1.0.0', type: 'node' } as any),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('remove', () => {
    it('should delete file from disk and remove from db', async () => {
      repo.findOne.mockResolvedValue(mockPkg);
      repo.remove.mockResolvedValue(mockPkg);

      await service.remove('pkg-001');

      expect(mockFs.unlinkSync).toHaveBeenCalledWith(mockPkg.filePath);
      expect(repo.remove).toHaveBeenCalledWith(mockPkg);
    });

    it('should still remove from db even if file does not exist on disk', async () => {
      mockFs.existsSync = jest.fn().mockReturnValue(false);
      repo.findOne.mockResolvedValue(mockPkg);
      repo.remove.mockResolvedValue(mockPkg);

      await service.remove('pkg-001');

      expect(mockFs.unlinkSync).not.toHaveBeenCalled();
      expect(repo.remove).toHaveBeenCalled();
    });
  });

  describe('getFileBuffer', () => {
    it('should return buffer and pkg when file exists', async () => {
      repo.findOne.mockResolvedValue(mockPkg);
      const result = await service.getFileBuffer('pkg-001');
      expect(result.pkg).toEqual(mockPkg);
      expect(Buffer.isBuffer(result.buffer)).toBe(true);
    });

    it('should throw NotFoundException when file not on disk', async () => {
      mockFs.existsSync = jest.fn().mockReturnValue(false);
      repo.findOne.mockResolvedValue(mockPkg);
      await expect(service.getFileBuffer('pkg-001')).rejects.toThrow(NotFoundException);
    });
  });

  describe('deprecate / activate', () => {
    it('should set status to DEPRECATED', async () => {
      const deprecated = { ...mockPkg, status: ExecutorPackageStatus.DEPRECATED };
      repo.findOne.mockResolvedValue(mockPkg);
      repo.save.mockResolvedValue(deprecated);
      const result = await service.deprecate('pkg-001');
      expect(result.status).toBe(ExecutorPackageStatus.DEPRECATED);
    });

    it('should set status to ACTIVE', async () => {
      const active = { ...mockPkg, status: ExecutorPackageStatus.ACTIVE };
      repo.findOne.mockResolvedValue({ ...mockPkg, status: ExecutorPackageStatus.DEPRECATED });
      repo.save.mockResolvedValue(active);
      const result = await service.activate('pkg-001');
      expect(result.status).toBe(ExecutorPackageStatus.ACTIVE);
    });
  });
});
