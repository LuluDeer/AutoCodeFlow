import { useState } from 'react';
import { ConfigProvider } from 'antd';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import { agentApi } from '../api/agent';
import AgentSessionCreateModal from '../components/AgentSessionCreateModal';

vi.mock('../api/agent', () => ({ agentApi: { create: vi.fn() } }));
vi.mock('../utils/toast', () => ({ message: { success: vi.fn() } }));

const QUESTION = '问题或目标';
const CONTEXT = '上下文（JSON 对象，可选）';
const created = { id: 'id-returned-by-create', status: 'pending' };

function renderModal() {
  const onCreated = vi.fn();
  const onClose = vi.fn();
  function Host() {
    const [open, setOpen] = useState(false);
    return (
      <ConfigProvider theme={{ token: { motion: false } }}>
        <button onClick={() => setOpen(true)}>打开表单</button>
        <AgentSessionCreateModal
          open={open}
          onClose={() => { onClose(); setOpen(false); }}
          onCreated={onCreated}
        />
      </ConfigProvider>
    );
  }
  const { unmount } = render(<Host />);
  const trigger = screen.getByRole('button', { name: '打开表单' });
  trigger.focus();
  fireEvent.click(trigger);
  return { onCreated, onClose, trigger, unmount };
}

function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}
function toggleAdvanced() {
  fireEvent.click(screen.getByText('高级选项：添加上下文'));
}
function submit() {
  fireEvent.click(screen.getByRole('button', { name: '新建会话' }));
}

