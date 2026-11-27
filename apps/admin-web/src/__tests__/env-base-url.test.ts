/**
 * 配置模板防回归守卫：VITE_API_URL_INTERNAL 只能是同源 /api（或留空走 fallback）。
 *
 * 背景（真栈 e2e 铁证）：admin-api 的 main.ts 全局前缀 /api 恒开（无 env 开关），
 * Vite dev proxy 只代理 /api，nginx proxy_pass 无尾斜杠保留 /api。任何形态
 * （dev / vite proxy / nginx 反代 / 容器）的浏览器基地址都必须是 /api 或空。
 * 模板曾写 `http://localhost:3105`（裸路径）与 `http://admin-api:3105`
 * （浏览器不可解析的 Docker 服务名），按模板 `cp .env.example .env` 后
 * `npm run dev` 登录必然 POST /auth/login → 404。
 *
 * 只断言模板文本，不 import 产品代码：产品侧 client.ts:14 的 fallback 不在本守卫写域。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const TEMPLATES = ['apps/admin-web/.env.example', '.env.example'] as const;

function readValue(template: string, key: string): { value: string; line: number } | null {
  const lines = readFileSync(join(REPO_ROOT, template), 'utf-8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (match?.[1] === key) return { value: (match[2] ?? '').trim(), line: i + 1 };
  }
  return null;
}

describe('VITE_API_URL_INTERNAL 模板防回归：同源 /api 或留空', () => {
  for (const template of TEMPLATES) {
    it(`${template} 声明了 VITE_API_URL_INTERNAL`, () => {
      expect(readValue(template, 'VITE_API_URL_INTERNAL'), `${template} 缺少该键`).not.toBeNull();
    });

    it(`${template} 的值不是裸 URL：为空 / /api，或完整 URL 以 /api 结尾`, () => {
      const entry = readValue(template, 'VITE_API_URL_INTERNAL');
      expect(entry, `${template} 缺少该键`).not.toBeNull();
      const value = entry!.value;
      const ok = value === '' || value === '/api' || value === '/api/' ||
        value.endsWith('/api') || value.endsWith('/api/');
      expect(
        ok,
        `${template}:${entry!.line} 值为 "${value}"；后端全局 /api 前缀恒开，` +
          `裸地址会让 POST /auth/login 404（admin-api:3105 浏览器也无法解析）`,
      ).toBe(true);
    });
  }
});
