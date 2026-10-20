/**
 * R115：**字节**口径的上限。
 *
 * 与 R111 的「码点」口径是两件事，所以分开一个文件：
 *
 * - R111：后端 `@MaxLength` 走 validator.js `isLength`，数**码点**；
 * - R115：后端 env / params 的上限走 `Buffer.byteLength(s, 'utf8')`，数 **UTF-8 字节**
 *   （app-deployment.dto.ts:39-40；task/params-size.util.ts:21-27）。
 *
 * 用错口径的两个方向都是缺陷：按字符算会**放过后端必拒的载荷**（agent 白跑一趟网络），
 * 按别的方式收紧会**拒掉后端接受的载荷**。本文件里凡是长度用例都刻意用**中文**构造 ——
 * 中文 1 字符 = 3 字节，字符数与字节数差 3 倍，用 ASCII 测不出区别。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { z } from 'zod';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import {
  registerApplicationTools,
  registerDeploymentTools,
  registerTaskTools,
  DEPLOYMENT_ENV_MAX_KEYS,
  DEPLOYMENT_ENV_VALUE_MAX_BYTES,
  TASK_PARAMS_MAX_BYTES,
  jsonByteLength,
  utf8ByteLength,
} from '../tools.js';

type AnySchema = Record<string, z.ZodTypeAny>;

let schemas: Map<string, AnySchema>;

beforeEach(() => {
  schemas = new Map();
  const call = vi.fn().mockResolvedValue({ ok: true });
  const fakeServer = {
    tool: (
      name: string,
      _d: string,
      schema: AnySchema,
      _a: ToolAnnotations,
      _h: unknown,
    ) => {
      schemas.set(name, schema);
    },
  };
  registerTaskTools(fakeServer as never, call as never);
  registerApplicationTools(fakeServer as never, call as never);
  registerDeploymentTools(fakeServer as never, call as never);
});

function parseOk(tool: string, value: unknown): boolean {
  const schema = schemas.get(tool)!;
  const shape = schemas.get(tool)!;
  void shape;
  const field = Object.entries(schema).find(([k]) => k === 'env' || k === 'params' || k === 'overrides');
  if (!field) throw new Error(`${tool} 上找不到 env/params/overrides 字段`);
  const result = (field[1] as z.ZodTypeAny).safeParse(value);
  return result.success;
}

describe('R115 环境变量 env 的字节口径', () => {
  it('常量与后端一致（50 键 / 4096 字节）', () => {
    expect(DEPLOYMENT_ENV_MAX_KEYS).toBe(50);
    expect(DEPLOYMENT_ENV_VALUE_MAX_BYTES).toBe(4096);
  });

  it('50 个键通过，51 个键被拒', () => {
    const make = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`K${i}`, 'v']));
    expect(parseOk('create_application', make(50))).toBe(true);
    expect(parseOk('create_application', make(51))).toBe(false);
  });

  it('**值按字节算**：1366 个中文（=4098 字节）超限被拒，1365 个（=4095 字节）通过', () => {
    const limitChars = Math.floor(DEPLOYMENT_ENV_VALUE_MAX_BYTES / 3); // 1365 → 4095 字节
    expect(utf8ByteLength('中'.repeat(limitChars))).toBe(4095);
    expect(parseOk('create_application', { K: '中'.repeat(limitChars) })).toBe(true);
    expect(parseOk('create_application', { K: '中'.repeat(limitChars + 1) })).toBe(false);
  });

  it('**键**也按字节算（后端 :39 对 key 同样校验）', () => {
    expect(parseOk('create_application', { ['键'.repeat(1366)]: 'v' })).toBe(false);
  });

  it('deploy_application 的 env 同样受约束', () => {
    const big = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`K${i}`, 'v']));
    expect(parseOk('deploy_application', big)).toBe(false);
  });
});

describe('R115 任务 params 的序列化字节口径', () => {
  it('常量与后端一致（65536 字节）', () => {
    expect(TASK_PARAMS_MAX_BYTES).toBe(65_536);
  });

  it('小载荷通过', () => {
    expect(parseOk('trigger_task', { a: 1 })).toBe(true);
  });

  it('**按序列化字节算**：22000 个中文（≈66000 字节）被拒 —— 按字符算只有 22000，会误放', () => {
    const payload = { blob: '中'.repeat(22_000) };
    expect(jsonByteLength(payload)!).toBeGreaterThan(TASK_PARAMS_MAX_BYTES);
    expect(parseOk('trigger_task', payload)).toBe(false);
  });

  it('恰好 65536 字节通过、65537 被拒（边界）', () => {
    // ASCII: 1 字节/字符，便于精确构造边界
    const at = { blob: 'a'.repeat(TASK_PARAMS_MAX_BYTES - jsonByteLength({ blob: '' })!) };
    const bytes = jsonByteLength(at)!;
    expect(bytes).toBe(TASK_PARAMS_MAX_BYTES);
    expect(parseOk('trigger_task', at)).toBe(true);
    expect(parseOk('trigger_task', { blob: 'a'.repeat(at.blob.length + 1) })).toBe(false);
  });
});
