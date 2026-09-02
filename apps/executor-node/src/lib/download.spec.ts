import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';

jest.mock('../config', () => ({
  config: { token: 'test-shared-token' },
}));

import { downloadFile } from './download';

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port);
    }),
  );
}

function tempDest(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'acf-dl-')), 'pkg.bin');
}

describe('downloadFile (shared Bearer downloader)', () => {
  it('sends the executor shared token as Bearer on the first request', async () => {
    const seen: Array<string | undefined> = [];
    const server = http.createServer((req, res) => {
      seen.push(req.headers.authorization);
      res.writeHead(200);
      res.end('payload');
    });
    const port = await listen(server);
    const dest = tempDest();
    try {
      const bytes = await downloadFile(`http://127.0.0.1:${port}/pkg.zip`, dest);
      expect(seen).toEqual(['Bearer test-shared-token']);
      expect(bytes).toBe(7);
      expect(fs.readFileSync(dest, 'utf8')).toBe('payload');
    } finally {
      server.close();
    }
  });

  it('keeps the token for same-host redirects and strips it on cross-host redirects', async () => {
    const seen: Array<string | undefined> = [];
    const serverB = http.createServer((req, res) => {
      seen.push(req.headers.authorization);
      res.writeHead(200);
      res.end('final');
    });
    const portB = await listen(serverB);
    // same-host target for the first hop (hostname 127.0.0.1 -> 127.0.0.1)
    const serverA = http.createServer((req, res) => {
      seen.push(req.headers.authorization);
      const target = req.url?.startsWith('/same')
        ? `http://127.0.0.1:${portB}/final`
        : `http://localhost:${portB}/final`;
      res.writeHead(302, { location: target });
      res.end();
    });
    const portA = await listen(serverA);

    const dest1 = tempDest();
    const dest2 = tempDest();
    try {
      await downloadFile(`http://127.0.0.1:${portA}/same`, dest1);
      expect(seen).toEqual(['Bearer test-shared-token', 'Bearer test-shared-token']);

      seen.length = 0;
      await downloadFile(`http://127.0.0.1:${portA}/cross`, dest2);
      // 127.0.0.1 → localhost is a cross-host redirect: token stripped
      expect(seen).toEqual(['Bearer test-shared-token', undefined]);
    } finally {
      serverA.close();
      serverB.close();
    }
  });

  it('rejects on the overall deadline even when the server drips bytes slowly', async () => {
    const sockets = new Set<import('net').Socket>();
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-length': '1000' });
      res.write('chunk');
      // keep the socket open, drip another byte every 50ms forever
      const drip = setInterval(() => res.write('x'), 50);
      res.on('close', () => clearInterval(drip));
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    const port = await listen(server);
    const dest = tempDest();
    try {
      await expect(
        downloadFile(`http://127.0.0.1:${port}/slow.zip`, dest, { timeoutMs: 400 }),
      ).rejects.toThrow(/timed out/i);
    } finally {
      for (const socket of sockets) socket.destroy();
      server.close();
      server.closeAllConnections?.();
    }
  }, 10_000);

  it('aborts when the response exceeds the byte cap', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200);
      res.end('x'.repeat(1000));
    });
    const port = await listen(server);
    const dest = tempDest();
    try {
      await expect(
        downloadFile(`http://127.0.0.1:${port}/big.zip`, dest, { maxBytes: 100 }),
      ).rejects.toThrow(/size limit/i);
      // the partial download must not linger
      expect(fs.existsSync(dest)).toBe(false);
    } finally {
      server.close();
    }
  }, 10_000);

  it('rejects HTTP error statuses and cleans the partial file', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end('nope');
    });
    const port = await listen(server);
    const dest = tempDest();
    try {
      await expect(downloadFile(`http://127.0.0.1:${port}/missing.zip`, dest)).rejects.toThrow(
        /status 404/,
      );
      expect(fs.existsSync(dest)).toBe(false);
    } finally {
      server.close();
    }
  }, 10_000);
});
