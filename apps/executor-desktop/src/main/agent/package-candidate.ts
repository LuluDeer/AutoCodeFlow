import * as fs from 'fs';
import * as path from 'path';
import { buildZip, type ZipEntry } from './zip-writer';
import { listWorkspaceFiles } from './workspace';

/**
 * P7d 前半（agent-and-deployment）：候选应用打包器（07 §3.3 / §7.2）。
 *
 * ## 这是「Agent 负责写、既有链路负责跑」的兑现点
 * 验收通过后，工作区内容被打成**标准应用包**（manifest.yaml + 源文件），
 * 经既有 executor-package 通道上传——admin 侧的 zip 魔数/后缀白名单/
 * zip bomb（SEC-05）检查链一字不动地作用在它身上。Agent 的自由仍然被
 * 限制在生成阶段；运行阶段走既有 deploy.ts 校验（shell/路径/env 白名单）。
 *
 * ## manifest.yaml（executor-node manifest.ts 契约）
 *   runtime:     python | node（由 entry 解释器映射；python3 → python）
 *   entrypoint:  工作区相对入口（LLM 的 entry spec）
 *   requirements: 从 SOP frontMatter.target 侧透传（P7a 恒空数组占位）
 *
 * ## 第 6 轮审计 P2：entrypoint 是 LLM 可控的文件名，绝不手拼进 YAML
 * 旧实现 `entrypoint: ${rel}` 直拼。rel 来自 LLM 的 entry spec，而工作区
 * 文件名也是 LLM 写的——只要写一个**名字里带换行**的文件（POSIX 合法），
 * `rel` 就会把下一行变成平台清单里的新键（例如
 * `main.js\nsecrets: leak`），而「LLM 不可覆盖 manifest」那道闸
 * （buildCandidatePackage 排除工作区自建 manifest.yaml）完全管不到这里：
 * 注入走的是**键**，不是文件。
 *
 * 现在两道独立的闸，任一漏掉另一道都还挡得住：
 *   1. **规范化 + 拒收**（validateEntrypointPath）：控制字符/换行、绝对路径、
 *      `..` 段、以 `-` 开头的段、冒号（YAML 键值分隔符，Windows 也非法）、
 *      首尾空白、空段、超长——这些形态要么造出键，要么让清单解析失败；
 *   2. **安全序列化**（yamlScalar）：值一律以 JSON 双引号标量写入——它是 YAML
 *      双引号标量的等价物（`\n`/`\"`/`\uXXXX` 的转义语义相同），换行、引号、
 *      `#`、`: ` 都只可能是**值的一部分**，结构上变不成新的键。
 */

/**
 * 打包时排除的观测产物目录（截图/录屏/执行证据是记录不是应用源码）。
 * trial-in-flight.json = P2-4 的试跑在飞登记（kill-tree 的孤儿清扫输入），
 * 正常结束即删——但崩溃窗口内可能残留，绝不能混进候选应用包。
 */
const EXCLUDED_PREFIXES = ['browser-recordings/', 'screenshots/', 'isolated-runs/', 'trial-in-flight.json'];
/** 平台构建的交付契约名——LLM 同名文件绝不进包（防 zip 双成员覆盖入口）。 */
const PLATFORM_MANIFEST_NAME = 'manifest.yaml';

/** interpreter → 包 runtime 类型（executor-node 可执行的运行时域）。 */
export function interpreterToRuntime(interpreter: string): 'python' | 'node' {
  return interpreter === 'python' || interpreter === 'python3' ? 'python' : 'node';
}

/** entrypoint 的长度上限（工作区相对路径；真实入口远短于此）。 */
export const ENTRYPOINT_MAX_CHARS = 512;

/**
 * 校验 LLM 给的入口相对路径。返回拒收原因（null = 通过）。
 *
 * 判据只收「YAML 结构敏感 / 路径穿越 / 平台非法」的形态，不收「非 ASCII」：
 * 中文文件名是合法的工作区产物，拒它只会把正常打包打红。真正的注入防线是
 * 下面的 yamlScalar——本函数负责在**写入前**把明显恶意的形态挡掉并给出可
 * 排障的原因（回报 failed 时能说清是哪条不合格）。
 */
