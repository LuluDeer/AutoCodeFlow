/**
 * `acf artifact` — read-side access to execution artifacts.
 *
 * Routes:
 *   GET /artifacts (cross-execution index, page/pageSize/taskId/... filters)
 *   GET /tasks/executions/:execId/artifacts (per-execution manifest)
 *   GET /tasks/executions/:execId/artifacts/:name/preview (bounded JSON preview)
 *   GET /tasks/executions/:execId/artifacts/:name (streamed download)
 *
 * Download bypasses the generic `unwrap` helper: the server streams raw bytes
 * with Content-Disposition / X-SHA256 headers. `getRaw` keeps those bytes and
 * surfaces the response headers so the CLI can verify the destination.
 */
import { Command } from 'commander';
import Table from 'cli-table3';
import chalk from 'chalk';
import { get, getRaw, type RawResponse } from '../client.js';
import { emitError, emitUsageError, UsageError } from '../ui.js';

interface ArtifactRow {
  id?: string;
  executionId?: string;
  name: string;
  size?: number;
  mimeType?: string;
  ext?: string;
  sha256?: string;
  createdAt?: string;
}

interface ArtifactManifestItem {
  name: string;
  size?: number;
  sha256?: string;
}

interface ArtifactIndex {
  items?: ArtifactRow[];
  total?: number;
}

interface ArtifactPreview {
  name: string;
  mimeType: string;
  size: number;
  truncated: boolean;
  kind: 'text' | 'image' | 'binary';
  content: string | null;
}

function intOption(flag: string, min: number, max?: number): (v: string) => number {
  return (v: string): number => {
    const n = /^\d+$/.test(v) ? Number(v) : Number.NaN;
    if (!Number.isInteger(n) || n < min || (max !== undefined && n > max)) {
      emitUsageError(
        `${flag} must be an integer ${max === undefined ? `>= ${min}` : `between ${min} and ${max}`} (got "${v}")`,
      );
      throw new UsageError('unreachable');
    }
    return n;
  };
}

/** Safe display filename: strip path separators and control characters. */
export function safeArtifactFileName(raw: string): string {
  return raw.replace(/[/\\\u0000-\u001f]/g, '_');
}

