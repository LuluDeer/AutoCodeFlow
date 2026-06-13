import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { logger } from './logger';

export interface Manifest {
  runtime?: string;
  entrypoint?: string;
  timeout?: number;
  requirements?: string[];
  [key: string]: unknown;
}

/**
 * Load manifest.yaml / manifest.yml from the working directory.
 * Returns an empty object if the file does not exist or fails to parse.
 */
export function loadManifest(workDir: string): Manifest {
  for (const name of ['manifest.yaml', 'manifest.yml']) {
    const p = path.join(workDir, name);
    if (fs.existsSync(p)) {
      try {
        const content = fs.readFileSync(p, 'utf-8');
        const data = yaml.load(content) as Manifest;
        logger.info(`Loaded manifest: ${p}`);
        return data || {};
      } catch (e: any) {
        logger.warn(`Failed to parse manifest ${p}: ${e.message}`);
      }
    }
  }
  return {};
}

/**
 * Fill in missing task fields with manifest values (task fields take priority).
 * Merge and deduplicate the requirements list.
 */
export function mergeTaskWithManifest(
  task: Record<string, unknown>,
  manifest: Manifest,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...manifest, ...task };
  const mReqs: string[] = (manifest.requirements as string[]) || [];
  const tReqs: string[] = (task.requirements as string[]) || [];
  if (mReqs.length || tReqs.length) {
    merged.requirements = [...new Set([...mReqs, ...tReqs])];
  }
  return merged;
}
