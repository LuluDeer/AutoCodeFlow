/**
 * P7d self-check：指派本地日志（崩溃恢复的最小持久层）。
 * Run via: npm run test:main
 *
 * 覆盖：原子落盘 roundtrip / 损坏文件按无日志降级 / 终态清理 / 陈旧清理 /
 * 路径语义消毒（assignmentId 来自中台载荷，不可信）。
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AssignmentJournal,
  clearAssignmentJournal,
  journalDirFor,
  JOURNAL_STALE_MS,
  listAssignmentJournals,
  loadAssignmentJournal,
  pruneStaleJournals,
  saveAssignmentJournal,
} from './assignment-journal';

let failures = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) console.log(`  \u2714 ${name}`);
  else {
    failures++;
    console.error(`  \u2718 ${name}${extra ? ` \u2014 ${extra}` : ''}`);
  }
}

const SOP = {
  slug: 'e2e-sop', title: 'T', version: '1.0.0', contentHash: 'hash-1',
  frontMatter: { capabilities: ['filesystem'], acceptance: [] },
  bodyMarkdown: '# do',
};

function makeJournal(assignmentId: string, over: Partial<AssignmentJournal> = {}): AssignmentJournal {
  return {
    assignmentId,
    sop: SOP,
    phase: 'running',
    pendingQuestion: null,
    asked: [],
    replies: [],
    counters: { iterations: 2, clarifications: 1, trialRuns: 2, dependencyInstalls: 0, startedAt: 1234 },
    guiActionsUsed: 0,
    lastSendError: null,
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

async function main(): Promise<void> {
  console.log('\n=== assignment-journal selftest ===\n');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-journal-'));
  try {
    console.log('-- 1. 落盘 roundtrip --');
    {
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-journal-w1-'));
      const jdir = journalDirFor(work);
      const j = makeJournal('aaaaaaaa-1111-2222-3333-444444444444', { phase: 'awaiting_reply', pendingQuestion: 'q1' });
      saveAssignmentJournal(jdir, j);
      const loaded = loadAssignmentJournal(jdir, j.assignmentId);
      check('roundtrip 保留 phase/pendingQuestion', loaded?.phase === 'awaiting_reply' && loaded?.pendingQuestion === 'q1');
      check('roundtrip 保留闸门计数（跨续跑预算）', loaded?.counters?.iterations === 2 && loaded?.counters?.startedAt === 1234);
      check('落盘在 <workDir>/agent-journal 下', fs.existsSync(path.join(work, 'agent-journal', `${j.assignmentId}.json`)));
      check('无 .tmp 残留（原子替换）', !fs.existsSync(path.join(work, 'agent-journal', `${j.assignmentId}.json.tmp`)));
      fs.rmSync(work, { recursive: true, force: true });
    }

    console.log('-- 2. 损坏/缺失按无日志降级（不抛）--');
    {
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-journal-w2-'));
      const jdir = journalDirFor(work);
      check('缺失 → null', loadAssignmentJournal(jdir, 'nope') === null);
      check('目录不存在 → 列表为空', listAssignmentJournals(jdir).length === 0);
      fs.mkdirSync(jdir, { recursive: true });
      fs.writeFileSync(path.join(jdir, 'broken.json'), '{ half', 'utf8');
      fs.writeFileSync(path.join(jdir, 'x.json.tmp'), '{"partial":1}', 'utf8');
      check('坏 JSON → null', loadAssignmentJournal(jdir, 'broken') === null);
      check('tmp 文件不进列表', listAssignmentJournals(jdir).length === 0);
      check('clear 缺失文件静默', clearAssignmentJournal(jdir, 'nope') === undefined);
      fs.rmSync(work, { recursive: true, force: true });
    }

    console.log('-- 3. 结构校验：缺 contentHash / 非法 phase 拒收 --');
    {
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-journal-w3-'));
      const jdir = journalDirFor(work);
      fs.mkdirSync(jdir, { recursive: true });
      fs.writeFileSync(path.join(jdir, 'bad1.json'), JSON.stringify({ assignmentId: 'bad1', phase: 'running', sop: {} }), 'utf8');
      fs.writeFileSync(path.join(jdir, 'bad2.json'), JSON.stringify({ assignmentId: 'bad2', phase: 'weird', sop: { contentHash: 'x' } }), 'utf8');
      check('无 contentHash 的 sop 拒收', loadAssignmentJournal(jdir, 'bad1') === null);
      check('非法 phase 拒收', loadAssignmentJournal(jdir, 'bad2') === null);
      fs.rmSync(work, { recursive: true, force: true });
    }

    console.log('-- 4. 路径语义消毒（assignmentId 不可信）--');
    {
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-journal-w4-'));
      const jdir = journalDirFor(work);
      const evil = makeJournal('../../etc/passwd');
      saveAssignmentJournal(jdir, evil);
      // 6 个非合法字符（4 个点 + 2 个斜杠）各自变下划线，文件留在日志目录内
      check('穿越 id 落盘为消毒文件名（不落目录外）',
        fs.existsSync(path.join(jdir, '______etc_passwd.json')) &&
        !fs.existsSync(path.join(work, 'etc', 'passwd.json')));
      check('消毒 id 可 roundtrip 读回', loadAssignmentJournal(jdir, '../../etc/passwd')?.assignmentId === '../../etc/passwd');
      fs.rmSync(work, { recursive: true, force: true });
    }

    console.log('-- 5. 陈旧清理 --');
    {
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-journal-w5-'));
      const jdir = journalDirFor(work);
      const now = Date.now();
      saveAssignmentJournal(jdir, makeJournal('fresh'));
      saveAssignmentJournal(jdir, makeJournal('stale'));
      // 落盘恒盖 updatedAt=now——「旧记录」直接改盘上文件模拟
      const patch = (id: string, iso: string): void => {
        const p = path.join(jdir, `${id}.json`);
        fs.writeFileSync(p, JSON.stringify({ ...JSON.parse(fs.readFileSync(p, 'utf8')), updatedAt: iso }), 'utf8');
      };
      patch('fresh', new Date(now - 1000).toISOString());
      patch('stale', new Date(now - JOURNAL_STALE_MS - 60_000).toISOString());
      const pruned = pruneStaleJournals(jdir, now);
      check('只清理超龄日志', pruned.join(',') === 'stale');
      check('fresh 仍在 / stale 已删', loadAssignmentJournal(jdir, 'fresh') !== null && loadAssignmentJournal(jdir, 'stale') === null);
      fs.rmSync(work, { recursive: true, force: true });
    }

    console.log('-- 6. 列表 --');
    {
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-journal-w6-'));
      const jdir = journalDirFor(work);
      saveAssignmentJournal(jdir, makeJournal('id-a', { phase: 'running' }));
      saveAssignmentJournal(jdir, makeJournal('id-b', { phase: 'awaiting_reply' }));
      const all = listAssignmentJournals(jdir);
      check('两份日志都在列表中', all.length === 2 && all.every((j) => j.assignmentId === 'id-a' || j.assignmentId === 'id-b'));
      clearAssignmentJournal(jdir, 'id-a');
      check('清理后列表只剩一条', listAssignmentJournals(jdir).length === 1);
      fs.rmSync(work, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(true);
  console.log(failures ? `\n=== ${failures} 项失败 ===\n` : '\n=== assignment-journal selftest 全部通过 ===\n');
  process.exit(failures ? 1 : 0);
}

void main();
