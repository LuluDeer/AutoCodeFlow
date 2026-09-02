import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';

jest.mock('../config', () => ({
  config: { token: 'test-shared-token' },
}));

import { downloadFile } from './download';

function listen(server: http.Server, host: string = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

/** Destroy client sockets, close idle keep-alive connections and await the
 *  close event so no server handle lingers into the next test. */
async function closeServer(server: http.Server, sockets?: Set<import('net').Socket>): Promise<void> {
  if (sockets) {
    for (const socket of sockets) socket.destroy();
  }
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) =>
    server.close((err) =>
      err && (err as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING'
        ? reject(err)
        : resolve(),
    ),
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
      await closeServer(server);
    }
  });

  it('keeps the token for same-host redirects and strips it on cross-host redirects', async () => {
    const seen: Array<string | undefined> = [];
    // Bound on 0.0.0.0 so both loopback literals below (127.0.0.1 and 127.0.0.2)
    // reach it: the whole 127/8 range routes to loopback on Linux/macOS/Windows,
    // so the redirect hops involve no DNS at all (a "localhost" target could
    // resolve to ::1 and hit nothing on IPv6-preferring CI machines).
    const serverB = http.createServer((req, res) => {
      seen.push(req.headers.authorization);
      res.writeHead(200);
      res.end('final');
    });
    const portB = await listen(serverB, '0.0.0.0');
    // same-host target for the first hop (hostname 127.0.0.1 -> 127.0.0.1)
    const serverA = http.createServer((req, res) => {
      seen.push(req.headers.authorization);
      const target = req.url?.startsWith('/same')
        ? `http://127.0.0.1:${portB}/final`
        : `http://127.0.0.2:${portB}/final`;
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
      // 127.0.0.1 → 127.0.0.2 is a cross-host redirect: token stripped
      expect(seen).toEqual(['Bearer test-shared-token', undefined]);
    } finally {
      await closeServer(serverA);
      await closeServer(serverB);
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
      await closeServer(server, sockets);
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
      await closeServer(server);
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
      await closeServer(server);
    }
  }, 10_000);
});
