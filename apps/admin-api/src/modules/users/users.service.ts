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
import { ConfigService } from "@nestjs/config";
import * as bcrypt from "bcrypt";
import { User, UserRole } from "./entities/user.entity";
import { RefreshToken } from "../auth/entities/refresh-token.entity";
// A-8: 删除用户时同事务清理其 project_members 行（该列无 FK，残留即幽灵成员）。
import { ProjectMember } from "../project/entities/project-member.entity";
import { CreateUserDto } from "./dto/create-user.dto";
import { UpdateUserDto } from "./dto/update-user.dto";
import { ListUsersDto } from "./dto/list-users.dto";
import { paginate } from "../../common/dto/pagination.dto";
import { ILike } from "typeorm";
// NETOPT-3⑤/API-09 同款先例（task.service getAllExecutions）：LIKE 元字符
// 转义 util 第三处落点（同模块函数导入，不新增依赖）。
import { escapeLikePattern } from "../audit/audit.service";

/**
 * ARCH-31: PG 唯一约束冲突（23505）判定——种子竞态里「输家」据此降级为跳过。
 * 只认 driver 层的 code，不做错误消息匹配（防 PG 文案/版本漂移）。
 */
function isUniqueViolation(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return code === "23505";
}

@Injectable()
export class UsersService implements OnModuleInit {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    // R-14: 删除用户时一并回收其 refresh_tokens（见 remove()）。
    @InjectRepository(RefreshToken)
    private readonly refreshTokenRepository: Repository<RefreshToken>,
    // ARCH-27: 种子账号配置经 ConfigService 读取（configuration.ts
    // initialAdmin 节 + Joi INITIAL_ADMIN_PASSWORD / INITIAL_ADMIN_EMAIL），
    // 取代原先 onModuleInit 直读 process.env 的模式。
    private readonly configService: ConfigService,
  ) {}

  /**
   * Bootstrap: seed the initial admin user from the registered initialAdmin
   * configuration (env INITIAL_ADMIN_PASSWORD / INITIAL_ADMIN_EMAIL) if no
   * users exist in the database yet.
   */
  async onModuleInit() {
    // boot 容错：空库场景（api-types-drift 的 export 等无迁移起 AppModule）
    // 下 count() 会因 users 表不存在抛错并炸掉整个 boot。种子引导本就依赖
    // DB 可用——失败只 warn，真实部署迁移后首 boot 会正常播种。
    let count: number;
    try {
      count = await this.usersRepository.count();
    } catch (err: unknown) {
      this.logger.warn(
        `initial-admin seed skipped (users table not ready): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }
    if (count > 0) return;

    const password = this.configService.get<string>("initialAdmin.password");
    const email =
      this.configService.get<string>("initialAdmin.email") ??
      "admin@autoflow.local";
    if (!password) {
      this.logger.warn("INITIAL_ADMIN_PASSWORD not set — skipping admin seed");
      return;
    }

    const hashed = await bcrypt.hash(password, 12);
    const admin = this.usersRepository.create({
      username: "admin",
      email,
      password: hashed,
      role: UserRole.ADMIN,
      isActive: true,
    });
    try {
      await this.usersRepository.save(admin);
      this.logger.log(
        `Initial admin user created (username: admin, email: ${email})`,
      );
    } catch (e: unknown) {
      // ARCH-31: 启动期种子竞态——空库上多实例同时引导时都看到 count=0，
      // 唯一索引只放行一个赢家，输家此前会吞到 23505 并**中断进程启动**
      // （真实场景：全新环境一次性拉起多个副本，第二个副本起不来）。
      // 输家核对「已有用户」后正常继续（种子是幂等的引导动作，不是业务写面）。
      if (isUniqueViolation(e)) {
        const now = await this.usersRepository.count();
        if (now > 0) {
          this.logger.log(
            "Initial admin seed skipped — another instance already seeded the first user",
          );
          return;
        }
      }
      throw e;
    }
  }

  /**
   * SEC: validate password meets minimum strength requirements.
   * At least 8 chars, one uppercase, one digit, one special character.
   */
  private validatePasswordStrength(password: string): void {
    if (!password || password.length < 8) {
      throw new BadRequestException("Password must be at least 8 characters");
    }
    if (!/[A-Z]/.test(password)) {
      throw new BadRequestException(
        "Password must contain at least one uppercase letter",
      );
    }
    if (!/[0-9]/.test(password)) {
      throw new BadRequestException("Password must contain at least one digit");
    }
    if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
      throw new BadRequestException(
        "Password must contain at least one special character",
      );
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

  // API-07（历史）：签名曾从 PaginationDto 收窄为 PageQueryDto（任务专用过滤
  // 字段从未被消费）。本轮接入 ListUsersDto.search：username/email ILIKE
  // 模糊匹配。`_`/`%` 经 escapeLikePattern 按字面量处理——否则搜含下划线的
  // 用户名（zhang_san）会静默匹配到无关账号（见 audit.service API-09 注释）。
  async findAll(pagination: ListUsersDto) {
    const { page, pageSize, search } = pagination;
    // trim 后空串 = 无过滤（避免生成 `%%` 全匹配的无效 where）
    const pattern = search ? `%${escapeLikePattern(search)}%` : null;
    const [list, total] = await this.usersRepository.findAndCount({
      skip: (page - 1) * pageSize,
      take: pageSize,
      order: { createdAt: "DESC" },
      ...(pattern
        ? { where: [{ username: ILike(pattern) }, { email: ILike(pattern) }] }
        : {}),
    });
    return paginate(list, total, page, pageSize);
  }

  async findById(id: number) {
    const user = await this.usersRepository.findOne({ where: { id } });
    if (!user) throw new NotFoundException(`User #${id} not found`);
    return user;
  }

  /**
   * H-3 / R-04: callers that need to differentiate between "missing user" and
   * "denied access" should use this — a 404 would leak that the user
   * previously existed. The auth flow paths (jwt.strategy.validate and
   * auth.service.refreshToken) call THIS method and translate null into a
   * clean UnauthorizedException themselves (findById would surface a 404
   * "User #N not found" for tokens of deleted users — presence disclosure).
   */
  async findByIdOrNull(
    id: number,
  ): Promise<import("./entities/user.entity").User | null> {
    return this.usersRepository.findOne({ where: { id } });
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

  /**
   * A-7（R3-A 审计）: 自改 email 的唯一性预检取数（与 findByUsername 同形态）
   * ——users.controller 自改分支据此把「email 已被他人占用」前置成 409，
   * 而不是让 user.email 唯一索引的 23505 冒成裸 500。
   */
  async findByEmail(email: string) {
    return this.usersRepository.findOne({ where: { email } });
  }

  async update(id: number, updateUserDto: UpdateUserDto) {
    const user = await this.findById(id);
    // R19: currentPassword is a verification-only field (checked in the
    // controller). Object.assign would graft it onto the entity and
    // save() returns the same object — the plaintext current password
    // would be echoed back in the API response. Drop it before merging.
    delete updateUserDto.currentPassword;
    if (updateUserDto.password) {
      this.validatePasswordStrength(updateUserDto.password);
      updateUserDto.password = await bcrypt.hash(updateUserDto.password, 12);
    }

    // R-14 对称缺口（本轮审计）：remove() 有「最后一名管理员」守卫，update()
    // 此前没有——PATCH /users/:id {role:'user'} 可以把唯一管理员降级，平台随即
    // 再无任何全量放行主体（ADR-013：ADMIN 是唯一全量角色），只能直连 DB 修复。
    // 与 remove() 同款并发姿态：判定与写在同一事务内、并对管理员行集合
    // SELECT ... FOR UPDATE —— 两个并发降级请求下，后到者在锁上等待并看到
    // count=1 从而拒绝（READ COMMITTED 下纯 count 检查会双双通过）。
    const demotingAdmin =
      user.role === UserRole.ADMIN &&
      updateUserDto.role !== undefined &&
      updateUserDto.role !== UserRole.ADMIN;

    if (demotingAdmin) {
      return this.usersRepository.manager.transaction(async (manager) => {
        const users = manager.getRepository(User);
        const target = await users.findOne({ where: { id } });
        if (!target) throw new NotFoundException(`User #${id} not found`);
        const admins = await users
          .createQueryBuilder("u")
          .setLock("pessimistic_write")
          .where("u.role = :role", { role: UserRole.ADMIN })
          .getMany();
        if (admins.length <= 1) {
          throw new BadRequestException("Cannot demote the last administrator");
        }
        Object.assign(target, updateUserDto);
        const savedInTx = await users.save(target);
        if (updateUserDto.password) {
          await this.bumpSessionVersion(id);
        }
        return savedInTx;
      });
    }

    Object.assign(user, updateUserDto);
    const saved = await this.usersRepository.save(user);
    // WIKI-AUTH-REVOC: 改密成功后原子 bump 会话版本——该用户所有在途
    // access token 的 ver 快照失配即 401（含管理员重置他人密码的场景）。
    // 放在 save 成功之后：改密失败（校验/落库异常）不误伤在途会话。
    // 返回实体中的 sessionVersion 为 bump 前快照（响应展示无消费方，语义
    // 以签发时重新读取的库中值为准）。
    if (updateUserDto.password) {
      await this.bumpSessionVersion(id);
    }
    return saved;
  }

  /**
   * R-14（DEEP_REVIEW 0ef3bbe）：删除用户的三重守卫 + 凭据回收。
   *
   *  - **自删拒绝**：管理员删掉自己会让当前会话立刻失效（WIKI-AUTH-REVOC 后
   *    改密/注销即 bump），且极易顺带删掉最后一名管理员而把平台锁死。
   *  - **最后一名管理员拒绝**：删后平台再无管理面主体（ADR-013 的 ADMIN 是唯一
   *    全量放行角色），只能直连 DB 修复——不可恢复操作必须前置拒绝。
   *  - **回收 refresh_tokens**：R-04 已让删除后的 refresh 路径 401
   *    （findByIdOrNull 缺行即拒），此处清行属凭据卫生——不把长期有效的孤儿
   *    令牌行留在库里（也避免会话列表/清理任务扫到悬空 userId）。
   *  - **清理 project_members**（A-8）：成员表 userId 无 FK，残留行会造成
   *    幽灵成员（面板显示已删用户、resolveRole 命中已删 id），同事务清行。
   *
   * 并发：判定与删除在同一事务内，且对管理员行集合 `SELECT ... FOR UPDATE`，
   * 两个并发请求同时删掉仅剩的两名管理员时后到者会在锁上等待并看到 count=1
   * 而拒绝（单纯 count 检查在 READ COMMITTED 下会双双通过）。
   *
   * @param actingUserId 发起删除的主体 id（controller 必传 AuthUser.id）——
   *   自删判定依据；缺省（内部/测试调用）跳过自删判定，最后管理员与令牌回收
   *   守卫仍然生效。
   */
  async remove(id: number, actingUserId?: number) {
    if (actingUserId !== undefined && actingUserId === id) {
      throw new BadRequestException("Cannot delete your own account");
    }
    return this.usersRepository.manager.transaction(async (manager) => {
      const users = manager.getRepository(User);
      const target = await users.findOne({ where: { id } });
      if (!target) throw new NotFoundException(`User #${id} not found`);
      if (target.role === UserRole.ADMIN) {
        const admins = await users
          .createQueryBuilder("u")
          .setLock("pessimistic_write")
          .where("u.role = :role", { role: UserRole.ADMIN })
          .getMany();
        if (admins.length <= 1) {
          throw new BadRequestException("Cannot delete the last administrator");
        }
      }
      await manager.getRepository(RefreshToken).delete({ userId: id });
      // A-8（R3-A 审计）: project_members.userId 无 FK——用户删除后残留成员行
      // 会造成「幽灵成员」：成员面板显示已删用户、resolveRole 仍命中已删 id
      // 参与项目角色判定。同事务清理（与 refresh_tokens 回收同点），删除失败
      // 一并回滚，不产生半清理状态。
      await manager.getRepository(ProjectMember).delete({ userId: id });
      await users.remove(target);
      return { deleted: true };
    });
  }

  /**
   * SEC-03: persist a fully-loaded user entity (TOTP staging / enable /
   * disable paths). Caller must have fetched the entity via findById /
   * findByIdRaw — this is a plain save, no partial-update semantics.
   */
  async saveUser(user: import("./entities/user.entity").User) {
    return this.usersRepository.save(user);
  }

  /**
   * M-3 + SEC-05: increment loginFailCount atomically and lock the account
   * when the threshold is reached. The previous read-modify-write lost
   * updates under concurrent failed logins (two near-simultaneous wrong
   * passwords could each see `loginFailCount = 3` and both decide to NOT
   * lock, letting an attacker bypass lockout).
   *
   * Uses two atomic UPDATEs:
   *   1. unconditional `loginFailCount = loginFailCount + 1`
   *   2. if the resulting count crosses the threshold, set lockedUntil.
   * `lockedUntil` is reset only if currently past or null (idempotent).
   */
  async recordLoginFailure(
    userId: number,
    opts: { maxFail: number; lockMinutes: number },
  ): Promise<void> {
    // Step 1: increment. RETURNING * gives us the post-update count without
    // a second SELECT roundtrip and without an explicit transaction.
    const incremented = await this.usersRepository
      .createQueryBuilder()
      .update()
      .set({ loginFailCount: () => '"loginFailCount" + 1' })
      .where("id = :id", { id: userId })
      .returning(["loginFailCount"])
      .execute();
    const row = (incremented.raw?.[0] ?? incremented.generatedMaps?.[0]) as
      { loginFailCount?: number } | undefined;
    const next = row?.loginFailCount ?? 0;
    if (next < opts.maxFail) return;

    // Step 2: set lockedUntil. Use IS NULL OR < now() so we don't extend an
    // already-active lockout window (the original implement could reset
    // the timer on every retry inside the lockout window).
    const until = new Date(Date.now() + opts.lockMinutes * 60_000);
    await this.usersRepository
      .createQueryBuilder()
      .update()
      .set({ lockedUntil: until })
      .where("id = :id", { id: userId })
      .andWhere("(lockedUntil IS NULL OR lockedUntil < :now)", {
        now: new Date(),
      })
      .execute();
  }

  /**
   * R10: atomically clear an EXPIRED lockout (loginFailCount → 0,
   * lockedUntil → NULL) with a single conditional UPDATE —
   * `lockedUntil IS NOT NULL AND lockedUntil < now` — so concurrent
   * logins cannot race a reset against a still-active lock, and a lock
   * that another request already cleared (or re-extended) is left alone.
   *
   * Without this the fail counter survives the lock window: after the
   * 15-minute expiry, loginFailCount is still MAX_FAIL, so ONE fresh wrong
   * password re-trips the threshold and re-locks instantly — the account
   * is effectively permanently locked for anyone who fails once after each
   * window (the "expired lock + 1 failure" case).
   */
  async clearExpiredLock(userId: number): Promise<boolean> {
    const result = await this.usersRepository
      .createQueryBuilder()
      .update()
      .set({ loginFailCount: 0, lockedUntil: null })
      .where("id = :id", { id: userId })
      .andWhere("lockedUntil IS NOT NULL AND lockedUntil < :now", {
        now: new Date(),
      })
      .execute();
    return (result.affected ?? 0) > 0;
  }

  /** SEC-05: Reset failure counter and lock on successful login. */
  async resetLoginFailure(userId: number): Promise<void> {
    // Use null explicitly so TypeORM issues SET lockedUntil = NULL in SQL.
    await this.usersRepository.update(userId, {
      loginFailCount: 0,
      lockedUntil: null,
    });
  }

  /**
   * WIKI-AUTH-REVOC: 原子 bump 用户级会话版本（sessionVersion + 1）。
   * 单条 UPDATE 列自增（repo.increment），不做读改写——并发 logout/改密
   * 不会互相覆盖 bump 次数。调用点：logout（auth.service.revokeAllForUser）
   * 与改密（update 携带 password）。bump 后该用户所有在途 access token 的
   * ver 快照与库中失配，jwt.strategy.validate() 即刻 401。
   */
  async bumpSessionVersion(userId: number): Promise<void> {
    await this.usersRepository.increment({ id: userId }, "sessionVersion", 1);
  }

  /**
   * NETOPT-5⑤: TOTP 重放防护——原子消费命中的 counter，返回是否占位成功。
   *
   * 单条条件 UPDATE（无读改写，防并发竞态）：仅当 lastTotpCounter 为 NULL
   * （从未消费 / 无 TOTP 用户首次占位）或小于本次命中 counter 时置为本次值；
   * affected=0 表示该 counter 已被使用（重放）或被并发请求先占——调用方
   * （auth.service.totpVerifyLogin）按无效码拒绝。单调递增语义同 HOTP
   * 计数器模型；列可空，无 TOTP 用户保持 NULL 不受影响。
   */
  async consumeTotpCounter(
    userId: number,
    matchedCounter: number,
  ): Promise<boolean> {
    const result = await this.usersRepository
      .createQueryBuilder()
      .update()
      .set({ lastTotpCounter: matchedCounter })
      .where("id = :id", { id: userId })
      .andWhere("(lastTotpCounter IS NULL OR lastTotpCounter < :matched)", {
        matched: matchedCounter,
      })
      .execute();
    return (result.affected ?? 0) > 0;
  }
}
