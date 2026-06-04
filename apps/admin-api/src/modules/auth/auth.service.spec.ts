import { Test } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import * as bcrypt from 'bcrypt';

const mockUser = { id: 1, username: 'admin', password: 'hashed', isActive: true };

describe('AuthService', () => {
  let service: AuthService;
  let usersService: jest.Mocked<Pick<UsersService, 'findByUsername' | 'findById'>>;
  let jwtService: jest.Mocked<Pick<JwtService, 'sign' | 'verify'>>;
  let configService: jest.Mocked<Pick<ConfigService, 'get'>>;

  beforeEach(async () => {
    usersService = { findByUsername: jest.fn(), findById: jest.fn() };
    jwtService = { sign: jest.fn().mockReturnValue('token'), verify: jest.fn() };
    configService = { get: jest.fn().mockReturnValue('secret') };

    const module = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: usersService },
        { provide: JwtService, useValue: jwtService },
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();
    service = module.get(AuthService);
  });

  describe('login', () => {
    it('returns tokens on valid credentials', async () => {
      usersService.findByUsername.mockResolvedValue(mockUser as any);
      jest.spyOn(bcrypt, 'compare').mockResolvedValue(true as never);
      const result = await service.login({ username: 'admin', password: 'pass' });
      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('refreshToken');
    });

    it('throws UnauthorizedException when user not found', async () => {
      usersService.findByUsername.mockResolvedValue(null);
      await expect(service.login({ username: 'x', password: 'y' })).rejects.toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException on wrong password', async () => {
      usersService.findByUsername.mockResolvedValue(mockUser as any);
      jest.spyOn(bcrypt, 'compare').mockResolvedValue(false as never);
      await expect(service.login({ username: 'admin', password: 'wrong' })).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('refreshToken', () => {
    it('returns new tokens for valid refresh token', async () => {
      jwtService.verify.mockReturnValue({ sub: 1, username: 'admin', type: 'refresh' } as any);
      usersService.findById.mockResolvedValue({ ...mockUser } as any);
      const result = await service.refreshToken('valid-token');
      expect(result).toHaveProperty('accessToken');
    });

    it('throws if token type is not refresh', async () => {
      jwtService.verify.mockReturnValue({ sub: 1, username: 'admin', type: 'access' } as any);
      await expect(service.refreshToken('bad')).rejects.toThrow(UnauthorizedException);
    });

    it('throws if user is inactive', async () => {
      jwtService.verify.mockReturnValue({ sub: 1, username: 'admin', type: 'refresh' } as any);
      usersService.findById.mockResolvedValue({ ...mockUser, isActive: false } as any);
      await expect(service.refreshToken('token')).rejects.toThrow(UnauthorizedException);
    });
  });
});
