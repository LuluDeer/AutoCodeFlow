// E-18（DEEP_REVIEW 0ef3bbe）：executor-python 全链 e2e 覆盖
// 此前 46 例 e2e 只注册 executor-node，python 执行器零端到端覆盖。
// 本 spec 覆盖：注册→派发（glueSource python）→执行→回调→终态断言。
//
// 编排：scripts/e2e-full.sh 在启动 executor-node 后并列启动 executor-python
// （端口 8003），并通过 E2E_PYTHON_EXECUTOR_AVAILABLE 环境变量标记是否就绪。
// 若 python 环境不可用（CI 未装 deps），test.skip 兜底不红。
const { test, expect } = require('@playwright/test');

const API = process.env.E2E_API_BASE || 'http://localhost:3105';
const PYTHON_AVAILABLE = process.env.E2E_PYTHON_EXECUTOR_AVAILABLE === '1';

async function apiLogin(request) {
  const r = await request.post(`${API}/api/auth/login`, {
    headers: { 'Content-Type': 'application/json' },
    data: { username: 'admin', password: 'admin123' },
  });
  return (await r.json()).data.accessToken;
}

// 查找 type=python 的在线执行器（与 getFirstOnlineExecutor 对齐，但按 type 过滤）
async function getPythonOnlineExecutor(request) {
  const tok = await apiLogin(request);
  const r = await request.get(`${API}/api/executors`, {
    headers: { Authorization: `Bearer ${tok}` },
  });
  const d = await r.json();
  const py = (d.data || []).find((e) => e.status === 'online' && e.type === 'python');
  if (!py) throw new Error('无 type=python 的在线执行器');
  return py;
}

async function apiCreateTask(request, payload) {
  const tok = await apiLogin(request);
  const r = await request.post(`${API}/api/tasks`, {
    headers: { Authorization: `Bearer ${tok}` },
    data: payload,
  });
  const d = await r.json();
  if (!d.data?.id) throw new Error(`创建任务失败: ${r.status()} ${JSON.stringify(d).slice(0, 200)}`);
  return d.data;
}

async function apiTriggerTask(request, taskId) {
  const tok = await apiLogin(request);
  const r = await request.post(`${API}/api/tasks/${taskId}/trigger`, {
    headers: { Authorization: `Bearer ${tok}` },
    data: {},
  });
  const d = await r.json();
  if (!d.data?.id) throw new Error(`触发失败: ${r.status()} ${JSON.stringify(d).slice(0, 200)}`);
  return d.data;
}

const TERMINAL_STATUSES = ['success', 'failed', 'timeout', 'killed', 'cancelled'];

async function apiWaitExecution(request, taskId, timeoutMs = 30000) {
  const tok = await apiLogin(request);
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    const r = await request.get(`${API}/api/tasks/${taskId}/executions?page=1&pageSize=5`, {
      headers: { Authorization: `Bearer ${tok}` },
    });
    const items = (await r.json()).data?.items || [];
    latest = items[0] || null;
    if (latest && TERMINAL_STATUSES.includes(latest.status)) return latest;
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error(`python 执行未在 ${timeoutMs}ms 内到终态，最后: ${latest?.status}`);
}

test.describe('E-18: executor-python 全链覆盖', () => {
  test.skip(!PYTHON_AVAILABLE, 'executor-python 未启动（E2E_PYTHON_EXECUTOR_AVAILABLE!=1）');

  test('注册→派发 python glue 任务→执行成功→回调终态=success', async ({ request }) => {
    // 1. 验证 python 执行器已注册 online
    const executor = await getPythonOnlineExecutor(request);
    console.log(`  ✓ 找到 python 执行器: ${executor.appName} @ ${executor.address}`);
    expect(executor.type).toBe('python');
    expect(executor.status).toBe('online');

    // 2. 创建 python glue 任务（内联 python 代码，零外部依赖）
    const task = await apiCreateTask(request, {
      name: 'e2e-python-smoke-' + Date.now().toString().slice(-6),
      triggerType: 'manual',
      runtime: 'python',
      glueSource: "print('E2E_PYTHON_OK from ' + __import__('os').environ.get('AUTOFLOW_EXECUTOR_ADDRESS', 'unknown'))",
      glueLanguage: 'python',
      executorId: executor.id,
      maxRetry: 0,
    });
    console.log(`  ✓ python 任务已创建: ${task.id}`);

    // 3. 触发并等待终态
    await apiTriggerTask(request, task.id);
    const exec = await apiWaitExecution(request, task.id, 30000);
    console.log(`  ✓ python 任务终态: ${exec.status}`);

    // 4. 断言成功
    expect(exec.status, `python 执行应成功，实际: ${exec.status}`).toBe('success');
  });
});
