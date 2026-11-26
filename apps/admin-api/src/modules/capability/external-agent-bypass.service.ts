/**
 * N1 外部 agent 旁路：配置文本落盘的**唯一 I/O 层**。
 *
 * external-agent-bypass.ts 是零 I/O 的纯函数：只做指针构造与单 key 字符串改写；
 * 本服务负责把它接到真实文件上——读配置文本 → 构造指针 → 单 key 改写 →
 * 命中才原子写回（同目录 tmp + rename）。写回的是 `{env:NAME}` 指针而不是
 * 明文凭证；明文 / 畸形 keyRef / 命中数≠1 一律 changed=false 且**一个字节都不写**。
 *
 * fs 与 path 走构造注入：单测可塞内存替身；Nest 注册零配置即可用——未显式
 * 提供 BYPASS_FS / BYPASS_PATH token 时，@Optional + 默认值回落到 node 实现。
 * 配置路径由调用方传入，本服务不硬编码任何路径。
 */
import { Inject, Injectable, Optional } from "@nestjs/common";
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import {
  applySingleKeyRewrite,
  buildBypassPointer,
  type SingleKeyRewriteResult,
} from "./external-agent-bypass";

/** Nest 注入 token：需要替身时按这两个 token 覆盖即可。 */
export const BYPASS_FS = Symbol("N1_BYPASS_FS");
export const BYPASS_PATH = Symbol("N1_BYPASS_PATH");

/** 最小 fs 面：同步读 + 原子写需要的写 / rename / 清理。 */
export interface BypassFs {
  readFileSync(path: string, encoding: BufferEncoding): string;
  writeFileSync(
    path: string,
    data: string,
    options?: { encoding?: BufferEncoding },
  ): void;
  renameSync(oldPath: string, newPath: string): void;
  unlinkSync(path: string): void;
}

/** 最小 path 面：tmp 必须与目标同目录才能保证 rename 原子。 */
export interface BypassPath {
  dirname(path: string): string;
  basename(path: string): string;
  join(...paths: string[]): string;
}

export const defaultBypassFs: BypassFs = {
  readFileSync: (file, encoding) => nodeFs.readFileSync(file, encoding),
  writeFileSync: (file, data, options) =>
    nodeFs.writeFileSync(file, data, options),
  renameSync: (from, to) => nodeFs.renameSync(from, to),
  unlinkSync: (file) => nodeFs.unlinkSync(file),
};

export const defaultBypassPath: BypassPath = {
  dirname: (file) => nodePath.dirname(file),
  basename: (file) => nodePath.basename(file),
  join: (...parts) => nodePath.join(...parts),
};

/** 同进程内 tmp 名去重；带 pid 前缀避免多实例撞名。 */
let tmpSeq = 0;

@Injectable()
export class ExternalAgentBypassWriteService {
  constructor(
    @Optional()
    @Inject(BYPASS_FS)
    private readonly fs: BypassFs = defaultBypassFs,
    @Optional()
    @Inject(BYPASS_PATH)
    private readonly path: BypassPath = defaultBypassPath,
  ) {}

  /**
   * 显式改写一次外部 agent 配置。返回纯函数的原样结果（content + changed）。
   *
   * 读失败如实抛：这是显式调用，不是旁路审计，绝不吞异常假装成功。
   * changed=false 时不触写；幂等由纯函数保证（已是指针 ⇒ false），
   * 本服务不重复改写、不先写空内容。
   */
  applyBypass(
    configPath: string,
    keyName: string,
    baseUrl: unknown,
    keyRef: unknown,
  ): SingleKeyRewriteResult {
    const original = this.fs.readFileSync(configPath, "utf8");
    const pointer = buildBypassPointer({ baseUrl, keyRef });
    const result = applySingleKeyRewrite(original, pointer, keyName);
    if (!result.changed) return result;
    this.atomicWrite(configPath, result.content);
    return result;
  }

  /** 写 tmp + rename；任何失败都清理 tmp 并重抛原始异常，不留半写。 */
  private atomicWrite(configPath: string, content: string): void {
    const tmpPath = this.tempPathFor(configPath);
    try {
      this.fs.writeFileSync(tmpPath, content, { encoding: "utf8" });
      this.fs.renameSync(tmpPath, configPath);
    } catch (error: unknown) {
      try {
        this.fs.unlinkSync(tmpPath);
      } catch {
        // tmp 可能从未落盘或已被清理；清理失败不得覆盖原始异常。
      }
      throw error;
    }
  }

  private tempPathFor(configPath: string): string {
    tmpSeq += 1;
    return this.path.join(
      this.path.dirname(configPath),
      `.${this.path.basename(configPath)}.${process.pid}.${tmpSeq}.tmp`,
    );
  }
}
