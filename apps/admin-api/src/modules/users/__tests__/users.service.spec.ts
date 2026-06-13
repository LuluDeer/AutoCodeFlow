import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { UsersService } from "../users.service";
import { User } from "../entities/user.entity";
import * as bcrypt from "bcrypt";

jest.mock("bcrypt");

const makeRepo = (overrides: Partial<Record<string, jest.Mock>> = {}) => ({
  findOne: jest.fn(),
  findAndCount: jest.fn(),
  find: jest.fn(),
  create: jest.fn((d: any) => d),
  save: jest.fn((e: any) => Promise.resolve(e)),
  delete: jest.fn().mockResolvedValue({ affected: 0 }),
  remove: jest.fn(),
  ...overrides,
});

describe("UsersService", () => {
  let service: UsersService;
  let repo: ReturnType<typeof makeRepo>;

  beforeEach(async () => {
    repo = makeRepo();
    (bcrypt.hash as jest.Mock).mockResolvedValue("hashed-password");
    const module = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: getRepositoryToken(User), useValue: repo },
      ],
    }).compile();
    service = module.get(UsersService);
  });

  describe("create", () => {
    it("should create a user with hashed password", async () => {
      repo.findOne.mockResolvedValue(null);
      repo.save.mockResolvedValue({
        id: 1,
        username: "test",
        password: "hashed-password",
      });

      const result = await service.create({
        username: "test",
        email: "test@example.com",
        password: "PlainPass1!",
      });

      expect(bcrypt.hash).toHaveBeenCalledWith("PlainPass1!", 12);
      expect(result.password).toBe("hashed-password");
    });

    it("should throw ConflictException when user exists", async () => {
      repo.findOne.mockResolvedValue({ id: 1, username: "test" });
      await expect(
        service.create({
          username: "test",
          email: "test@example.com",
                    password: "StrongPass1!",
        }),
      ).rejects.toThrow("already exists");
    });
  });

  describe("findAll", () => {
    it("should return paginated users", async () => {
      repo.findAndCount.mockResolvedValue([[{ id: 1, username: "test" }], 1]);
      const result = await service.findAll({ page: 1, pageSize: 10 });
      expect(result.list).toHaveLength(1);
      expect(result.total).toBe(1);
    });
  });
});
