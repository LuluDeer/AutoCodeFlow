import * as fs from 'fs';
import * as path from 'path';
import { config } from './config';
import { logger } from './logger';

const logsDir = path.join(config.workDir, 'logs');
fs.mkdirSync(logsDir, { recursive: true });

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function getLogFilePath(executionId: string, date?: Date): string {
  const dateStr = date ? formatDate(date) : formatDate(new Date());
  const dateDir = path.join(logsDir, dateStr);
  fs.mkdirSync(dateDir, { recursive: true });
  return path.join(dateDir, `${executionId}.log`);
}

export function appendLog(executionId: string, content: string): void {
  const filePath = getLogFilePath(executionId);
  fs.appendFileSync(filePath, content + '\n');
}

export function readLog(executionId: string, fromLine: number = 0, maxLines: number = 1000): { lines: string[], totalLines: number } {
  const filePath = getLogFilePath(executionId);
  
  if (!fs.existsSync(filePath)) {
    return { lines: [], totalLines: 0 };
  }
  
  const content = fs.readFileSync(filePath, 'utf-8');
  const allLines = content.split('\n').filter(line => line.length > 0);
  const totalLines = allLines.length;
  
  if (fromLine >= totalLines) {
    return { lines: [], totalLines };
  }
  
  const endIndex = Math.min(fromLine + maxLines, totalLines);
  const lines = allLines.slice(fromLine, endIndex);
  
  return { lines, totalLines };
}

export function clearLog(executionId: string): void {
  const filePath = getLogFilePath(executionId);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

export function deleteOldLogs(retentionDays: number): number {
  let deletedCount = 0;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  
  try {
    const dateDirs = fs.readdirSync(logsDir);
    for (const dateDir of dateDirs) {
      const dirPath = path.join(logsDir, dateDir);
      const stat = fs.statSync(dirPath);
      
      if (stat.isDirectory() && stat.birthtime.getTime() < cutoff) {
        fs.rmdirSync(dirPath, { recursive: true });
        deletedCount++;
        logger.debug(`Deleted old log directory: ${dateDir}`);
      }
    }
  } catch (error: unknown) {
    logger.error(`Error deleting old logs: ${error instanceof Error ? error.message : String(error)}`);
  }
  
  return deletedCount;
}

let cleanupInterval: NodeJS.Timeout | null = null;

export function startLogCleanup(retentionDays: number = 7): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
  }
  
  logger.info(`Starting log cleanup thread (retention: ${retentionDays} days)`);
  
  const cleanup = () => {
    const deleted = deleteOldLogs(retentionDays);
    if (deleted > 0) {
      logger.info(`Cleaned up ${deleted} old log directories`);
    }
  };
  
  cleanup();
  
  cleanupInterval = setInterval(cleanup, 24 * 60 * 60 * 1000);
}

export function stopLogCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
    logger.info('Stopped log cleanup thread');
  }
}

export function getLogStats(): { totalSize: number; fileCount: number } {
  let totalSize = 0;
  let fileCount = 0;
  
  const walk = (dir: string) => {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);
      
      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (file.endsWith('.log')) {
        totalSize += stat.size;
        fileCount++;
      }
    }
  };
  
  try {
    walk(logsDir);
  } catch {
    // Ignore if logs directory doesn't exist
  }
  
  return { totalSize, fileCount };
}