export function validateEntrypointPath(rel: unknown): string | null {
  if (typeof rel !== 'string' || rel.trim() === '') return 'entrypoint 必须是非空字符串';
  if (rel.length > ENTRYPOINT_MAX_CHARS) return `entrypoint 过长（>${ENTRYPOINT_MAX_CHARS} 字符）`;
  // 控制字符（含换行/回车/制表符与 DEL/C1）：文件名没有合法用途，却是 YAML
  // 结构注入的唯一入口——一个换行就是一行新键。
  if (/[\u0000-\u001f\u007f-\u009f]/.test(rel)) return 'entrypoint 含控制字符/换行（YAML 注入面）';
  // 绝对路径 / 盘符 / 家目录：包内入口必须是工作区相对路径
  if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel) || rel.startsWith('~')) {
    return 'entrypoint 必须是工作区相对路径（绝对路径/家目录/盘符一律拒收）';
  }
  // 冒号：YAML 的键值分隔符（`a: b` 会让值被解析成嵌套映射），Windows 也非法
  if (rel.includes(':')) return 'entrypoint 含冒号（YAML 键值分隔符）';
  // `#` 前有空白 = YAML 注释起点；整值以 `#` 开头同理
  if (rel.startsWith('#') || rel.includes(' #')) return 'entrypoint 含 YAML 注释形态';
  for (const seg of rel.split('/')) {
    if (seg === '') return 'entrypoint 含空路径段（// 或结尾 /）';
    if (seg === '.' || seg === '..') return 'entrypoint 含 . 或 .. 路径段（穿越形态）';
    // `- ` 是 YAML 块序列标记；以 `-` 开头的文件名在清单里同样危险
    if (seg.startsWith('-')) return 'entrypoint 的路径段以 - 开头（YAML 块序列标记）';
    if (seg !== seg.trim()) return 'entrypoint 的路径段首尾含空白';
  }
  // 兜底：整值以任一 YAML 指示符开头（引号/花括号/方括号/&/*/!|>/%/@/` 等）
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(rel)) return 'entrypoint 以 YAML 指示符开头';
  return null;
}

/**
 * 把任意字符串写成**单行** YAML 标量：JSON 双引号形态（合法 YAML 双引号标量）。
 * 这是「不手拼」的落点：值里的换行/引号/冒号只会被转义，不会变成结构。
 */
export function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

/**
 * 注释行里的元数据（sop slug / version / contentHash）。
 * 换行会把注释截断、让后面变成真正的键——`#` 注释不是安全边界。
 */
function commentValue(value: unknown): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .slice(0, 200);
}

export interface CandidatePackageInput {
  workspaceRoot: string;
  /** LLM 交付的入口 spec（interpreter + workspace 相对路径）。 */
  entry: { interpreter: string; path: string };
  sopSlug: string;
  sopVersion: string;
  contentHash: string;
}

export interface CandidatePackage {
  filename: string;
  buf: Buffer;
  manifest: string;
  fileCount: number;
}

/** 打包候选应用。工作区文件缺失/超限时如实抛——调用方收敛为回报 failed。 */
export function buildCandidatePackage(input: CandidatePackageInput): CandidatePackage {
  const runtime = interpreterToRuntime(input.entry.interpreter);
  // 规范化（Windows 分隔符 → POSIX）后立即校验：绝不把未校验的字符串带进 YAML。
  const rel = String(input.entry.path ?? '').replace(/\\/g, '/');
  const relError = validateEntrypointPath(rel);
  if (relError !== null) {
    // 报错里回显也用转义形态：载荷可能带控制字符（换行），不能原样进日志/回报。
    throw new Error(
      `入口路径不合法（${relError}）：entrypoint=${JSON.stringify(rel).slice(0, 120)}`,
    );
  }
  const allFiles = listWorkspaceFiles(input.workspaceRoot);
  const files = allFiles.filter(
    (f) =>
      // manifest.yaml 是平台构建的交付契约（runtime/entrypoint 来自 entry
      // spec，不是 LLM 可覆盖的）。LLM 在工作区写同名文件会产生 zip 双成员，
      // 多数解压器「后写者胜」→ 平台 manifest 被顶掉（入口约束被绕过）。
      !EXCLUDED_PREFIXES.some((p) => f.startsWith(p)) && f !== PLATFORM_MANIFEST_NAME,
  );
  if (allFiles.includes(PLATFORM_MANIFEST_NAME)) {
    console.warn('[agent] 工作区内的 LLM manifest.yaml 已被排除——平台 manifest 是唯一交付契约');
  }
  if (!files.includes(rel)) {
    throw new Error(`入口文件 ${rel} 不在工作区文件清单中，无法打包`);
  }

  const manifest = [
    `runtime: ${runtime}`,
    // 值走 JSON 双引号标量（YAML 双引号标量等价物），绝不手拼
    `entrypoint: ${yamlScalar(rel)}`,
    `requirements: []`,
    // 注释里的元数据同样去控制字符：`#` 不是安全边界，换行会把注释变成键
    `# agent candidate: sop=${commentValue(input.sopSlug)} version=${commentValue(input.sopVersion)} contentHash=${commentValue(input.contentHash)}`,
    '',
  ].join('\n');

  const entries: ZipEntry[] = [
    { name: 'manifest.yaml', data: Buffer.from(manifest, 'utf8') },
    ...files.map((f) => ({
      name: f,
      data: fs.readFileSync(path.join(input.workspaceRoot, f)),
    })),
  ];
  // manifest 名单如实反映产物——验收跑的是工作区里的这些文件，包内必须一致
  const buf = buildZip(entries);
  const filename = `sop-${input.sopSlug}-${input.sopVersion}-agent.zip`;
  return { filename, buf, manifest, fileCount: entries.length };
}
