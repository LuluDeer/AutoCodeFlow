/**
 * Unit tests for the CLI HTTP client: envelope unwrapping, method/path
 * plumbing (via a mocked axios instance) and readable error formatting
 * that distinguishes 401 from 403.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { axiosInstance } = vi.hoisted(() => ({
  axiosInstance: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => axiosInstance),
    isAxiosError: (e: unknown) =>
      !!e && typeof e === 'object' && (e as { isAxiosError?: boolean }).isAxiosError === true,
  },
}));

vi.mock('../config', () => ({
  getApiUrl: () => 'http://localhost:3105',
  getToken: () => 'test-token',
}));

import { get, post, put, patch, del, unwrap, resetClient, formatApiError } from '../client';

const envelope = (data: unknown) => ({ data: { code: 0, message: 'success', data } });

beforeEach(() => {
  resetClient();
  vi.clearAllMocks();
});

describe('unwrap', () => {
  it('strips the { code, message, data } envelope', () => {
    expect(unwrap({ code: 0, message: 'ok', data: { a: 1 } })).toEqual({ a: 1 });
  });

  it('strips an envelope that only has data+message', () => {
    expect(unwrap({ message: 'ok', data: [1, 2] })).toEqual([1, 2]);
  });

  it('passes through non-envelope payloads', () => {
    const raw = { data: 'x', extra: true };
    expect(unwrap(raw)).toEqual(raw);
    expect(unwrap('plain')).toBe('plain');
  });

  it('maps envelope data:null to null', () => {
    expect(unwrap({ code: 0, message: 'ok', data: null })).toBeNull();
  });
});

describe('client methods (mocked axios)', () => {
  it('get passes path and params through', async () => {
    axiosInstance.get.mockResolvedValueOnce(envelope({ list: [], total: 0 }));
    const result = await get<{ list: unknown[]; total: number }>('/tasks', { page: 1, pageSize: 20 });
    expect(axiosInstance.get).toHaveBeenCalledWith('/tasks', { params: { page: 1, pageSize: 20 } });
    expect(result).toEqual({ list: [], total: 0 });
  });

  it('post sends the body and unwraps the envelope', async () => {
    axiosInstance.post.mockResolvedValueOnce(envelope({ id: 'a1' }));
    const result = await post<{ id: string }>('/tasks', { name: 'n' });
    expect(axiosInstance.post).toHaveBeenCalledWith('/tasks', { name: 'n' });
    expect(result).toEqual({ id: 'a1' });
  });

  it('put sends the body (application update uses PUT)', async () => {
    axiosInstance.put.mockResolvedValueOnce(envelope({ id: 'a1' }));
    const result = await put<{ id: string }>('/applications/a1', { version: '2.0.0' });
    expect(axiosInstance.put).toHaveBeenCalledWith('/applications/a1', { version: '2.0.0' });
    expect(result).toEqual({ id: 'a1' });
  });

  it('patch sends the body', async () => {
    axiosInstance.patch.mockResolvedValueOnce(envelope({ id: 't1' }));
    await patch('/tasks/t1', { cronExpression: '* * * * *' });
    expect(axiosInstance.patch).toHaveBeenCalledWith('/tasks/t1', { cronExpression: '* * * * *' });
  });

  it('del sends the path', async () => {
    axiosInstance.delete.mockResolvedValueOnce(envelope(undefined));
    await del('/tasks/t1');
    expect(axiosInstance.delete).toHaveBeenCalledWith('/tasks/t1');
  });
});

function axiosError(status?: number, data?: unknown, message = 'Request failed') {
  return {
    isAxiosError: true,
    message,
    ...(status !== undefined ? { response: { status, data } } : {}),
  };
}

describe('formatApiError', () => {
  it('401 → tells the user to log in', () => {
    const msg = formatApiError(axiosError(401, { message: 'Unauthorized' }));
    expect(msg).toContain('401');
    expect(msg).toContain('acf login');
  });

  it('401 without detail still gets a readable hint', () => {
    const msg = formatApiError(axiosError(401));
    expect(msg).toContain('Unauthorized');
    expect(msg).toContain('acf login');
  });

  it('403 → distinguishes permission problem from bad token', () => {
    const msg = formatApiError(axiosError(403, { message: 'Forbidden resource' }));
    expect(msg).toContain('403');
    expect(msg).toContain('Forbidden');
    expect(msg).not.toContain('acf login');
  });

  it('403 default hint mentions the ADMIN role requirement', () => {
    const msg = formatApiError(axiosError(403));
    expect(msg).toContain('ADMIN');
  });

  it('400 surfaces the backend message', () => {
    const msg = formatApiError(axiosError(400, { message: 'property name should not exist' }));
    expect(msg).toContain('400');
    expect(msg).toContain('property name should not exist');
  });

  it('400 joins class-validator message arrays', () => {
    const msg = formatApiError(axiosError(400, { message: ['name must be a string', 'version should not be empty'] }));
    expect(msg).toContain('name must be a string; version should not be empty');
  });

  it('404 / 409 get their own labels', () => {
    expect(formatApiError(axiosError(404, { message: 'Task not found' }))).toContain('not found');
    expect(formatApiError(axiosError(409, { message: 'already exists' }))).toContain('Conflict');
  });

  it('other statuses keep the backend detail', () => {
    const msg = formatApiError(axiosError(500, { message: 'boom' }));
    expect(msg).toContain('500');
    expect(msg).toContain('boom');
  });

  it('network errors mention the API URL', () => {
    const msg = formatApiError(axiosError(undefined, undefined, 'getaddrinfo ENOTFOUND'));
    expect(msg).toContain('Network error');
    expect(msg).toContain('http://localhost:3105');
  });

  it('non-axios errors pass their message through', () => {
    expect(formatApiError(new Error('plain failure'))).toBe('plain failure');
    expect(formatApiError('raw string')).toBe('raw string');
  });
});
