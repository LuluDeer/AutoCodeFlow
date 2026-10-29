/**
 * `sopSessionTurnStream`（客户端 SSE 解析）。
 *
 * 服务端逐帧发 `delta` → `done`；客户端必须：边收边回调、`done` 帧解析成整条
 * 会话、`error` 帧抛出、半帧留在缓冲里等下一块。jsdom 里用假 fetch + 手搓
 * ReadableStream 逐块喂，模拟真实分片。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { aiApi } from '../api/ai';

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sopSessionTurnStream', () => {
  it('逐帧回调 delta，done 帧解析成会话；分片切在帧中间也不丢', async () => {
    const session = { id: 's-1', status: 'drafted', messages: [], media: [], draft: null };
    const frames = [
      'event: delta\ndata: {"text":"你好"}\n\n',
      'event: delta\ndata: {"text":"，世界"}\n\n',
      `event: done\ndata: ${JSON.stringify(session)}\n\n`,
    ];
    // 故意在第二帧中间切开，验证缓冲拼接
    const raw = frames.join('');
    const cut = raw.indexOf('event: delta\ndata: {"text":"，') + 10;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sseResponse([raw.slice(0, cut), raw.slice(cut)])),
    );

    const deltas: string[] = [];
    const out = await aiApi.sopSessionTurnStream(
      's-1',
      { text: '继续' },
      { onDelta: (t) => deltas.push(t) },
    );

    expect(deltas).toEqual(['你好', '，世界']);
    expect(out).toEqual(session);
  });

  it('error 帧 → 抛出（不把半截内容当成成功）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          'event: error\ndata: {"code":"AI_SOP_QUESTIONS_EXHAUSTED","message":"追问已达上限"}\n\n',
        ]),
      ),
    );

    await expect(
      aiApi.sopSessionTurnStream('s-1', { text: 'x' }, { onDelta: () => {} }),
    ).rejects.toThrow(/追问已达上限/);
  });

  it('只有 delta 没有 done → 抛错（防把半截输出当完整会话）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sseResponse(['event: delta\ndata: {"text":"半截"}\n\n'])),
    );
    await expect(
      aiApi.sopSessionTurnStream('s-1', { text: 'x' }, { onDelta: () => {} }),
    ).rejects.toThrow(/without done/);
  });

  it('HTTP 非 2xx → 抛错并带状态码', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 401 })),
    );
    await expect(
      aiApi.sopSessionTurnStream('s-1', { text: 'x' }, { onDelta: () => {} }),
    ).rejects.toThrow(/status=401/);
  });
});
