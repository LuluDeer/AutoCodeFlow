/**
 * TypeORM DataSource for CLI migrations.
 * Usage:
 *   npm run migration:run     — apply pending migrations in production
 *   npm run migration:revert  — undo last migration
 *   npm run migration:generate src/migrations/MyName — generate from entity diff
 */
import { DataSource } from "typeorm";
import * as dotenv from "dotenv";
dotenv.config();
// ARCH-27: migration CLI 的独立引导路径 —— 不经 NestDI/ConfigModule（无 IoC
// 容器），无法注入 ConfigService，因此经 src/config/env.ts 的 getEnvVar()
// 收口读取（ESLint 豁免：data-source.ts override，见 .eslintrc.js）。
import { getEnvVar } from "./config/env";

export const AppDataSource = new DataSource({
  type: "postgres",
  host: getEnvVar("DB_HOST") || "localhost",
  port: parseInt(getEnvVar("DB_PORT") || "5432", 10),
  username: getEnvVar("DB_USERNAME") || "autoflow",
  password: getEnvVar("DB_PASSWORD") || "",
  database: getEnvVar("DB_DATABASE") || "autoflow",
  // 与 src/config/configuration.ts 运行面 glob（../**/*.entity）对齐：
  // 模块根直放的实体（project/project.entity.ts、executor-package 同款）
  // 也能被 CLI 引导路径加载，避免 AUTH-01 Task#project 反向关系因
  // Project 实体元数据缺失而报 "Entity metadata not found"。
  entities: [__dirname + "/modules/**/*.entity{.ts,.js}"],
  migrations: [__dirname + "/migrations/*{.ts,.js}"],
  synchronize: false,
  logging:
    getEnvVar("NODE_ENV") !== "production" ? ["query", "error"] : ["error"],
});
