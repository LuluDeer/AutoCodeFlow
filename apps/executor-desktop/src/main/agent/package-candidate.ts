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
 */

/** 打包时排除的观测产物目录（截图/录屏是证据不是应用源码）。 */
const EXCLUDED_PREFIXES = ['browser-recordings/', 'screenshots/'];

/** interpreter → 包 runtime 类型（executor-node 可执行的运行时域）。 */
export function interpreterToRuntime(interpreter: string): 'python' | 'node' {
  return interpreter === 'python' || interpreter === 'python3' ? 'python' : 'node';
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
  const rel = input.entry.path.replace(/\\/g, '/');
  const files = listWorkspaceFiles(input.workspaceRoot).filter(
    (f) => !EXCLUDED_PREFIXES.some((p) => f.startsWith(p)),
  );
  if (!files.includes(rel)) {
    throw new Error(`入口文件 ${rel} 不在工作区文件清单中，无法打包`);
  }

  const manifest = [
    `runtime: ${runtime}`,
    `entrypoint: ${rel}`,
    `requirements: []`,
    `# agent candidate: sop=${input.sopSlug} version=${input.sopVersion} contentHash=${input.contentHash}`,
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
