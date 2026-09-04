/**
 * Unit tests for the MCP server HTTP layer: envelope unwrapping and the
 * apiRequest fetch plumbing (path / method / body / Authorization header),
 * with node-fetch mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('node-fetch', () => ({ default: fetchMock }));

import { apiRequest, unwrap, apiGet, apiPost, apiPut, apiDelete, REQUEST_TIMEOUT_MS } from '../api';

function jsonResponse(ok: boolean, body: unknown, status = ok ? 200 : 500) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(jsonResponse(true, { code: 0, message: 'success', data: null }));
});

describe('unwrap', () => {
  it('strips the { code, message, data } envelope', () => {
    expect(unwrap({ code: 0, message: 'ok', data: { a: 1 } })).toEqual({ a: 1 });
  });

  it('strips an envelope without code (data+message heuristic)', () => {
    expect(unwrap({ message: 'ok', data: [1, 2] })).toEqual([1, 2]);
  });

  it('passes through non-envelope payloads', () => {
    const raw = { data: 'x', extra: 1 };
    expect(unwrap(raw)).toEqual(raw);
    // Known heuristic edge (R4 P3): an object carrying BOTH data and message
    // is treated as an envelope even if it was an entity payload.
    expect(unwrap({ data: 'x', message: 'y', extra: 1 })).toBe('x');
  });

  it('maps envelope data:null to null', () => {
    expect(unwrap({ code: 0, message: 'ok', data: null })).toBeNull();
  });
});

describe('apiRequest', () => {
  it('sends GET with the Authorization header and unwraps the envelope', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(true, { code: 0, message: 'success', data: { id: 't1' } }));
    const result = await apiRequest<{ id: string }>('GET', '/tasks/t1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:3105/tasks/t1');
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toMatch(/^Bearer /);
    expect(result).toEqual({ id: 't1' });
  });

  it('sends POST with a JSON body', async () => {
    await apiRequest('POST', '/tasks/t1/trigger', { params: { a: 1 } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:3105/tasks/t1/trigger');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ params: { a: 1 } });
  });

  it('omits the body entirely when none is given', async () => {
    await apiRequest('GET', '/audit');
    const [, init] = fetchMock.mock.calls[0];
    expect(init.body).toBeUndefined();
  });

  it('throws a descriptive error including method, path and status on HTTP errors', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(false, { statusCode: 401, message: 'Unauthorized' }, 401),
    );
    // N12: the envelope message is extracted instead of dumping raw JSON.
    await expect(apiRequest('GET', '/audit')).rejects.toThrow(/Unauthorized \(401\)/);
  });
});

// ---------------------------------------------------------------------------
// N12: timeout control + envelope error message extraction
// ---------------------------------------------------------------------------
describe('apiRequest timeout (N12)', () => {
  it('passes an AbortSignal with the default 30s budget', async () => {
    await apiRequest('GET', '/tasks');
    const [, init] = fetchMock.mock.calls[0];
    expect(init.signal).toBeDefined();
    expect(REQUEST_TIMEOUT_MS).toBe(30_000);
  });

  it('rejects with a friendly timeout error when the request exceeds the budget', async () => {
    fetchMock.mockImplementationOnce(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_res, rej) => {
          init.signal.addEventListener('abort', () => {
            const err = new Error('This operation was aborted');
            err.name = 'AbortError';
            rej(err);
          });
        }),
    );
    // 注入极短超时，避免测试真等 30s
    await expect(apiRequest('GET', '/slow', undefined, 30)).rejects.toThrow(
      /timed out after 30ms/,
    );
  });

  it('rethrows non-timeout network errors unchanged', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(apiRequest('GET', '/x')).rejects.toThrow('ECONNREFUSED');
  });
});

describe('apiRequest error extraction (N12)', () => {
  it('401: surfaces the envelope message and the token hint', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(false, { code: 401, message: 'jwt expired', data: null }, 401),
    );
    await expect(apiRequest('GET', '/tasks')).rejects.toThrow(
      /Unauthorized \(401\): jwt expired.*AUTOCODEFLOW_API_TOKEN/,
    );
  });

  it('403: mentions the ADMIN role requirement', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(false, { code: 403, message: 'Forbidden', data: null }, 403),
    );
    await expect(apiRequest('POST', '/executors/e1/install')).rejects.toThrow(
      /Forbidden \(403\): Forbidden.*ADMIN/,
    );
  });

  it('400: joins class-validator message arrays', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(false, { statusCode: 400, message: ['name should not be empty', 'runtime must be a string'] }, 400),
    );
    await expect(apiRequest('POST', '/tasks')).rejects.toThrow(
      /API error \(400\): name should not be empty; runtime must be a string/,
    );
  });

  it('falls back to the raw text when the body is not JSON', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error('not json');
      },
      text: async () => 'Bad Gateway from nginx',
    });
    await expect(apiRequest('GET', '/tasks')).rejects.toThrow(
      /API GET \/tasks → 502: Bad Gateway from nginx/,
    );
  });

  it('falls back to raw text when JSON parses but carries no message', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(false, { timestamp: '2026-01-01', path: '/tasks' }, 500));
    await expect(apiRequest('GET', '/tasks')).rejects.toThrow(/API GET \/tasks → 500/);
  });
});

describe('method helpers', () => {
  it('apiGet / apiPost / apiPut / apiDelete use the right verbs', async () => {
    await apiGet('/x');
    await apiPost('/y', { k: 1 });
    await apiPut('/z', { k: 2 });
    await apiDelete('/w');
    expect(fetchMock.mock.calls.map((c) => c[1].method)).toEqual(['GET', 'POST', 'PUT', 'DELETE']);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ k: 1 });
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ k: 2 });
    expect(fetchMock.mock.calls[3][1].body).toBeUndefined();
  });
});
