/**
 * Unit tests for the bin-entry CLI argument handling in index.ts:
 * --help / -h and --version / -v must exit 0 with usage / version text,
 * everything else keeps the historical "start the stdio server" behaviour.
 * The module is import-safe under vitest (auto-run is guarded by
 * process.env.VITEST), so parseCliArgs is exercised as a pure function.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseCliArgs, VERSION } from '../index';

describe('parseCliArgs', () => {
  it('starts the server when no arguments are given', () => {
    expect(parseCliArgs([])).toEqual({ action: 'run', output: '', exitCode: 0 });
  });

  it.each(['--help', '-h'])('%s exits 0 with usage text', (flag) => {
    const result = parseCliArgs([flag]);
    expect(result.action).toBe('exit');
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('AutoCodeFlow MCP server');
    expect(result.output).toContain('stdio');
  });

  it.each(['--version', '-v'])('%s exits 0 with the version', (flag) => {
    const result = parseCliArgs([flag]);
    expect(result.action).toBe('exit');
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe(`${VERSION}\n`);
  });

  it('help text documents the MCP stdio startup contract', () => {
    const { output } = parseCliArgs(['--help']);
    expect(output).toContain('Usage:');
    expect(output).toContain('autocodeflow-mcp');
    expect(output).toContain(`Version: ${VERSION}`);
  });

  it('help text lists the environment variables actually consumed', () => {
    const { output } = parseCliArgs(['--help']);
    expect(output).toContain('AUTOCODEFLOW_API_URL');
    expect(output).toContain('AUTOCODEFLOW_API_TOKEN');
    // names must match what src/api.ts reads (no drift to *_BASE_URL etc.)
    const apiSource = readFileSync(
      fileURLToPath(new URL('../api.ts', import.meta.url)),
      'utf-8',
    );
    expect(apiSource).toContain('process.env.AUTOCODEFLOW_API_URL');
    expect(apiSource).toContain('process.env.AUTOCODEFLOW_API_TOKEN');
  });

  it('unknown arguments keep the historical run behaviour', () => {
    expect(parseCliArgs(['--unknown-flag'])).toEqual({
      action: 'run',
      output: '',
      exitCode: 0,
    });
    expect(parseCliArgs(['serve', '--foo'])).toEqual({
      action: 'run',
      output: '',
      exitCode: 0,
    });
  });

  it('VERSION stays in sync with package.json', () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf-8'),
    );
    expect(VERSION).toBe(pkg.version);
  });
});
