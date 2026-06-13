import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  Logger,
  OnModuleInit,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import * as bcrypt from "bcrypt";
import { User, UserRole } from "./entities/user.entity";
import { CreateUserDto } from "./dto/create-user.dto";
import { UpdateUserDto } from "./dto/update-user.dto";
import { PaginationDto, paginate } from "../../common/dto/pagination.dto";

@Injectable()
export class UsersService implements OnModuleInit {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
  ) {}

  /**
   * Bootstrap: seed the initial admin user from INITIAL_ADMIN_PASSWORD env var
   * if no users exist in the database yet.
   */
  async onModuleInit() {
    const count = await this.usersRepository.count();
    if (count > 0) return;

    const password = process.env.INITIAL_ADMIN_PASSWORD;
    const email = process.env.INITIAL_ADMIN_EMAIL ?? 'admin@autoflow.local';
    if (!password) {
      this.logger.warn('INITIAL_ADMIN_PASSWORD not set — skipping admin seed');
      return;
    }

    const hashed = await bcrypt.hash(password, 12);
    const admin = this.usersRepository.create({
      username: 'admin',
      email,
      password: hashed,
      role: UserRole.ADMIN,
      isActive: true,
    });
    await this.usersRepository.save(admin);
    this.logger.log(`Initial admin user created (username: admin, email: ${email})`);
  }

  /**
   * SEC: validate password meets minimum strength requirements.
   * At least 8 chars, one uppercase, one digit, one special character.
   */
  private validatePasswordStrength(password: string): void {
    if (!password || password.length < 8) {
      throw new BadRequestException('Password must be at least 8 characters');
    }
    if (!/[A-Z]/.test(password)) {
      throw new BadRequestException('Password must contain at least one uppercase letter');
    }
    if (!/[0-9]/.test(password)) {
      throw new BadRequestException('Password must contain at least one digit');
    }
    if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
      throw new BadRequestException('Password must contain at least one special character');
    }
  }

  async create(createUserDto: CreateUserDto) {
    this.validatePasswordStrength(createUserDto.password);
    const existing = await this.usersRepository.findOne({
      where: [
        { username: createUserDto.username },
        { email: createUserDto.email },
      ],
    });
    if (existing)
      throw new ConflictException("Username or email already exists");
    const hashed = await bcrypt.hash(createUserDto.password, 12);
    const user = this.usersRepository.create({
      ...createUserDto,
      password: hashed,
    });
    return this.usersRepository.save(user);
  }

  async findAll(pagination: PaginationDto) {
    const { page, pageSize } = pagination;
    const [list, total] = await this.usersRepository.findAndCount({
      skip: (page - 1) * pageSize,
      take: pageSize,
      order: { createdAt: "DESC" },
    });
    return paginate(list, total, page, pageSize);
  }

  async findById(id: number) {
    const user = await this.usersRepository.findOne({ where: { id } });
    if (!user) throw new NotFoundException(`User #${id} not found`);
    return user;
  }

  // S12: expose raw user (including hashed password) for current-password verification
  async findByIdRaw(
    id: number,
  ): Promise<import("./entities/user.entity").User | null> {
    return this.usersRepository.findOne({ where: { id } });
  }

  async findByUsername(username: string) {
    return this.usersRepository.findOne({ where: { username } });
  }

  async update(id: number, updateUserDto: UpdateUserDto) {
    const user = await this.findById(id);
    if (updateUserDto.password) {
      this.validatePasswordStrength(updateUserDto.password);
      updateUserDto.password = await bcrypt.hash(updateUserDto.password, 12);
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
      user.lockedUntil = new Date(Date.now() + opts.lockMinutes * 60_000);
    }
    await this.usersRepository.save(user);
  }

  /** SEC-05: Reset failure counter and lock on successful login. */
  async resetLoginFailure(userId: number): Promise<void> {
    // Use null explicitly so TypeORM issues SET lockedUntil = NULL in SQL
    await this.usersRepository.update(userId, {
      loginFailCount: 0,
      lockedUntil: null as any,
    });
  }
}
