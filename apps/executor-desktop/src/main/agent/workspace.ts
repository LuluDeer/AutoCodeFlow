import * as fs from 'fs';
import * as path from 'path';
import { checkPathWithinDomains } from '../path-domain';

/**
 * P7a（agent-and-deployment）：Agent 沙箱工作区（设计文档 07 §5）。
 *
 * ## 沙箱在这里防什么
 * 「Agent 误删用户文件 / 误改系统配置」——不是防恶意代码（07 §5 的诚实
 * 结论：能操作本机已登录软件的 Agent 天然拥有用户权限，L1 沙箱防误操作、
 * 防不住恶意）。因此所有文件操作**必须**落在本模块划出的
 * `<workDir>/agent-workspace/<assignmentId>/` 之内，路径解析复用
 * path-domain 的 realpath 手法（折叠 symlink 祖先，Windows 大小写不敏感）。
 *
 * ## 为什么复用 checkPathWithinDomains
 * 同一条「renderer/LLM 提供的路径绝不裸用」的纪律——LLM 生成的代码里的
 * 路径与渲染层 IPC 的路径在信任模型上是**同级的不可信输入**。返回的
 * resolvedPath 才是 I/O 用的路径（TOCTOU 缓解，见 path-domain.ts 头注）。
 */

export const AGENT_WORKSPACE_DIRNAME = 'agent-workspace';

/** assignmentId 与执行 id 同款字符集（防路径穿越载荷）。 */
const ASSIGNMENT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function isValidAssignmentId(id: unknown): id is string {
  return typeof id === 'string' && ASSIGNMENT_ID_PATTERN.test(id) && id.length <= 128;
}

/**
 * 创建（或复用）一次指派的沙箱工作区，返回绝对根路径。
 * `assignmentId` 必须通过封闭字符集校验——它直接拼进路径。
 */
export function ensureWorkspace(workDir: string, assignmentId: string): string {
  if (!isValidAssignmentId(assignmentId)) {
    throw new Error(`invalid assignment id: ${String(assignmentId).slice(0, 64)}`);
  }
  const root = path.join(workDir, AGENT_WORKSPACE_DIRNAME, assignmentId);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/**
 * LLM/候选应用提供的路径 → 工作区内绝对路径。
 * 穿越载荷（`../`、绝对路径、盘符）一律拒绝；返回值必须用于实际 I/O。
 */
export function resolveWithinWorkspace(
  workspaceRoot: string,
  candidate: unknown,
): { ok: true; path: string } | { ok: false; error: string } {
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    return { ok: false, error: 'path is empty' };
  }
  if (path.isAbsolute(candidate) || /^[a-zA-Z]:[\\/]/.test(candidate) || candidate.startsWith('~')) {
    return { ok: false, error: 'absolute/home paths are not allowed — use workspace-relative paths' };
  }
  const result = checkPathWithinDomains(path.join(workspaceRoot, candidate), [workspaceRoot]);
  if (!result.ok || result.resolvedPath === undefined) {
    return { ok: false, error: result.error ?? 'path escapes the agent workspace' };
  }
  // 额外约束：realpath 后必须仍在工作区内（防 symlink 指出域外）
  //
  // realpathSync 在 workspaceRoot **不存在**时抛 ENOENT——而本函数的契约是
  // 「返回 ok:false，绝不抛」（调用方是 LLM 驱动的路径解析，抛出去就是一次
  // 会话崩溃）。工作区由 ensureWorkspace 创建，但配置里的 workDir 可能指向
  // 一个已被清理/迁移走的目录——那时"工作区不存在"应当如实报为解析失败。
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(workspaceRoot);
  } catch {
    return { ok: false, error: 'agent workspace does not exist' };
  }
  const normalizedRoot = process.platform === 'win32' ? realRoot.toLowerCase() : realRoot;
  const normalizedTarget = process.platform === 'win32' ? result.resolvedPath.toLowerCase() : result.resolvedPath;
  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(normalizedRoot + path.sep)) {
    return { ok: false, error: 'path escapes the agent workspace' };
  }
  return { ok: true, path: result.resolvedPath };
}

/**
 * 列出工作区文件（相对路径，供 LLM 观察自身产物）。
 *
 * ★ 目录遍历**绝不跟随 symlink**：工作区内一个指向域外的链接若被跟随，
 * 列目录就变成了「把域外文件列进 Agent 的观察面」——沙箱的可见性边界被
 * 悄悄扩大，而 `resolveWithinWorkspace` 那道闸完全管不到（它只校验**输入**
 * 路径，不校验 walk 到达的路径）。readdirSync 的 `withFileTypes` 给出
 * `isSymbolicLink()`，据此跳过而不是跟随。
 */
export function listWorkspaceFiles(workspaceRoot: string, sub: string = '.'): string[] {
  const abs = resolveWithinWorkspace(workspaceRoot, sub);
  if (!abs.ok) return [];
  if (!fs.existsSync(abs.path)) return [];
  const out: string[] = [];
  const walk = (dir: string, prefix: string, depth: number): void => {
    if (depth > 4) return; // 深度上限：防环形/超深目录拖垮探测
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.slice(0, 200)) {
      const rel = prefix === '' ? e.name : `${prefix}/${e.name}`;
      // 链接（含 junction）一律不跟随、也不列为目录——它可能指向域外。
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(path.join(dir, e.name), rel, depth + 1);
      else out.push(rel);
    }
  };
  walk(abs.path, sub === '.' ? '' : sub, 0);
  return out.sort();
}

/** 读取工作区内文本文件（大小上限 256KB——防超大文件塞爆 LLM 上下文）。 */
export function readWorkspaceFile(workspaceRoot: string, rel: string): { ok: true; content: string } | { ok: false; error: string } {
  const resolved = resolveWithinWorkspace(workspaceRoot, rel);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  try {
    const stat = fs.statSync(resolved.path);
    if (!stat.isFile()) return { ok: false, error: 'not a regular file' };
    if (stat.size > 256 * 1024) return { ok: false, error: 'file too large (>256KB)' };
    return { ok: true, content: fs.readFileSync(resolved.path, 'utf8') };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 写工作区内文本文件（内容上限 1MB——候选应用源码的合理上界）。 */
export function writeWorkspaceFile(workspaceRoot: string, rel: string, content: string): { ok: true; path: string } | { ok: false; error: string } {
  const resolved = resolveWithinWorkspace(workspaceRoot, rel);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  if (typeof content !== 'string' || content.length > 1024 * 1024) {
    return { ok: false, error: 'content empty or too large (>1MB)' };
  }
  try {
    fs.mkdirSync(path.dirname(resolved.path), { recursive: true });
    fs.writeFileSync(resolved.path, content, 'utf8');
    return { ok: true, path: resolved.path };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
