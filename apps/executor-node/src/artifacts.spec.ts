/**
 * FEAT-05: executor-node artifacts collection & upload (src/artifacts.ts).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  artifactsDirFor,
  collectArtifacts,
  gatherArtifacts,
  MAX_ARTIFACT_COUNT,
} from './artifacts';

function writeArt(dir: string, name: string, data: Buffer): string {
  const a = artifactsDirFor(dir);
  fs.mkdirSync(a, { recursive: true });
  const p = path.join(a, name);
  fs.writeFileSync(p, data);
  return p;
}

function shaOf(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

describe('artifacts.collectArtifacts', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-node-art-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('无 artifacts 目录返回空', () => {
    expect(collectArtifacts(tmp)).toEqual([]);
  });

  it('收集顶层文件，name 排序、size/sha 正确', () => {
    writeArt(tmp, 'shot.png', Buffer.from('png-data'));
    writeArt(tmp, 'report.csv', Buffer.from('a,b,c\n'));
    const items = collectArtifacts(tmp);
    expect(items.map((i) => i.name)).toEqual(['report.csv', 'shot.png']);
    for (const it of items) {
      expect(it.sha256).toBe(shaOf(fs.readFileSync(it.absPath)));
      expect(it.size).toBe(fs.statSync(it.absPath).size);
    }
  });

  it('跳过子目录与非法名（前导点）文件', () => {
    writeArt(tmp, 'keep.txt', Buffer.from('x'));
    fs.mkdirSync(path.join(artifactsDirFor(tmp), 'nested'));
    writeArt(tmp, '.hidden.txt', Buffer.from('y'));
    const names = collectArtifacts(tmp).map((i) => i.name);
    expect(names).toEqual(['keep.txt']);
  });

  it('数量上限 ≤ MAX_ARTIFACT_COUNT', () => {
    for (let i = 0; i < MAX_ARTIFACT_COUNT + 6; i++) {
      writeArt(tmp, `f${String(i).padStart(3, '0')}.bin`, Buffer.from('z'));
    }
    expect(collectArtifacts(tmp).length).toBe(MAX_ARTIFACT_COUNT);
  });
});

describe('artifacts.gatherArtifacts', () => {
  let tmp: string;
  let fetchMock: jest.Mock;
  const origFetch = global.fetch;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-node-gather-'));
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
  });
  afterEach(() => {
    (global as any).fetch = origFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('adminBaseUrl 缺省返回空且不发请求', async () => {
    writeArt(tmp, 'a.png', Buffer.from('1'));
    const r = await gatherArtifacts('exec-1', tmp, undefined, 'tok');
    expect(r).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('仅收录上传成功项，URL 带 /api 与 sha256 查询', async () => {
    writeArt(tmp, 'a.png', Buffer.from('1'));
    writeArt(tmp, 'b.csv', Buffer.from('2'));
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('a.png')) return { ok: true, status: 200 };
      return { ok: false, status: 500 };
    });
    const r = await gatherArtifacts('exec-1', tmp, 'http://admin:3105', 'tok');
    expect(r).toHaveLength(1);
    expect(r[0].name).toBe('a.png');
    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls.some((u) => u.startsWith('http://admin:3105/api/executions/exec-1/artifacts/a.png'))).toBe(true);
    expect(urls.some((u) => /a\.png\?sha256=[0-9a-f]{64}$/.test(u))).toBe(true);
  });

  it('上传 fetch 抛异常时 best-effort 返回空清单', async () => {
    writeArt(tmp, 'a.png', Buffer.from('1'));
    fetchMock.mockRejectedValue(new Error('network down'));
    const r = await gatherArtifacts('exec-1', tmp, 'http://admin:3105', 'tok');
    expect(r).toEqual([]);
  });

  it('已带 /api 的 base 不重复拼接', async () => {
    writeArt(tmp, 'x.txt', Buffer.from('1'));
    fetchMock.mockResolvedValue({ ok: true, status: 201 });
    await gatherArtifacts('e', tmp, 'http://admin:3105/api', 'tok');
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('http://admin:3105/api/executions/e/artifacts/x.txt');
    expect(url).not.toContain('/api/api');
  });
});
