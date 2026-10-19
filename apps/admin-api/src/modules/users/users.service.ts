import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
// LANG-ERR-01（后端错误码化）：用户面抛出统一走 AppError（带稳定码，前端按
// 用户语言渲染）。AppError 按状态码挂到对应内置异常原型上，故既有按异常类
// 断言的 spec 不受影响。
import { AppError } from "../../common/errors/app-error";
// R32-A5：唯一性竞态兜底按码归因（USERNAME_TAKEN / EMAIL_TAKEN / USER_EXISTS）。
import { ErrorCode } from "../../common/errors/error-codes";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ConfigService } from "@nestjs/config";
import * as bcrypt from "bcrypt";
import { User, UserRole } from "./entities/user.entity";
import { RefreshToken } from "../auth/entities/refresh-token.entity";
// A-8: 删除用户时同事务清理其 project_members 行（该列无 FK，残留即幽灵成员）。
import { ProjectMember } from "../project/entities/project-member.entity";
// R32-A5: 删除用户时同事务回收其 api_keys 行（同样无 FK，残留即孤儿凭据）。
import { ApiKey } from "../api-keys/entities/api-key.entity";
import { CreateUserDto } from "./dto/create-user.dto";
import { UpdateUserDto } from "./dto/update-user.dto";
import { ListUsersDto } from "./dto/list-users.dto";
import { paginate } from "../../common/dto/pagination.dto";
import { ILike } from "typeorm";
// NETOPT-3⑤/API-09 同款先例（task.service getAllExecutions）：LIKE 元字符
// 转义 util 第三处落点（同模块函数导入，不新增依赖）。
import { escapeLikePattern } from "../audit/audit.service";

/**
 * R32-C3: update() 允许落库的列——UpdateUserDto（PartialType(CreateUserDto)）的
 * 全部业务列。单独拎成类型别名的用意：**编译期**就把可写面钉死在这四列上，
 * 将来谁想在 patch 里多加一列，tsc 先红（不必等线上问题复现）。
 */
type UpdatableUserColumn = "username" | "email" | "password" | "role";

/**
 * ARCH-31: PG 唯一约束冲突（23505）判定——种子竞态里「输家」据此降级为跳过。
 * 只认 driver 层的 code，不做错误消息匹配（防 PG 文案/版本漂移）。
 */
