/**
 * Focused tests for the workbench stream reducer and display helpers.
 * Pure logic only — no DOM, no network, no mounting. Not run by this slice.
 */
import { describe, expect, it } from 'vitest';
import {
  applyWorkbenchFrame,
  maxObservedSeq,
  parseWorkbenchFrame,
} from './stream';
import { formatBytes, sessionFallbackTitle, statusTone } from './format';
import type { WorkbenchSessionDetail } from './types';

const base: WorkbenchSessionDetail = {
  sessionId: 'sess-1',
  kind: 'chat',
  status: 'running',
  steps: [{ seq: 1, role: 'user', content: 'hello' }],
  toolCalls: [],
  approvalItems: [],
  artifacts: [],
};

describe('workbench stream reducer', () => {
  it('parses a JSON message frame and defaults its type', () => {
    const frame = parseWorkbenchFrame('{"seq":2,"role":"assistant","content":"hi"}');
    expect(frame?.type).toBe('message');
    expect(frame?.seq).toBe(2);
  });

  it('ignores malformed frames', () => {
    expect(parseWorkbenchFrame('not json')).toBeNull();
  });

  it('merges a durable step frame by seq', () => {
    const next = applyWorkbenchFrame(base, {
      type: 'step',
      step: { seq: 2, role: 'assistant', content: 'world' },
    });
    expect(next.steps).toHaveLength(2);
    expect(next.steps[1].content).toBe('world');
  });

  it('appends token deltas to the current assistant step', () => {
    const next = applyWorkbenchFrame(base, {
      type: 'token_delta',
      seq: 2,
      text: 'Hello',
    });
    expect(next.steps.find((s) => s.seq === 2)?.content).toBe('Hello');
    const next2 = applyWorkbenchFrame(next, { type: 'token_delta', seq: 2, delta: ' world' });
    expect(next2.steps.find((s) => s.seq === 2)?.content).toBe('Hello world');
  });

  it('updates status and phase from named frames', () => {
    let next = applyWorkbenchFrame(base, { type: 'phase_changed', phase: ' planning ' });
    expect(next.phase).toBe(' planning ');
    next = applyWorkbenchFrame(next, { type: 'status_changed', status: 'waiting_input' });
    expect(next.status).toBe('waiting_input');
  });

  it('tracks the highest observed seq for resumable streams', () => {
    const next = applyWorkbenchFrame(base, { type: 'step', seq: 9, step: { seq: 9, role: 'tool' } });
    expect(maxObservedSeq(next)).toBe(9);
  });
});

describe('workbench display helpers', () => {
  it('formats byte sizes in human-readable units', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
  });

  it('falls back to a short kind-prefixed label when no title exists', () => {
    expect(sessionFallbackTitle({ title: null, kind: 'chat', sessionId: 'abcdefgh-1234' }))
      .toBe('chat · abcdefgh');
  });

  it('maps terminal states to semantic tones', () => {
    expect(statusTone('succeeded')).toBe('success');
    expect(statusTone('failed')).toBe('error');
    expect(statusTone('waiting_input')).toBe('warning');
    expect(statusTone('something_new')).toBe('default');
  });
});
