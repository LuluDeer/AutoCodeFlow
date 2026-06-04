/**
 * TypeORM DataSource for CLI migrations.
 * Usage:
 *   npm run migration:run     — apply pending migrations in production
 *   npm run migration:revert  — undo last migration
 *   npm run migration:generate src/migrations/MyName — generate from entity diff
 */
import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
dotenv.config();

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  username: process.env.DB_USERNAME || 'autoflow',
  password: process.env.DB_PASSWORD || 'autoflow123',
  database: process.env.DB_DATABASE || 'autoflow',
  entities: [__dirname + '/modules/**/entities/*.entity{.ts,.js}'],
  migrations: [__dirname + '/migrations/*{.ts,.js}'],
  synchronize: false,
  logging: process.env.NODE_ENV !== 'production' ? ['query', 'error'] : ['error'],
});