function isUniqueViolation(e: unknown): boolean {
  // TypeORM 把 PG 原始错误挂在 driverError 上，不同驱动/版本也会直接放顶层
  // （与 projects.service.isUniqueViolationOn / executor.service 同款两处都看）。
  const err = e as
    | { code?: unknown; driverError?: { code?: unknown } }
    | null
    | undefined;
  const code = err?.code ?? err?.driverError?.code;
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
      throw new AppError("PASSWORD_TOO_SHORT");
    }
    if (!/[A-Z]/.test(password)) {
      throw new AppError("PASSWORD_NEEDS_UPPERCASE");
    }
    if (!/[0-9]/.test(password)) {
      throw new AppError("PASSWORD_NEEDS_DIGIT");
    }
    if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
      throw new AppError("PASSWORD_NEEDS_SPECIAL");
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
    if (existing) throw new AppError("USER_EXISTS");
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
    if (!user) throw new AppError("USER_ID_NOT_FOUND", { id });
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

    try {
      return await this.applyUpdate(id, updateUserDto, demotingAdmin);
    } catch (e: unknown) {
      // R32-A5（轴4）：唯一性竞态兜底。
      //
      // 缺陷现场：唯一性预检只在 controller 侧、只覆盖「非 admin 自改」
      // （users.controller.ts:143-159）——预检与落库（R32-C3 起是列级 UPDATE）
      // 之间是 TOCTOU 窗口。两个请求同时改成同一个 username/email 时两者都过
      // 预检，输家的写入撞唯一索引 → PG 23505 一路穿到全局 filter
      // （http-exception.filter.ts:114）
      // 落成笼统的 RESOURCE_EXISTS「资源已存在」：状态码还是 409、不 500，但
      // **不知道撞的是哪个字段**，而同一语义的另一条路径（预检命中）给的是点名
      // 409 USERNAME_TAKEN / EMAIL_TAKEN。admin 改他人账号更是零预检，本兜底
      // 就是那条路径的唯一归因点。
      //
      // 归因方式：事务已随异常回滚，改在池连接上按 dto 里出现的字段重读一次
      // （不依赖约束名——TypeORM 的 UQ_<hash> 名不稳定，PG 侧也可能漂移）。
      // 重读失败/无命中/命中自己 → 回落 USER_EXISTS（仍是 409，绝不冒充成功）。
      if (isUniqueViolation(e)) {
        throw await this.classifyUniqueConflict(id, updateUserDto);
      }
      throw e;
    }
  }

  /**
   * R32-C3: update 的写入列集合——**只**包含本次真正要改的列。
   *
   * 缺陷现场（L2 / 与 R32-A4 在 auth.service 修掉的 TOTP 三处同形态）：此前是
   * 「findById 读整行快照 → bcrypt + 唯一性/降级判定 → save(user) 整行回写」。
   * TypeORM 的 save 会按 id 重读库中行逐列 diff
   * （persistence/SubjectChangedColumnsComputer.computeDiffColumns），于是内存
   * 实体里的**陈旧快照值**与并发写入后的新值不同 → 被判成"脏列" → 按旧值写回。
   * 触发窗口是 [快照读, save 内部那次 SELECT]，中间夹着 bcrypt(12) 与预检，
   * 完全不是理论窄窗。同一行上的三种并发写因此被静默回滚：
   *   · 并发 logout / 改密 bump 的 sessionVersion 被回退 ⇒ 已吊销 access token
   *     的 ver 又匹配上（令牌复活，WIKI-AUTH-REVOC 失效）；
   *   · 管理员刚落库的 isActive=false 被撤销 ⇒ 禁用失效（账号逃逸隔离）；
   *   · 并发写入的新密码哈希被旧哈希覆盖 ⇒ 改密被静默撤销。
   *
   * 逐列取舍（其余列宁可不动）：
   *   · username / email / password / role = `UpdateUserDto`
   *     （PartialType(CreateUserDto)）的全部业务列，也是旧实现整行回写下**唯一**
   *     可能被 PATCH 改到的列：main.ts 的 ValidationPipe 是 whitelist +
   *     forbidNonWhitelisted（main.ts:370-375），契约外的键到不了这里。故对
   *     **可达**列而言，列级写入与旧行为逐字节等价，不是语义收敛。
   *   · isActive / loginFailCount / lockedUntil / totpEnabled / totpSecret /
   *     lastTotpCounter / oidcSub 各自有自己的原子写点（禁用面、登录失败计数、
   *     TOTP 状态、OIDC 绑定），本路径绝不能带着快照值重写它们。
   *   · sessionVersion 的唯一写入点是 bumpSessionVersion（原子自增）与降级事务
   *     内的 increment——把快照值写回正是"令牌复活"的根因。
   *   · id / createdAt 不可变；updatedAt 交给 UpdateQueryBuilder 自动追加的
   *     `"updatedAt" = CURRENT_TIMESTAMP`（query-builder/UpdateQueryBuilder.js
   *     的 updateDateColumn 分支），与 save 的修改时间语义一致且用库时钟，
   *     故不手写。
   *
   * 用 `!== undefined` 而非真值判断：false / 0 / 空串等有意义的取值也必须照写。
   */
  private buildUpdatePatch(
    updateUserDto: UpdateUserDto,
  ): Partial<Pick<User, UpdatableUserColumn>> {
    const patch: Partial<Pick<User, UpdatableUserColumn>> = {};
    if (updateUserDto.username !== undefined)
      patch.username = updateUserDto.username;
    if (updateUserDto.email !== undefined) patch.email = updateUserDto.email;
    if (updateUserDto.password !== undefined)
      patch.password = updateUserDto.password;
    if (updateUserDto.role !== undefined) patch.role = updateUserDto.role;
    return patch;
  }

  /**
   * R32-A5：update 的实际写入路径（拆出仅为让 23505 兜底只包一层 try）。
   * 失败面（23505 / AppError）与拆分前一致；R32-C3 起写入本身改为**列级
   * UPDATE**（逐列取舍见 buildUpdatePatch 的头注）。
   */
  private async applyUpdate(
    id: number,
    updateUserDto: UpdateUserDto,
    demotingAdmin: boolean,
  ) {
    const patch = this.buildUpdatePatch(updateUserDto);

    if (demotingAdmin) {
      return this.usersRepository.manager.transaction(async (manager) => {
        const users = manager.getRepository(User);
        const target = await users.findOne({ where: { id } });
        if (!target) throw new AppError("USER_ID_NOT_FOUND", { id });
        const admins = await users
          .createQueryBuilder("u")
          .setLock("pessimistic_write")
          .where("u.role = :role", { role: UserRole.ADMIN })
          .getMany();
        if (admins.length <= 1) {
          throw new AppError("USER_LAST_ADMIN_CANNOT_DEMOTE");
        }
        // R32-C3: 与事务外路径同款列级 UPDATE。事务内 findOne 到这条 UPDATE
        // 之间仍可能夹着已提交的并发写（行锁要等下面 FOR UPDATE 才拿到），整行
        // 回写在这里同样会按旧快照把并发结果盖回去。
        await users.update({ id }, patch);
        const savedInTx = await users.findOne({ where: { id } });
        if (!savedInTx) throw new AppError("USER_ID_NOT_FOUND", { id });
        if (updateUserDto.password) {
          // DEADLOCK-01（审计 P2，2026-10-17）：**必须**用事务内的 manager，
          // 不能用 this.bumpSessionVersion（它走 this.usersRepository，即
          // 连接池里的**另一条**连接）。
          //
          // 缺陷现场：事务已持有目标行的写锁，而这条外部 UPDATE 需要同一行
          // 的行锁 → 它排队等事务提交；事务又在 await 它 → 二者互等。单连接
          // 池（DATABASE_POOL_SIZE=1，或池被并发请求耗尽）下是**确定性死锁**，
          // 请求挂到连接超时；多连接下也会把池占满并放大锁等待。
          //
          // 事务内单条 UPDATE 语义与 bumpSessionVersion 逐字节一致
          // （increment → SET "sessionVersion" = "sessionVersion" + 1）。
          await users.increment({ id }, "sessionVersion", 1);
        }
        return savedInTx;
      });
    }

    // R32-C3: 列级 UPDATE——只写 patch 里出现的列，快照里的并发安全列
    // （sessionVersion / isActive / password 等）一个字都不进 SQL。
    await this.usersRepository.update({ id }, patch);
    // 响应实体改为写后重读（不再把陈旧快照当响应）：UserResponseDto 暴露
    // isActive / sessionVersion / loginFailCount，拿快照会把这些列报成旧值。
    // 查询次数不增——TypeORM 的 save 本来就会按 id 先 SELECT 一次做 diff。
    // 行若在 update 与本次读之间被并发删除：findById 抛 USER_ID_NOT_FOUND，
    // 比旧行为诚实（save 在行已不存在时会把实体 INSERT 回来 = 删除被复活）。
    const saved = await this.findById(id);
    // WIKI-AUTH-REVOC: 改密成功后原子 bump 会话版本——该用户所有在途
    // access token 的 ver 快照失配即 401（含管理员重置他人密码的场景）。
    // 放在写入成功之后：改密失败（校验/落库异常）不误伤在途会话。
    // 返回实体中的 sessionVersion 为 bump 前快照（响应展示无消费方，语义
    // 以签发时重新读取的库中值为准）。
    if (updateUserDto.password) {
      await this.bumpSessionVersion(id);
    }
    return saved;
  }

  /**
   * R32-A5：把 PG 23505 归因到具体字段（update 的唯一性竞态兜底）。
   *
   * 只看 dto 里**实际出现**的字段：未改的列不可能被这次写入撞到，为它多查
   * 一次只会带来「把别人的冲突算到你头上」的误报。命中他人 → 点名 409；否则
   * 回落 USER_EXISTS（笼统但仍是 409）。重读本身失败也不改写失败语义。
   */
  private async classifyUniqueConflict(
    id: number,
    updateUserDto: UpdateUserDto,
  ): Promise<AppError> {
    try {
      if (updateUserDto.username) {
        const holder = await this.usersRepository.findOne({
          where: { username: updateUserDto.username },
        });
        if (holder && holder.id !== id) {
          return new AppError(ErrorCode.USERNAME_TAKEN);
        }
      }
      if (updateUserDto.email) {
        const holder = await this.usersRepository.findOne({
          where: { email: updateUserDto.email },
        });
        if (holder && holder.id !== id) {
          return new AppError(ErrorCode.EMAIL_TAKEN);
        }
      }
    } catch {
      // 归因重读失败：保持 409 的失败面，不让排障查询把原错误改写成 500。
    }
    return new AppError(ErrorCode.USER_EXISTS);
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
      throw new AppError("USER_SELF_DELETE_FORBIDDEN");
    }
    return this.usersRepository.manager.transaction(async (manager) => {
      const users = manager.getRepository(User);
      const target = await users.findOne({ where: { id } });
      if (!target) throw new AppError("USER_ID_NOT_FOUND", { id });
      if (target.role === UserRole.ADMIN) {
        const admins = await users
          .createQueryBuilder("u")
          .setLock("pessimistic_write")
          .where("u.role = :role", { role: UserRole.ADMIN })
          .getMany();
        if (admins.length <= 1) {
          throw new AppError("USER_LAST_ADMIN_CANNOT_DELETE");
        }
      }
      await manager.getRepository(RefreshToken).delete({ userId: id });
      // R32-A5（轴1）: api_keys.userId 同样无 FK——用户删除后残留的是**长期有效
      // 的凭据行**（永不过期的 key 也在其中）。认证面已由 R32-A4 的属主闸兜住
      // （api-keys.service.ts:215-218：属主不存在或已禁用 → owner_inactive → 401），
      // 所以这里不是堵"删了还能用"，而是补齐凭据回收：与 refresh_tokens 同一
      // 卫生口径（"不把孤儿令牌/凭据留在库里"），也避免会话/审计面扫到悬空 userId。
      // 同事务、行在用户行之前删——api_keys 无 FK，删除顺序只影响半清理状态，
      // 放前面可保证「用户行没了但凭据还在」这个窗口不存在。
      await manager.getRepository(ApiKey).delete({ userId: id });
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
   * SEC-03: persist a fully-loaded user entity.
   *
   * ⚠️ **已无生产调用方（R32-C3 后）—— 新代码不要用它。**
   *
   * 它是**整行回写**：TypeORM 的 save 会按 id 重读库中行做逐列 diff，但比的是
   * 「内存里的陈旧快照 vs 写入时刻库中行」，陈旧值 ≠ 新值 ⇒ 被判成脏列并**按旧值
   * 写回**。users 表上恰好有四个「各自有原子写点」的安全列（sessionVersion 由
   * bumpSessionVersion / 事务内 increment、isActive / password / totpSecret 各有
   * 独立写点），一旦经由本方法回写，并发的登出（令牌复活）、禁用（失效）、改密
   * （被撤销）会被静默回滚——R32-C3 已实测复现（窗口含 bcrypt(12)，不是窄窗）。
   *
   * 局部更新请走 `update({id}, patch)`（见本文件 buildUpdatePatch：编译期钉死
   * 可写面）。保留本方法只为兼容既有装配与测试替身；真正删除需要同时改
   * auth.totp-sessions.spec 的 mock 形态，留作单独一轮。
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
