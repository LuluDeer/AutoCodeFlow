/**
 * history-store.ts
 * 管理任务执行历史记录，持久化到 userData/history.json
 * 结构：{ records: HistoryRecord[] }
 */
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import log from './logger';

export interface HistoryRecord {
  executionId: string;
  taskId: string;
  taskName: string;
  appId: string;
  appName: string;
  startTime: number;       // unix ms
  endTime?: number;
  status?: 'success' | 'failed' | 'running';
  exitCode?: number;
  errorMessage?: string;
  logFile?: string;        // 绝对路径
}

const MAX_RECORDS = 500;

class HistoryStore {
  private filePath: string;
  private records: HistoryRecord[] = [];

  constructor() {
    const userData = app.getPath('userData');
    this.filePath = path.join(userData, 'history.json');
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const data = JSON.parse(raw);
        this.records = Array.isArray(data.records) ? data.records : [];
      }
    } catch (e) {
      log.warn(`HistoryStore: failed to load history: ${e}`);
      this.records = [];
    }
  }

  private save(): void {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify({ records: this.records }, null, 2), 'utf-8');
    } catch (e) {
      log.warn(`HistoryStore: failed to save history: ${e}`);
    }
  }

  addOrUpdate(record: HistoryRecord): void {
    const idx = this.records.findIndex(r => r.executionId === record.executionId);
    if (idx >= 0) {
      this.records[idx] = { ...this.records[idx], ...record };
    } else {
      this.records.unshift(record);
      // 超出上限时截断
      if (this.records.length > MAX_RECORDS) {
        this.records = this.records.slice(0, MAX_RECORDS);
      }
    }
    this.save();
  }

  getAll(): HistoryRecord[] {
    return this.records;
  }

  /** 按 appId 分组，每组内按 startTime 倒序 */
  getGroupedByApp(): Record<string, HistoryRecord[]> {
    const groups: Record<string, HistoryRecord[]> = {};
    for (const rec of this.records) {
      const key = rec.appId || rec.appName || 'unknown';
      if (!groups[key]) groups[key] = [];
      groups[key].push(rec);
    }
    // 每组内已按 unshift 倒序，确保稳定
    return groups;
  }

  clear(): void {
    this.records = [];
    this.save();
  }
}

// 单例 — 主进程启动后才能调用 app.getPath
let _store: HistoryStore | null = null;
export function getHistoryStore(): HistoryStore {
  if (!_store) _store = new HistoryStore();
  return _store;
}