export function artifactCommand(): Command {
  const cmd = new Command('artifact').description(
    'List, preview and download execution artifacts',
  );

  cmd
    .command('list')
    .description(
      'List artifacts for one execution, or query the cross-execution index',
    )
    .option('--execution <execId>', 'Execution ID — returns that execution manifest')
    .option('--task <taskId>', 'Filter the index by task ID')
    .option('--application <appId>', 'Filter the index by application ID')
    .option('-q, --query <text>', 'Filename substring filter')
    .option('--ext <ext>', 'Extension filter (lowercase, without dot)')
    .option('--from <iso>', 'createdAt lower bound (ISO-8601, inclusive)')
    .option('--to <iso>', 'createdAt upper bound (ISO-8601, inclusive)')
    .option('--mine', 'Only artifacts for tasks owned by the caller')
    .option('-p, --page <n>', 'Page number', '1')
    .option('-n, --page-size <n>', 'Items per page (1-100, default 20)', (v) => intOption('--page-size', 1, 100)(v), 20)
    .option('--json', 'Emit raw JSON (CI-consumable, no table)')
    .action(
      async (opts: {
        execution?: string;
        task?: string;
        application?: string;
        query?: string;
        ext?: string;
        from?: string;
        to?: string;
        mine?: boolean;
        page: string;
        pageSize: number;
        json?: boolean;
      }) => {
        try {
          if (opts.execution) {
            const rows = (await get<ArtifactManifestItem[]>(
              `/tasks/executions/${opts.execution}/artifacts`,
            )) ?? [];
            if (opts.json) {
              console.log(JSON.stringify(rows, null, 2));
              return;
            }
            if (!rows.length) {
              console.log(chalk.gray('No artifacts for this execution.'));
              return;
            }
            const table = new Table({ head: ['Name', 'Size', 'SHA-256'] });
            for (const row of rows) {
              table.push([
                row.name,
                row.size === undefined ? '-' : String(row.size),
                row.sha256 ?? '-',
              ]);
            }
            console.log(table.toString());
            return;
          }

          const data = await get<ArtifactIndex>('/artifacts', {
            page: opts.page,
            pageSize: opts.pageSize,
            taskId: opts.task,
            applicationId: opts.application,
            q: opts.query,
            ext: opts.ext,
            from: opts.from,
            to: opts.to,
            mine: opts.mine ? 'true' : undefined,
          });
          if (opts.json) {
            console.log(JSON.stringify(data, null, 2));
            return;
          }
          const rows = data.items ?? [];
          if (!rows.length) {
            console.log(chalk.gray('No artifacts matched.'));
            return;
          }
          const table = new Table({
            head: ['Name', 'Execution', 'Size', 'Created'],
          });
          for (const row of rows) {
            table.push([
              row.name,
              row.executionId ?? '-',
              row.size === undefined ? '-' : String(row.size),
              row.createdAt ? new Date(row.createdAt).toISOString().slice(0, 10) : '-',
            ]);
          }
          console.log(table.toString());
          console.log(chalk.gray(`Total: ${data.total ?? rows.length}  page ${opts.page}`));
        } catch (e: unknown) {
          emitError('Failed to list artifacts', e);
        }
      },
    );

  cmd
    .command('preview <execId> <name>')
    .description(
      'Preview a bounded artifact payload (text inline; image/binary metadata only)',
    )
    .option('--max-bytes <n>', 'Preview byte budget (default 65536, max 262144)', (v) =>
      intOption('--max-bytes', 1, 262144)(v),
    )
    .option('--json', 'Emit the raw preview DTO as JSON')
    .action(
      async (
        execId: string,
        name: string,
        opts: { maxBytes?: number; json?: boolean },
      ) => {
        try {
          const preview = await get<ArtifactPreview>(
            `/tasks/executions/${execId}/artifacts/${encodeURIComponent(name)}/preview`,
            opts.maxBytes ? { maxBytes: opts.maxBytes } : undefined,
          );
          if (opts.json) {
            console.log(JSON.stringify(preview, null, 2));
            return;
          }
          if (preview.kind === 'text') {
            if (preview.content !== null) process.stdout.write(preview.content);
            if (!preview.content?.endsWith('\n')) process.stdout.write('\n');
            if (preview.truncated) {
              process.stderr.write(
                chalk.yellow(
                  `⚠ preview truncated at ${preview.size} bytes; use \`acf artifact download ${execId} ${name}\` for the full file.\n`,
                ),
              );
            }
            return;
          }
          console.log(
            chalk.gray(
              `${preview.kind} artifact (${preview.mimeType}, ${preview.size} bytes) — inline preview unavailable; use \`acf artifact download ${execId} ${name}\`.`,
            ),
          );
        } catch (e: unknown) {
          emitError('Failed to preview artifact', e);
        }
      },
    );

  cmd
    .command('download <execId> <name>')
    .description('Download an artifact to a local file (or stdout with -o -)')
    .option('-o, --output <path>', 'Destination path (default: artifact name)')
    .action(async (execId: string, name: string, opts: { output?: string }) => {
      try {
        const res: RawResponse = await getRaw(
          `/tasks/executions/${execId}/artifacts/${encodeURIComponent(name)}`,
        );
        const dest = opts.output ?? safeArtifactFileName(name);
        if (dest === '-') {
          process.stdout.write(Buffer.from(res.data));
          return;
        }
        const fs = await import('node:fs/promises');
        await fs.writeFile(dest, Buffer.from(res.data));
        const sha = res.headers['x-sha256'];
        console.log(
          chalk.green(`✔ downloaded ${name} → ${dest}`) +
            (typeof sha === 'string' ? chalk.gray(` (sha256 ${sha})`) : ''),
        );
      } catch (e: unknown) {
        emitError('Failed to download artifact', e);
      }
    });

  return cmd;
}