beforeAll(() => {
  if (typeof ResizeObserver === 'undefined') {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  }
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => { vi.mocked(agentApi.create).mockReset().mockResolvedValue(created); });
afterEach(cleanup);

describe('AgentSessionCreateModal', () => {
  it('只写问题即可创建：不生成标题或权限，关闭后交还精确 id，下次不带旧问题', async () => {
    const { onCreated, onClose, trigger } = renderModal();
    const question = screen.getByRole('textbox', { name: QUESTION });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('会话类型')));
    expect(screen.getByText(QUESTION).getAttribute('for')).toBe(question.id);
    expect(screen.getByLabelText(CONTEXT).closest('details')?.open).toBe(false);
    fill(QUESTION, '  昨晚的日报为什么失败？\n请给出原因。  ');
    submit();
    await waitFor(() => expect(onCreated).toHaveBeenCalledExactlyOnceWith(created.id));
    expect(agentApi.create).toHaveBeenCalledExactlyOnceWith({
      kind: 'chat', context: { question: '昨晚的日报为什么失败？\n请给出原因。' },
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    expect(screen.getByLabelText<HTMLTextAreaElement>(QUESTION).value).toBe('');
  });

  it.each([
    { context: { applicationId: 'app-7', filters: { failed: true } } },
    { context: { applicationId: 'app-7', filters: { failed: true }, question: '检查日报' } },
  ])('合并问题，保留用户标题和所有上下文字段；相同问题只发送一次：$context', async ({ context }) => {
    const { onCreated } = renderModal();
    fill(QUESTION, ' 检查日报 ');
    fill('标题', ' 交接班记录 ');
    toggleAdvanced();
    fill(CONTEXT, JSON.stringify(context));
    submit();
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(agentApi.create).toHaveBeenCalledExactlyOnceWith({
      kind: 'chat', title: '交接班记录',
      context: { question: '检查日报', applicationId: 'app-7', filters: { failed: true } },
    });
  });

  it('两处问题不一致时展开并指明冲突；用户自己选定 JSON 问题后才提交', async () => {
    const { onCreated, onClose } = renderModal();
    fill(QUESTION, '为什么失败？');
    toggleAdvanced();
    const json = '{"question":"下次何时执行？","taskId":6}';
    fill(CONTEXT, json);
    toggleAdvanced();
    submit();
    expect(screen.getByRole('alert').textContent).toContain('两处的问题不同');
    expect(screen.getByLabelText(CONTEXT).closest('details')?.open).toBe(true);
    expect(document.activeElement).toBe(screen.getByLabelText(CONTEXT));
    expect(screen.getByLabelText<HTMLTextAreaElement>(QUESTION).value).toBe('为什么失败？');
    expect(screen.getByLabelText<HTMLTextAreaElement>(CONTEXT).value).toBe(json);
    expect(agentApi.create).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    fill(QUESTION, '');
    submit();
    await waitFor(() => expect(onCreated).toHaveBeenCalledExactlyOnceWith(created.id));
    expect(agentApi.create).toHaveBeenCalledExactlyOnceWith({
      kind: 'chat', context: { question: '下次何时执行？', taskId: 6 },
    });
  });

  it('空白、空对象和只有元数据的 chat 不入队；高级 JSON 中明确的 goal 可独立使用', async () => {
    const { onCreated } = renderModal();
    fill(QUESTION, '   ');
    toggleAdvanced();
    for (const context of ['', '{}', '{"taskId":1}', '{"goal":"   "}']) {
      fill(CONTEXT, context);
      submit();
      expect(screen.getByRole('alert').textContent).toContain('请说明想让 Agent 做什么');
      expect(agentApi.create).not.toHaveBeenCalled();
    }
    fill('标题', '交接班');
    fill(CONTEXT, '{"taskId":1}');
    submit();
    expect(agentApi.create).not.toHaveBeenCalled(); // 标题 + 元数据并非「只填标题」
    fill(CONTEXT, '{"taskId":1,"goal":"分析执行失败原因"}');
    submit();
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(agentApi.create).toHaveBeenCalledExactlyOnceWith({
      kind: 'chat', title: '交接班', context: { taskId: 1, goal: '分析执行失败原因' },
    });
  });

  it('chat 确实只有标题时，把同一用户文本同时作为标题和运行时问题', async () => {
    const { onCreated } = renderModal();
    fill('标题', '  昨晚为何失败？ ');
    submit();
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(agentApi.create).toHaveBeenCalledExactlyOnceWith({
      kind: 'chat', title: '昨晚为何失败？', context: { question: '昨晚为何失败？' },
    });
  });

  it('不把 chat 的必填规则套给其他会话类型', async () => {
    const { onCreated } = renderModal();
    fireEvent.mouseDown(screen.getByLabelText('会话类型'));
    fireEvent.click(await screen.findByText('事件处置', { selector: '.ant-select-item-option-content' }));
    submit();
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(agentApi.create).toHaveBeenCalledExactlyOnceWith({ kind: 'incident' });
  });

  it('即使有自然语言问题也不丢弃无效 JSON 或覆盖无效的 question', () => {
    renderModal();
    fill(QUESTION, '检查日报');
    toggleAdvanced();
    for (const invalid of ['{', 'null', '[]', '"hello"']) {
      fill(CONTEXT, invalid);
      submit();
      expect(screen.getByRole('alert').textContent).toBe('上下文必须是 JSON 对象');
    }
    for (const question of [null, 42, {}, '  ']) {
      fill(CONTEXT, JSON.stringify({ question }));
      submit();
      expect(screen.getByRole('alert').textContent).toContain('question 必须是非空文本');
    }
    expect(agentApi.create).not.toHaveBeenCalled();
  });

  it('创建期间离开页面，迟到的响应不再打开旧页面的详情', async () => {
    let resolve!: (result: typeof created) => void;
    vi.mocked(agentApi.create).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const { unmount, onClose, onCreated } = renderModal();
    fill(QUESTION, '检查日报');
    submit();
    unmount();
    await act(async () => resolve(created));
    expect(onClose).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('在途不重复提交或关闭；失败保留输入并解锁，用同一份输入重试', async () => {
    let reject!: (error: Error) => void;
    vi.mocked(agentApi.create).mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    const { onCreated, onClose } = renderModal();
    fill(QUESTION, '分析失败日志');
    fill('标题', '日报');
    toggleAdvanced();
    fill(CONTEXT, '{"taskId":17}');
    const createButton = screen.getByRole<HTMLButtonElement>('button', { name: '新建会话' });
    fireEvent.click(createButton);
    expect(createButton.disabled).toBe(true);
    fireEvent.click(createButton);
    const cancel = screen.getByRole<HTMLButtonElement>('button', { name: /取\s*消/ });
    expect(cancel.disabled).toBe(true);
    expect(screen.getByLabelText<HTMLTextAreaElement>(QUESTION).disabled).toBe(true);
    fireEvent.click(cancel);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(agentApi.create).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => reject(new Error('network failure')));
    expect(screen.getByRole('alert').textContent).toContain('已保留输入');
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.getByLabelText<HTMLInputElement>('标题').value).toBe('日报');
    expect(screen.getByLabelText<HTMLTextAreaElement>(QUESTION).value).toBe('分析失败日志');
    expect(screen.getByLabelText<HTMLTextAreaElement>(CONTEXT).value).toBe('{"taskId":17}');
    expect(cancel.disabled).toBe(false);
    submit();
    await waitFor(() => expect(onCreated).toHaveBeenCalledExactlyOnceWith(created.id));
    const body = { kind: 'chat', title: '日报', context: { taskId: 17, question: '分析失败日志' } };
    expect(vi.mocked(agentApi.create).mock.calls).toEqual([[body], [body]]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
