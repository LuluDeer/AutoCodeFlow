import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { User } from './entities/user.entity';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { PaginationDto, paginate } from '../../common/dto/pagination.dto';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
  ) {}

  async create(createUserDto: CreateUserDto) {
    const existing = await this.usersRepository.findOne({
      where: [{ username: createUserDto.username }, { email: createUserDto.email }],
    });
    if (existing) throw new ConflictException('Username or email already exists');
    const hashed = await bcrypt.hash(createUserDto.password, 10);
    const user = this.usersRepository.create({ ...createUserDto, password: hashed });
    return this.usersRepository.save(user);
  }

  async findAll(pagination: PaginationDto) {
    const { page, pageSize } = pagination;
    const [list, total] = await this.usersRepository.findAndCount({
      skip: (page - 1) * pageSize,
      take: pageSize,
      order: { createdAt: 'DESC' },
    });
    return paginate(list, total, page, pageSize);
  }

  async findById(id: number) {
    const user = await this.usersRepository.findOne({ where: { id } });
    if (!user) throw new NotFoundException(`User #${id} not found`);
    return user;
  }

  // S12: expose raw user (including hashed password) for current-password verification
  async findByIdRaw(id: number): Promise<import('./entities/user.entity').User | null> {
    return this.usersRepository.findOne({ where: { id } });
  }

  async findByUsername(username: string) {
    return this.usersRepository.findOne({ where: { username } });
  }

  async update(id: number, updateUserDto: UpdateUserDto) {
    const user = await this.findById(id);
    if (updateUserDto.password) {
      updateUserDto.password = await bcrypt.hash(updateUserDto.password, 10);
    }
    Object.assign(user, updateUserDto);
    return this.usersRepository.save(user);
  }

  async remove(id: number) {
    const user = await this.findById(id);
    await this.usersRepository.remove(user);
    return { deleted: true };
  }

  /**
   * SEC-05: Increment loginFailCount; lock the account when threshold is reached.
   */
  async recordLoginFailure(
    userId: number,
    opts: { maxFail: number; lockMinutes: number },
  ): Promise<void> {
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user) return;
    user.loginFailCount += 1;
    if (user.loginFailCount >= opts.maxFail) {
      user.lockedUntil = new Date(
        Date.now() + opts.lockMinutes * 60_000,
      );
    }
    await this.usersRepository.save(user);
  }

  /** SEC-05: Reset failure counter and lock on successful login. */
  async resetLoginFailure(userId: number): Promise<void> {
    await this.usersRepository.update(userId, {
      loginFailCount: 0,
      lockedUntil: undefined as any,
    });
  }
}
